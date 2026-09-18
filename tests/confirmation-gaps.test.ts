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
				// Short wait here only to keep the test quick; the production
				// default gives an ordinary autosave time to ride out a publish.
				expect(() =>
					withDraftWriteLock(fixture.mountPath, () => writeFixtureDocument(fixture.mountPath, "blocked", { name: "Blocked" }), {
						waitMs: 300,
					}),
				).toThrow(/publish or discard is in progress/);
			} finally {
				release();
			}
			// It waited rather than failing on the first attempt.
			expect(Date.now() - started).toBeGreaterThanOrEqual(250);
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
	}, 20_000);

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
			{ revision: "draft:a.b", state: "committed_not_pushed", records: [] },
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
