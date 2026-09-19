import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitFetchAsync } from "../src/git.ts";
import { acquirePublishLock } from "../src/lock.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { atomicTempPath } from "../src/yamlIo.ts";
import { cloneFixture, createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

describe("phase 0: unique atomic temp filename", () => {
	test("atomicTempPath is unique per call so concurrent same-path writes never collide", () => {
		const target = path.join(os.tmpdir(), "phase0", "data.yaml");
		const first = atomicTempPath(target);
		const second = atomicTempPath(target);

		expect(first).not.toBe(second);
		expect(first.startsWith(`${target}.`)).toBe(true);
		expect(first.endsWith(".tmp")).toBe(true);
		// The old implementation keyed the temp name on the pid alone, so two
		// writes to the same path in one process shared one temp file.
		expect(first).not.toBe(`${target}.${process.pid}.tmp`);
	});
});

describe("phase 0: lock-free read-only fetch", () => {
	test("pull with no remote changes does not take the publish lock", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			// Hold the publish lock as if a publish were running elsewhere.
			const release = acquirePublishLock(fixture.mountPath);
			try {
				// Read-only fetch + ahead/behind must run lock-free; with nothing
				// behind there is no integration, so this must not raise
				// PublishLockedError.
				const result = await db.pull();
				expect(result).toEqual({ state: "up_to_date", behind: 0, remoteChanges: [] });
			} finally {
				release();
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("pull still takes the publish lock to integrate when behind > 0", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);

			// Remote moves ahead so the local checkout is behind.
			const second = cloneFixture(fixture, "second-behind");
			writeFixtureDocument(second, "thing-remote", { name: "remote" });
			git(second, ["add", "--all"]);
			git(second, ["commit", "--message", "remote change"]);
			git(second, ["push", "origin", fixture.branch]);

			const release = acquirePublishLock(fixture.mountPath);
			try {
				// Fetch/ahead-behind run lock-free, but integrating remote commits
				// must contend for the held lock.
				await expect(db.pull()).rejects.toThrow(/publish is already running/);
			} finally {
				release();
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("pull integrates an already-fetched remote without network pull under the lock", async () => {
		const fixture = createFixtureRepo();
		const fakeDir = mkdtempSync(path.join(os.tmpdir(), "phase0-pull-no-network-under-lock-"));
		const fakeGit = path.join(fakeDir, "git");
		const logPath = path.join(fakeDir, "git-network.log");
		const realGit = Bun.which("git");
		if (!realGit) throw new Error("git binary not found for fake git wrapper test");
		writeFileSync(
			fakeGit,
			`#!/bin/sh
if [ "$1" = "-C" ] && [ "$2" = "$PHASE0_PULL_ROOT" ]; then
  case "$3" in
    fetch|pull) printf '%s\n' "$3" >> "$PHASE0_PULL_GIT_LOG" ;;
  esac
fi
"$PHASE0_REAL_GIT" "$@"
`,
			{ encoding: "utf8", mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		const previousRealGit = process.env.PHASE0_REAL_GIT;
		const previousPullRoot = process.env.PHASE0_PULL_ROOT;
		const previousPullLog = process.env.PHASE0_PULL_GIT_LOG;
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const second = cloneFixture(fixture, "second-no-pull-under-lock");
			writeFixtureDocument(second, "thing-remote", { name: "remote" });
			git(second, ["add", "--all"]);
			git(second, ["commit", "--message", "remote change"]);
			git(second, ["push", "origin", fixture.branch]);

			process.env.PATH = `${fakeDir}${path.delimiter}${previousPath ?? ""}`;
			process.env.PHASE0_REAL_GIT = realGit;
			process.env.PHASE0_PULL_ROOT = fixture.mountPath;
			process.env.PHASE0_PULL_GIT_LOG = logPath;

			const result = await db.pull();
			expect(result).toEqual({
				state: "pulled",
				behind: 1,
				remoteChanges: ["data/things/thing-remote.yaml"],
			});
			const networkOps = readFileSync(logPath, "utf8").trim().split(/\n+/).filter(Boolean);
			expect(networkOps).toEqual(["fetch"]);
		} finally {
			process.env.PATH = previousPath;
			process.env.PHASE0_REAL_GIT = previousRealGit;
			process.env.PHASE0_PULL_ROOT = previousPullRoot;
			process.env.PHASE0_PULL_GIT_LOG = previousPullLog;
			rmSync(fakeDir, { recursive: true, force: true });
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("pull re-checks conflict state after lock-free fetch before integrating", async () => {
		const fixture = createFixtureRepo();
		const fakeDir = mkdtempSync(path.join(os.tmpdir(), "phase0-fetch-conflict-git-"));
		const fakeGit = path.join(fakeDir, "git");
		const realGit = Bun.which("git");
		if (!realGit) throw new Error("git binary not found for fake git wrapper test");
		writeFileSync(
			fakeGit,
			`#!/bin/sh
"$PHASE0_REAL_GIT" "$@"
status=$?
if [ "$status" -eq 0 ] && [ "$1" = "-C" ] && [ "$2" = "$PHASE0_CONFLICT_AFTER_FETCH_ROOT" ] && [ "$3" = "fetch" ]; then
  mkdir -p "$2/.repository-db"
  cat > "$2/.repository-db/conflict.json" <<'JSON'
{
  "schemaVersion": "repository-db.conflict.v1",
  "detectedAt": "test",
  "operation": "test:fetch-race",
  "gitState": "injected by test after fetch",
  "message": "injected conflict after lock-free fetch",
  "handoff": "test handoff"
}
JSON
fi
exit "$status"
`,
			{ encoding: "utf8", mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		const previousRealGit = process.env.PHASE0_REAL_GIT;
		const previousConflictRoot = process.env.PHASE0_CONFLICT_AFTER_FETCH_ROOT;
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const second = cloneFixture(fixture, "second-conflict-after-fetch");
			writeFixtureDocument(second, "thing-remote", { name: "remote" });
			git(second, ["add", "--all"]);
			git(second, ["commit", "--message", "remote change"]);
			git(second, ["push", "origin", fixture.branch]);

			process.env.PATH = `${fakeDir}${path.delimiter}${previousPath ?? ""}`;
			process.env.PHASE0_REAL_GIT = realGit;
			process.env.PHASE0_CONFLICT_AFTER_FETCH_ROOT = fixture.mountPath;

			await expect(db.pull()).rejects.toThrow(/injected conflict after lock-free fetch/);
		} finally {
			process.env.PATH = previousPath;
			process.env.PHASE0_REAL_GIT = previousRealGit;
			process.env.PHASE0_CONFLICT_AFTER_FETCH_ROOT = previousConflictRoot;
			rmSync(fakeDir, { recursive: true, force: true });
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("phase 0: async network git with timeout", () => {
	test("a slow network git op rejects promptly with git_timeout", async () => {
		const fakeDir = mkdtempSync(path.join(os.tmpdir(), "phase0-fake-git-"));
		// A fake git that hangs longer than the timeout. The runner must reject at
		// the deadline (and kill the git process) rather than wait for the close
		// callback, which an orphaned child holding the pipe would otherwise delay.
		const fakeGit = path.join(fakeDir, "fake-git");
		writeFileSync(fakeGit, "#!/bin/sh\nsleep 3\n", { encoding: "utf8", mode: 0o755 });
		try {
			const started = performance.now();
			let code: string | undefined;
			let message = "";
			try {
				// Inject the fake git directly — no global process.env.PATH
				// mutation, so this test can never contaminate sibling tests.
				await gitFetchAsync(fakeDir, 150, { gitBin: fakeGit });
				throw new Error("expected gitFetchAsync to time out");
			} catch (error) {
				code = (error as { code?: string }).code;
				message = String((error as Error).message);
			}
			const elapsed = performance.now() - started;
			expect(code).toBe("git_timeout");
			expect(message).toMatch(/timed out after 150ms/);
			// The deadline must actually interrupt: reject well below the fake
			// git's 3s hang, proving it does not wait for the close callback.
			expect(elapsed).toBeLessThan(1500);
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});
});
