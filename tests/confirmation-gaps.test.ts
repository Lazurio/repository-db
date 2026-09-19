import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DraftChangedError } from "../src/discard.ts";
import { computeDraftRevision, parseDraftRevision } from "../src/draftRevision.ts";
import { acquirePublishLock, withDraftWriteLock } from "../src/lock.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { cloneFixture, createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

const ACTOR = "Anna <anna@example.com>";

function publishBaseline(fixture: { mountPath: string; branch: string }): void {
	git(fixture.mountPath, ["add", "--all"]);
	git(fixture.mountPath, ["commit", "--message", "baseline"]);
	git(fixture.mountPath, ["push", "--quiet", "origin", fixture.branch]);
}

/**
 * Publish integrates remote work between the confirmation and the commit. These
 * tests exercise that window, because that is where a write can land and ride
 * out unreviewed.
 */
function publishRemoteChange(fixture: { mountPath: string; branch: string; root: string }): void {
	const second = cloneFixture(fixture as never, `remote-${Math.random().toString(36).slice(2, 8)}`);
	writeFixtureDocument(second, `remote-${Math.random().toString(36).slice(2, 8)}`, {
		name: "Published by a colleague",
	});
	git(second, ["add", "--all"]);
	git(second, ["commit", "--message", "colleague publish"]);
	git(second, ["push", "--quiet", "origin", fixture.branch]);
	git(fixture.mountPath, ["fetch", "--quiet", "origin"]);
}

describe("the confirmed revision covers the whole publish", () => {
	test("a write landing during integration is refused, not published", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed" });
			publishBaseline(fixture);

			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed edit" });
			const snapshot = await db.review();
			const confirmed = snapshot.draftRevision as string;

			// Someone else publishes, so this publish has to integrate — and the
			// unseen record appears while that integration is happening.
			publishRemoteChange(fixture);
			writeFixtureDocument(fixture.mountPath, "unseen", { name: "Never reviewed" });

			await expect(
				db.publish({
					actor: ACTOR,
					source: "test",
					expectedRevision: confirmed,
					skipValidate: true,
				}),
			).rejects.toThrow(DraftChangedError);

			// Nothing was committed, so nothing could have been pushed.
			expect(db.status().dirtyPaths).toContain("data/things/unseen.yaml");
			const log = git(fixture.mountPath, ["log", "--oneline", "-1"]);
			expect(log).not.toContain("publish");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("an empty confirmation is a malformed one, not an absent one", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing", { name: "Draft" });

			await expect(
				db.publish({ actor: ACTOR, source: "test", expectedRevision: "", skipValidate: true }),
			).rejects.toThrow(DraftChangedError);
			expect(db.status().state).toBe("draft");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("the review carries the revision that describes its own resources", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing", { name: "Draft" });

			const snapshot = await db.review();
			expect(snapshot.draftRevision).toBe(db.draftRevision());
			expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/);

			// A later write must invalidate the revision the review handed out.
			writeFixtureDocument(fixture.mountPath, "later", { name: "Later" });
			expect(db.draftRevision()).not.toBe(snapshot.draftRevision);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a mode change is part of the confirmed content", () => {
		const fixture = createFixtureRepo();
		try {
			const scriptPath = path.join(fixture.mountPath, "scripts/run.sh");
			mkdirSync(path.dirname(scriptPath), { recursive: true });
			writeFileSync(scriptPath, "#!/bin/sh\necho hi\n", "utf8");
			chmodSync(scriptPath, 0o644);
			const before = computeDraftRevision(fixture.mountPath);

			chmodSync(scriptPath, 0o755);
			expect(computeDraftRevision(fixture.mountPath)).not.toBe(before);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("the revision splits into a baseline and a content part", () => {
		const fixture = createFixtureRepo();
		try {
			const parts = parseDraftRevision(computeDraftRevision(fixture.mountPath));
			expect(parts.baseline).toMatch(/^[0-9a-f]{40}$/);
			expect(parts.content).toMatch(/^[0-9a-f]{64}$/);
			// A malformed value can never match a computed one.
			expect(parseDraftRevision("nonsense")).toEqual({ baseline: "", content: "" });
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("the shared write gate", () => {
	test("a write cannot land while a publish or discard holds the lock", () => {
		const fixture = createFixtureRepo();
		try {
			const release = acquirePublishLock(fixture.mountPath);
			const started = Date.now();
			try {
				expect(() =>
					withDraftWriteLock(fixture.mountPath, () =>
						writeFixtureDocument(fixture.mountPath, "blocked", { name: "Blocked" }),
					),
				).toThrow(/publish or discard is in progress/);
			} finally {
				release();
			}
			// Fails immediately: a host runs publish on this same thread, so
			// waiting here would stall the publish it is waiting for.
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(existsSync(path.join(fixture.mountPath, "data/things/blocked.yaml"))).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a collection write goes through the gate", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const things = db.collection<{ name: string }>("things", { schemaVersion: "thing.v3" });
			things.put("free", { name: "Free" });
			expect(things.has("free")).toBe(true);

			// Holding the lock makes the same write refuse instead of landing.
			const release = acquirePublishLock(fixture.mountPath);
			try {
				expect(() => things.remove("free")).toThrow(/publish or discard is in progress/);
			} finally {
				release();
			}
			expect(things.has("free")).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("the gate releases even when the write throws", () => {
		const fixture = createFixtureRepo();
		try {
			expect(() =>
				withDraftWriteLock(fixture.mountPath, () => {
					throw new Error("write failed");
				}),
			).toThrow("write failed");
			// Still acquirable: the lock did not leak.
			const release = acquirePublishLock(fixture.mountPath);
			release();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("finishing a send is not a publish", () => {
	test("a draft written after the failed push blocks the finish", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed" });
			publishBaseline(fixture);

			// A publish that committed but never reached the remote.
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed edit" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "publish that failed to push"]);
			expect(db.status().state).toBe("committed_not_pushed");
			const pendingHead = db.review().then((snapshot) => snapshot.head);

			// Someone edits again afterwards; that work was never reviewed.
			writeFixtureDocument(fixture.mountPath, "unreviewed", { name: "After failed push" });

			await expect(
				db.publish({
					actor: ACTOR,
					source: "test",
					finishSendOnly: true,
					expectedHead: await pendingHead,
					skipValidate: true,
				}),
			).rejects.toThrow(/beyond the commit waiting to be sent/);

			// The new record is still only local.
			expect(db.status().dirtyPaths).toContain("data/things/unreviewed.yaml");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("finishing sends exactly the commit that was shown", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed" });
			publishBaseline(fixture);

			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed edit" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "publish that failed to push"]);
			const snapshot = await db.review();

			const result = await db.publish({
				actor: ACTOR,
				source: "test",
				finishSendOnly: true,
				expectedHead: snapshot.head,
				skipValidate: true,
			});

			expect(result.state).toBe("published");
			expect(db.status().state).toBe("published");
			expect(
				readFileSync(path.join(fixture.mountPath, "data/things/reviewed.yaml"), "utf8"),
			).toContain("Reviewed edit");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a different pending commit is refused", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed" });
			publishBaseline(fixture);

			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed edit" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "publish that failed to push"]);

			await expect(
				db.publish({
					actor: ACTOR,
					source: "test",
					finishSendOnly: true,
					expectedHead: "0".repeat(40),
					skipValidate: true,
				}),
			).rejects.toThrow(/no longer the one that was shown/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("whole-draft discard only removes what was confirmed", () => {
	test("a file created after the confirmation survives", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "confirmed", { name: "Confirmed" });
			const confirmed = db.draftRevision();

			// Written outside the gate, after the confirmation — the engine cannot
			// include it, so it must not delete it either.
			const strayPath = path.join(fixture.mountPath, "data/things/stray.yaml");
			writeFileSync(strayPath, "schemaVersion: thing.v3\nid: stray\n", "utf8");

            // The revision guard catches it first.
			expect(() =>
				db.discard({ scope: { kind: "draft" }, expectedRevision: confirmed }),
			).toThrow(DraftChangedError);
			expect(existsSync(strayPath)).toBe(true);

			// Confirming the refreshed draft removes exactly what it listed.
			db.discard({ scope: { kind: "draft" }, expectedRevision: db.draftRevision() });
			expect(existsSync(strayPath)).toBe(false);
			expect(db.status().dirtyPaths).toEqual([]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("the panel does not offer what the host cannot do", () => {
	test("an unwired recovery action is disabled with a reason", async () => {
		const { deriveDraftPanel } = await import("../src/ui/draftPanelModel.ts");
		const model = deriveDraftPanel(
			{
				revision: "draft:a.b",
				state: "committed_not_pushed",
				pendingHead: "c".repeat(40),
				records: [],
			},
			{ finishSend: false },
		);
		const finish = model.actions.find((action) => action.kind === "finish_send");
		expect(finish?.enabled).toBe(false);
		expect(finish?.disabledReason).toContain("nepodporuje");
	});

	test("a wired action stays available and carries the pending commit", async () => {
		const { deriveDraftPanel } = await import("../src/ui/draftPanelModel.ts");
		const model = deriveDraftPanel(
			{
				revision: "draft:a.b",
				state: "committed_not_pushed",
				pendingHead: "c".repeat(40),
				records: [],
			},
			{ finishSend: true },
		);
		expect(model.actions.find((action) => action.kind === "finish_send")?.enabled).toBe(true);
		expect(model.pendingHead).toBe("c".repeat(40));
	});
});

describe("publishing a draft that regenerates output", () => {
	test("a materializer rewriting generated files does not look like someone else's write", async () => {
		const fixture = createFixtureRepo();
		try {
			// A declared artifact with a materializer, which is the ordinary shape
			// of a repository-db app and the case a fixture without one hides.
			const materializer =
				"sh -c 'printf \"count: %s\\n\" \"$(ls data/things | wc -l | tr -d \" \")\" > generated/rollup.yaml'";
			writeFileSync(
				path.join(fixture.mountPath, "repository-db.yaml"),
				[
					"schema_version: repository-db.config.v1",
					"app: fixture",
					`data_repo: {remote: ${fixture.originPath}, branch: ${fixture.branch}}`,
					"schema: {name: fixture-data, version: 3.0.0-alpha.0}",
					"layout: {data: data, generated: generated, scripts: scripts}",
					"generated_manifest:",
					"  - path: generated/rollup.yaml",
					`    materializer: ${JSON.stringify(materializer)}`,
					"validate: []",
					"",
				].join("\n"),
				"utf8",
			);
			publishBaseline(fixture);

			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "new-record", { name: "New" });
			const snapshot = await db.review();

			const result = await db.publish({
				actor: ACTOR,
				source: "test",
				expectedRevision: snapshot.draftRevision,
			});

			// The regenerated rollup is part of the publish, not a reason to refuse it.
			expect(result.state).toBe("published");
			expect(db.status().dirtyPaths).toEqual([]);
			expect(
				readFileSync(path.join(fixture.mountPath, "generated/rollup.yaml"), "utf8"),
			).toContain("count:");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("round 2 — finishing a send must name its commit", () => {
	test("finishSendOnly without expectedHead is refused before anything moves", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed" });
			publishBaseline(fixture);
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Unsent" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "publish that failed to push"]);
			const remoteBefore = git(fixture.originPath, ["rev-parse", fixture.branch]).trim();

			for (const expectedHead of [undefined, "", "   "]) {
				await expect(
					db.publish({
						actor: ACTOR,
						source: "test",
						finishSendOnly: true,
						expectedHead,
						skipValidate: true,
					}),
				).rejects.toThrow(/requires the commit that was shown/);
			}
			// Nothing reached the remote.
			expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(remoteBefore);
			expect(db.status().state).toBe("committed_not_pushed");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("the panel cannot offer finishing a send without the pending commit", async () => {
		const { deriveDraftPanel } = await import("../src/ui/draftPanelModel.ts");
		const model = deriveDraftPanel({
			revision: "draft:a.b",
			state: "committed_not_pushed",
			records: [],
		});
		const finish = model.actions.find((action) => action.kind === "finish_send");
		expect(finish?.enabled).toBe(false);
		expect(finish?.disabledReason).toContain("Obnovte přehled");
	});
});

describe("round 2 — no row offers a revert the engine would refuse", () => {
	test("conflict and unsent states disable per-record revert whatever the host said", async () => {
		const { deriveDraftPanel } = await import("../src/ui/draftPanelModel.ts");
		const record = {
			resource: {
				appId: "a",
				resourceType: "r",
				stableResourceId: "r:1",
				label: "Record",
				changes: [
					{
						changeId: "c",
						kind: "modified" as const,
						summary: "",
						technicalRefs: [{ path: "data/r/1.yaml", kind: "canonical_data_path" as const }],
						fields: [],
					},
				],
				reviewState: { value: "unreviewed" as const },
				fallback: { activeLevel: "resource_adapter" as const, steps: [] },
			},
			technicalPath: "data/r/1.yaml",
			revert: { supported: true },
		};
		for (const input of [
			{ state: "conflict" as const },
			{ state: "committed_not_pushed" as const, pendingHead: "c".repeat(40) },
			{ state: "draft" as const, ahead: 1 },
		]) {
			const model = deriveDraftPanel({ revision: "draft:a.b", records: [record], ...input });
			expect(model.records[0]?.revertSupported).toBe(false);
			expect(model.records[0]?.revertBlockedReason).toBeTruthy();
		}
	});
});

describe("round 2 — revision and review read the checkout honestly", () => {
	test("retargeting a dangling symlink changes the revision", async () => {
		const { symlinkSync, unlinkSync } = await import("node:fs");
		const fixture = createFixtureRepo();
		try {
			const linkPath = path.join(fixture.mountPath, "data/things/link.yaml");
			symlinkSync("does-not-exist-a.yaml", linkPath);
			const before = computeDraftRevision(fixture.mountPath);
			unlinkSync(linkPath);
			symlinkSync("does-not-exist-b.yaml", linkPath);
			expect(computeDraftRevision(fixture.mountPath)).not.toBe(before);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a dirty symlink is reviewed as its target path, never followed", async () => {
		const { symlinkSync } = await import("node:fs");
		const fixture = createFixtureRepo();
		try {
			const secretPath = path.join(fixture.root, "host-secret.yaml");
			writeFileSync(secretPath, "token: TOP-SECRET-VALUE\n", "utf8");
			symlinkSync(secretPath, path.join(fixture.mountPath, "data/things/link.yaml"));

			const snapshot = await RepositoryDb.open(fixture.mountPath).review();
			expect(JSON.stringify(snapshot)).not.toContain("TOP-SECRET-VALUE");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rename detection does not depend on the user's git config", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "old", { name: "Old" });
			publishBaseline(fixture);
			git(fixture.mountPath, ["config", "status.renames", "false"]);
			git(fixture.mountPath, ["mv", "data/things/old.yaml", "data/things/new.yaml"]);

			expect(db.canRevertRecord("data/things/new.yaml").reason).toContain("renamed");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a trailing slash in the layout does not hide generated changes", async () => {
		const { parseRepositoryDbConfig } = await import("../src/config.ts");
		const config = parseRepositoryDbConfig({
			schema_version: "repository-db.config.v1",
			app: "fixture",
			data_repo: { remote: "git@example.com:x.git", branch: "v3" },
			schema: { name: "x", version: "1" },
			layout: { data: "data/", generated: "generated/", scripts: "scripts/" },
		});
		expect(config.layout).toEqual({ data: "data", generated: "generated", scripts: "scripts" });
	});
});

describe("round 2 — the gate's release belongs to its acquisition", () => {
	test("releasing a reclaimed lock does not remove its successor", () => {
		const fixture = createFixtureRepo();
		try {
			const lockFile = path.join(fixture.mountPath, ".repository-db", "publish.lock");
			const releaseFirst = acquirePublishLock(fixture.mountPath);
			// Simulate the stale reclaim: the file is replaced by a new holder in
			// this same process (same pid and hostname, different acquisition).
			rmSync(lockFile);
			const releaseSecond = acquirePublishLock(fixture.mountPath);

			releaseFirst();
			// The successor's lock is still there and still holds the gate.
			expect(existsSync(lockFile)).toBe(true);
			expect(() => withDraftWriteLock(fixture.mountPath, () => undefined)).toThrow(
				/publish or discard is in progress/,
			);
			releaseSecond();
			expect(existsSync(lockFile)).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("round 2 — the CLI demands the head too", () => {
	test("--finish-send without --head is refused and pushes nothing", async () => {
		const { spawnSync } = await import("node:child_process");
		const fixture = createFixtureRepo();
		try {
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed" });
			publishBaseline(fixture);
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Unsent" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "publish that failed to push"]);
			const remoteBefore = git(fixture.originPath, ["rev-parse", fixture.branch]).trim();

			const run = spawnSync(
				process.execPath,
				[
					path.join(import.meta.dir, "../src/cli.ts"),
					"publish",
					"--mount",
					fixture.mountPath,
					"--actor",
					ACTOR,
					"--source",
					"test",
					"--finish-send",
				],
				{ encoding: "utf8" },
			);

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("--finish-send requires --head");
			expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(remoteBefore);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("round 2 — a rename never hides the deleted record", () => {
	test("a staged rename shows the old record as deleted", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "old-name", { name: "Published" });
			publishBaseline(fixture);
			git(fixture.mountPath, ["mv", "data/things/old-name.yaml", "data/things/new-name.yaml"]);

			const snapshot = await db.review();
			const kinds = new Map(
				snapshot.resources.map((resource) => [
					resource.changes[0]?.technicalRefs[0]?.path,
					resource.changes[0]?.kind,
				]),
			);
			expect(kinds.get("data/things/old-name.yaml")).toBe("deleted");
			expect(kinds.get("data/things/new-name.yaml")).toBe("created");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a committed-but-unsent rename shows both sides too", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "old-name", { name: "Published" });
			publishBaseline(fixture);
			git(fixture.mountPath, ["mv", "data/things/old-name.yaml", "data/things/new-name.yaml"]);
			git(fixture.mountPath, ["commit", "--message", "rename, never pushed"]);

			const paths = (await db.review()).resources.map(
				(resource) => resource.changes[0]?.technicalRefs[0]?.path,
			);
			expect(paths).toContain("data/things/old-name.yaml");
			expect(paths).toContain("data/things/new-name.yaml");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("round 2 — declared artifacts outside generated/ do not trip the check", () => {
	test("a materializer writing under data/ does not refuse a confirmed publish", async () => {
		const fixture = createFixtureRepo();
		try {
			const materializer =
				"sh -c 'mkdir -p data/rollups && ls data/things | wc -l | tr -d \" \" > data/rollups/count.txt'";
			writeFileSync(
				path.join(fixture.mountPath, "repository-db.yaml"),
				[
					"schema_version: repository-db.config.v1",
					"app: fixture",
					`data_repo: {remote: ${fixture.originPath}, branch: ${fixture.branch}}`,
					"schema: {name: fixture-data, version: 3.0.0-alpha.0}",
					"layout: {data: data, generated: generated, scripts: scripts}",
					"generated_manifest:",
					"  - path: data/rollups/count.txt",
					`    materializer: ${JSON.stringify(materializer)}`,
					"validate: []",
					"",
				].join("\n"),
				"utf8",
			);
			publishBaseline(fixture);

			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "new-record", { name: "New" });
			const snapshot = await db.review();
			const result = await db.publish({
				actor: ACTOR,
				source: "test",
				expectedRevision: snapshot.draftRevision,
			});
			expect(result.state).toBe("published");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("round 3 — a live local lock is never taken over by age", () => {
	function writeLock(mountPath: string, payload: Record<string, unknown>): string {
		const lockFile = path.join(mountPath, ".repository-db", "publish.lock");
		mkdirSync(path.dirname(lockFile), { recursive: true });
		writeFileSync(lockFile, JSON.stringify(payload), "utf8");
		return lockFile;
	}

	test("an hour-old lock of a running local process still holds the gate", async () => {
		const os = await import("node:os");
		const { spawn } = await import("node:child_process");
		const fixture = createFixtureRepo();
		// A genuinely separate, running process stands in for a long publish.
		const holder = spawn("sleep", ["30"], { stdio: "ignore" });
		try {
			const lockFile = writeLock(fixture.mountPath, {
				pid: holder.pid,
				hostname: os.hostname(),
				acquiredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
				token: "long-publish",
			});

			expect(() => acquirePublishLock(fixture.mountPath)).toThrow(/already running/);
			expect(() => withDraftWriteLock(fixture.mountPath, () => undefined)).toThrow(
				/publish or discard is in progress/,
			);
			expect(JSON.parse(readFileSync(lockFile, "utf8")).token).toBe("long-publish");
		} finally {
			holder.kill("SIGKILL");
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a lock left with our own pid by a crashed previous incarnation is reclaimed", async () => {
		const os = await import("node:os");
		const fixture = createFixtureRepo();
		try {
			// The container-restart shape: same hostname, the new app got the same
			// pid, and the lock carries a token this process never issued.
			writeLock(fixture.mountPath, {
				pid: process.pid,
				hostname: os.hostname(),
				acquiredAt: new Date().toISOString(),
				token: "previous-incarnation",
			});
			const release = acquirePublishLock(fixture.mountPath);
			release();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("our own live lock is not mistaken for an abandoned one", () => {
		const fixture = createFixtureRepo();
		try {
			const release = acquirePublishLock(fixture.mountPath);
			try {
				// Same pid, but a token this process did issue and still holds.
				expect(() => acquirePublishLock(fixture.mountPath)).toThrow(/already running/);
			} finally {
				release();
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a lock of a dead local process is reclaimed at once", async () => {
		const os = await import("node:os");
		const fixture = createFixtureRepo();
		try {
			writeLock(fixture.mountPath, {
				pid: 2_147_483_000,
				hostname: os.hostname(),
				acquiredAt: new Date().toISOString(),
				token: "crashed",
			});
			const release = acquirePublishLock(fixture.mountPath);
			release();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("another host's lock is reclaimed only once it is old", () => {
		const fixture = createFixtureRepo();
		try {
			writeLock(fixture.mountPath, {
				pid: 1,
				hostname: "some-other-machine",
				acquiredAt: new Date().toISOString(),
				token: "remote-fresh",
			});
			expect(() => acquirePublishLock(fixture.mountPath)).toThrow(/already running/);

			writeLock(fixture.mountPath, {
				pid: 1,
				hostname: "some-other-machine",
				acquiredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
				token: "remote-old",
			});
			const release = acquirePublishLock(fixture.mountPath);
			release();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("round 3 — a confirmed publish of a staged rename does not refuse itself", () => {
	test("publishes after integration splits the rename", async () => {
		const fixture = createFixtureRepo();
		try {
			writeFixtureDocument(fixture.mountPath, "old-name", { name: "Published" });
			publishBaseline(fixture);
			// An agent renames a record; a colleague publishes meanwhile, so the
			// publish integrates and its autostash turns the rename into an add
			// plus an unstaged delete.
			git(fixture.mountPath, ["mv", "data/things/old-name.yaml", "data/things/new-name.yaml"]);
			publishRemoteChange(fixture);

			const db = RepositoryDb.open(fixture.mountPath);
			const snapshot = await db.review();
			const result = await db.publish({
				actor: ACTOR,
				source: "test",
				expectedRevision: snapshot.draftRevision,
				skipValidate: true,
			});

			expect(result.state).toBe("published");
			const remoteTree = git(fixture.originPath, ["ls-tree", "-r", "--name-only", fixture.branch]);
			expect(remoteTree).toContain("data/things/new-name.yaml");
			expect(remoteTree).not.toContain("data/things/old-name.yaml");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("publishes a staged rename even with nothing to integrate", async () => {
		const fixture = createFixtureRepo();
		try {
			writeFixtureDocument(fixture.mountPath, "old-name", { name: "Published" });
			publishBaseline(fixture);
			git(fixture.mountPath, ["mv", "data/things/old-name.yaml", "data/things/new-name.yaml"]);

			const db = RepositoryDb.open(fixture.mountPath);
			const snapshot = await db.review();
			const result = await db.publish({
				actor: ACTOR,
				source: "test",
				expectedRevision: snapshot.draftRevision,
				skipValidate: true,
			});
			expect(result.state).toBe("published");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
