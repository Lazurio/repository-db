import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Collection, writeRecordDraft } from "../src/collections.ts";
import { assertDataPath, readDataFile } from "../src/dataPath.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { toStableYaml } from "../src/yamlIo.ts";
import { type FixtureRepo, createFixtureRepo } from "./fixtures.ts";

/**
 * Record files are read and written only inside the data checkout, through
 * real directories: a symbolic link anywhere below the mount root (data/
 * itself, a collection directory, a nested year directory, the file) is
 * refused, so a read never returns an outside file and a write never creates
 * one.
 */

const fixtures: FixtureRepo[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

const SENTINEL = toStableYaml({ schemaVersion: "thing.v3", id: "sentinel", record: { name: "OUTSIDE" } });

/** A checkout plus a directory outside it holding a sentinel record. */
function setup() {
	const fixture = createFixtureRepo();
	fixtures.push(fixture);
	const outside = path.join(fixture.root, "outside");
	mkdirSync(outside, { recursive: true });
	writeFileSync(path.join(outside, "sentinel.yaml"), SENTINEL, "utf8");
	return { fixture, mount: fixture.mountPath, outside };
}

function things(mount: string, directory?: string) {
	const db = RepositoryDb.open(mount);
	return db.collection<{ name: string }>("things", { schemaVersion: "thing.v3", ...(directory ? { directory } : {}) });
}

function outsideFiles(outside: string): string[] {
	return readdirSync(outside).sort();
}

function code(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
}

describe("a symlinked collection directory", () => {
	function linked() {
		const ctx = setup();
		rmSync(path.join(ctx.mount, "data/things"), { recursive: true, force: true });
		symlinkSync(ctx.outside, path.join(ctx.mount, "data/things"));
		return ctx;
	}

	test("get, has, list and listIds refuse it; the outside record is never returned", () => {
		const { mount } = linked();
		const collection: Collection<{ name: string }> = things(mount);
		expect(code(() => collection.get("sentinel"))).toBe("symlink_refused");
		expect(code(() => collection.has("sentinel"))).toBe("symlink_refused");
		expect(code(() => collection.list())).toBe("symlink_refused");
		expect(code(() => collection.listIds())).toBe("symlink_refused");
		expect(code(() => readDataFile(mount, "data/things/sentinel.yaml"))).toBe("symlink_refused");
	});

	test("put, remove and writeRecordDraft refuse it; nothing is created or removed outside", () => {
		const { mount, outside } = linked();
		const collection = things(mount);
		expect(code(() => collection.put("new", { name: "x" }))).toBe("symlink_refused");
		expect(code(() => collection.remove("sentinel"))).toBe("symlink_refused");
		expect(
			code(() =>
				writeRecordDraft(mount, path.join(mount, "data/things/raw.yaml"), {}, () =>
					writeFileSync(path.join(mount, "data/things/raw.yaml"), "x: 1\n"),
				),
			),
		).toBe("symlink_refused");
		expect(outsideFiles(outside)).toEqual(["sentinel.yaml"]);
	});
});

describe("a symlinked nested (year) directory", () => {
	function linked() {
		const ctx = setup();
		mkdirSync(path.join(ctx.mount, "data/forecasts"), { recursive: true });
		symlinkSync(ctx.outside, path.join(ctx.mount, "data/forecasts/2026"));
		return ctx;
	}

	test("a Collection on the nested directory refuses get, list and put", () => {
		const { mount, outside } = linked();
		const collection = things(mount, "forecasts/2026");
		expect(code(() => collection.get("sentinel"))).toBe("symlink_refused");
		expect(code(() => collection.list())).toBe("symlink_refused");
		expect(code(() => collection.put("q4", { name: "x" }))).toBe("symlink_refused");
		expect(outsideFiles(outside)).toEqual(["sentinel.yaml"]);
	});

	test("writeRecordDraft and readDataFile refuse a nested file below it", () => {
		const { mount, outside } = linked();
		const target = path.join(mount, "data/forecasts/2026/q4.yaml");
		let wrote = false;
		expect(code(() => writeRecordDraft(mount, target, { baseRevision: null }, () => (wrote = true)))).toBe(
			"symlink_refused",
		);
		expect(wrote).toBe(false);
		expect(code(() => readDataFile(mount, "data/forecasts/2026/sentinel.yaml"))).toBe("symlink_refused");
		expect(code(() => assertDataPath(mount, "data/forecasts/2026/q4.yaml"))).toBe("symlink_refused");
		expect(outsideFiles(outside)).toEqual(["sentinel.yaml"]);
	});
});

describe("data/ itself, the final file and paths outside the checkout", () => {
	test("a symlinked data/ directory is refused", () => {
		const { mount } = setup();
		rmSync(path.join(mount, "data"), { recursive: true, force: true });
		mkdirSync(path.join(mount, "..", "outside-data/things"), { recursive: true });
		symlinkSync(path.join(mount, "..", "outside-data"), path.join(mount, "data"));
		expect(code(() => things(mount).put("new", { name: "x" }))).toBe("symlink_refused");
		expect(existsSync(path.join(mount, "..", "outside-data/things/new.yaml"))).toBe(false);
	});

	test("a symlinked record file is refused for reading and writing", () => {
		const { mount, outside } = setup();
		symlinkSync(path.join(outside, "sentinel.yaml"), path.join(mount, "data/things/link.yaml"));
		expect(code(() => things(mount).get("link"))).toBe("symlink_refused");
		expect(code(() => readDataFile(mount, "data/things/link.yaml"))).toBe("symlink_refused");
		expect(code(() => things(mount).put("link", { name: "overwritten" }))).toBe("symlink_refused");
		expect(readDataFile(mount, "data/things/absent.yaml")).toBeNull();
	});

	test("a path outside the checkout is a boundary violation", () => {
		const { mount, outside } = setup();
		expect(code(() => readDataFile(mount, "../outside/sentinel.yaml"))).toBe("boundary_violation");
		expect(code(() => assertDataPath(mount, path.join(outside, "sentinel.yaml")))).toBe("boundary_violation");
		expect(
			code(() => writeRecordDraft(mount, path.join(outside, "new.yaml"), {}, () => writeFileSync(path.join(outside, "new.yaml"), "x"))),
		).toBe("boundary_violation");
		expect(outsideFiles(outside)).toEqual(["sentinel.yaml"]);
	});

	test("real directories and files work as before", () => {
		const { mount } = setup();
		const collection = things(mount, "forecasts/2026");
		collection.put("q4", { name: "real" });
		expect(collection.get("q4")?.record.name).toBe("real");
		expect(readDataFile(mount, "data/forecasts/2026/q4.yaml")).toContain("name: real");
		expect(assertDataPath(mount, "data/forecasts/2026/q4.yaml")).toBe(path.join(mount, "data/forecasts/2026/q4.yaml"));
	});
});
