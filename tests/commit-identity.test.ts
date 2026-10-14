import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { type FixtureRepo, cloneFixture, createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

const IDENTITY_ENV = [
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"EMAIL",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
] as const;

const publishOptions = (db: RepositoryDb) => ({
	expectedRevision: db.draftRevision(),
	actor: "Test Actor <test@repository-db.test>",
	source: "repository-db-test",
});

function stagedPaths(mountPath: string): string[] {
	return git(mountPath, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
}

/**
 * Take every source of a commit identity away from the engine's git calls, the
 * way a Remote Environment without a configured identity looks. The fixture's
 * `git()` helper does not inherit these runtime env changes, so the test can
 * still arrange the repo with an identity.
 *
 * Git would otherwise guess an address from the user name and the hostname; a
 * Remote Environment's hostname has no domain, so the guess is refused there,
 * but a laptop's `*.local` name passes. `user.useConfigOnly` makes the test
 * behave the same on every machine.
 */
function removeCommitIdentity(fixture: FixtureRepo, mountPath = fixture.mountPath): void {
	git(mountPath, ["config", "--unset", "user.name"]);
	git(mountPath, ["config", "--unset", "user.email"]);
	const globalConfig = path.join(fixture.root, "empty-global.gitconfig");
	writeFileSync(globalConfig, "[user]\n\tuseConfigOnly = true\n", "utf8");
	for (const key of IDENTITY_ENV) delete process.env[key];
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
}

describe("commit identity", () => {
	let saved: Partial<Record<(typeof IDENTITY_ENV)[number], string>> = {};
	let fixture: FixtureRepo;

	beforeEach(() => {
		saved = Object.fromEntries(IDENTITY_ENV.map((key) => [key, process.env[key]]));
		fixture = createFixtureRepo();
	});

	afterEach(() => {
		for (const key of IDENTITY_ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		rmSync(fixture.root, { recursive: true, force: true });
	});

	test("publish without a Git identity refuses before anything is staged", async () => {
		const db = RepositoryDb.open(fixture.mountPath);
		writeFixtureDocument(fixture.mountPath, "thing-1", { name: "first" });
		const revision = db.draftRevision();
		const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
		removeCommitIdentity(fixture);

		const refusal = db.publish(publishOptions(db));
		await expect(refusal).rejects.toMatchObject({ code: "identity_missing" });
		await expect(refusal).rejects.toThrow(/Git name and e-mail/);
		await expect(refusal).rejects.toThrow(/sign in to GitHub in the Launchpad/i);

		expect(stagedPaths(fixture.mountPath)).toEqual([]);
		expect(db.draftRevision()).toBe(revision);
		expect(git(fixture.mountPath, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(db.status().state).toBe("draft");
	});

	test("a commit that fails after staging leaves nothing staged and the draft unchanged", async () => {
		const db = RepositoryDb.open(fixture.mountPath);
		writeFixtureDocument(fixture.mountPath, "thing-1", { name: "first" });
		const revision = db.draftRevision();
		const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
		const hook = path.join(fixture.mountPath, ".git/hooks/pre-commit");
		writeFileSync(hook, "#!/bin/sh\necho 'hook refuses' >&2\nexit 1\n", "utf8");
		chmodSync(hook, 0o755);

		await expect(db.publish(publishOptions(db))).rejects.toThrow(/hook refuses/);

		expect(stagedPaths(fixture.mountPath)).toEqual([]);
		expect(db.draftRevision()).toBe(revision);
		expect(git(fixture.mountPath, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(existsSync(path.join(fixture.mountPath, "data/things/thing-1.yaml"))).toBe(true);
	});

	test("finishing a send without a Git identity refuses instead of recording a conflict", async () => {
		// A colleague's publish makes the send replay the waiting commit, which
		// needs a committer identity.
		const second = cloneFixture(fixture);
		writeFixtureDocument(second, "thing-remote", { name: "remote" });
		git(second, ["add", "--all"]);
		git(second, ["commit", "--message", "remote change"]);
		git(second, ["push", "origin", fixture.branch]);

		const db = RepositoryDb.open(fixture.mountPath);
		writeFixtureDocument(fixture.mountPath, "thing-local", { name: "local" });
		git(fixture.mountPath, ["add", "--all"]);
		git(fixture.mountPath, ["commit", "--message", "waiting to be sent"]);
		const pending = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
		removeCommitIdentity(fixture);

		await expect(db.finishSend({ expectedHead: pending })).rejects.toMatchObject({
			code: "identity_missing",
		});
		expect(existsSync(path.join(fixture.mountPath, ".repository-db/conflict.json"))).toBe(false);
		expect(git(fixture.mountPath, ["rev-parse", "HEAD"]).trim()).toBe(pending);
		expect(db.status().state).toBe("committed_not_pushed");
	});

	test("publish with a Git identity still publishes", async () => {
		const db = RepositoryDb.open(fixture.mountPath);
		writeFixtureDocument(fixture.mountPath, "thing-1", { name: "first" });
		const result = await db.publish(publishOptions(db));
		expect(result.state).toBe("published");
		expect(stagedPaths(fixture.mountPath)).toEqual([]);
		expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(result.commit ?? "");
	});
});
