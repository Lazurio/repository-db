import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { RepositoryDbError } from "../src/types.ts";
import { type FixtureRepo, cloneFixture, createDerivedFixture, git, writeFixtureDocument } from "./fixtures.ts";

/**
 * #32: a publish must reach the data repository the configuration names, not
 * wherever Git's push configuration diverts it.
 * #33: a validation conflict keeps the validator's own explanation.
 */

const fixtures: FixtureRepo[] = [];
let savedGlobal: string | undefined;
beforeEach(() => {
	savedGlobal = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
	if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
	for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

const PUBLISH = { actor: "Tester <tester@example.test>", source: "push-target-test" };

function setup() {
	const fixture = createDerivedFixture();
	fixtures.push(fixture);
	const diverted = path.join(fixture.root, "diverted.git");
	git(fixture.root, ["init", "--quiet", "--bare", "--initial-branch", fixture.branch, diverted]);
	return { fixture, a: fixture.mountPath, diverted };
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

const refOf = (repo: string, branch: string) =>
	Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", "--quiet", branch]).stdout.toString().trim();

describe("the boundary guard holds the push destination to data_repo.remote", () => {
	const diversions: Array<[string, (fixture: FixtureRepo, mount: string, diverted: string) => void]> = [
		["remote.origin.pushurl", (_f, mount, diverted) => git(mount, ["config", "remote.origin.pushurl", diverted])],
		["url.<x>.pushInsteadOf", (f, mount, diverted) => git(mount, ["config", `url.${diverted}.pushInsteadOf`, f.originPath])],
		["url.<x>.insteadOf", (f, mount, diverted) => git(mount, ["config", `url.${diverted}.insteadOf`, f.originPath])],
		[
			"a global url.<x>.pushInsteadOf",
			(f, _mount, diverted) => {
				const globalConfig = path.join(f.root, "global.gitconfig");
				writeFileSync(globalConfig, `[url "${diverted}"]\n\tpushInsteadOf = ${f.originPath}\n`, "utf8");
				process.env.GIT_CONFIG_GLOBAL = globalConfig;
			},
		],
	];

	for (const [label, divert] of diversions) {
		test(`${label}: publish is refused with boundary_violation before anything is committed or pushed`, async () => {
			const { fixture, a, diverted } = setup();
			const db = RepositoryDb.open(a);
			writeFixtureDocument(a, "mine", { code: "M" });
			const revision = db.draftRevision();
			const head = git(a, ["rev-parse", "HEAD"]).trim();
			const remoteBefore = refOf(fixture.originPath, fixture.branch);
			divert(fixture, a, diverted);

			const refused = await errorOf(() => db.publish({ ...PUBLISH, expectedRevision: revision }));
			expect(refused.code).toBe("boundary_violation");
			expect(git(a, ["rev-parse", "HEAD"]).trim()).toBe(head);
			expect(db.draftRevision()).toBe(revision);
			expect(refOf(fixture.originPath, fixture.branch)).toBe(remoteBefore);
			expect(refOf(diverted, fixture.branch)).toBe("");
		});
	}

	test("a waiting commit is not sent once the push is diverted", async () => {
		const { fixture, a, diverted } = setup();
		writeFixtureDocument(a, "mine", { code: "M" });
		git(a, ["add", "--all"]);
		git(a, ["commit", "--quiet", "--message", "waiting to be sent"]);
		const head = git(a, ["rev-parse", "HEAD"]).trim();
		git(a, ["config", "remote.origin.pushurl", diverted]);

		const refused = await errorOf(() => RepositoryDb.open(a).finishSend({ expectedHead: head }));
		expect(refused.code).toBe("boundary_violation");
		expect(refOf(diverted, fixture.branch)).toBe("");
	});

	test("an explicit push URL equal to data_repo.remote is fine", async () => {
		const { fixture, a } = setup();
		git(a, ["config", "remote.origin.pushurl", fixture.originPath]);
		const db = RepositoryDb.open(a);
		writeFixtureDocument(a, "mine", { code: "M" });
		expect((await db.publish({ ...PUBLISH, expectedRevision: db.draftRevision() })).state).toBe("published");
	});
});

describe("a validation conflict keeps the validator's explanation", () => {
	test("the integrated result's validator output is in the conflict, bounded, and the handoff names no host path", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const a = fixture.mountPath;
		const b = cloneFixture(fixture, "b");
		// A validator that explains itself at length: 30 lines on stderr.
		writeFileSync(
			path.join(a, "scripts/validate.sh"),
			[
				"set -e",
				"dups=$(cat data/things/*.yaml 2>/dev/null | grep '^  code:' | sort | uniq -d)",
				'if [ -n "$dups" ]; then',
				"  echo 'rule: every code is used once' >&2",
				"  i=1; while [ $i -le 30 ]; do echo \"explanation line $i\" >&2; i=$((i+1)); done",
				"  exit 4",
				"fi",
				"",
			].join("\n"),
			"utf8",
		);
		git(a, ["add", "--all"]);
		git(a, ["commit", "--quiet", "--message", "an explaining validator"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);
		const dbB = RepositoryDb.open(b);
		await dbB.pull();

		const dbA = RepositoryDb.open(a);
		writeFixtureDocument(a, "first", { code: "DUP" });
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });
		writeFixtureDocument(b, "second", { code: "DUP" });
		const refused = await errorOf(() => dbB.publish({ ...PUBLISH, expectedRevision: dbB.draftRevision() }));
		expect(refused.code).toBe("publish_conflict");

		const conflict = dbB.conflict();
		expect(conflict?.kind).toBe("validation");
		expect(conflict?.message).toContain("rule: every code is used once");
		expect(refused.message).toContain("rule: every code is used once");
		expect(conflict?.message).toContain("explanation line 5");
		expect(conflict?.message).not.toContain("explanation line 30");
		expect((conflict?.message ?? "").length).toBeLessThan(6_000);
		for (const hostPath of [b, os.tmpdir(), fs_realTmp()]) {
			expect(conflict?.handoff ?? "").not.toContain(hostPath);
		}
	});

	test("a merge conflict's handoff names no host path either", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const a = fixture.mountPath;
		const dbA = RepositoryDb.open(a);
		writeFixtureDocument(a, "shared", { code: "S", x: 1 });
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });
		const b = cloneFixture(fixture, "b");
		writeFixtureDocument(a, "shared", { code: "S", x: 2 });
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });
		const dbB = RepositoryDb.open(b);
		writeFixtureDocument(b, "shared", { code: "S", x: 3 });
		await errorOf(() => dbB.publish({ ...PUBLISH, expectedRevision: dbB.draftRevision() }));
		const conflict = dbB.conflict();
		expect(conflict?.kind).toBe("merge");
		for (const hostPath of [b, os.tmpdir(), fs_realTmp()]) {
			expect(conflict?.handoff ?? "").not.toContain(hostPath);
			expect(conflict?.gitState ?? "").not.toContain("repository-db-lane-");
		}
	});
});

function fs_realTmp(): string {
	return Bun.spawnSync(["sh", "-c", "cd \"${TMPDIR:-/tmp}\" && pwd -P"]).stdout.toString().trim();
}
