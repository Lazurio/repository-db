import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { type SyncHostEvent, createSyncHost } from "../src/syncHost.ts";
import { RepositoryDbError } from "../src/types.ts";
import { type FixtureRepo, cloneFixture, createDerivedFixture, git, writeFixtureDocument } from "./fixtures.ts";

/**
 * A colleague can change repository-db.yaml itself: a stricter validator, a new
 * derived artifact, or — incompatibly — the data layout or the remote. A
 * checkout opened before that change must use the configuration it now holds,
 * never the one it parsed at open, and must refuse a change of its boundary.
 */

const fixtures: FixtureRepo[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

const PUBLISH = { actor: "Tester <tester@example.test>", source: "config-test" };

function setup() {
	const fixture = createDerivedFixture();
	fixtures.push(fixture);
	return { fixture, a: fixture.mountPath, b: cloneFixture(fixture, "b") };
}

/** A publishes a config whose validate list gains a rule rejecting code BAD. */
function publishStricterValidator(fixture: FixtureRepo, a: string): void {
	writeFileSync(
		path.join(a, "scripts/no-bad.sh"),
		"if cat data/things/*.yaml 2>/dev/null | grep -q '^  code: BAD$'; then echo 'BAD is not allowed' >&2; exit 5; fi\n",
		"utf8",
	);
	editConfig(a, (text) => text.replace("  - sh scripts/validate.sh", "  - sh scripts/validate.sh\n  - sh scripts/no-bad.sh"));
	git(a, ["add", "--all"]);
	git(a, ["commit", "--message", "stricter validator"]);
	git(a, ["push", "--quiet", "origin", fixture.branch]);
}

function editConfig(mountPath: string, edit: (text: string) => string): void {
	const file = path.join(mountPath, "repository-db.yaml");
	const before = readFileSync(file, "utf8");
	const after = edit(before);
	if (after === before) throw new Error("config edit did not apply");
	writeFileSync(file, after, "utf8");
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

const remoteHead = (fixture: FixtureRepo) => git(fixture.originPath, ["rev-parse", fixture.branch]).trim();

describe("a send validates the integrated result with the configuration it now holds", () => {
	test("a stricter validator a colleague published rejects the record: refused, nothing pushed, a validation conflict", async () => {
		const { fixture, a, b } = setup();
		const dbB = RepositoryDb.open(b); // opened before the colleague's change
		publishStricterValidator(fixture, a);
		const remoteBefore = remoteHead(fixture);

		writeFixtureDocument(b, "mine", { code: "BAD" });
		const refused = await errorOf(() => dbB.publish({ ...PUBLISH, expectedRevision: dbB.draftRevision() }));
		expect(refused.code).toBe("publish_conflict");
		const conflict = dbB.conflict();
		expect(conflict?.kind).toBe("validation");
		expect(conflict?.message).toContain("no-bad.sh");
		expect(git(b, ["rev-parse", "HEAD"]).trim()).toBe(conflict?.pendingHead ?? "");
		expect(remoteHead(fixture)).toBe(remoteBefore);
	});

	test("a colleague's change of the data layout fails closed: back to the confirmed commit, nothing pushed", async () => {
		const { fixture, a, b } = setup();
		const dbB = RepositoryDb.open(b);
		editConfig(a, (text) => text.replace("data: data", "data: records"));
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "move the data layout"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);
		const remoteBefore = remoteHead(fixture);

		writeFixtureDocument(b, "mine", { code: "M" });
		const refused = await errorOf(() => dbB.publish({ ...PUBLISH, expectedRevision: dbB.draftRevision() }));
		expect(refused.code).toBe("config_changed");
		expect(refused.message).toContain("layout.data");
		expect(git(b, ["log", "-1", "--format=%s"]).trim()).toContain("publish");
		expect(git(b, ["show", "HEAD:repository-db.yaml"])).toContain("data: data");
		expect(dbB.status().state).toBe("committed_not_pushed");
		expect(remoteHead(fixture)).toBe(remoteBefore);
	});

	test("a push that arrived although it reported failure, then a colleague's layout change: finishing refuses without moving", async () => {
		const { fixture, a, b } = setup();
		const dbB = RepositoryDb.open(b);
		// B's commit reached the remote, but B never heard back.
		writeFixtureDocument(b, "mine", { code: "M" });
		git(b, ["add", "--all"]);
		git(b, ["commit", "--message", "lost push"]);
		const pending = git(b, ["rev-parse", "HEAD"]).trim();
		git(b, ["push", "--quiet", "origin", `HEAD:${fixture.branch}`]);
		git(b, ["update-ref", `refs/remotes/origin/${fixture.branch}`, `${pending}~1`]);
		// A colleague then moves the data layout on top of it.
		git(a, ["pull", "--quiet", "--ff-only", "origin", fixture.branch]);
		editConfig(a, (text) => text.replace("data: data", "data: records"));
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "move the data layout"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);

		const refused = await errorOf(() => dbB.finishSend({ expectedHead: pending }));
		expect(refused.code).toBe("config_changed");
		expect(git(b, ["rev-parse", "HEAD"]).trim()).toBe(pending);
		expect(readFileSync(path.join(b, "repository-db.yaml"), "utf8")).toContain("data: data");
	});
});

describe("a pull brings in configuration, and the checkout uses it", () => {
	test("after the host pulls a stricter validator, the next publish uses the new rule", async () => {
		const { fixture, a, b } = setup();
		const host = createSyncHost({ mountRoot: b, intervalMs: 0 });
		await host.refresh(); // the facade exists before the change
		publishStricterValidator(fixture, a);
		expect((await host.refresh()).sync?.behind).toBe(0);
		expect(host.db().config.validate).toContain("sh scripts/no-bad.sh");

		writeFixtureDocument(b, "mine", { code: "BAD" });
		const refused = await errorOf(() =>
			host.run("publish", (db) => db.publish({ ...PUBLISH, expectedRevision: db.draftRevision() })),
		);
		expect(refused.code).toBe("validation_failed");
		expect(git(b, ["diff", "--cached", "--name-only"]).trim()).toBe("");
		host.stop();
	});

	test("a pull that would change the boundary is refused before anything moves", async () => {
		const { fixture, a, b } = setup();
		const dbB = RepositoryDb.open(b);
		const host = createSyncHost({ mountRoot: b, intervalMs: 0 });
		const events: SyncHostEvent[] = [];
		host.subscribe((event) => events.push(event));
		await host.refresh();
		editConfig(a, (text) => text.replace(`remote: ${fixture.originPath}`, "remote: git@example.test:other/data.git"));
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "point at another remote"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);
		const head = git(b, ["rev-parse", "HEAD"]).trim();

		const refused = await errorOf(() => dbB.pull());
		expect(refused.code).toBe("config_changed");
		expect(refused.message).toContain("data_repo.remote");
		expect(git(b, ["rev-parse", "HEAD"]).trim()).toBe(head);

		const status = await host.refresh();
		expect(status.sync?.behind).toBe(1);
		expect(git(b, ["rev-parse", "HEAD"]).trim()).toBe(head);
		const error = events.find((event) => event.type === "error");
		expect(error?.type === "error" && error.error.code).toBe("config_changed");
		host.stop();
	});

	test("an invalid incoming configuration is refused the same way", async () => {
		const { fixture, a, b } = setup();
		const dbB = RepositoryDb.open(b);
		editConfig(a, (text) => text.replace("schema_version: repository-db.config.v1", "schema_version: repository-db.config.v9"));
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "a config this engine cannot read"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);
		const head = git(b, ["rev-parse", "HEAD"]).trim();

		const refused = await errorOf(() => dbB.pull());
		expect(refused.code).toBe("config_changed");
		expect(refused.message).toContain("unsupported schema_version");
		expect(git(b, ["rev-parse", "HEAD"]).trim()).toBe(head);
	});
});

describe("derived output follows the configuration", () => {
	test("a changed materializer in the configuration makes the cache stale", async () => {
		const { fixture, a } = setup();
		const db = RepositoryDb.open(a);
		await db.ensureGenerated();
		expect((await db.ensureGenerated()).rebuilt).toBe(false);

		writeFileSync(
			path.join(a, "scripts/materialize-v2.sh"),
			"mkdir -p generated/summary && echo v2 > generated/summary/ids.txt\n",
			"utf8",
		);
		editConfig(a, (text) => text.replace("sh scripts/materialize.sh", "sh scripts/materialize-v2.sh"));
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "new materializer"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);

		const rebuilt = await db.ensureGenerated();
		expect(rebuilt.rebuilt).toBe(true);
		expect(rebuilt.ran).toEqual(["sh scripts/materialize-v2.sh"]);
		expect(readFileSync(path.join(a, "generated/summary/ids.txt"), "utf8")).toBe("v2\n");
	});
});
