import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import {
	cloneFixture,
	createFixtureRepo,
	git,
	writeFixtureDocument,
} from "./fixtures.ts";

/** Seed a shared document and push a conflicting remote edit. */
function seedAndDivergeRemote(
	fixture: ReturnType<typeof createFixtureRepo>,
): string {
	writeFixtureDocument(fixture.mountPath, "thing-1", { name: "seed" });
	git(fixture.mountPath, ["add", "--all"]);
	git(fixture.mountPath, ["commit", "--message", "seed"]);
	git(fixture.mountPath, ["push", "origin", fixture.branch]);

	const second = cloneFixture(fixture);
	writeFixtureDocument(second, "thing-1", { name: "remote-version" });
	git(second, ["add", "--all"]);
	git(second, ["commit", "--message", "remote edit"]);
	git(second, ["push", "origin", fixture.branch]);
	return second;
}

const readThing = (mountPath: string, id: string) =>
	readFileSync(path.join(mountPath, `data/things/${id}.yaml`), "utf8");

describe("integration conflicts happen in the lane, never in the checkout", () => {
	test("a conflicting remote edit stops publish; the checkout stays whole and abort returns the work to the draft", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });

			await expect(
				db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toThrow(/publish stopped: remote changes could not be safely integrated/);

			// The checkout was never rebased: no operation in progress, no
			// markers, the local file exactly as written.
			expect(existsSync(path.join(fixture.mountPath, ".git/rebase-merge"))).toBe(false);
			expect(git(fixture.mountPath, ["status", "--porcelain"])).not.toContain("UU");
			expect(readThing(fixture.mountPath, "thing-1")).toContain("local-version");
			expect(readThing(fixture.mountPath, "thing-1")).not.toContain("<<<<<<<");

			const conflict = db.conflict();
			expect(conflict?.operation).toBe("publish");
			expect(conflict?.paths).toEqual(["data/things/thing-1.yaml"]);
			expect(db.status().state).toBe("conflict");

			// Writes and a second publish are blocked until abort/resolve.
			const things = db.collection<{ name: string }>("things", { schemaVersion: "thing.v3" });
			expect(() => things.put("thing-9", { name: "blocked" })).toThrow(/conflict/i);
			await expect(
				db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toThrow(/conflict/i);

			// Abort: the commit that could not be sent is a draft again.
			db.abortConflict();
			expect(db.conflict()).toBeUndefined();
			const status = db.status();
			expect(status.state).toBe("draft");
			expect(status.ahead).toBe(0);
			expect(status.dirtyPaths).toEqual(["data/things/thing-1.yaml"]);
			expect(readThing(fixture.mountPath, "thing-1")).toContain("local-version");
			things.put("thing-9", { name: "allowed-again" });
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("after abort, reverting the conflicting record lets the rest publish on top of the colleague's work", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });
			writeFixtureDocument(fixture.mountPath, "thing-2", { name: "unrelated" });
			await expect(
				db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toThrow(/publish stopped/);
			db.abortConflict();

			db.discard({
				scope: { kind: "record", path: "data/things/thing-1.yaml" },
				expectedRevision: db.draftRevision(),
			});
			const result = await db.publish({
				actor: "a <a@a>",
				source: "test",
				expectedRevision: db.draftRevision(),
			});
			expect(result.state).toBe("published");
			expect(result.remoteChanges).toEqual(["data/things/thing-1.yaml"]);
			expect(readThing(fixture.mountPath, "thing-1")).toContain("remote-version");
			expect(readThing(fixture.mountPath, "thing-2")).toContain("unrelated");
			const status = await db.statusAsync({ fetch: true });
			expect(status.state).toBe("published");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("resolved by hand: integrate manually, mark resolved, finish the send", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });
			await expect(
				db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toThrow(/publish stopped/);

			// A person integrates in the checkout: rebase, resolve, continue.
			const rebase = Bun.spawnSync(["git", "-C", fixture.mountPath, "rebase", `origin/${fixture.branch}`]);
			expect(rebase.exitCode).not.toBe(0);
			expect(() => db.markConflictResolved()).toThrow(/still in progress/);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "merged-version" });
			git(fixture.mountPath, ["add", "--all"]);
			Bun.spawnSync(["git", "-C", fixture.mountPath, "-c", "core.editor=true", "rebase", "--continue"]);
			db.markConflictResolved();
			expect(db.conflict()).toBeUndefined();

			const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			const result = await db.finishSend({ expectedHead: head });
			expect(result.state).toBe("published");
			expect(result.commit).toBe(head);
			expect(git(fixture.mountPath, ["show", "HEAD:data/things/thing-1.yaml"])).toContain(
				"merged-version",
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("retries only an engine-recorded clean pending send with the displayed head", async () => {
		const fixture = createFixtureRepo();
		try {
			const base = {
				amount: 100,
				stage: "draft",
				updatedAt: "2026-10-01T10:00:00.000Z",
				updatedByName: "Base editor",
			};
			writeFixtureDocument(fixture.mountPath, "thing-1", base);
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "seed retry fixture"]);
			git(fixture.mountPath, ["push", "origin", fixture.branch]);

			const second = cloneFixture(fixture, "retry-remote");
			writeFixtureDocument(second, "thing-1", {
				...base,
				stage: "approved",
				updatedAt: "2026-10-02T10:00:00.000Z",
				updatedByName: "Remote editor",
			});
			git(second, ["add", "--all"]);
			git(second, ["commit", "--message", "remote retry field"]);
			git(second, ["push", "origin", fixture.branch]);

			writeFixtureDocument(fixture.mountPath, "thing-1", {
				...base,
				stage: "cancelled",
				updatedAt: "2026-10-03T10:00:00.000Z",
				updatedByName: "Local editor",
			});
			const db = RepositoryDb.open(fixture.mountPath);
			await expect(
				db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toThrow(/publish stopped/);
			const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			expect(db.conflict()).toMatchObject({
				operation: "publish",
				pendingHead: head,
				retryable: true,
				paths: ["data/things/thing-1.yaml"],
			});
			await expect(db.retryConflictSend({ expectedHead: "not-the-displayed-head" })).rejects.toThrow(
				/no longer the one that was shown/,
			);
			expect(db.conflict()).toBeDefined();

			// A colleague resolves the competing business value on the remote. The
			// existing engine marker may now retry the same pending commit; it must
			// still use the normal three-way lane rather than clear the conflict.
			const third = cloneFixture(fixture, "retry-converged-remote");
			writeFixtureDocument(third, "thing-1", {
				...base,
				stage: "cancelled",
				updatedAt: "2026-10-04T10:00:00.000Z",
				updatedByName: "Remote resolver",
			});
			git(third, ["add", "--all"]);
			git(third, ["commit", "--message", "converge retry value"]);
			git(third, ["push", "origin", fixture.branch]);

			const result = await db.retryConflictSend({ expectedHead: head });
			expect(result.state).toBe("published");
			expect(db.conflict()).toBeUndefined();
			expect(readThing(fixture.mountPath, "thing-1")).toContain("stage: cancelled");
			expect(readThing(fixture.mountPath, "thing-1")).toContain("updatedByName: Remote resolver");
			expect((await db.statusAsync({ fetch: true })).state).toBe("published");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("never retries an external Git conflict marker", async () => {
		const fixture = createFixtureRepo();
		try {
			const { writeConflictState } = await import("../src/conflict.ts");
			writeConflictState(fixture.mountPath, {
				detectedAt: "2026-10-04T10:00:00.000Z",
				operation: "external",
				gitState: "fixture external operation",
				message: "external fixture conflict",
				handoff: "fixture",
			});
			const db = RepositoryDb.open(fixture.mountPath);
			const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			await expect(db.retryConflictSend({ expectedHead: head })).rejects.toThrow(/Only an engine-recorded/);
			expect(db.conflict()?.operation).toBe("external");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("does not retry an engine marker while an external rebase is active", async () => {
		const fixture = createFixtureRepo();
		try {
			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "local conflicting edit"]);
			git(fixture.mountPath, ["fetch", "origin"]);
			const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			const { writeConflictState } = await import("../src/conflict.ts");
			writeConflictState(fixture.mountPath, {
				detectedAt: "2026-10-04T10:00:00.000Z",
				operation: "publish",
				gitState: "fixture engine conflict",
				message: "fixture engine conflict",
				paths: ["data/things/thing-1.yaml"],
				pendingHead: head,
				retryable: true,
				handoff: "fixture",
			});
			const rebase = Bun.spawnSync([
				"git",
				"-C",
				fixture.mountPath,
				"rebase",
				`origin/${fixture.branch}`,
			]);
			expect(rebase.exitCode).not.toBe(0);

			const db = RepositoryDb.open(fixture.mountPath);
			await expect(db.retryConflictSend({ expectedHead: head })).rejects.toThrow(
				/external Git operation or unresolved index/,
			);
			expect(db.conflict()?.pendingHead).toBe(head);
			git(fixture.mountPath, ["rebase", "--abort"]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a rebase someone started by hand is reported as a conflict and abort runs rebase --abort", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-committed" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "local committed edit"]);
			git(fixture.mountPath, ["fetch", "origin"]);
			Bun.spawnSync(["git", "-C", fixture.mountPath, "rebase", `origin/${fixture.branch}`]);

			expect(db.conflict()?.operation).toBe("external");
			db.abortConflict();
			expect(db.conflict()).toBeUndefined();
			const log = git(fixture.mountPath, ["log", "--format=%s", fixture.branch]);
			expect(log).toContain("local committed edit");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("abort never clears a conflict it could not undo", () => {
	test("the low-level helper refuses without the branch and keeps the record", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });
			await expect(
				db.publish({ actor: "a <a@a>", source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toThrow(/publish stopped/);

			const { abortConflict } = await import("../src/conflict.ts");
			expect(() => (abortConflict as (root: string) => void)(fixture.mountPath)).toThrow(
				/needs the data branch/,
			);
			// Still blocked, and the unsent commit is still waiting.
			expect(db.conflict()).toBeDefined();
			expect(db.status().ahead).toBe(1);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
