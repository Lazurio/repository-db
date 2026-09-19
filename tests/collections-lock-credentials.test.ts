import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCredentials } from "../src/credentials.ts";
import { acquirePublishLock } from "../src/lock.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { toStableYaml } from "../src/yamlIo.ts";
import {
	createFixtureRepo,
	fakeFailingGh,
	fixtureConfigValue,
	git,
} from "./fixtures.ts";

describe("collections", () => {
	test("put/get/list roundtrip with envelope validation", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const things = db.collection<{ name: string; price?: number }>("things", {
				schemaVersion: "thing.v3",
			});
			things.put("thing a/1", { name: "first", price: 10 });
			things.put("thing-2", { name: "second" });

			expect(things.listIds()).toEqual(["thing a/1", "thing-2"]);
			expect(things.get("thing a/1")?.record.name).toBe("first");
			expect(things.has("thing-404")).toBe(false);
			expect(things.list()).toHaveLength(2);

			// Id is URL-encoded in the filename.
			expect(
				existsSync(
					path.join(
						fixture.mountPath,
						"data/things",
						"thing%20a%2F1.yaml",
					),
				),
			).toBe(true);

			expect(things.remove("thing-2")).toBe(true);
			expect(things.remove("thing-2")).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("parser rejection propagates and nothing is written", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const strict = db.collection<{ name: string }>("things", {
				schemaVersion: "thing.v3",
				parser: {
					parse(value: unknown): { name: string } {
						const record = value as { name?: unknown };
						if (typeof record?.name !== "string") {
							throw new Error("name must be a string");
						}
						return { name: record.name };
					},
				},
			});
			expect(() =>
				strict.put("bad", { name: 42 as unknown as string }),
			).toThrow(/name must be a string/);
			expect(strict.has("bad")).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("schemaVersion mismatch is refused on read", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const filePath = path.join(fixture.mountPath, "data/things/old.yaml");
			mkdirSync(path.dirname(filePath), { recursive: true });
			writeFileSync(
				filePath,
				toStableYaml({ schemaVersion: "thing.v2", id: "old", record: {} }),
				"utf8",
			);
			const things = db.collection("things", { schemaVersion: "thing.v3" });
			expect(() => things.get("old")).toThrow(/schemaVersion "thing.v2"/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("publish lock", () => {
	test("second acquire fails while the lock is held, then succeeds after release", () => {
		const root = path.join(os.tmpdir(), `repository-db-lock-${process.pid}`);
		mkdirSync(root, { recursive: true });
		try {
			const release = acquirePublishLock(root);
			expect(() => acquirePublishLock(root)).toThrow(/publish is already running/);
			release();
			const release2 = acquirePublishLock(root);
			release2();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("stale lock from a dead process is reclaimed", () => {
		const root = path.join(os.tmpdir(), `repository-db-stale-${process.pid}`);
		mkdirSync(path.join(root, ".repository-db"), { recursive: true });
		try {
			writeFileSync(
				path.join(root, ".repository-db", "publish.lock"),
				JSON.stringify({
					pid: 999999999,
					hostname: os.hostname(),
					acquiredAt: new Date(0).toISOString(),
				}),
				"utf8",
			);
			const release = acquirePublishLock(root);
			release();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("credential preflight", () => {
	const savedEnv = { ...process.env };

	afterEach(() => {
		process.env.REPOSITORY_DB_GH_BIN = savedEnv.REPOSITORY_DB_GH_BIN;
		process.env.GIT_CONFIG_GLOBAL = savedEnv.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_SYSTEM = savedEnv.GIT_CONFIG_SYSTEM;
		if (savedEnv.REPOSITORY_DB_GH_BIN === undefined)
			delete process.env.REPOSITORY_DB_GH_BIN;
		if (savedEnv.GIT_CONFIG_GLOBAL === undefined)
			delete process.env.GIT_CONFIG_GLOBAL;
		if (savedEnv.GIT_CONFIG_SYSTEM === undefined)
			delete process.env.GIT_CONFIG_SYSTEM;
	});

	test("non-GitHub HTTPS helper must fill credentials, not merely exist", () => {
		const root = path.join(os.tmpdir(), `repository-db-credentials-${process.pid}`);
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		try {
			const gitConfig = path.join(root, "gitconfig");
			writeFileSync(
				gitConfig,
				'[credential]\n	helper = "!f() { exit 0; }; f"\n',
				"utf8",
			);
			process.env.GIT_CONFIG_GLOBAL = gitConfig;
			process.env.GIT_CONFIG_SYSTEM = "/dev/null";

			const check = checkCredentials("https://gitlab.com/example/private-data.git");

			expect(check.ok).toBe(false);
			expect(check.mechanism).toBe("none");
			expect(check.detail).toMatch(/did not return a non-interactive credential/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("publish fails before any fetch or mutation when gh auth is unavailable", () => {
		const fixture = createFixtureRepo();
		try {
			// Point both config and origin at a GitHub-https remote so a broken
			// ordering would try a real network fetch. The fake git wrapper below
			// proves publish stops at credential preflight before fetch/mutation.
			const configPath = path.join(fixture.mountPath, "repository-db.yaml");
			writeFileSync(
				configPath,
				toStableYaml(
					fixtureConfigValue("https://github.com/Spectoda/fixture-data.git", fixture.branch),
				),
				"utf8",
			);
			git(fixture.mountPath, [
				"remote",
				"set-url",
				"origin",
				"https://github.com/Spectoda/fixture-data.git",
			]);
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "retarget remote"]);

			const headBefore = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			const fakeBinDir = path.join(fixture.root, "fake-bin");
			mkdirSync(fakeBinDir, { recursive: true });
			const gitCallLog = path.join(fixture.root, "git-calls.log");
			const homeDir = path.join(fixture.root, "home");
			const xdgConfigDir = path.join(fixture.root, "xdg-config");
			mkdirSync(homeDir, { recursive: true });
			mkdirSync(xdgConfigDir, { recursive: true });
			const realGit = spawnSync("sh", ["-c", "command -v git"], {
				encoding: "utf8",
			}).stdout.trim();
			expect(realGit.length).toBeGreaterThan(0);
			const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
			writeFileSync(
				path.join(fakeBinDir, "git"),
				[
					"#!/bin/sh",
					`printf '%s\\n' \"$*\" >> ${shellQuote(gitCallLog)}`,
					'if [ "$1" = "config" ] && [ "$2" = "--get" ] && [ "$3" = "credential.helper" ]; then',
					"  exit 1",
					"fi",
					'for arg in "$@"; do',
					'  if [ "$arg" = "fetch" ]; then',
					'    echo "unexpected git fetch before credential preflight" >&2',
					"    exit 42",
					"  fi",
					"done",
					`exec ${shellQuote(realGit)} "$@"`,
					"",
				].join("\n"),
				{ encoding: "utf8", mode: 0o755 },
			);

			const childScript = `
				import { RepositoryDb } from "./src/repositoryDb.ts";
				const db = RepositoryDb.open(process.argv[1]);
				try {
					await db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() });
					console.error("publish unexpectedly succeeded");
					process.exit(10);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.log(message);
					if (!/credential preflight failed/.test(message)) process.exit(11);
				}
			`;
			const publish = spawnSync("bun", ["--eval", childScript, fixture.mountPath], {
				cwd: process.cwd(),
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
					REPOSITORY_DB_GH_BIN: fakeFailingGh(fixture.root),
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					HOME: homeDir,
					XDG_CONFIG_HOME: xdgConfigDir,
					GIT_TERMINAL_PROMPT: "0",
					GCM_INTERACTIVE: "Never",
				},
			});

			expect(`${publish.stdout}${publish.stderr}`).toMatch(/credential preflight failed/);
			expect(publish.status).toBe(0);
			const gitCalls = existsSync(gitCallLog) ? readFileSync(gitCallLog, "utf8") : "";
			expect(gitCalls).not.toMatch(/(^|\s)fetch(\s|$)/);

			// Nothing was committed or modified by the failed preflight.
			const headAfter = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			expect(headAfter).toBe(headBefore);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
