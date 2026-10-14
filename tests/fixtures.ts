import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE_NAME } from "../src/config.ts";
import { toStableYaml } from "../src/yamlIo.ts";

export interface FixtureRepo {
	root: string;
	originPath: string;
	mountPath: string;
	branch: string;
}

export function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if ((result.status ?? 1) !== 0) {
		throw new Error(
			`fixture git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout;
}

function configureIdentity(repoPath: string): void {
	git(repoPath, ["config", "user.email", "fixture@repository-db.test"]);
	git(repoPath, ["config", "user.name", "Repository Db Fixture"]);
}

export function fixtureConfigValue(
	originPath: string,
	branch: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema_version: "repository-db.config.v1",
		app: "fixture",
		data_repo: { remote: originPath, branch },
		schema: { name: "fixture-data", version: "3.0.0-alpha.0" },
		layout: { data: "data", generated: "generated", scripts: "scripts" },
		generated_manifest: [],
		validate: [],
		...overrides,
	};
}

/**
 * Create a bare origin + a working clone bootstrapped with the
 * repository-db structure on the given generation branch and push it.
 */
export function createFixtureRepo(branch = "v3"): FixtureRepo {
	const root = mkdtempSync(path.join(os.tmpdir(), "repository-db-test-"));
	const originPath = path.join(root, "origin.git");
	mkdirSync(originPath);
	git(root, ["init", "--bare", "--initial-branch", branch, "origin.git"]);

	const mountPath = path.join(root, "mount");
	git(root, ["clone", originPath, "mount"]);
	configureIdentity(mountPath);
	git(mountPath, ["checkout", "-B", branch]);

	writeFileSync(
		path.join(mountPath, CONFIG_FILE_NAME),
		toStableYaml(fixtureConfigValue(originPath, branch)),
		"utf8",
	);
	writeFileSync(
		path.join(mountPath, ".gitignore"),
		"/.repository-db/\n",
		"utf8",
	);
	for (const dir of ["data/things", "generated", "scripts"]) {
		mkdirSync(path.join(mountPath, dir), { recursive: true });
	}
	writeFileSync(path.join(mountPath, "data/things/.gitkeep"), "", "utf8");
	writeFileSync(path.join(mountPath, "generated/.gitkeep"), "", "utf8");
	writeFileSync(path.join(mountPath, "scripts/.gitkeep"), "", "utf8");

	git(mountPath, ["add", "--all"]);
	git(mountPath, ["commit", "--message", "fixture: bootstrap"]);
	git(mountPath, ["push", "--set-upstream", "origin", branch]);
	return { root, originPath, mountPath, branch };
}

/** Second working clone of the same origin (for divergence/conflict tests). */
export function cloneFixture(fixture: FixtureRepo, name = "second"): string {
	const clonePath = path.join(fixture.root, name);
	git(fixture.root, ["clone", fixture.originPath, name]);
	configureIdentity(clonePath);
	git(clonePath, ["checkout", fixture.branch]);
	return clonePath;
}

export function writeFixtureDocument(
	mountPath: string,
	id: string,
	value: Record<string, unknown>,
): string {
	const filePath = path.join(
		mountPath,
		"data/things",
		`${encodeURIComponent(id)}.yaml`,
	);
	writeFileSync(
		filePath,
		toStableYaml({ schemaVersion: "thing.v3", id, record: value }),
		"utf8",
	);
	return filePath;
}

/** A fake `gh` binary that always fails (credential preflight tests). */
export function fakeFailingGh(root: string): string {
	const binPath = path.join(root, "fake-gh");
	writeFileSync(binPath, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
	return binPath;
}

/** Repo-relative path of the derived artifact the derived fixture declares. */
export const DERIVED_PATH = "generated/summary";
export const DERIVED_FILE = "generated/summary/ids.txt";

/**
 * Fixture with derived output, built the way real data repos build it: a
 * materializer and a validator that live in the data repo and run with
 * cwd = the checkout.
 *
 *   - the materializer lists the records into generated/summary/ids.txt and
 *     fails when a record named `broken` exists;
 *   - the validator refuses two records sharing one `code`, which each side of
 *     a concurrent publish can pass on its own while their union does not.
 */
export function createDerivedFixture(branch = "v3"): FixtureRepo {
	const root = mkdtempSync(path.join(os.tmpdir(), "repository-db-test-"));
	const originPath = path.join(root, "origin.git");
	mkdirSync(originPath);
	git(root, ["init", "--bare", "--initial-branch", branch, "origin.git"]);

	const mountPath = path.join(root, "mount");
	git(root, ["clone", originPath, "mount"]);
	configureIdentity(mountPath);
	git(mountPath, ["checkout", "-B", branch]);

	writeFileSync(
		path.join(mountPath, CONFIG_FILE_NAME),
		toStableYaml(
			fixtureConfigValue(originPath, branch, {
				generated_manifest: [{ path: DERIVED_PATH, materializer: "sh scripts/materialize.sh" }],
				validate: ["sh scripts/validate.sh"],
			}),
		),
		"utf8",
	);
	writeFileSync(path.join(mountPath, ".gitignore"), "/.repository-db/\n/generated/\n", "utf8");
	for (const dir of ["data/things", "scripts"]) {
		mkdirSync(path.join(mountPath, dir), { recursive: true });
	}
	writeFileSync(path.join(mountPath, "data/things/.gitkeep"), "", "utf8");
	writeFileSync(
		path.join(mountPath, "scripts/materialize.sh"),
		[
			"set -e",
			"if [ -f data/things/broken.yaml ]; then echo 'broken record' >&2; exit 3; fi",
			`mkdir -p ${DERIVED_PATH}`,
			`ls data/things | grep '\\.yaml$' | sort > ${DERIVED_FILE}`,
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		path.join(mountPath, "scripts/validate.sh"),
		[
			"set -e",
			"dups=$(cat data/things/*.yaml 2>/dev/null | grep '^  code:' | sort | uniq -d)",
			'if [ -n "$dups" ]; then echo "duplicate code: $dups" >&2; exit 4; fi',
			"",
		].join("\n"),
		"utf8",
	);
	git(mountPath, ["add", "--all"]);
	git(mountPath, ["commit", "--message", "fixture: bootstrap with derived output"]);
	git(mountPath, ["push", "--set-upstream", "origin", branch]);
	return { root, originPath, mountPath, branch };
}
