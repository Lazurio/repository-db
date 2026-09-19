import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { cloneFixture, createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

const ACTOR = "Anna <anna@example.com>";

/** Origin refuses pushes while the marker file exists. */
function rejectPushesWhile(fixture: { root: string; originPath: string }): string {
	const marker = path.join(fixture.root, "reject-push");
	writeFileSync(
		path.join(fixture.originPath, "hooks", "pre-receive"),
		`#!/bin/sh\nif [ -f "${marker}" ]; then echo "push rejected by test" >&2; exit 1; fi\nexit 0\n`,
		{ encoding: "utf8", mode: 0o755 },
	);
	writeFileSync(marker, "", "utf8");
	return marker;
}

/** A materializer whose output differs on every run, so any run is visible. */
function useStampMaterializer(fixture: { mountPath: string; originPath: string; branch: string }): void {
	const materializer = "sh -c 'date +%s%N > generated/stamp.txt'";
	writeFileSync(
		path.join(fixture.mountPath, "repository-db.yaml"),
		[
			"schema_version: repository-db.config.v1",
			"app: fixture",
			`data_repo: {remote: ${fixture.originPath}, branch: ${fixture.branch}}`,
			"schema: {name: fixture-data, version: 3.0.0-alpha.0}",
			"layout: {data: data, generated: generated, scripts: scripts}",
			"generated_manifest:",
			"  - path: generated/stamp.txt",
			`    materializer: ${JSON.stringify(materializer)}`,
			"validate: []",
			"",
		].join("\n"),
		"utf8",
	);
	git(fixture.mountPath, ["add", "--all"]);
	git(fixture.mountPath, ["commit", "--message", "stamp materializer"]);
	git(fixture.mountPath, ["push", "--quiet", "origin", fixture.branch]);
}

const commitCount = (mountPath: string) =>
	Number(git(mountPath, ["rev-list", "--count", "HEAD"]).trim());

describe("a failed send leaves one waiting commit; finishing it is a separate operation", () => {
	test("failed push, then every wrong finish is refused, then a clean retry sends that commit and nothing else", async () => {
		const fixture = createFixtureRepo();
		try {
			useStampMaterializer(fixture);
			const db = RepositoryDb.open(fixture.mountPath);
			const marker = rejectPushesWhile(fixture);
			writeFixtureDocument(fixture.mountPath, "reviewed", { name: "Reviewed" });

			await expect(
				db.publish({ actor: ACTOR, source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toMatchObject({ code: "publish_push_failed" });
			expect(db.status().state).toBe("committed_not_pushed");
			const pending = (await db.review()).head as string;
			const stamp = readFileSync(path.join(fixture.mountPath, "generated/stamp.txt"), "utf8");
			const commitsAfterPublish = commitCount(fixture.mountPath);
			rmSync(marker);

			// Publish is not the way to finish: there is no new draft to confirm.
			await expect(
				db.publish({ actor: ACTOR, source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toMatchObject({ code: "send_pending" });
			// Missing or wrong head.
			await expect(db.finishSend({ expectedHead: "" })).rejects.toMatchObject({
				code: "invalid_publish",
			});
			await expect(db.finishSend({ expectedHead: "0".repeat(40) })).rejects.toMatchObject({
				code: "head_changed",
			});
			// A new draft written after the failure.
			writeFixtureDocument(fixture.mountPath, "later", { name: "Written after the failure" });
			await expect(db.finishSend({ expectedHead: pending })).rejects.toMatchObject({
				code: "new_draft_present",
			});
			rmSync(path.join(fixture.mountPath, "data/things/later.yaml"));

			// Clean retry: exactly the waiting commit, no new commit, no materializer run.
			const result = await db.finishSend({ expectedHead: pending });
			expect(result.state).toBe("published");
			expect(result.commit).toBe(pending);
			expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(pending);
			expect(commitCount(fixture.mountPath)).toBe(commitsAfterPublish);
			expect(readFileSync(path.join(fixture.mountPath, "generated/stamp.txt"), "utf8")).toBe(stamp);
			expect(db.status().state).toBe("published");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("when a colleague published in between, finishing replays the same commit onto their work without adding one", async () => {
		const fixture = createFixtureRepo();
		try {
			useStampMaterializer(fixture);
			const db = RepositoryDb.open(fixture.mountPath);
			const marker = rejectPushesWhile(fixture);
			writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });
			await expect(
				db.publish({ actor: ACTOR, source: "test", expectedRevision: db.draftRevision() }),
			).rejects.toMatchObject({ code: "publish_push_failed" });
			const pending = (await db.review()).head as string;
			const pendingMessage = git(fixture.mountPath, ["log", "-1", "--format=%B", pending]);
			const stamp = readFileSync(path.join(fixture.mountPath, "generated/stamp.txt"), "utf8");
			rmSync(marker);

			const second = cloneFixture(fixture);
			writeFixtureDocument(second, "theirs", { name: "Theirs" });
			git(second, ["add", "data"]);
			git(second, ["commit", "--message", "colleague publish"]);
			git(second, ["push", "--quiet", "origin", fixture.branch]);
			const theirs = git(second, ["rev-parse", "HEAD"]).trim();

			const result = await db.finishSend({ expectedHead: pending });
			expect(result.state).toBe("published");
			expect(result.remoteChanges).toEqual(["data/things/theirs.yaml"]);
			// One commit on top of the colleague's, carrying the same message.
			expect(git(fixture.mountPath, ["rev-parse", "HEAD~1"]).trim()).toBe(theirs);
			expect(git(fixture.mountPath, ["log", "-1", "--format=%B"])).toBe(pendingMessage);
			expect(git(fixture.originPath, ["rev-parse", fixture.branch]).trim()).toBe(result.commit ?? "");
			expect(readFileSync(path.join(fixture.mountPath, "generated/stamp.txt"), "utf8")).toBe(stamp);
			expect(existsSync(path.join(fixture.mountPath, "data/things/theirs.yaml"))).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a send the remote already has is reported as nothing to send", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "pushed behind our back"]);
			const head = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			// The push had in fact arrived; only the answer was lost.
			git(fixture.mountPath, ["push", "--quiet", "origin", `HEAD:${fixture.branch}`]);
			git(fixture.mountPath, ["update-ref", `refs/remotes/origin/${fixture.branch}`, `${head}~1`]);

			const result = await db.finishSend({ expectedHead: head });
			expect(result.state).toBe("nothing_to_publish");
			expect(db.status().state).toBe("published");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
