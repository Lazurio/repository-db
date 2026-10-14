import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE_NAME } from "../src/config.ts";
import { checkCredentials, clearCredentialCache } from "../src/credentials.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { toStableYaml } from "../src/yamlIo.ts";
import { type FixtureRepo, createFixtureRepo, fixtureConfigValue, git, writeFixtureDocument } from "./fixtures.ts";

/**
 * Preflight gaps found by consumer conversions: an identity Git only guessed,
 * a data repository without a first commit, and an SSH key the agent does not
 * hold.
 */

const ENV_KEYS = [
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"EMAIL",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_SSH_COMMAND",
	"SSH_AUTH_SOCK",
	"FAKE_SSH_BARE",
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
const roots: string[] = [];
beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	clearCredentialCache();
});
afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	clearCredentialCache();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): FixtureRepo {
	const repo = createFixtureRepo();
	roots.push(repo.root);
	return repo;
}

describe("an identity Git would only guess does not count", () => {
	test("no configured name or e-mail: publish refuses although `git var` alone would invent one", async () => {
		const repo = fixture();
		const db = RepositoryDb.open(repo.mountPath);
		writeFixtureDocument(repo.mountPath, "thing-1", { name: "first" });
		git(repo.mountPath, ["config", "--unset", "user.name"]);
		git(repo.mountPath, ["config", "--unset", "user.email"]);
		const emptyGlobal = path.join(repo.root, "empty.gitconfig");
		writeFileSync(emptyGlobal, "", "utf8");
		for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"] as const) {
			delete process.env[key];
		}
		process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
		process.env.GIT_CONFIG_NOSYSTEM = "1";

		await expect(
			db.publish({ expectedRevision: db.draftRevision(), source: "preflight-test" }),
		).rejects.toMatchObject({ code: "identity_missing" });
		expect(git(repo.mountPath, ["diff", "--cached", "--name-only"]).trim()).toBe("");
	});
});

describe("a data repository without a first commit", () => {
	test("open refuses with empty_repository, not a Git error", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "rdb-empty-"));
		roots.push(root);
		const origin = path.join(root, "origin.git");
		const mount = path.join(root, "mount");
		git(root, ["init", "--bare", "-b", "v3", origin]);
		git(root, ["init", "-b", "v3", mount]);
		git(mount, ["remote", "add", "origin", origin]);
		writeFileSync(path.join(mount, CONFIG_FILE_NAME), toStableYaml(fixtureConfigValue(origin, "v3")), "utf8");

		expect(() => RepositoryDb.open(mount)).toThrow(expect.objectContaining({ code: "empty_repository" }));
	});
});

describe("an SSH key the agent does not hold", () => {
	function fakeSsh(root: string, bare: string, works: boolean): void {
		const script = path.join(root, "fake-ssh.sh");
		writeFileSync(script, works ? '#!/bin/sh\nexec git-upload-pack "$FAKE_SSH_BARE"\n' : "#!/bin/sh\nexit 255\n", "utf8");
		chmodSync(script, 0o755);
		process.env.GIT_SSH_COMMAND = script;
		process.env.FAKE_SSH_BARE = bare;
		delete process.env.SSH_AUTH_SOCK;
	}

	test("a remote reachable non-interactively passes the preflight", async () => {
		const repo = fixture();
		fakeSsh(repo.root, repo.originPath, true);
		const check = await checkCredentials("ssh://git@example.invalid/example-org/data.git");
		expect(check).toMatchObject({ ok: true, mechanism: "ssh-config" });
	});

	test("an unreachable remote is still refused", async () => {
		const repo = fixture();
		fakeSsh(repo.root, repo.originPath, false);
		const check = await checkCredentials("ssh://git@example.invalid/example-org/data.git");
		expect(check.ok).toBe(false);
	});
});
