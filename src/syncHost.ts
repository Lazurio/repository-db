import path from "node:path";
import { gitFetchAsync } from "./git.ts";
import type { DraftOwner } from "./origin.ts";
import type { PullResult } from "./publish.ts";
import { RepositoryDb } from "./repositoryDb.ts";
import {
	type ConflictState,
	PullBlockedError,
	PublishLockedError,
	RepositoryDbError,
	type SyncStatus,
} from "./types.ts";

/**
 * The host side of synchronisation, owned by the engine so no app rebuilds it.
 *
 * One small service per data checkout. It gives an app:
 *
 *   - a serialized mutation queue, `run(kind, fn)`, that every write, publish,
 *     pull and discard goes through, so in-process work waits its turn instead
 *     of meeting the engine's fail-fast gate;
 *   - a status snapshot, `status()`, which is what the Draft & Publish card is
 *     derived from (`deriveDraftPanel`);
 *   - events, `subscribe(listener)`: `status`, `remote-pulled` (with the
 *     changed paths), `conflict` and `error`;
 *   - a background check every `intervalMs`: fetch, then fast-forward to
 *     colleagues' work whenever the engine allows it — also under a draft of
 *     other records;
 *   - recovery: a checkout that does not exist yet (or vanished) is opened
 *     again on every check; a failed open is never cached.
 *
 * Framework-agnostic on purpose: the app keeps only its HTTP or SSE wiring.
 */

export interface SyncHostOptions {
	/** Root of the data checkout. It may not exist yet. */
	mountRoot: string;
	/** Background check cadence in ms; default 30 000. `0` runs no timer. */
	intervalMs?: number;
	/** Fast-forward to colleagues' work in the background; default true. */
	autoPull?: boolean;
}

export interface SyncHostProblem {
	code: string;
	message: string;
}

export interface SyncHostStatus {
	mountRoot: string;
	/** False while the checkout cannot be opened; `error` says why. */
	available: boolean;
	error: SyncHostProblem | null;
	sync: SyncStatus | null;
	conflict: ConflictState | null;
	/** Revision of the draft as it stands; what a publish or discard confirms. */
	revision: string | null;
	draftOwner: DraftOwner | null;
	/** The engine refused the last pull because the draft changes the same records. */
	pullBlocked: { paths: string[]; message: string } | null;
	/** The last fetch failed (offline, credentials): remote freshness is unknown. */
	fetchError: SyncHostProblem | null;
	checkedAt: string;
}

/** A record a pull or send brought in, by the Collection layout `<data>/<collection>/<id>.yaml`. */
export interface SyncHostRecordRef {
	collection: string;
	id: string;
	path: string;
}

export type SyncHostEvent =
	| { type: "status"; status: SyncHostStatus }
	| {
			type: "remote-pulled";
			/** Paths colleagues' work changed in this checkout. */
			paths: string[];
			records: SyncHostRecordRef[];
			status: SyncHostStatus;
	  }
	| { type: "conflict"; conflict: ConflictState; status: SyncHostStatus }
	| { type: "error"; operation: string; error: SyncHostProblem };

export interface SyncHost {
	readonly mountRoot: string;
	/** Start the background check (runs one at once). Idempotent. */
	start(): void;
	stop(): void;
	/**
	 * The facade for reads. Throws `mount_unavailable` while the checkout
	 * cannot be opened; it is tried again on the next call.
	 */
	db(): RepositoryDb;
	/**
	 * Run one mutation after every earlier one on this checkout has finished
	 * (in this process). The status is refreshed afterwards and events fire.
	 */
	run<T>(kind: string, operation: (db: RepositoryDb) => T | Promise<T>): Promise<T>;
	/** Run the background check now and return the fresh status. */
	refresh(): Promise<SyncHostStatus>;
	/** Last computed status; cheap. */
	status(): SyncHostStatus;
	/** Listen to events; returns the unsubscribe function. */
	subscribe(listener: (event: SyncHostEvent) => void): () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;

/** One queue per checkout across every host in this process (a dev server may build two). */
const queues = new Map<string, Promise<void>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const current = previous.then(task, task);
	const tail = current.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, tail);
	void tail.then(() => {
		if (queues.get(key) === tail) queues.delete(key);
	});
	return current;
}

function problemOf(error: unknown): SyncHostProblem {
	if (error instanceof RepositoryDbError) return { code: error.code, message: error.message };
	return { code: "unexpected", message: error instanceof Error ? error.message : String(error) };
}

/** Errors meaning "the checkout is not (or no longer) there": open it again next time. */
function isMountGone(error: unknown): boolean {
	return (
		error instanceof RepositoryDbError &&
		(error.code === "boundary_violation" || error.code === "config_missing")
	);
}

function recordRefs(db: RepositoryDb, paths: readonly string[]): SyncHostRecordRef[] {
	const prefix = `${db.config.layout.data}/`;
	const refs: SyncHostRecordRef[] = [];
	for (const entry of paths) {
		if (!entry.startsWith(prefix) || !entry.endsWith(".yaml")) continue;
		const segments = entry.slice(prefix.length).split("/");
		if (segments.length !== 2 || !segments[0] || !segments[1]) continue;
		try {
			refs.push({
				collection: segments[0],
				id: decodeURIComponent(segments[1].slice(0, -".yaml".length)),
				path: entry,
			});
		} catch {
			/* not a Collection file name */
		}
	}
	return refs;
}

function sameSnapshot(left: SyncHostStatus, right: SyncHostStatus): boolean {
	return (
		JSON.stringify({ ...left, checkedAt: "" }) === JSON.stringify({ ...right, checkedAt: "" })
	);
}

export function createSyncHost(options: SyncHostOptions): SyncHost {
	const mountRoot = path.resolve(options.mountRoot);
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const autoPull = options.autoPull ?? true;
	const listeners = new Set<(event: SyncHostEvent) => void>();

	let facade: RepositoryDb | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let checking: Promise<SyncHostStatus> | undefined;
	let pullBlocked: SyncHostStatus["pullBlocked"] = null;
	let fetchError: SyncHostProblem | null = null;
	let lastOpenError = "";
	let snapshot: SyncHostStatus = unavailable({
		code: "not_checked",
		message: "The data checkout has not been checked yet.",
	});

	function unavailable(error: SyncHostProblem): SyncHostStatus {
		return {
			mountRoot,
			available: false,
			error,
			sync: null,
			conflict: null,
			revision: null,
			draftOwner: null,
			pullBlocked: null,
			fetchError: null,
			checkedAt: new Date().toISOString(),
		};
	}

	function emit(event: SyncHostEvent): void {
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {
				/* a listener's failure is its own; the host keeps going */
			}
		}
	}

	function open(): RepositoryDb {
		if (facade) return facade;
		try {
			facade = RepositoryDb.open(mountRoot);
			lastOpenError = "";
			return facade;
		} catch (error) {
			const problem = problemOf(error);
			const key = `${problem.code}\0${problem.message}`;
			if (key !== lastOpenError) {
				lastOpenError = key;
				emit({ type: "error", operation: "open", error: problem });
			}
			throw new RepositoryDbError(
				"mount_unavailable",
				`The data checkout ${mountRoot} is not available yet: ${problem.message}`,
			);
		}
	}

	function forgetIfGone(error: unknown): void {
		if (isMountGone(error)) facade = undefined;
	}

	/** Recompute the snapshot from the checkout and announce what changed. */
	function publishStatus(): SyncHostStatus {
		let next: SyncHostStatus;
		try {
			const db = open();
			const sync = db.status();
			if (sync.behind === 0) pullBlocked = null;
			next = {
				mountRoot,
				available: true,
				error: null,
				sync,
				conflict: db.conflict() ?? null,
				revision: db.draftRevision(),
				draftOwner: db.draftOwner() ?? null,
				pullBlocked,
				fetchError,
				checkedAt: new Date().toISOString(),
			};
		} catch (error) {
			forgetIfGone(error);
			next = unavailable(problemOf(error));
		}
		const previous = snapshot;
		snapshot = next;
		if (!sameSnapshot(previous, next)) emit({ type: "status", status: next });
		if (
			next.conflict &&
			JSON.stringify(previous.conflict) !== JSON.stringify(next.conflict)
		) {
			emit({ type: "conflict", conflict: next.conflict, status: next });
		}
		return next;
	}

	function announceIncoming(db: RepositoryDb, paths: readonly string[], status: SyncHostStatus): void {
		if (paths.length === 0) return;
		emit({
			type: "remote-pulled",
			paths: [...paths],
			records: recordRefs(db, paths),
			status,
		});
	}

	function run<T>(kind: string, operation: (db: RepositoryDb) => T | Promise<T>): Promise<T> {
		return enqueue(mountRoot, async () => {
			const db = open();
			let result: T;
			try {
				result = await operation(db);
			} catch (error) {
				forgetIfGone(error);
				if (error instanceof PullBlockedError) {
					pullBlocked = { paths: error.paths, message: error.message };
				}
				publishStatus();
				throw error;
			}
			if (kind === "pull" && (result as PullResult | undefined)?.state === "pulled") pullBlocked = null;
			const status = publishStatus();
			// A pull, and a send that integrated colleagues' work, both bring
			// their records into this checkout.
			const incoming = (result as { remoteChanges?: unknown } | undefined)?.remoteChanges;
			if (Array.isArray(incoming)) {
				announceIncoming(
					db,
					incoming.filter((entry): entry is string => typeof entry === "string"),
					status,
				);
			}
			return result;
		});
	}

	async function check(): Promise<SyncHostStatus> {
		let db: RepositoryDb;
		try {
			db = open();
		} catch {
			return publishStatus();
		}
		try {
			await gitFetchAsync(db.mountRoot);
			fetchError = null;
		} catch (error) {
			forgetIfGone(error);
			fetchError = problemOf(error);
		}
		return enqueue(mountRoot, async () => {
			let pulled: PullResult | undefined;
			try {
				const sync = db.status();
				if (autoPull && !fetchError && sync.behind > 0 && sync.ahead === 0 && !sync.conflict) {
					pulled = await db.pull({ fetch: false });
					pullBlocked = null;
				}
			} catch (error) {
				forgetIfGone(error);
				if (error instanceof PullBlockedError) {
					pullBlocked = { paths: error.paths, message: error.message };
				} else if (!(error instanceof PublishLockedError)) {
					// Someone else (an agent through the CLI) holding the gate is
					// ordinary; the next check tries again. Anything else is told.
					emit({ type: "error", operation: "pull", error: problemOf(error) });
				}
			}
			const status = publishStatus();
			if (pulled?.state === "pulled") announceIncoming(db, pulled.remoteChanges, status);
			return status;
		});
	}

	function refresh(): Promise<SyncHostStatus> {
		if (!checking) {
			checking = check().finally(() => {
				checking = undefined;
			});
		}
		return checking;
	}

	return {
		mountRoot,
		start() {
			if (timer) return;
			void refresh();
			if (intervalMs > 0) {
				timer = setInterval(() => void refresh(), intervalMs);
				(timer as { unref?: () => void }).unref?.();
			}
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
		},
		db: open,
		run,
		refresh,
		status: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
