import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { MaterializeFailedError, RepositoryDbError, TrackedDerivedOutputError } from "../src/types.ts";
import {
	DERIVED_FILE,
	DERIVED_PATH,
	type FixtureRepo,
	cloneFixture,
	createDerivedFixture,
	git,
	writeFixtureDocument,
} from "./fixtures.ts";

/**
 * The contract of DEV-6664: derived output is an ignored cache, so it never
 * makes two people collide; validation runs in the live checkout, also after
 * integrating a colleague's work; a real overlap on one record is merged or
 * has a way out that keeps the rest of the draft.
 */

const fixtures: FixtureRepo[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

function setup(): { fixture: FixtureRepo; a: string; b: string } {
	const fixture = createDerivedFixture();
	fixtures.push(fixture);
	return { fixture, a: fixture.mountPath, b: cloneFixture(fixture, "b") };
}

const PUBLISH = { actor: "Tester <tester@example.test>", source: "contract-test" };

function publishAll(db: RepositoryDb) {
	return db.publish({ ...PUBLISH, expectedRevision: db.draftRevision() });
}

function derived(mountPath: string): string {
	return readFileSync(path.join(mountPath, DERIVED_FILE), "utf8");
}

function remoteFiles(fixture: FixtureRepo): string[] {
	return git(fixture.originPath, ["ls-tree", "-r", "--name-only", fixture.branch]).split("\n").filter(Boolean);
}

function staged(mountPath: string): string {
	return git(mountPath, ["diff", "--cached", "--name-only"]).trim();
}

async function errorOf(run: () => Promise<unknown>): Promise<RepositoryDbError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof RepositoryDbError) return error;
		throw error;
	}
	throw new Error("expected the operation to be refused");
}

describe("derived output never makes two people collide", () => {
	test("two clones change disjoint records: both publish and both caches equal a fresh build", async () => {
		const { fixture, a, b } = setup();
		const dbA = RepositoryDb.open(a);
		const dbB = RepositoryDb.open(b);
		writeFixtureDocument(a, "r1", { code: "A" });
		writeFixtureDocument(b, "r2", { code: "B" });
		// Each side has built its own derived view of its own draft.
		await dbA.ensureGenerated();
		await dbB.ensureGenerated();

		expect((await publishAll(dbA)).state).toBe("published");
		const second = await publishAll(dbB);
		expect(second.state).toBe("published");
		expect(second.remoteChanges).toContain("data/things/r1.yaml");

		expect((await dbA.pull()).state).toBe("pulled");
		await dbA.ensureGenerated();
		await dbB.ensureGenerated();
		const fresh = cloneFixture(fixture, "fresh");
		await RepositoryDb.open(fresh).ensureGenerated();
		expect(derived(fresh)).toBe("r1.yaml\nr2.yaml\n");
		expect(derived(a)).toBe(derived(fresh));
		expect(derived(b)).toBe(derived(fresh));

		// Nothing derived is tracked anywhere, and nothing is left as a draft.
		expect(remoteFiles(fixture).some((entry) => entry.startsWith("generated/"))).toBe(false);
		expect(dbA.status().dirtyPaths).toEqual([]);
		expect(dbB.status().dirtyPaths).toEqual([]);
	});

	test("a pull under a draft of another record keeps the draft; derived output is rebuilt on its next read", async () => {
		const { a, b } = setup();
		const dbA = RepositoryDb.open(a);
		const dbB = RepositoryDb.open(b);
		writeFixtureDocument(b, "r3", { code: "C" });
		const drafted = readFileSync(path.join(b, "data/things/r3.yaml"), "utf8");
		await dbB.ensureGenerated();
		expect(derived(b)).toBe("r3.yaml\n");

		writeFixtureDocument(a, "r4", { code: "D" });
		await publishAll(dbA);

		const pulled = await dbB.pull();
		expect(pulled.state).toBe("pulled");
		expect(pulled.remoteChanges).toEqual(["data/things/r4.yaml"]);
		expect(dbB.status().dirtyPaths).toEqual(["data/things/r3.yaml"]);
		expect(readFileSync(path.join(b, "data/things/r3.yaml"), "utf8")).toBe(drafted);

		const rebuilt = await dbB.ensureGenerated();
		expect(rebuilt.rebuilt).toBe(true);
		expect(derived(b)).toBe("r3.yaml\nr4.yaml\n");
		expect((await dbB.ensureGenerated()).rebuilt).toBe(false);
	});
});

describe("the same record changed in two clones", () => {
	async function sharedRecord() {
		const { fixture, a, b } = setup();
		const dbA = RepositoryDb.open(a);
		writeFixtureDocument(a, "shared", { code: "S", x: 1, y: 1 });
		await publishAll(dbA);
		const dbB = RepositoryDb.open(b);
		await dbB.pull();
		return { fixture, a, b, dbA, dbB };
	}

	test("a semantically mergeable edit publishes on both sides", async () => {
		const { a, b, dbA, dbB } = await sharedRecord();
		writeFixtureDocument(a, "shared", { code: "S", x: 2, y: 1 });
		writeFixtureDocument(b, "shared", { code: "S", x: 1, y: 2 });
		await publishAll(dbA);
		expect((await publishAll(dbB)).state).toBe("published");
		await dbA.pull();
		expect(readFileSync(path.join(a, "data/things/shared.yaml"), "utf8")).toContain("x: 2");
		expect(readFileSync(path.join(a, "data/things/shared.yaml"), "utf8")).toContain("y: 2");
	});

	test("a competing edit is a typed conflict; reverting that record, pulling and redoing it keeps the rest of the draft", async () => {
		const { fixture, a, b, dbA, dbB } = await sharedRecord();
		writeFixtureDocument(a, "shared", { code: "S", x: 2, y: 1 });
		await publishAll(dbA);
		writeFixtureDocument(b, "shared", { code: "S", x: 3, y: 1 });
		writeFixtureDocument(b, "other", { code: "O" });

		const refused = await errorOf(() => publishAll(dbB));
		expect(refused.code).toBe("publish_conflict");
		const conflict = dbB.conflict();
		expect(conflict?.kind).toBe("merge");
		expect(conflict?.paths).toEqual(["data/things/shared.yaml"]);

		// The way out, one record at a time.
		dbB.abortConflict();
		expect(dbB.status().dirtyPaths.sort()).toEqual(["data/things/other.yaml", "data/things/shared.yaml"]);
		expect(dbB.canRevertRecord("data/things/shared.yaml")).toEqual({ supported: true });
		dbB.discard({
			scope: { kind: "record", path: "data/things/shared.yaml" },
			expectedRevision: dbB.draftRevision(),
		});
		expect((await dbB.pull()).state).toBe("pulled");
		expect(dbB.status().dirtyPaths).toEqual(["data/things/other.yaml"]);
		writeFixtureDocument(b, "shared", { code: "S", x: 3, y: 1 });
		expect((await publishAll(dbB)).state).toBe("published");

		const files = remoteFiles(fixture);
		expect(files).toContain("data/things/other.yaml");
		expect(git(fixture.originPath, ["show", `${fixture.branch}:data/things/shared.yaml`])).toContain("x: 3");
	});
});

describe("materializers and validators run in the live checkout", () => {
	test("a failing materializer refuses publish with nothing staged and the draft unchanged; a reader gets the typed error", async () => {
		const { fixture, b } = setup();
		const dbB = RepositoryDb.open(b);
		writeFixtureDocument(b, "broken", { code: "X" });
		writeFixtureDocument(b, "fine", { code: "Y" });
		const revision = dbB.draftRevision();
		const remoteBefore = git(fixture.originPath, ["rev-parse", fixture.branch]);

		const refused = await errorOf(() => publishAll(dbB));
		expect(refused).toBeInstanceOf(MaterializeFailedError);
		expect((refused as MaterializeFailedError).entryPath).toBe(DERIVED_PATH);
		expect(staged(b)).toBe("");
		expect(dbB.draftRevision()).toBe(revision);
		expect(dbB.status().state).toBe("draft");
		expect(git(fixture.originPath, ["rev-parse", fixture.branch])).toBe(remoteBefore);

		const read = await errorOf(() => dbB.ensureGenerated());
		expect(read.code).toBe("materialize_failed");
		expect(dbB.draftRevision()).toBe(revision);
	});

	test("an integrated result that fails validation moves the checkout back to the local commit, records a conflict and pushes nothing", async () => {
		const { fixture, a, b } = setup();
		const dbA = RepositoryDb.open(a);
		const dbB = RepositoryDb.open(b);
		writeFixtureDocument(a, "first", { code: "DUP" });
		await publishAll(dbA);
		const remoteAfterA = git(fixture.originPath, ["rev-parse", fixture.branch]).trim();

		// Valid on its own; invalid together with the colleague's record.
		writeFixtureDocument(b, "second", { code: "DUP" });
		const refused = await errorOf(() => publishAll(dbB));
		expect(refused.code).toBe("publish_conflict");

		const head = git(b, ["rev-parse", "HEAD"]).trim();
		const conflict = dbB.conflict();
		expect(conflict?.kind).toBe("validation");
		expect(conflict?.gitState).toBe("integrated result failed validation");
		expect(conflict?.pendingHead).toBe(head);
		expect(conflict?.retryable).toBe(true);
		// The local commit, not the integrated one: its parent is the old base.
		expect(Bun.spawnSync(["git", "-C", b, "merge-base", "--is-ancestor", remoteAfterA, "HEAD"]).exitCode).toBe(1);
		expect(existsSync(path.join(b, "data/things/first.yaml"))).toBe(false);
		expect(dbB.status().dirtyPaths).toEqual([]);
		expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(remoteAfterA);

		// Recovery: once the colleague fixes their record, finishing the send
		// retries the integration and passes.
		writeFixtureDocument(a, "first", { code: "UNIQUE" });
		await publishAll(dbA);
		const sent = await dbB.finishSend({ expectedHead: head });
		expect(sent.state).toBe("published");
		expect(dbB.conflict()).toBeUndefined();
		expect(remoteFiles(fixture)).toContain("data/things/second.yaml");
	});

	test("a retried conflict whose push then fails keeps the checkout on the recorded commit, so the next retry works", async () => {
		const { fixture, a, b } = setup();
		const dbA = RepositoryDb.open(a);
		const dbB = RepositoryDb.open(b);
		writeFixtureDocument(a, "first", { code: "DUP" });
		await publishAll(dbA);
		writeFixtureDocument(b, "second", { code: "DUP" });
		await errorOf(() => publishAll(dbB));
		const pending = dbB.conflict()?.pendingHead as string;

		writeFixtureDocument(a, "first", { code: "UNIQUE" });
		await publishAll(dbA);
		// The integration now validates, but the remote refuses the push.
		const marker = path.join(fixture.root, "reject-push");
		const hook = path.join(fixture.originPath, "hooks", "pre-receive");
		writeFileSync(hook, `#!/bin/sh\nif [ -f '${marker}' ]; then echo refused >&2; exit 1; fi\n`, "utf8");
		chmodSync(hook, 0o755);
		writeFileSync(marker, "", "utf8");

		const refused = await errorOf(() => dbB.finishSend({ expectedHead: pending }));
		expect(refused.code).toBe("publish_push_failed");
		expect(git(b, ["rev-parse", "HEAD"]).trim()).toBe(pending);
		expect(dbB.conflict()?.pendingHead).toBe(pending);
		expect(dbB.status().dirtyPaths).toEqual([]);

		rmSync(marker);
		expect((await dbB.finishSend({ expectedHead: pending })).state).toBe("published");
		expect(dbB.conflict()).toBeUndefined();
	});

	test("a materializer that changes tracked files on the integrated result is undone and recorded, nothing is pushed", async () => {
		const { fixture, a, b } = setup();
		// A materializer that misbehaves only on content a colleague brings in.
		writeFileSync(
			path.join(a, "scripts/materialize.sh"),
			[
				"set -e",
				"if [ -f data/things/trigger.yaml ]; then echo touched > data/things/touched.yaml; fi",
				`mkdir -p ${DERIVED_PATH}`,
				`ls data/things | grep '\\.yaml$' | sort > ${DERIVED_FILE}`,
				"",
			].join("\n"),
			"utf8",
		);
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "materializer with a side effect"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);
		const dbB = RepositoryDb.open(b);
		await dbB.pull();
		writeFixtureDocument(a, "trigger", { code: "T" });
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "colleague record, pushed with plain Git"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);
		const remoteBefore = git(fixture.originPath, ["rev-parse", fixture.branch]).trim();

		writeFixtureDocument(b, "mine", { code: "M" });
		const refused = await errorOf(() => publishAll(dbB));
		expect(refused.code).toBe("publish_conflict");
		expect(dbB.conflict()?.kind).toBe("validation");
		expect(dbB.conflict()?.message).toContain("changed tracked files (data/things/touched.yaml)");
		expect(existsSync(path.join(b, "data/things/touched.yaml"))).toBe(false);
		expect(dbB.status().dirtyPaths).toEqual([]);
		expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(remoteBefore);
	});

	test("a push the remote moved under is integrated again and sent", async () => {
		const { fixture, a, b } = setup();
		const dbB = RepositoryDb.open(b);
		// A colleague's commit is ready; B's pre-push hook publishes it the
		// moment B pushes, so B's first push meets a moved remote.
		writeFixtureDocument(a, "colleague", { code: "C" });
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "colleague"]);
		const marker = path.join(fixture.root, "hook-fired");
		const hook = path.join(b, ".git/hooks/pre-push");
		writeFileSync(
			hook,
			[
				"#!/bin/sh",
				`if [ ! -f '${marker}' ]; then`,
				`  touch '${marker}'`,
				"  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_QUARANTINE_PATH",
				`  git -C '${a}' push -q origin HEAD:${fixture.branch} >/dev/null 2>&1 || exit 1`,
				"fi",
				"exit 0",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(hook, 0o755);

		writeFixtureDocument(b, "mine", { code: "M" });
		const result = await publishAll(dbB);
		expect(existsSync(marker)).toBe(true);
		expect(result.state).toBe("published");
		expect(result.remoteChanges).toContain("data/things/colleague.yaml");
		const files = remoteFiles(fixture);
		expect(files).toContain("data/things/colleague.yaml");
		expect(files).toContain("data/things/mine.yaml");
		expect(dbB.status().state).toBe("published");
	});
});

describe("a data repo that still tracks derived output", () => {
	test("open and publish refuse with the exact migration; after it the checkout works", async () => {
		const { fixture, a } = setup();
		// An older data repo: the derived artifact is committed and not ignored.
		writeFileSync(path.join(a, ".gitignore"), "/.repository-db/\n", "utf8");
		git(a, ["add", ".gitignore"]);
		writeFixtureDocument(a, "r1", { code: "A" });
		expect(Bun.spawnSync(["sh", "scripts/materialize.sh"], { cwd: a }).exitCode).toBe(0);
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "old style: derived output committed"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);
		expect(git(a, ["ls-files", DERIVED_PATH]).trim()).toBe(DERIVED_FILE);

		let refused: unknown;
		try {
			RepositoryDb.open(a);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(TrackedDerivedOutputError);
		const tracked = refused as TrackedDerivedOutputError;
		expect(tracked.code).toBe("derived_output_tracked");
		expect(tracked.paths).toEqual([DERIVED_PATH]);
		expect(tracked.message).toContain(`git rm -r --cached --ignore-unmatch -- ${DERIVED_PATH}`);

		// The migration, exactly as handed out, run as plain shell in the checkout.
		for (const command of tracked.migration) {
			const result = Bun.spawnSync(["sh", "-c", command], { cwd: a });
			expect(result.exitCode).toBe(0);
		}
		const db = RepositoryDb.open(a);
		expect(db.status().state).toBe("published");
		expect(git(a, ["ls-files", DERIVED_PATH]).trim()).toBe("");
		expect(existsSync(path.join(a, DERIVED_FILE))).toBe(true);
	});

	test("runtime files an older engine left tracked are refused with a clean-the-checkout message", async () => {
		const { fixture, a } = setup();
		writeFileSync(path.join(a, ".gitignore"), "/generated/\n", "utf8");
		git(a, ["add", ".gitignore"]);
		mkdirSync(path.join(a, ".repository-db"), { recursive: true });
		writeFileSync(path.join(a, ".repository-db/publish.lock"), "{}\n", "utf8");
		git(a, ["add", "--force", ".repository-db/publish.lock"]);
		git(a, ["commit", "--message", "old engine: lock tracked"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);

		expect(() => RepositoryDb.open(a)).toThrow(/older repository-db/);
	});
});
