import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ForeignChangeError } from "../src/discard.ts";
import { readDraftOwner } from "../src/origin.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { toStableYaml } from "../src/yamlIo.ts";
import { createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

const ANNA = "Anna <anna@example.com>";
const AGENT = "Henry <agent@example.com>";

describe("discard", () => {
	test("restores a modified record and removes a newly created one", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "published" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "baseline"]);

			// One edit of published content, one brand new record.
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "draft edit" });
			writeFixtureDocument(fixture.mountPath, "thing-2", { name: "new" });
			db.recordOrigin(["data/things/thing-1.yaml", "data/things/thing-2.yaml"], {
				kind: "app",
				actor: ANNA,
			});
			expect(db.status().state).toBe("draft");

			const result = db.discard({ all: true, actor: ANNA });

			expect(result.discarded).toEqual(
				expect.arrayContaining([
					{ path: "data/things/thing-1.yaml", action: "restored" },
					{ path: "data/things/thing-2.yaml", action: "removed" },
				]),
			);
			expect(result.remainingDirtyPaths).toEqual([]);
			// The unpushed baseline commit stays; only the draft is gone.
			expect(db.status().dirtyPaths).toEqual([]);
			expect(
				readFileSync(path.join(fixture.mountPath, "data/things/thing-1.yaml"), "utf8"),
			).toContain("published");
			expect(
				existsSync(path.join(fixture.mountPath, "data/things/thing-2.yaml")),
			).toBe(false);
			// The draft is gone, so its coarse owner label must be gone too.
			expect(readDraftOwner(fixture.mountPath)).toBeUndefined();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("discards only the requested path and keeps the rest of the draft", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "keep", { name: "kept draft" });
			writeFixtureDocument(fixture.mountPath, "drop", { name: "unwanted" });
			db.recordOrigin(["data/things/keep.yaml", "data/things/drop.yaml"], {
				kind: "app",
				actor: ANNA,
			});

			const result = db.discard({ paths: ["data/things/drop.yaml"], actor: ANNA });

			expect(result.discarded).toEqual([
				{ path: "data/things/drop.yaml", action: "removed" },
			]);
			expect(result.remainingDirtyPaths).toEqual(["data/things/keep.yaml"]);
			expect(readDraftOwner(fixture.mountPath)?.actor).toBe(ANNA);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("restores a staged deletion of a published record", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "published" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "baseline"]);

			git(fixture.mountPath, ["rm", "--quiet", "data/things/thing-1.yaml"]);
			db.recordOrigin(["data/things/thing-1.yaml"], { kind: "app", actor: ANNA });

			const result = db.discard({ all: true, actor: ANNA });

			expect(result.discarded).toEqual([
				{ path: "data/things/thing-1.yaml", action: "restored" },
			]);
			expect(db.status().dirtyPaths).toEqual([]);
			expect(
				existsSync(path.join(fixture.mountPath, "data/things/thing-1.yaml")),
			).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses a foreign change until the caller confirms", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "agent-work", { name: "from agent" });
			db.recordOrigin(["data/things/agent-work.yaml"], {
				kind: "agent",
				actor: AGENT,
			});

			expect(() => db.discard({ all: true, actor: ANNA })).toThrow(ForeignChangeError);
			// Nothing was touched by the refused call.
			expect(db.status().dirtyPaths).toContain("data/things/agent-work.yaml");

			const confirmed = db.discard({ all: true, actor: ANNA, confirmForeign: true });
			expect(confirmed.discarded).toEqual([
				{ path: "data/things/agent-work.yaml", action: "removed" },
			]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("treats an unattributed filesystem edit as foreign", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			// No recordOrigin: the classic "an agent edited YAML directly" case.
			writeFixtureDocument(fixture.mountPath, "unknown", { name: "who wrote this" });

			expect(() => db.discard({ all: true, actor: ANNA })).toThrow(
				/foreign_change_requires_confirm|not written by the requesting actor/,
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("carries declared generated artifacts along with their source", () => {
		const fixture = createFixtureRepo();
		try {
			const configPath = path.join(fixture.mountPath, "repository-db.yaml");
			writeFileSync(
				configPath,
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

			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "draft" });
			writeFileSync(
				path.join(fixture.mountPath, "generated/rollup.json"),
				'{"count":1}\n',
				"utf8",
			);
			db.recordOrigin(["data/things/thing-1.yaml"], { kind: "app", actor: ANNA });

			const result = db.discard({
				paths: ["data/things/thing-1.yaml"],
				actor: ANNA,
				confirmForeign: true,
			});

			expect(result.generatedIncluded).toEqual(["generated/rollup.json"]);
			expect(result.remainingDirtyPaths).toEqual([]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects a path that is not part of the current draft", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "draft" });

			expect(() =>
				db.discard({ paths: ["data/things/not-dirty.yaml"], confirmForeign: true }),
			).toThrow(/not part of the current draft/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
