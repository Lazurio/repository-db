import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeDraftRevision } from "../src/draftRevision.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { deriveDraftPanel } from "../src/ui/draftPanelModel.ts";
import { REVIEW_SURFACE_CONTRACT_VERSION } from "../src/types.ts";
import { cloneFixture, createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

/** Regressions for the review threads on PR #12, one per confirmed finding. */

describe("nothing unsent is hidden from review", () => {
	test("without an upstream, committed records are reviewed against the empty tree", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "local-only", { name: "Never pushed" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "local commit"]);
			git(fixture.mountPath, ["update-ref", "-d", `refs/remotes/origin/${fixture.branch}`]);
			const snapshot = await db.review();
			const paths = snapshot.resources.flatMap((resource) =>
				resource.changes.flatMap((change) => change.technicalRefs.map((ref) => ref.path)),
			);
			expect(paths).toContain("data/things/local-only.yaml");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a committed-but-unsent change keeps its recorded origin", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "by-agent", { name: "Agent edit" });
			db.recordOrigin(["data/things/by-agent.yaml"], { kind: "agent", actor: "Henry" });
			git(fixture.mountPath, ["add", "data"]);
			git(fixture.mountPath, ["commit", "--message", "publish that failed to push"]);
			const snapshot = await db.review();
			const change = snapshot.resources[0]?.changes[0];
			expect(change?.technicalRefs[0]?.path).toBe("data/things/by-agent.yaml");
			expect(change?.origin?.kind).toBe("agent");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("an undeclared generated file in an unsent commit blocks publish readiness", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFileSync(path.join(fixture.mountPath, "generated/rogue.json"), "{}\n", "utf8");
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "committed outside publish"]);
			const snapshot = await db.review();
			const policy = snapshot.publishReadiness.references.find(
				(reference) => reference.kind === "generated_policy",
			);
			expect(policy?.blocking).toBe(true);
			expect(policy?.technicalRefs?.map((ref) => ref.path)).toEqual(["generated/rogue.json"]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("the draft revision covers what a commit would take", () => {
	test("a nested repository's checked-out commit is part of the revision", () => {
		const fixture = createFixtureRepo();
		try {
			const nested = path.join(fixture.mountPath, "data/nested");
			mkdirSync(nested, { recursive: true });
			git(fixture.root, ["init", "--quiet", nested]);
			git(nested, ["config", "user.email", "n@n.test"]);
			git(nested, ["config", "user.name", "Nested"]);
			writeFileSync(path.join(nested, "a.txt"), "one\n", "utf8");
			git(nested, ["add", "--all"]);
			git(nested, ["commit", "--quiet", "--message", "one"]);
			const first = computeDraftRevision(fixture.mountPath);
			writeFileSync(path.join(nested, "a.txt"), "two\n", "utf8");
			git(nested, ["commit", "--quiet", "--all", "--message", "two"]);
			expect(computeDraftRevision(fixture.mountPath)).not.toBe(first);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("the panel shows every change a resource groups", () => {
	test("fields and summaries of all changes are listed", () => {
		const change = (id: string, field: string) => ({
			changeId: id,
			kind: "modified" as const,
			summary: `${field} změněno`,
			technicalRefs: [{ path: `data/deals/${id}.yaml`, kind: "canonical_data_path" as const }],
			fields: [
				{ fieldPath: `/record/${field}`, label: field, changeKind: "modified" as const, beforeSummary: "a", afterSummary: "b" },
			],
		});
		const model = deriveDraftPanel({
			revision: "draft:x.y",
			state: "draft",
			records: [
				{
					resource: {
						appId: "deals",
						resourceType: "deals",
						stableResourceId: "deals:grouped",
						label: "Grouped",
						contractMetadata: { reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION },
						changes: [change("one", "title"), change("two", "status")],
						reviewState: { value: "unreviewed" },
						fallback: { activeLevel: "resource_adapter", steps: [] },
					},
					technicalPath: "data/deals/one.yaml",
					revert: { supported: false, reason: "x" },
				},
			],
		});
		expect(model.records[0]?.fields.map((field) => field.fieldPath)).toEqual([
			"/record/title",
			"/record/status",
		]);
		expect(model.records[0]?.summary).toBe("title změněno · status změněno");
	});
});

describe("a changed document root is the empty JSON Pointer", () => {
	test("a created document reports its root as \"\", not \"/\"", async () => {
		const { structuralDiff } = await import("../src/structuralDiff.ts");
		const result = structuralDiff(undefined, { name: "new" });
		expect(result.fields.map((field) => field.fieldPath)).toEqual([""]);
	});
});

describe("a waiting commit is recognised without an upstream too", () => {
	test("status says it waits, publish points to finishing the send, and review compares with the published baseline", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const published = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			writeFixtureDocument(fixture.mountPath, "waiting", { name: "Waiting" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "publish that failed to push"]);

			// With the upstream known, the snapshot's baseline is the published commit.
			expect((await db.review()).baselineHead).toBe(published);

			git(fixture.mountPath, ["update-ref", "-d", `refs/remotes/origin/${fixture.branch}`]);
			expect(db.status().state).toBe("committed_not_pushed");
			await expect(
				db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toMatchObject({ code: "send_pending" });
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("auto-review follow-ups", () => {
	test("publish does not carry an undeclared generated file in a waiting commit below a new draft", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFileSync(path.join(fixture.mountPath, "generated/rogue.json"), "{}\n", "utf8");
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "committed outside publish"]);
			writeFixtureDocument(fixture.mountPath, "new-draft", { name: "New draft" });
			const remoteBefore = git(fixture.originPath, ["rev-parse", fixture.branch]).trim();
			await expect(
				db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toMatchObject({ code: "generated_policy" });
			expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(remoteBefore);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("discarding a draft that holds a nested repository is refused before anything changes", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "draft-record", { name: "Draft" });
			const nested = path.join(fixture.mountPath, "data/nested");
			mkdirSync(nested, { recursive: true });
			git(fixture.root, ["init", "--quiet", nested]);
			writeFileSync(path.join(nested, "a.txt"), "inside\n", "utf8");
			const revision = db.draftRevision();
			expect(() => db.discard({ scope: { kind: "draft" }, expectedRevision: revision })).toThrow(
				expect.objectContaining({ code: "discard_unsupported" }),
			);
			expect(existsSync(path.join(nested, "a.txt"))).toBe(true);
			expect(existsSync(path.join(fixture.mountPath, "data/things/draft-record.yaml"))).toBe(true);
			expect(db.draftRevision()).toBe(revision);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("markers left by someone else point to resolving, not to an abort that refuses them", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "shared", { name: "base" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "base"]);
			writeFixtureDocument(fixture.mountPath, "shared", { name: "stashed" });
			git(fixture.mountPath, ["stash", "push", "--quiet"]);
			writeFixtureDocument(fixture.mountPath, "shared", { name: "committed" });
			git(fixture.mountPath, ["commit", "--quiet", "--all", "--message", "other"]);
			Bun.spawnSync(["git", "-C", fixture.mountPath, "stash", "apply"]);

			const conflict = db.conflict();
			expect(conflict?.operation).toBe("external");
			expect(conflict?.handoff).toContain("conflict --resolved");
			expect(conflict?.handoff).not.toContain("--abort");
			expect(() => db.abortConflict()).toThrow(expect.objectContaining({ code: "abort_incomplete" }));
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("the bootstrap placeholder is not generated output", () => {
	test("without an upstream, generated/.gitkeep neither blocks readiness nor the send", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFileSync(path.join(fixture.mountPath, "generated/.gitkeep"), "", "utf8");
			writeFixtureDocument(fixture.mountPath, "first", { name: "First" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "first publish whose push failed"]);
			const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			// The first push failed: no remote-tracking ref yet.
			git(fixture.mountPath, ["update-ref", "-d", `refs/remotes/origin/${fixture.branch}`]);

			const snapshot = await db.review();
			expect(
				snapshot.publishReadiness.references.filter((ref) => ref.kind === "generated_policy"),
			).toEqual([]);
			const result = await db.finishSend({ expectedHead: head });
			expect(result.state).toBe("published");
			expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(head);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("pull never undoes a drafted deletion", () => {
	test("a record deleted in the draft and changed by a colleague blocks the pull", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "shared", { name: "Published" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "publish shared"]);
			git(fixture.mountPath, ["push", "--quiet", "origin", fixture.branch]);

			const second = cloneFixture(fixture);
			writeFixtureDocument(second, "shared", { name: "Changed by a colleague" });
			git(second, ["commit", "--quiet", "--all", "--message", "colleague edit"]);
			git(second, ["push", "--quiet", "origin", fixture.branch]);

			// The draft deletes the record the way the engine does: unstaged.
			const recordPath = path.join(fixture.mountPath, "data/things/shared.yaml");
			rmSync(recordPath);
			const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();

			await expect(db.pull()).rejects.toMatchObject({ code: "pull_blocked_by_draft" });
			expect(existsSync(recordPath)).toBe(false);
			expect(git(fixture.mountPath, ["rev-parse", "HEAD"]).trim()).toBe(head);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
	for (const [label, id, colleague] of [
		["a non-ASCII record name", "čáp-dodávka", "edit"],
		["a record the colleague renamed", "renamed-away", "rename"],
	] as const) {
		test(`the same holds for ${label}`, async () => {
			const fixture = createFixtureRepo();
			try {
				const db = RepositoryDb.open(fixture.mountPath);
				// Written by name: the fixture helper would percent-encode it.
				const writeRecord = (root: string, name: string) =>
					writeFileSync(
						path.join(root, `data/things/${id}.yaml`),
						`schemaVersion: thing.v3\nid: x\nrecord:\n  name: ${name}\n`,
						"utf8",
					);
				writeRecord(fixture.mountPath, "Published");
				git(fixture.mountPath, ["add", "--all"]);
				git(fixture.mountPath, ["commit", "--message", "publish"]);
				git(fixture.mountPath, ["push", "--quiet", "origin", fixture.branch]);

				const second = cloneFixture(fixture);
				if (colleague === "edit") {
					writeRecord(second, "Changed by a colleague");
					git(second, ["commit", "--quiet", "--all", "--message", "colleague edit"]);
				} else {
					git(second, ["mv", `data/things/${id}.yaml`, "data/things/new-home.yaml"]);
					git(second, ["commit", "--quiet", "--message", "colleague rename"]);
				}
				git(second, ["push", "--quiet", "origin", fixture.branch]);

				rmSync(path.join(fixture.mountPath, `data/things/${id}.yaml`));
				await expect(db.pull()).rejects.toMatchObject({ code: "pull_blocked_by_draft" });
				expect(existsSync(path.join(fixture.mountPath, `data/things/${id}.yaml`))).toBe(false);
				expect(existsSync(path.join(fixture.mountPath, "data/things/new-home.yaml"))).toBe(false);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		});
	}
});

describe("changed paths are reported as they are named on disk", () => {
	test("a colleague's record with diacritics is listed raw after a send", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "waiting to be sent"]);
			const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();

			const second = cloneFixture(fixture);
			writeFileSync(
				path.join(second, "data/things/čáp.yaml"),
				"schemaVersion: thing.v3\nid: cap\nrecord:\n  name: Čáp\n",
				"utf8",
			);
			git(second, ["add", "--all"]);
			git(second, ["commit", "--quiet", "--message", "colleague"]);
			git(second, ["push", "--quiet", "origin", fixture.branch]);

			const result = await db.finishSend({ expectedHead: head });
			expect(result.remoteChanges).toEqual(["data/things/čáp.yaml"]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("a conflict recorded by an older engine", () => {
	test("abort says exactly how to restore the stashed draft", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "shared", { name: "base" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "base"]);
			const before = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			writeFixtureDocument(fixture.mountPath, "shared", { name: "stashed" });
			git(fixture.mountPath, ["stash", "push", "--quiet"]);
			const stash = git(fixture.mountPath, ["rev-parse", "stash@{0}"]).trim();
			writeFixtureDocument(fixture.mountPath, "shared", { name: "committed" });
			git(fixture.mountPath, ["commit", "--quiet", "--all", "--message", "other"]);
			Bun.spawnSync(["git", "-C", fixture.mountPath, "stash", "apply"]);
			mkdirSync(path.join(fixture.mountPath, ".repository-db"), { recursive: true });
			writeFileSync(
				path.join(fixture.mountPath, ".repository-db/conflict.json"),
				JSON.stringify({
					schemaVersion: "repository-db.conflict.v1",
					detectedAt: "2026-09-01T08:00:00.000Z",
					operation: "publish",
					gitState: "autostash apply conflicted",
					message: "older engine",
					handoff: "repository-db conflict --abort",
					preOperationHead: before,
					autostashSha: stash,
				}),
				"utf8",
			);

			expect(() => db.abortConflict()).toThrow(
				expect.objectContaining({
					code: "abort_incomplete",
					message: expect.stringContaining(`git stash apply ${stash}`),
				}),
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
