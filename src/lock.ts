import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublishLockedError, RepositoryDbError } from "./types.ts";

export const ENGINE_DIR = ".repository-db";
const LOCK_FILE = "publish.lock";

/** Locks older than this are considered stale even if the pid check is inconclusive. */
const STALE_LOCK_MS = 15 * 60 * 1000;

interface LockPayload {
	pid: number;
	hostname: string;
	acquiredAt: string;
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
		const stale =
			(sameHost && !isProcessAlive(existing.pid)) ||
			(Number.isFinite(age) && age > STALE_LOCK_MS);
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
		if (current && current.pid === payload.pid && current.hostname === payload.hostname) {
			rmSync(filePath, { force: true });
		}
	};
}

/** How long a supported write waits for an in-flight publish or discard. */
const WRITE_GATE_WAIT_MS = 10_000;
const WRITE_GATE_POLL_MS = 25;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The shared gate every supported writer passes through.
 *
 * This is the same lock publish and discard hold — not a second mechanism. It
 * is what makes "the draft I confirmed is the draft I published" true for
 * writes the engine knows about: a `Collection` write or a CLI write cannot
 * land inside a publish's integrate-then-stage window, or between a discard's
 * revision check and its cleanup.
 *
 * The contract is deliberately narrow. A process that writes the data checkout
 * directly, without this gate, is not held back by it; for those, the content
 * re-check before staging is the backstop that makes publish refuse rather
 * than quietly include the write.
 *
 * Writes wait briefly rather than failing instantly, because a publish takes
 * seconds and an autosave landing in that window is ordinary, not exceptional.
 */
export function withDraftWriteLock<T>(
	mountRoot: string,
	write: () => T,
	options: { waitMs?: number } = {},
): T {
	const deadline = Date.now() + (options.waitMs ?? WRITE_GATE_WAIT_MS);
	for (;;) {
		let release: (() => void) | undefined;
		try {
			release = acquirePublishLock(mountRoot);
		} catch (error) {
			if (!(error instanceof PublishLockedError) || Date.now() >= deadline) {
				throw new RepositoryDbError(
					"draft_write_blocked",
					"A publish or discard is in progress on this data checkout; the write was not applied. Try again in a moment.",
				);
			}
			sleepSync(WRITE_GATE_POLL_MS);
			continue;
		}
		try {
			return write();
		} finally {
			release();
		}
	}
}
