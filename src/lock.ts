import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Acquire the publish mutual-exclusion lock. Throws {@link PublishLockedError}
 * when another live publish holds it. Returns a release function.
 */
export function acquirePublishLock(mountRoot: string): () => void {
	const filePath = lockPath(mountRoot);
	mkdirSync(path.dirname(filePath), { recursive: true });

	const existing = existsSync(filePath) ? readLock(filePath) : undefined;
	if (existing) {
		const sameHost = existing.hostname === os.hostname();
		const age = Date.now() - Date.parse(existing.acquiredAt);
		// On this machine liveness is provable, so it is the only test: a lock
		// held by a process that is still running is never taken over, however
		// old it is. Taking it by age would open the shared write gate in the
		// middle of a long publish. Age decides only for a lock from another
		// host, whose process cannot be checked from here.
		const stale = sameHost
			? !isProcessAlive(existing.pid)
			: Number.isFinite(age) && age > STALE_LOCK_MS;
		if (!stale) {
			throw new PublishLockedError(
				`publish is already running (pid ${existing.pid} on ${existing.hostname}, since ${existing.acquiredAt}); ` +
					`remove ${filePath} only if you are sure that process is gone`,
			);
		}
		rmSync(filePath, { force: true });
	}

	const payload: LockPayload = {
		pid: process.pid,
		hostname: os.hostname(),
		acquiredAt: new Date().toISOString(),
		token: randomUUID(),
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
