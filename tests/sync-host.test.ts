import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { type SyncHost, type SyncHostEvent, createSyncHost } from "../src/syncHost.ts";
import {
	type FixtureRepo,
	cloneFixture,
	createDerivedFixture,
	git,
	writeFixtureDocument,
} from "./fixtures.ts";

const fixtures: FixtureRepo[] = [];
const hosts: SyncHost[] = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.stop();
	for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

function host(mountRoot: string): { host: SyncHost; events: SyncHostEvent[] } {
	const created = createSyncHost({ mountRoot, intervalMs: 0 });
	hosts.push(created);
	const events: SyncHostEvent[] = [];
	created.subscribe((event) => events.push(event));
	return { host: created, events };
}

const PUBLISH = { actor: "Tester <tester@example.test>", source: "host-test" };

describe("host sync service", () => {
	test("started before the data checkout exists, it recovers on the first check after the checkout appears", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const later = path.join(fixture.root, "later");
		const { host: service, events } = host(later);
		service.start();

		const before = await service.refresh();
		expect(before.available).toBe(false);
		expect(() => service.db()).toThrow(/not available yet/);
		await expect(service.run("write", () => "never")).rejects.toThrow(/not available yet/);

		cloneFixture(fixture, "later");
		const after = await service.refresh();
		expect(after.available).toBe(true);
		expect(after.sync?.state).toBe("published");
		expect(after.revision).toStartWith("draft:");
		expect(events.some((event) => event.type === "status" && event.status.available)).toBe(true);
		expect(await service.run("read", (db) => db.mountRoot)).toBe(later);
	});

	test("auto-pull under a draft of another record brings colleagues' work in and says which records came", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const b = cloneFixture(fixture, "b");
		const { host: service, events } = host(b);
		writeFixtureDocument(b, "mine", { code: "M" });
		const drafted = readFileSync(path.join(b, "data/things/mine.yaml"), "utf8");

		const dbA = RepositoryDb.open(fixture.mountPath);
		writeFixtureDocument(fixture.mountPath, "theirs", { code: "T" });
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });

		const status = await service.refresh();
		const pulled = events.find((event) => event.type === "remote-pulled");
		expect(pulled?.type).toBe("remote-pulled");
		if (pulled?.type !== "remote-pulled") throw new Error("no remote-pulled event");
		expect(pulled.paths).toEqual(["data/things/theirs.yaml"]);
		expect(pulled.records).toEqual([{ collection: "things", id: "theirs", path: "data/things/theirs.yaml" }]);
		expect(status.sync?.behind).toBe(0);
		expect(status.sync?.dirtyPaths).toEqual(["data/things/mine.yaml"]);
		expect(readFileSync(path.join(b, "data/things/mine.yaml"), "utf8")).toBe(drafted);
	});

	test("a pull refused under a draft of the same record is reported with the records, and the draft stays", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const dbA = RepositoryDb.open(fixture.mountPath);
		writeFixtureDocument(fixture.mountPath, "shared", { code: "S", x: 1 });
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });
		const b = cloneFixture(fixture, "b");
		const { host: service, events } = host(b);

		writeFixtureDocument(fixture.mountPath, "shared", { code: "S", x: 2 });
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });
		writeFixtureDocument(b, "shared", { code: "S", x: 3 });

		const status = await service.refresh();
		expect(status.sync?.behind).toBe(1);
		expect(status.pullBlocked?.paths).toEqual(["data/things/shared.yaml"]);
		expect(events.some((event) => event.type === "remote-pulled")).toBe(false);
		expect(readFileSync(path.join(b, "data/things/shared.yaml"), "utf8")).toContain("x: 3");

		// Reverting that record lifts the block at once, and the next check pulls.
		await service.run("discard", (db) =>
			db.discard({
				scope: { kind: "record", path: "data/things/shared.yaml" },
				expectedRevision: db.draftRevision(),
			}),
		);
		expect(service.status().pullBlocked).toBeNull();
		expect((await service.refresh()).sync?.behind).toBe(0);
		expect(readFileSync(path.join(b, "data/things/shared.yaml"), "utf8")).toContain("x: 2");
	});

	test("mutations run one after another, also across two hosts of the same checkout", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const first = host(fixture.mountPath).host;
		const second = host(fixture.mountPath).host;
		const trace: string[] = [];
		const step = (name: string, ms: number) => async () => {
			trace.push(`${name}:start`);
			await new Promise((resolve) => setTimeout(resolve, ms));
			trace.push(`${name}:end`);
			return name;
		};

		const results = await Promise.all([
			first.run("write", step("one", 40)),
			second.run("write", step("two", 5)),
			first.run("write", step("three", 1)),
		]);
		expect(results).toEqual(["one", "two", "three"]);
		expect(trace).toEqual(["one:start", "one:end", "two:start", "two:end", "three:start", "three:end"]);

		// A failing mutation does not stop the queue.
		await expect(first.run("write", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		expect(await first.run("write", () => "after")).toBe("after");
	});

	test("a publish through the host refreshes the status and announces a conflict", async () => {
		const fixture = createDerivedFixture();
		fixtures.push(fixture);
		const b = cloneFixture(fixture, "b");
		const { host: service, events } = host(b);
		await service.refresh();

		// The colleague publishes first; together the two records break the
		// validator, which only the integrated result in the live checkout shows.
		const dbA = RepositoryDb.open(fixture.mountPath);
		writeFixtureDocument(fixture.mountPath, "first", { code: "DUP" });
		await dbA.publish({ ...PUBLISH, expectedRevision: dbA.draftRevision() });
		writeFixtureDocument(b, "second", { code: "DUP" });
		await expect(
			service.run("publish", (db) => db.publish({ ...PUBLISH, expectedRevision: db.draftRevision() })),
		).rejects.toThrow(/failed validation/);

		const conflict = events.find((event) => event.type === "conflict");
		if (conflict?.type !== "conflict") throw new Error("no conflict event");
		expect(conflict.conflict.kind).toBe("validation");
		expect(service.status().sync?.state).toBe("conflict");
		expect(service.status().conflict?.pendingHead).toBe(git(b, ["rev-parse", "HEAD"]).trim());
	});
});
