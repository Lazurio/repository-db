import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadRepositoryDbConfig } from "../src/config.ts";
import { pullRemote } from "../src/publish.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { type SyncHost, createSyncHost } from "../src/syncHost.ts";
import { TrackedDerivedOutputError } from "../src/types.ts";
import {
	DERIVED_FILE,
	DERIVED_PATH,
	type FixtureRepo,
	cloneFixture,
	createDerivedFixture,
	git,
	writeFixtureDocument,
} from "./fixtures.ts";

/**
 * An Environment cloned its data checkout while the data repository still
 * tracked derived output. The data repository is migrated afterwards, as one
 * ordinary commit. The engine refuses to open the old checkout, so the commit
 * that fixes it has to come in through a pull that accepts exactly this case.
 */

const fixtures: FixtureRepo[] = [];
const hosts: SyncHost[] = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.stop();
	for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

/** `a` publishes old style; `env` clones then; `a` migrates afterwards when asked. */
function setup(): { fixture: FixtureRepo; a: string; env: string; migrate: () => void } {
	const fixture = createDerivedFixture();
	fixtures.push(fixture);
	const a = fixture.mountPath;
	writeFileSync(path.join(a, ".gitignore"), "/.repository-db/\n", "utf8");
	writeFixtureDocument(a, "r1", { code: "A" });
	expect(Bun.spawnSync(["sh", "scripts/materialize.sh"], { cwd: a }).exitCode).toBe(0);
	git(a, ["add", "--all"]);
	git(a, ["commit", "--message", "old style: derived output committed"]);
	git(a, ["push", "--quiet", "origin", fixture.branch]);
	const env = cloneFixture(fixture, "env");
	expect(git(env, ["ls-files", DERIVED_PATH]).trim()).toBe(DERIVED_FILE);
	const migrate = () => {
		let refused: unknown;
		try {
			RepositoryDb.open(a);
		} catch (error) {
			refused = error;
		}
		for (const command of (refused as TrackedDerivedOutputError).migration) {
			expect(Bun.spawnSync(["sh", "-c", command], { cwd: a }).exitCode).toBe(0);
		}
	};
	return { fixture, a, env, migrate };
}

function refusal(mountRoot: string): unknown {
	try {
		RepositoryDb.open(mountRoot);
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("a checkout cloned before its data repository was migrated", () => {
	test("a pull brings the migration in; the checkout then opens clean and rebuilds its cache", async () => {
		const { env, migrate } = setup();
		migrate();
		expect(refusal(env)).toBeInstanceOf(TrackedDerivedOutputError);
		expect((refusal(env) as Error).message).toContain("only needs to catch up");

		const pulled = await pullRemote(env, loadRepositoryDbConfig(env));
		expect(pulled.state).toBe("pulled");

		const db = RepositoryDb.open(env);
		expect(git(env, ["ls-files", DERIVED_PATH]).trim()).toBe("");
		expect(db.status().state).toBe("published");
		expect((await db.ensureGenerated()).rebuilt).toBe(true);
		expect(readFileSync(path.join(env, DERIVED_FILE), "utf8")).toContain("r1.yaml");
		expect(git(env, ["status", "--porcelain"])).toBe("");
	});

	test("a stale copy of the cache does not stand in the way, a data draft stays", async () => {
		const { env, migrate } = setup();
		migrate();
		// What an older engine left behind: the cache rebuilt in place, plus a draft.
		writeFileSync(path.join(env, DERIVED_FILE), "stale\n", "utf8");
		writeFixtureDocument(env, "mine", { code: "M" });

		expect((await pullRemote(env, loadRepositoryDbConfig(env))).state).toBe("pulled");

		const db = RepositoryDb.open(env);
		expect(db.status().dirtyPaths).toEqual(["data/things/mine.yaml"]);
		expect(existsSync(path.join(env, "data/things/mine.yaml"))).toBe(true);
	});

	test("while the published tip still tracks derived output, the pull refuses with the migration", async () => {
		const { env } = setup();
		const config = loadRepositoryDbConfig(env);
		const refused = await pullRemote(env, config).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(TrackedDerivedOutputError);
		expect((refused as TrackedDerivedOutputError).code).toBe("derived_output_tracked");
	});

	test("the sync host catches up on its own check and then serves the data", async () => {
		const { env, migrate } = setup();
		migrate();
		const host = createSyncHost({ mountRoot: env, intervalMs: 0 });
		hosts.push(host);

		const status = await host.refresh();
		expect(status.available).toBe(true);
		expect(status.sync?.state).toBe("published");
		expect(status.sync?.behind).toBe(0);
		expect(git(env, ["ls-files", DERIVED_PATH]).trim()).toBe("");
	});

	test("a sync host that does not pull leaves the old checkout as it is", async () => {
		const { env, migrate } = setup();
		migrate();
		const head = git(env, ["rev-parse", "HEAD"]).trim();
		const host = createSyncHost({ mountRoot: env, intervalMs: 0, autoPull: false });
		hosts.push(host);

		const status = await host.refresh();
		expect(status.available).toBe(false);
		expect(git(env, ["rev-parse", "HEAD"]).trim()).toBe(head);
	});
});

describe("a partially migrated published tip", () => {
	test("tracking engine files and derived output, a tip that drops only the engine files is refused", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const a = fixture.mountPath;
		writeFileSync(path.join(a, ".gitignore"), "", "utf8");
		writeFixtureDocument(a, "r1", { code: "A" });
		expect(Bun.spawnSync(["sh", "scripts/materialize.sh"], { cwd: a }).exitCode).toBe(0);
		mkdirSync(path.join(a, ".repository-db"), { recursive: true });
		writeFileSync(path.join(a, ".repository-db/draft-owner.json"), "{}\n", "utf8");
		git(a, ["add", "--all", "--force"]);
		git(a, ["commit", "--message", "old style: engine files and derived output committed"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);
		const env = cloneFixture(fixture, "env");

		git(a, ["rm", "-r", "--cached", "--quiet", "--", ".repository-db"]);
		writeFileSync(path.join(a, ".gitignore"), "/.repository-db/\n", "utf8");
		git(a, ["add", ".gitignore"]);
		git(a, ["commit", "--message", "stop tracking engine files only"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);

		const head = git(env, ["rev-parse", "HEAD"]).trim();
		const refused = await pullRemote(env, loadRepositoryDbConfig(env)).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(TrackedDerivedOutputError);
		expect(git(env, ["rev-parse", "HEAD"]).trim()).toBe(head);
	});
});
