import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertDataRepoBoundary, normalizeRemoteUrl } from "../src/boundary.ts";
import { CONFIG_FILE_NAME, parseRepositoryDbConfig } from "../src/config.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { toStableYaml } from "../src/yamlIo.ts";
import { createFixtureRepo, fixtureConfigValue, git } from "./fixtures.ts";

describe("git boundary guard", () => {
	test("normalizes ssh and https remote spellings to the same identity", () => {
		expect(normalizeRemoteUrl("git@github.com:example-org/deals-data.git")).toBe(
			normalizeRemoteUrl("https://github.com/example-org/deals-data"),
		);
		expect(normalizeRemoteUrl("ssh://git@github.com/example-org/deals-data.git")).toBe(
			normalizeRemoteUrl("https://github.com/example-org/Deals-Data.git"),
		);
		expect(normalizeRemoteUrl("/tmp/origin.git")).toBe("/tmp/origin.git");
		expect(normalizeRemoteUrl("/tmp/Origin.git")).not.toBe("/tmp/origin.git");
	});

	test("accepts a correct mount", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			expect(db.config.app).toBe("fixture");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses to operate from a parent repository", () => {
		const fixture = createFixtureRepo();
		try {
			// Simulate the modules/deals situation: a parent Git repo containing
			// the data checkout in a subdirectory, with a stray config at its
			// root pointing at the data repo.
			const parent = path.join(fixture.root, "parent");
			mkdirSync(parent, { recursive: true });
			git(fixture.root, ["init", "parent"]);
			const config = parseRepositoryDbConfig(
				fixtureConfigValue(fixture.originPath, fixture.branch),
			);
			writeFileSync(
				path.join(parent, CONFIG_FILE_NAME),
				toStableYaml(fixtureConfigValue(fixture.originPath, fixture.branch)),
				"utf8",
			);
			const nested = path.join(parent, "db");
			mkdirSync(nested);
			expect(() => assertDataRepoBoundary(nested, config)).toThrow(
				/not the root of its Git repository/,
			);
			// Parent repo root itself: remote mismatch (parent has no origin).
			expect(() => assertDataRepoBoundary(parent, config)).toThrow(
				/no "origin" remote/,
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses a wrong remote", () => {
		const fixture = createFixtureRepo();
		try {
			const config = parseRepositoryDbConfig(
				fixtureConfigValue("git@github.com:example-org/other-data.git", fixture.branch),
			);
			expect(() => assertDataRepoBoundary(fixture.mountPath, config)).toThrow(
				/origin remote mismatch/,
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses a wrong branch", () => {
		const fixture = createFixtureRepo();
		try {
			git(fixture.mountPath, ["checkout", "-b", "feature"]);
			const config = parseRepositoryDbConfig(
				fixtureConfigValue(fixture.originPath, fixture.branch),
			);
			expect(() => assertDataRepoBoundary(fixture.mountPath, config)).toThrow(
				/branch mismatch/,
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses option-injection shaped remotes and branches", () => {
		expect(() =>
			parseRepositoryDbConfig(
				fixtureConfigValue("--upload-pack=/tmp/evil", "v3"),
			),
		).toThrow(/must not start with "-"/);
		expect(() =>
			parseRepositoryDbConfig(fixtureConfigValue("/tmp/origin.git", "-evil")),
		).toThrow(/unexpected format/);
	});

	test("status reports paths with unusual characters verbatim", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const weirdPath = path.join(
				fixture.mountPath,
				"data/things",
				"weird\tname č.yaml",
			);
			writeFileSync(weirdPath, "schemaVersion: thing.v3\nid: weird\nrecord: {}\n", "utf8");
			const status = db.status();
			expect(status.dirtyPaths).toContain("data/things/weird\tname č.yaml");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses a directory without repository-db.yaml", () => {
		const fixture = createFixtureRepo();
		try {
			expect(() => RepositoryDb.open(fixture.root)).toThrow(
				/repository-db.yaml not found/,
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses a config with an unsupported schema_version", () => {
		expect(() =>
			parseRepositoryDbConfig(fixtureConfigValue("/tmp/origin.git", "v3", { schema_version: "repository-db.config.v2" })),
		).toThrow(/unsupported schema_version "repository-db.config.v2"/);
		expect(() => parseRepositoryDbConfig(fixtureConfigValue("/tmp/origin.git", "v3", { schema_version: undefined }))).toThrow(
			/schema_version/,
		);
	});
});
