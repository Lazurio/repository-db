import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { type SyncHost, type SyncHostEvent, type SyncHostOptions, createSyncHost } from "../src/syncHost.ts";
import {
	type FixtureRepo,
	cloneFixture,
	createDerivedFixture,
	git,
	writeFixtureDocument,
} from "./fixtures.ts";

/**
 * Gaps found in reviews of consumer apps: a host must not run a read or a
 * mutation on a checkout that is no longer what it opened, must report
 * colleagues' work whatever the app's callback returns, and must serve only
 * the data repository the app expects.
 */

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

function track(options: SyncHostOptions): { host: SyncHost; events: SyncHostEvent[] } {
	const host = createSyncHost({ intervalMs: 0, ...options });
	hosts.push(host);
	const events: SyncHostEvent[] = [];
	host.subscribe((event) => events.push(event));
	return { host, events };
}

const PUBLISH = { actor: "Tester <tester@example.test>", source: "host-binding-test" };

async function colleaguePublishes(a: string, id: string): Promise<void> {
	const db = RepositoryDb.open(a);
	writeFixtureDocument(a, id, { code: id.toUpperCase() });
	await db.publish({ ...PUBLISH, expectedRevision: db.draftRevision() });
}

describe("reads and mutations re-validate the live checkout before they run", () => {
	test("a removed repository-db.yaml stops reads and mutations with mount_unavailable; they work again once it is back", async () => {
		const { a } = setup();
		const { host } = track({ mountRoot: a });
		expect(await host.read((db) => db.status().state)).toBe("published");

		const configPath = path.join(a, "repository-db.yaml");
		const parked = path.join(a, "..", "parked-config.yaml");
		renameSync(configPath, parked);
		let ran = false;
		await expect(host.read(() => (ran = true))).rejects.toMatchObject({ code: "mount_unavailable" });
		await expect(host.run("write", () => (ran = true))).rejects.toMatchObject({ code: "mount_unavailable" });
		expect(ran).toBe(false);

		renameSync(parked, configPath);
		expect(await host.read((db) => db.status().state)).toBe("published");
	});

	test("a removed mount is mount_unavailable, not an untyped failure", async () => {
		const { fixture } = setup();
		const mount = cloneFixture(fixture, "removable");
		const { host } = track({ mountRoot: mount });
		await host.refresh();
		rmSync(mount, { recursive: true, force: true });
		await expect(host.read((db) => db.status())).rejects.toMatchObject({ code: "mount_unavailable" });
		expect(host.status().available).toBe(true); // the snapshot says what the last check saw
		expect((await host.refresh()).available).toBe(false);
	});

	test("a boundary change in the live configuration is config_changed before the read runs, and the next call opens anew", async () => {
		const { a } = setup();
		const { host } = track({ mountRoot: a });
		await host.read((db) => db.status());
		const configPath = path.join(a, "repository-db.yaml");
		writeFileSync(configPath, readFileSync(configPath, "utf8").replace("data: data", "data: records"), "utf8");

		let ran = false;
		await expect(host.read(() => (ran = true))).rejects.toMatchObject({ code: "config_changed" });
		expect(ran).toBe(false);
		expect(await host.read((db) => db.config.layout.data)).toBe("records");
	});
});

describe("remote-pulled does not depend on what the app's callback returns", () => {
	test("a publish that integrated colleagues' work announces it, even when the callback returns something else", async () => {
		const { a, b } = setup();
		const { host, events } = track({ mountRoot: b });
		await host.refresh();
		await colleaguePublishes(a, "theirs");

		writeFixtureDocument(b, "mine", { code: "M" });
		const wrapped = await host.run("publish", async (db) => {
			await db.publish({ ...PUBLISH, expectedRevision: db.draftRevision() });
			return { ok: true };
		});
		expect(wrapped).toEqual({ ok: true });
		const pulled = events.find((event) => event.type === "remote-pulled");
		if (pulled?.type !== "remote-pulled") throw new Error("no remote-pulled event");
		expect(pulled.paths).toEqual(["data/things/theirs.yaml"]);
	});

	test("a pull through a wrapped callback announces the incoming records", async () => {
		const { a, b } = setup();
		const { host, events } = track({ mountRoot: b });
		await host.refresh();
		await colleaguePublishes(a, "theirs");

		await host.run("pull", async (db) => {
			await db.pull();
		});
		const pulled = events.find((event) => event.type === "remote-pulled");
		if (pulled?.type !== "remote-pulled") throw new Error("no remote-pulled event");
		expect(pulled.records).toEqual([{ collection: "things", id: "theirs", path: "data/things/theirs.yaml" }]);
	});

	test("a fast-forward made through another facade inside run() is announced from the moved HEAD", async () => {
		const { a, b } = setup();
		const { host, events } = track({ mountRoot: b });
		await host.refresh();
		await colleaguePublishes(a, "theirs");

		await host.run("pull", async () => {
			await RepositoryDb.open(b).pull();
		});
		const pulled = events.find((event) => event.type === "remote-pulled");
		if (pulled?.type !== "remote-pulled") throw new Error("no remote-pulled event");
		expect(pulled.paths).toEqual(["data/things/theirs.yaml"]);
	});

	test("a pull through another facade under a draft still announces what its result names", async () => {
		const { a, b } = setup();
		const { host, events } = track({ mountRoot: b });
		await host.refresh();
		await colleaguePublishes(a, "theirs");
		writeFixtureDocument(b, "mine", { code: "M" }); // a draft: the HEAD fallback does not apply

		await host.run("pull", () => RepositoryDb.open(b).pull());
		const pulled = events.find((event) => event.type === "remote-pulled");
		if (pulled?.type !== "remote-pulled") throw new Error("no remote-pulled event");
		expect(pulled.paths).toEqual(["data/things/theirs.yaml"]);
	});

	test("a publish with nothing to integrate announces nothing", async () => {
		const { b } = setup();
		const { host, events } = track({ mountRoot: b });
		writeFixtureDocument(b, "mine", { code: "M" });
		await host.run("publish", (db) => db.publish({ ...PUBLISH, expectedRevision: db.draftRevision() }));
		expect(events.some((event) => event.type === "remote-pulled")).toBe(false);
	});
});

describe("a host bound to the data repository the app expects", () => {
	test("a checkout of another data repository is refused with boundary_violation; nothing is fetched or pulled", async () => {
		const { fixture, a, b } = setup();
		const { host } = track({
			mountRoot: b,
			expect: { remote: "git@example.test:other/data.git", branch: fixture.branch },
		});
		await colleaguePublishes(a, "theirs");
		const head = git(b, ["rev-parse", "HEAD"]).trim();
		const tracking = git(b, ["rev-parse", `origin/${fixture.branch}`]).trim();

		const status = await host.refresh();
		expect(status.available).toBe(false);
		expect(status.error?.code).toBe("boundary_violation");
		await expect(host.read((db) => db.status())).rejects.toMatchObject({ code: "boundary_violation" });
		await expect(host.run("pull", (db) => db.pull())).rejects.toMatchObject({ code: "boundary_violation" });
		expect(() => host.db()).toThrow(expect.objectContaining({ code: "boundary_violation" }));
		expect(git(b, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(git(b, ["rev-parse", `origin/${fixture.branch}`]).trim()).toBe(tracking);
	});

	test("the wrong branch is refused the same way, also for a checkout that appears after start", async () => {
		const { fixture } = setup();
		const later = path.join(fixture.root, "later");
		const { host } = track({ mountRoot: later, expect: { remote: fixture.originPath, branch: "v4" } });
		expect((await host.refresh()).available).toBe(false);
		cloneFixture(fixture, "later");
		const status = await host.refresh();
		expect(status.available).toBe(false);
		expect(status.error?.code).toBe("boundary_violation");
	});

	test("the expected data repository, in either remote spelling, is served", async () => {
		const { fixture, b } = setup();
		const { host } = track({ mountRoot: b, expect: { remote: fixture.originPath, branch: fixture.branch } });
		expect((await host.refresh()).available).toBe(true);
		expect(await host.read((db) => db.config.app)).toBe("fixture");
	});

	test("a config change that points the checkout elsewhere is refused before the read runs", async () => {
		const { fixture, b } = setup();
		const { host } = track({ mountRoot: b, expect: { remote: fixture.originPath, branch: fixture.branch } });
		await host.read((db) => db.status());
		const configPath = path.join(b, "repository-db.yaml");
		writeFileSync(
			configPath,
			readFileSync(configPath, "utf8").replace(`remote: ${fixture.originPath}`, "remote: git@example.test:other/data.git"),
			"utf8",
		);
		let ran = false;
		await expect(host.read(() => (ran = true))).rejects.toMatchObject({ code: "config_changed" });
		expect(ran).toBe(false);
		// Reopened, the checkout no longer matches what the app expects.
		await expect(host.read(() => (ran = true))).rejects.toMatchObject({ code: "boundary_violation" });
		expect(ran).toBe(false);
	});
});
