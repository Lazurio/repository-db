import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { type SyncHost, type SyncHostEvent, createSyncHost } from "../src/syncHost.ts";
import { parseCommitMessage } from "../src/trailers.ts";
import {
	type FixtureRepo,
	cloneFixture,
	createDerivedFixture,
	git,
	writeFixtureDocument,
} from "./fixtures.ts";

/** Gaps a real consumer found when it moved onto the sync host. */

const fixtures: FixtureRepo[] = [];
const hosts: SyncHost[] = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.stop();
	for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

function setup() {
	const fixture = createDerivedFixture();
	fixtures.push(fixture);
	return { fixture, a: fixture.mountPath, b: cloneFixture(fixture, "b") };
}

function track(host: SyncHost): { host: SyncHost; events: SyncHostEvent[] } {
	hosts.push(host);
	const events: SyncHostEvent[] = [];
	host.subscribe((event) => events.push(event));
	return { host, events };
}

const PUBLISH = { actor: "Tester <tester@example.test>", source: "consumer-gap-test" };

describe("reads through the host never keep a facade that no longer fits the checkout", () => {
	test("a read that meets a changed configuration drops the facade; the next read opens the checkout again", async () => {
		const { fixture, a } = setup();
		const { host } = track(createSyncHost({ mountRoot: a, intervalMs: 0 }));
		await host.refresh();
		expect(await host.read((db) => db.config.layout.data)).toBe("data");

		// The checkout now holds a different data layout than the facade opened.
		const configPath = path.join(a, "repository-db.yaml");
		writeFileSync(configPath, readFileSync(configPath, "utf8").replace("data: data", "data: records"), "utf8");
		git(a, ["add", "--all"]);
		git(a, ["commit", "--message", "move the data layout"]);
		git(a, ["push", "--quiet", "origin", fixture.branch]);

		await expect(host.read((db) => db.config)).rejects.toMatchObject({ code: "config_changed" });
		// Forgotten: the next read opens the checkout as it is now.
		expect(await host.read((db) => db.config.layout.data)).toBe("records");
		expect(host.status().available).toBe(true);
	});

	test("a read while the checkout is missing fails with mount_unavailable and recovers when it appears", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const later = path.join(fixture.root, "later");
		const { host } = track(createSyncHost({ mountRoot: later, intervalMs: 0 }));
		await expect(host.read((db) => db.status())).rejects.toMatchObject({ code: "mount_unavailable" });
		cloneFixture(fixture, "later");
		expect((await host.read((db) => db.status())).state).toBe("published");
	});

	test("reads do not wait behind the mutation queue", async () => {
		const { a } = setup();
		const { host } = track(createSyncHost({ mountRoot: a, intervalMs: 0 }));
		let release: () => void = () => undefined;
		const blocked = host.run("write", () => new Promise<void>((resolve) => (release = resolve)));
		expect(await host.read((db) => db.status().state)).toBe("published");
		release();
		await blocked;
	});
});

describe("remote-pulled names records in layouts the app defines", () => {
	test("by default it names Collection files; an app's recordOf maps nested files too", async () => {
		const { a, b } = setup();
		const { host, events } = track(
			createSyncHost({
				mountRoot: b,
				intervalMs: 0,
				recordOf: (filePath, collectionRecord) => {
					const nested = filePath.match(/^data\/forecasts\/(\d{4})\/([^/]+)\.yaml$/);
					if (nested) return { collection: "forecasts", id: `${nested[1]}/${nested[2]}` };
					return collectionRecord;
				},
			}),
		);
		await host.refresh();

		mkdirSync(path.join(a, "data/forecasts/2026"), { recursive: true });
		writeFileSync(path.join(a, "data/forecasts/2026/q4.yaml"), "amount: 1\n", "utf8");
		writeFixtureDocument(a, "flat", { code: "F" });
		writeFileSync(path.join(a, "data/notes.txt"), "not a record\n", "utf8");
		const dbA = RepositoryDb.open(a);
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });

		await host.refresh();
		const pulled = events.find((event) => event.type === "remote-pulled");
		if (pulled?.type !== "remote-pulled") throw new Error("no remote-pulled event");
		expect(pulled.paths.sort()).toEqual([
			"data/forecasts/2026/q4.yaml",
			"data/notes.txt",
			"data/things/flat.yaml",
		]);
		expect(pulled.records).toEqual([
			{ collection: "forecasts", id: "2026/q4", path: "data/forecasts/2026/q4.yaml" },
			{ collection: "things", id: "flat", path: "data/things/flat.yaml" },
		]);
	});
});

describe("an app's recordOf that throws", () => {
	test("never turns a successful pull into a failure; the record falls back to the Collection layout and an error is reported", async () => {
		const { a, b } = setup();
		const { host, events } = track(
			createSyncHost({
				mountRoot: b,
				intervalMs: 0,
				recordOf: () => {
					throw new Error("unexpected layout");
				},
			}),
		);
		writeFixtureDocument(a, "theirs", { code: "T" });
		const dbA = RepositoryDb.open(a);
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });

		const result = await host.run("pull", (db) => db.pull());
		expect(result.state).toBe("pulled");
		const pulled = events.find((event) => event.type === "remote-pulled");
		if (pulled?.type !== "remote-pulled") throw new Error("no remote-pulled event");
		expect(pulled.records).toEqual([{ collection: "things", id: "theirs", path: "data/things/theirs.yaml" }]);
		const error = events.find((event) => event.type === "error");
		expect(error?.type === "error" && error.operation).toBe("recordOf");
	});
});

describe("publish without an explicit actor", () => {
	test("records the Environment's Git identity as the actor; an explicit actor still wins", async () => {
		const { a } = setup();
		const db = RepositoryDb.open(a);
		writeFixtureDocument(a, "first", { code: "A" });
		const result = await db.publish({ source: "consumer-gap-test", expectedRevision: db.draftRevision() });
		expect(result.state).toBe("published");
		const message = git(a, ["log", "-1", "--format=%B"]);
		expect(parseCommitMessage(message).trailers.actor).toBe("Repository Db Fixture <fixture@repository-db.test>");

		writeFixtureDocument(a, "second", { code: "B" });
		await db.publish({ ...PUBLISH, expectedRevision: db.draftRevision() });
		expect(parseCommitMessage(git(a, ["log", "-1", "--format=%B"])).trailers.actor).toBe(PUBLISH.actor);
	});

	test("an explicitly empty actor is still refused", async () => {
		const { a } = setup();
		const db = RepositoryDb.open(a);
		writeFixtureDocument(a, "first", { code: "A" });
		await expect(
			db.publish({ actor: "  ", source: "consumer-gap-test", expectedRevision: db.draftRevision() }),
		).rejects.toMatchObject({ code: "invalid_publish" });
	});
});
