import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DraftChangedError, RevertNotSupportedError } from "../src/discard.ts";
import { readDraftOwner } from "../src/origin.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { toStableYaml } from "../src/yamlIo.ts";
import { createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

const ANNA = "Anna <anna@example.com>";

function declareGeneratedArtifact(fixture: {
	mountPath: string;
	originPath: string;
	branch: string;
}): void {
	writeFileSync(
		path.join(fixture.mountPath, "repository-db.yaml"),
		toStableYaml({
			schema_version: "repository-db.config.v1",
			app: "fixture",
			data_repo: { remote: fixture.originPath, branch: fixture.branch },
			schema: { name: "fixture-data", version: "3.0.0-alpha.0" },
			layout: { data: "data", generated: "generated", scripts: "scripts" },
			generated_manifest: [{ path: "generated/rollup.json" }],
			validate: [],
		}),
		"utf8",
	);
	git(fixture.mountPath, ["add", "--all"]);
	git(fixture.mountPath, ["commit", "--message", "declare generated artifact"]);
	git(fixture.mountPath, ["push", "--quiet", "origin", fixture.branch]);
}

/** Commit and push, so the checkout is genuinely at the published state. */
function publishBaseline(fixture: { mountPath: string; branch: string }): void {
	git(fixture.mountPath, ["add", "--all"]);
	git(fixture.mountPath, ["commit", "--message", "baseline"]);
	git(fixture.mountPath, ["push", "--quiet", "origin", fixture.branch]);
}

describe("discard — record scope", () => {
	test("returns one record to its published content and leaves the rest alone", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "published" });
			publishBaseline(fixture);

			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "draft edit" });
			writeFixtureDocument(fixture.mountPath, "thing-2", { name: "unrelated draft" });
			db.recordOrigin(["data/things/thing-1.yaml"], { kind: "app", actor: ANNA });

			const result = db.discard({
				scope: { kind: "record", path: "data/things/thing-1.yaml" },
				expectedRevision: db.draftRevision(),
			});

			expect(result.restored).toEqual(["data/things/thing-1.yaml"]);
			expect(
				readFileSync(path.join(fixture.mountPath, "data/things/thing-1.yaml"), "utf8"),
			).toContain("published");
			// An unrelated change must never be taken along.
			expect(result.remainingDirtyPaths).toEqual(["data/things/thing-2.yaml"]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("removes a record that only existed in the draft", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "fresh", { name: "new" });

			const result = db.discard({
				scope: { kind: "record", path: "data/things/fresh.yaml" },
				expectedRevision: db.draftRevision(),
			});

			expect(result.removed).toEqual(["data/things/fresh.yaml"]);
			expect(existsSync(path.join(fixture.mountPath, "data/things/fresh.yaml"))).toBe(false);
			expect(readDraftOwner(fixture.mountPath)).toBeUndefined();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("does not offer a record revert while generated data is also in the draft", () => {
		const fixture = createFixtureRepo();
		try {
			declareGeneratedArtifact(fixture);
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "draft" });
			writeFileSync(
				path.join(fixture.mountPath, "generated/rollup.json"),
				'{"count":1}\n',
				"utf8",
			);

			const availability = db.canRevertRecord("data/things/thing-1.yaml");
			expect(availability.supported).toBe(false);
			expect(availability.reason).toContain("generated data");

			expect(() =>
				db.discard({
					scope: { kind: "record", path: "data/things/thing-1.yaml" },
					expectedRevision: db.draftRevision(),
				}),
			).toThrow(RevertNotSupportedError);

			// The documented way out is the whole draft, and it works.
			const result = db.discard({
				scope: { kind: "draft" },
				expectedRevision: db.draftRevision(),
			});
			expect(result.remainingDirtyPaths).toEqual([]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("does not offer a record revert for a renamed record", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "old-name", { name: "Original" });
			publishBaseline(fixture);

			git(fixture.mountPath, [
				"mv",
				"data/things/old-name.yaml",
				"data/things/new-name.yaml",
			]);

			const availability = db.canRevertRecord("data/things/new-name.yaml");
			expect(availability.supported).toBe(false);
			expect(availability.reason).toContain("renamed");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses generated output, non-canonical files and paths outside the draft", () => {
		const fixture = createFixtureRepo();
		try {
			declareGeneratedArtifact(fixture);
			const db = RepositoryDb.open(fixture.mountPath);
			writeFileSync(
				path.join(fixture.mountPath, "generated/rollup.json"),
				'{"count":1}\n',
				"utf8",
			);
			writeFileSync(path.join(fixture.mountPath, "scripts/helper.mjs"), "// draft\n", "utf8");

			expect(db.canRevertRecord("generated/rollup.json").reason).toContain("generated output");
			expect(db.canRevertRecord("scripts/helper.mjs").reason).toContain(
				"Only canonical records",
			);
			expect(db.canRevertRecord("data/things/never-touched.yaml").reason).toContain(
				"not part of the current draft",
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("discard — whole draft", () => {
	test("returns every change, including staged edits and renames", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "kept", { name: "published" });
			writeFixtureDocument(fixture.mountPath, "renamed", { name: "published" });
			publishBaseline(fixture);

			writeFixtureDocument(fixture.mountPath, "kept", { name: "edited" });
			git(fixture.mountPath, ["add", "data/things/kept.yaml"]);
			git(fixture.mountPath, ["mv", "data/things/renamed.yaml", "data/things/moved.yaml"]);
			writeFixtureDocument(fixture.mountPath, "brand-new", { name: "new" });
			db.recordOrigin(["data/things/kept.yaml"], { kind: "app", actor: ANNA });

			const result = db.discard({
				scope: { kind: "draft" },
				expectedRevision: db.draftRevision(),
			});

			expect(result.remainingDirtyPaths).toEqual([]);
			expect(db.status().dirtyPaths).toEqual([]);
			expect(
				readFileSync(path.join(fixture.mountPath, "data/things/kept.yaml"), "utf8"),
			).toContain("published");
			expect(existsSync(path.join(fixture.mountPath, "data/things/renamed.yaml"))).toBe(true);
			expect(existsSync(path.join(fixture.mountPath, "data/things/moved.yaml"))).toBe(false);
			expect(existsSync(path.join(fixture.mountPath, "data/things/brand-new.yaml"))).toBe(
				false,
			);
			expect(readDraftOwner(fixture.mountPath)).toBeUndefined();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("discard — guards", () => {
	test("refuses when the draft changed since it was shown", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "shown" });
			const shownRevision = db.draftRevision();

			// A colleague or an agent saves something in between.
			writeFixtureDocument(fixture.mountPath, "thing-2", { name: "written meanwhile" });

			expect(() =>
				db.discard({ scope: { kind: "draft" }, expectedRevision: shownRevision }),
			).toThrow(DraftChangedError);
			// Nothing was touched by the refused call.
			expect(db.status().dirtyPaths).toHaveLength(2);

			// Confirming the refreshed view works.
			const result = db.discard({
				scope: { kind: "draft" },
				expectedRevision: db.draftRevision(),
			});
			expect(result.remainingDirtyPaths).toEqual([]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses while a published commit is still waiting to be sent", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "committed" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "local commit, never pushed"]);
			expect(db.status().state).toBe("committed_not_pushed");

			writeFixtureDocument(fixture.mountPath, "thing-2", { name: "later draft" });

			expect(() =>
				db.discard({ scope: { kind: "draft" }, expectedRevision: db.draftRevision() }),
			).toThrow(/waiting to be sent/);
			// A blocked state must not hide the draft.
			expect(db.status().dirtyPaths).toContain("data/things/thing-2.yaml");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("requires the displayed revision", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "draft" });
			expect(() => db.discard({ scope: { kind: "draft" }, expectedRevision: "" })).toThrow(
				/revision of the draft that was shown/,
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("draft revision", () => {
	test("changes with content and returns to a stable value", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const clean = db.draftRevision();

			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "one" });
			const afterWrite = db.draftRevision();
			expect(afterWrite).not.toBe(clean);
			expect(db.draftRevision()).toBe(afterWrite);

			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "two" });
			expect(db.draftRevision()).not.toBe(afterWrite);

			db.discard({ scope: { kind: "draft" }, expectedRevision: db.draftRevision() });
			expect(db.draftRevision()).toBe(clean);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("publish — displayed revision", () => {
	test("refuses to publish a draft that changed since it was shown", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "shown" });
			const shownRevision = db.draftRevision();

			// Someone saves another record while the user is looking at the panel.
			writeFixtureDocument(fixture.mountPath, "thing-2", { name: "meanwhile" });

			await expect(
				db.publish({
					actor: ANNA,
					source: "test",
					expectedRevision: shownRevision,
					skipValidate: true,
				}),
			).rejects.toThrow(DraftChangedError);
			// Nothing was committed: both records are still draft.
			expect(db.status().state).toBe("draft");
			expect(db.status().dirtyPaths).toHaveLength(2);

			// Confirming the refreshed draft publishes everything as one unit.
			const result = await db.publish({
				actor: ANNA,
				source: "test",
				expectedRevision: db.draftRevision(),
				skipValidate: true,
			});
			expect(result.state).toBe("published");
			expect(db.status().dirtyPaths).toEqual([]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
