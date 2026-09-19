import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PublishLockedError, RepositoryDbError } from "./types.ts";

export const ENGINE_DIR = ".repository-db";
const LOCK_FILE = "publish.lock";

/**
 * A lock from another host older than this is considered stale: that host's
 * process cannot be checked from here. Never applied to a local lock.
 */
const STALE_LOCK_MS = 15 * 60 * 1000;

interface LockPayload {
	pid: number;
	hostname: string;
	acquiredAt: string;
	/**
	 * Identity of this acquisition. pid + hostname are not enough once the lock
	 * doubles as the write gate: a stale-reclaimed lock and its successor can
	 * share both, and releasing by pid would remove the successor's lock.
	 */
	token?: string;
	/**
	 * The OS record of when the holding process started. Same for every thread
	 * and module copy in one process, different for a new process that got the
	 * same pid — which is what tells "our own live lock" from "a predecessor".
	 */
	processStart?: string;
}

function lockPath(mountRoot: string): string {
	return path.join(mountRoot, ENGINE_DIR, LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLock(filePath: string): LockPayload | undefined {
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as LockPayload;
	} catch {
		return undefined;
	}
}

/**
 * The operating system's record of when this process started.
 *
 * Read from the OS on purpose: it is the same value from every thread and every
 * copy of this module in one process, and different for a new process that was
 * handed the same pid. (`process.uptime()` is not usable here — in a Bun worker
 * it counts from the worker's start, not the process's.) Undefined where the
 * platform offers no cheap reading; the caller then errs toward "live".
 */
let cachedProcessStart: string | undefined | null = null;
function ownProcessStart(): string | undefined {
	if (cachedProcessStart !== null) return cachedProcessStart;
	cachedProcessStart = undefined;
	try {
		if (process.platform === "linux") {
			// Field 22 of /proc/self/stat, counted after the parenthesised name,
			// which may itself contain spaces.
			const stat = readFileSync("/proc/self/stat", "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			cachedProcessStart = fields[19] ? `linux:${fields[19]}` : undefined;
		} else if (process.platform === "darwin") {
			const result = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
				encoding: "utf8",
			});
			const text = result.stdout?.trim();
			cachedProcessStart = result.status === 0 && text ? `darwin:${text}` : undefined;
		}
	} catch {
		cachedProcessStart = undefined;
	}
	return cachedProcessStart;
}

/** An unreadable lock newer than this may still be being written by its creator. */
const UNREADABLE_LOCK_GRACE_MS = 5_000;

/**
 * Is a lock written on this machine abandoned?
 *
 * Liveness is the test, never age: a running holder keeps the gate however long
 * its publish takes. One case needs care — a lock carrying *this* process's pid.
 * It is ours (from any thread or module copy) if it records our start time, and
 * a predecessor's if it does not: a process that crashed and whose pid was
 * handed out again, the usual shape of a container restarting under the same
 * hostname. Treating that as live would block every write for good.
 */
function isLocalLockAbandoned(lock: LockPayload): boolean {
	if (lock.pid === process.pid) {
		// A lock from an older engine version records no process start. It can
		// only have been left by a predecessor that ran that version — a live
		// sibling would be running this one — so the previous age rule applies,
		// and an upgrade after a crash does not leave the gate shut for good.
		if (lock.processStart === undefined) {
			const age = Date.now() - Date.parse(lock.acquiredAt);
			return Number.isFinite(age) && age > STALE_LOCK_MS;
		}
		const ours = ownProcessStart();
		// Without a reading we cannot tell a predecessor from a sibling thread,
		// so the lock is kept: a wrongly kept lock is recoverable by hand, a
		// wrongly taken one silently opens the gate.
		if (!ours || lock.processStart === "unavailable") return false;
		return lock.processStart !== ours;
	}
	return !isProcessAlive(lock.pid);
}

/**
 * Remove a lock judged abandoned — but only if it is still that lock.
 *
 * Two acquirers can judge the same stale file at once. Without this check the
 * slower one deletes the fresh lock the faster one has just created, and both
 * believe they hold the gate. Re-reading right before removal narrows that to
 * the instant between the read and the unlink; the `wx` create that follows
 * still admits only one of them.
 */
function removeIfUnchanged(filePath: string, judged: LockPayload | undefined): void {
	const current = existsSync(filePath) ? readLock(filePath) : undefined;
	// Compared whole, not by token: locks from older engine versions have none.
	// `undefined` on both sides means "still unreadable", which is what was judged.
	if (JSON.stringify(current) !== JSON.stringify(judged)) return;
	rmSync(filePath, { force: true });
}

/**
 * Acquire the publish mutual-exclusion lock. Throws {@link PublishLockedError}
 * when another live publish holds it. Returns a release function.
 */
export function acquirePublishLock(mountRoot: string): () => void {
	const filePath = lockPath(mountRoot);
	mkdirSync(path.dirname(filePath), { recursive: true });

	const existing = existsSync(filePath) ? readLock(filePath) : undefined;
	if (!existing && existsSync(filePath)) {
		// Unreadable: empty (a crash between creating and writing it) or corrupt.
		// Give a creator that is writing it right now a moment, then reclaim —
		// otherwise it would block every write through the gate forever.
		let modifiedAt = 0;
		try {
			modifiedAt = statSync(filePath).mtimeMs;
		} catch {
			/* vanished meanwhile */
		}
		if (Date.now() - modifiedAt < UNREADABLE_LOCK_GRACE_MS) {
			throw new PublishLockedError(
				`publish lock at ${filePath} is being written; try again in a moment`,
			);
		}
		removeIfUnchanged(filePath, undefined);
	}
	if (existing) {
		const sameHost = existing.hostname === os.hostname();
		const age = Date.now() - Date.parse(existing.acquiredAt);
		// On this machine liveness is provable, so it is the only test: a lock
		// held by a process that is still running is never taken over, however
		// old it is. Taking it by age would open the shared write gate in the
		// middle of a long publish. Age decides only for a lock from another
		// host, whose process cannot be checked from here.
		const stale = sameHost
			? isLocalLockAbandoned(existing)
			: Number.isFinite(age) && age > STALE_LOCK_MS;
		if (!stale) {
			throw new PublishLockedError(
				`publish is already running (pid ${existing.pid} on ${existing.hostname}, since ${existing.acquiredAt}); ` +
					`remove ${filePath} only if you are sure that process is gone`,
			);
		}
		removeIfUnchanged(filePath, existing);
	}

	const payload: LockPayload = {
		pid: process.pid,
		hostname: os.hostname(),
		acquiredAt: new Date().toISOString(),
		token: randomUUID(),
		// "unavailable" rather than absent: an absent field means a lock from an
		// older engine version, which is handled differently below.
		processStart: ownProcessStart() ?? "unavailable",
	};
	// "wx" fails when someone else recreated the lock between check and write.
	try {
		writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
	} catch {
		throw new PublishLockedError(
			`publish lock appeared concurrently at ${filePath}; another publish is starting`,
		);
	}

	return () => {
		const current = readLock(filePath);
		if (current?.token === payload.token) {
			rmSync(filePath, { force: true });
		}
	};
}

/**
 * The shared gate every supported writer passes through.
 *
 * This is the same lock publish and discard hold — not a second mechanism. It
 * is what makes "the draft I confirmed is the draft I published" true for
 * writes the engine knows about: a `Collection` write or a CLI write cannot
 * land inside a publish's validate-integrate-stage window, or between a
 * discard's revision check and its cleanup.
 *
 * It fails immediately rather than waiting. Waiting would be worse than
 * useless: a host app runs publish in the same single-threaded process, so a
 * synchronous wait would block the very event loop that has to finish the
 * publish and release the lock — the write would stall the server and then fail
 * anyway. A caller that wants to retry can do so where it can actually await.
 *
 * The contract is deliberately narrow. A process that writes the data checkout
 * directly, without this gate, is not held back by it; for those, the content
 * check before staging is the backstop that makes publish refuse rather than
 * quietly include the write.
 */
export function withDraftWriteLock<T>(mountRoot: string, write: () => T): T {
	let release: () => void;
	try {
		release = acquirePublishLock(mountRoot);
	} catch (error) {
		if (error instanceof PublishLockedError) {
			throw new RepositoryDbError(
				"draft_write_blocked",
				"A publish or discard is in progress on this data checkout; the write was not applied. Try again in a moment.",
			);
		}
		throw error;
	}
	try {
		return write();
	} finally {
		release();
	}
}

/** Exposed for tests that write a lock "as another copy of this module" would. */
export function ownProcessStartForTests(): string | undefined {
	return ownProcessStart();
}

/** Exposed for the test that simulates two acquirers judging one stale lock. */
export function removeIfUnchangedForTests(filePath: string, judged: unknown): void {
	removeIfUnchanged(filePath, judged as LockPayload | undefined);
}
