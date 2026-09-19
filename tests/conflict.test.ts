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
			).rejects.toThrow(/publish stopped: remote changes to the same files/);

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
