import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { assertDataRepoBoundary, normalizeRemoteUrl } from "./boundary.ts";
import { CONFIG_FILE_NAME } from "./config.ts";
import {
	gitAheadBehind,
	gitChangedPaths,
	gitDirtyPaths,
	gitFetchAsync,
	gitHeadCommit,
	runGit,
} from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";
import type { DraftOwner } from "./origin.ts";
import type { PullResult } from "./publish.ts";
import { RepositoryDb, takeIncomingChanges } from "./repositoryDb.ts";
import {
	BoundaryViolationError,
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
 *   - `read(fn)` for everything else: no queue, but the same facade handling,
 *     so a read that finds the checkout changed under it never keeps a stale
 *     facade;
 *   - a status snapshot, `status()`, which is what the Draft & Publish card is
 *     derived from (`deriveDraftPanel`);
 *   - events, `subscribe(listener)`: `status`, `remote-pulled` (with the
 *     changed paths), `conflict` and `error`;
 *   - a background check every `intervalMs`, in the same queue: fetch, then
 *     fast-forward to colleagues' work whenever the engine allows it — also
 *     under a draft of other records;
 *   - recovery: a checkout that does not exist yet (or vanished) is opened
 *     again on every check; a failed open is never cached;
 *   - a live check before every read and mutation: the checkout must still be
 *     there, with a configuration of the same boundary (and, with `expect`,
 *     the data repository the app serves). Cheap: the configuration is re-read
 *     only when its file changed.
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
	/**
	 * Which record a changed path is, for `remote-pulled`. The engine knows only
	 * the Collection layout (`<data>/<collection>/<id>.yaml`), passed in as
	 * `collectionRecord`; an app with nested record files maps them here and
	 * returns `collectionRecord` for the rest. `null` means "not a record".
	 */
	/**
	 * The data repository this app serves. When set, a checkout whose
	 * configuration names another remote or branch is refused with
	 * `boundary_violation` — on open, before every read and mutation, and in the
	 * background check — so nothing is fetched or pulled into the wrong data.
	 * `within`, when set, also requires the checkout's real path (symbolic links
	 * resolved) to lie inside that directory, typically the module root, so a
	 * mount that is a link to a checkout elsewhere is refused the same way.
	 */
	expect?: { remote: string; branch: string; within?: string | undefined } | undefined;
	recordOf?: (
		path: string,
		collectionRecord: { collection: string; id: string } | null,
	) => { collection: string; id: string } | null;
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
	 * The current facade, for a synchronous read. Throws `mount_unavailable`
	 * while the checkout cannot be opened; it is tried again on the next call.
	 * Prefer {@link SyncHost.read}: an error this facade meets later is not seen
	 * by the host, so it is only dropped by the next `read`, `run` or check.
	 */
	db(): RepositoryDb;
	/**
	 * Run a read against the checkout, without waiting for the mutation queue.
	 * A read that finds the checkout no longer what was opened (moved, a changed
	 * boundary in its configuration) drops the facade, so the next call opens it
	 * again. Reads must not write; writes go through {@link SyncHost.run}.
	 */
	read<T>(operation: (db: RepositoryDb) => T | Promise<T>): Promise<T>;
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
/** Deadline of the background fetch, which runs in the mutation queue. */
const FETCH_TIMEOUT_MS = 20_000;

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

/** Errors meaning "the checkout is not (or no longer) what was opened": open it again next time. */
function isMountGone(error: unknown): boolean {
	return (
		error instanceof RepositoryDbError &&
		(error.code === "boundary_violation" ||
			error.code === "config_missing" ||
			error.code === "config_changed" ||
			error.code === "empty_repository")
	);
}

/** The Collection layout: `<data>/<collection>/<encodeURIComponent(id)>.yaml`. */
function collectionRecordOf(dataDir: string, entry: string): { collection: string; id: string } | null {
	const prefix = `${dataDir}/`;
	if (!entry.startsWith(prefix) || !entry.endsWith(".yaml")) return null;
	const segments = entry.slice(prefix.length).split("/");
	if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
	try {
		return { collection: segments[0], id: decodeURIComponent(segments[1].slice(0, -".yaml".length)) };
	} catch {
		return null;
	}
}

function recordRefs(
	db: RepositoryDb,
	paths: readonly string[],
	recordOf: SyncHostOptions["recordOf"],
	onError: (error: unknown) => void,
): SyncHostRecordRef[] {
	const refs: SyncHostRecordRef[] = [];
	for (const entry of [...paths].sort()) {
		const collectionRecord = collectionRecordOf(db.config.layout.data, entry);
		let record = collectionRecord;
		if (recordOf) {
			// The app's mapping is its own: a throw falls back to the Collection
			// answer and is reported; it never fails the mutation that pulled.
			try {
				record = recordOf(entry, collectionRecord);
			} catch (error) {
				onError(error);
			}
		}
		if (record) refs.push({ collection: record.collection, id: record.id, path: entry });
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

	const configPath = path.join(mountRoot, CONFIG_FILE_NAME);
	/**
	 * Files whose change can change what the checkout is: its configuration,
	 * Git's config (remotes; in the common dir for a worktree) and HEAD (the
	 * branch; per worktree). Resolved when the facade is opened.
	 */
	let identityFiles: string[] = [configPath];
	/** Their stats when the facade was last validated. */
	let configStat = "";

	function resolveIdentityFiles(): string[] {
		const gitDir = runGit(mountRoot, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
		const commonDir = runGit(mountRoot, ["rev-parse", "--git-common-dir"]).stdout.trim();
		if (!gitDir || !commonDir) return [configPath];
		return [
			configPath,
			path.join(path.resolve(mountRoot, commonDir), "config"),
			path.join(gitDir, "HEAD"),
		];
	}

	/** The checkout's real path lies inside `expect.within`, links resolved. */
	function assertWithin(): void {
		const within = options.expect?.within;
		if (within === undefined) return;
		let real: string;
		let root: string;
		try {
			real = realpathSync(mountRoot);
			root = realpathSync(within);
		} catch {
			throw new RepositoryDbError(
				"mount_unavailable",
				`The data checkout ${mountRoot} is not available.`,
			);
		}
		const relative = path.relative(root, real);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
		throw new BoundaryViolationError(
			`The data checkout ${mountRoot} resolves to ${real}, outside ${within}. Nothing was read, fetched or pulled.`,
		);
	}

	function assertExpected(config: RepositoryDb["config"]): void {
		const expected = options.expect;
		if (!expected) return;
		const sameRemote = normalizeRemoteUrl(config.dataRepo.remote) === normalizeRemoteUrl(expected.remote);
		if (sameRemote && config.dataRepo.branch === expected.branch) return;
		throw new BoundaryViolationError(
			`This app serves ${expected.remote}#${expected.branch}, but the data checkout ${mountRoot} is ${config.dataRepo.remote}#${config.dataRepo.branch}. Nothing was read, fetched or pulled.`,
		);
	}

	function statKey(): string {
		// The configuration must exist (statSync throws otherwise); a missing Git
		// file is part of the key, so its disappearance triggers the full check.
		return identityFiles
			.map((file, index) => {
				try {
					const stats = statSync(file);
					return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
				} catch (error) {
					if (index === 0) throw error;
					return "missing";
				}
			})
			.join("|");
	}

	/**
	 * Is the open facade still the checkout it was opened as? The mount and its
	 * configuration must exist. When the configuration, Git's config or HEAD
	 * changed, the configuration is re-read through the facade (a boundary
	 * change is `config_changed`) and the full boundary guard runs again: the
	 * mount is the repo root, `origin` and the branch match (`boundary_violation`).
	 */
	function verifyLive(db: RepositoryDb): void {
		// Cheap and checked every time: a swapped link must never be followed,
		// whatever the configuration's stat says.
		assertWithin();
		let key: string;
		try {
			key = statKey();
		} catch {
			throw new RepositoryDbError(
				"mount_unavailable",
				`The data checkout ${mountRoot} is not available: ${CONFIG_FILE_NAME} is gone.`,
			);
		}
		if (key === configStat) return;
		const config = db.config;
		assertDataRepoBoundary(mountRoot, config);
		assertExpected(config);
		configStat = key;
	}

	function reportOpenError(problem: SyncHostProblem): void {
		const key = `${problem.code}\0${problem.message}`;
		if (key !== lastOpenError) {
			lastOpenError = key;
			emit({ type: "error", operation: "open", error: problem });
		}
	}

	function open(): RepositoryDb {
		if (facade) {
			try {
				verifyLive(facade);
				return facade;
			} catch (error) {
				facade = undefined;
				configStat = "";
				identityFiles = [configPath];
				reportOpenError(problemOf(error));
				throw error;
			}
		}
		let opened: RepositoryDb;
		try {
			assertWithin();
			opened = RepositoryDb.open(mountRoot);
			assertExpected(opened.config);
			identityFiles = resolveIdentityFiles();
			configStat = statKey();
		} catch (error) {
			const problem = problemOf(error);
			reportOpenError(problem);
			// A checkout that is there but is not this app's data is a typed
			// refusal; anything else means the data is not available yet.
			if (error instanceof BoundaryViolationError) throw error;
			throw new RepositoryDbError(
				"mount_unavailable",
				`The data checkout ${mountRoot} is not available yet: ${problem.message}`,
			);
		}
		facade = opened;
		lastOpenError = "";
		return opened;
	}

	/** Where the checkout stood before a mutation, to tell afterwards what came in. */
	function positionOf(db: RepositoryDb): { head: string | undefined; clean: boolean } {
		const head = gitHeadCommit(db.mountRoot);
		const dirty = gitDirtyPaths(db.mountRoot).filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`));
		const { ahead } = gitAheadBehind(db.mountRoot, db.config.dataRepo.branch);
		return { head, clean: dirty.length === 0 && ahead === 0 };
	}

	/**
	 * Colleagues' paths a mutation brought in: what the facade's own publish,
	 * finish-send or pull recorded (whatever the callback returned), together
	 * with the `remoteChanges` of a result the callback did return (a mutation
	 * through another facade); failing both, when the checkout held no local
	 * work and moved forward, everything between the two heads.
	 */
	function incomingSince(
		db: RepositoryDb,
		before: { head: string | undefined; clean: boolean },
		result: unknown,
	): string[] {
		const returned = (result as { remoteChanges?: unknown } | undefined)?.remoteChanges;
		const recorded = [
			...new Set([
				...takeIncomingChanges(db),
				...(Array.isArray(returned) ? returned.filter((entry): entry is string => typeof entry === "string") : []),
			]),
		];
		if (recorded.length > 0) return recorded;
		const after = gitHeadCommit(db.mountRoot);
		if (!before.clean || !before.head || !after || after === before.head) return [];
		if (runGit(db.mountRoot, ["merge-base", "--is-ancestor", before.head, after]).status !== 0) return [];
		return gitChangedPaths(db.mountRoot, [before.head, after]);
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
			// A refused pull stays reported only while the draft still changes
			// one of the records that stood in the way (or Git itself refused).
			if (
				sync.behind === 0 ||
				(pullBlocked &&
					pullBlocked.paths.length > 0 &&
					!pullBlocked.paths.some((entry) => sync.dirtyPaths.includes(entry)))
			) {
				pullBlocked = null;
			}
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
			records: recordRefs(db, paths, options.recordOf, (error) =>
				emit({ type: "error", operation: "recordOf", error: problemOf(error) }),
			),
			status,
		});
	}

	async function read<T>(operation: (db: RepositoryDb) => T | Promise<T>): Promise<T> {
		const db = open();
		try {
			return await operation(db);
		} catch (error) {
			if (isMountGone(error)) {
				facade = undefined;
				publishStatus();
			}
			throw error;
		}
	}

	function run<T>(kind: string, operation: (db: RepositoryDb) => T | Promise<T>): Promise<T> {
		return enqueue(mountRoot, async () => {
			const db = open();
			takeIncomingChanges(db);
			const before = positionOf(db);
			let result: T;
			try {
				result = await operation(db);
			} catch (error) {
				forgetIfGone(error);
				if (error instanceof PullBlockedError) {
					pullBlocked = { paths: error.paths, message: error.message };
				}
				const status = publishStatus();
				// A callback can fail after its pull or send already moved the
				// checkout; the records that came in are still announced.
				announceIncoming(db, safeIncoming(db, before, undefined), status);
				throw error;
			}
			if (kind === "pull" && (result as PullResult | undefined)?.state === "pulled") pullBlocked = null;
			const status = publishStatus();
			announceIncoming(db, safeIncoming(db, before, result), status);
			return result;
		});
	}

	function safeIncoming(
		db: RepositoryDb,
		before: { head: string | undefined; clean: boolean },
		result: unknown,
	): string[] {
		try {
			return incomingSince(db, before, result);
		} catch {
			return [];
		}
	}

	async function check(): Promise<SyncHostStatus> {
		let db: RepositoryDb;
		try {
			db = open();
		} catch {
			return publishStatus();
		}
		// In the queue: a fetch running beside a publish's own fetch or push can
		// collide on Git's ref locks. A short deadline keeps a hung network from
		// holding writes back for long.
		return enqueue(mountRoot, async () => {
			// Again inside the queue, right before the network: the checkout may
			// have been pointed elsewhere while this check waited for its turn.
			try {
				db = open();
			} catch {
				return publishStatus();
			}
			try {
				await gitFetchAsync(db.mountRoot, FETCH_TIMEOUT_MS);
				fetchError = null;
			} catch (error) {
				forgetIfGone(error);
				fetchError = problemOf(error);
			}
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
			if (pulled?.state === "pulled") announceIncoming(db, takeIncomingChanges(db), status);
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
		read,
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
