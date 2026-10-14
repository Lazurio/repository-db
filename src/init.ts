import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE_NAME, CONFIG_SCHEMA_VERSION, configToYamlValue } from "./config.ts";
import { assertCredentials } from "./credentials.ts";
import { runGit, runGitAsync, runGitOrThrow } from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";
import { writeFileAtomic, toStableYaml } from "./yamlIo.ts";
import {
	type RepositoryDbConfig,
	RepositoryDbError,
} from "./types.ts";

export interface InitOptions {
	/** Application name; the data repo conventionally is `<app>-data`. */
	app: string;
	/** Remote URL of the data repo, e.g. git@github.com:Spectoda/deals-data.git */
	remote: string;
	/** Major-generation branch, e.g. `v3`. */
	branch: string;
	/** Absolute mount path, e.g. <workspace>/modules/deals/db */
	mountPath: string;
	schemaName: string;
	schemaVersion: string;
	/** Create the remote repo via `gh repo create` (private) before cloning. */
	createRemote?: boolean;
	/** Visibility used with --create-remote. Data repos default to private. */
	visibility?: "private" | "public";
}

function gh(args: string[]): { status: number; out: string } {
	const bin = process.env.REPOSITORY_DB_GH_BIN || "gh";
	const result = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env } });
	if (result.error) return { status: 127, out: result.error.message };
	return {
		status: result.status ?? 1,
		out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function remoteRepoSlug(remote: string): string | undefined {
	const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
	return match?.[1];
}

function assertSafeRemote(remote: string): void {
	if (!remote.trim() || remote.trim().startsWith("-")) {
		throw new RepositoryDbError(
			"invalid_remote",
			`remote URL must not be empty or start with "-": ${remote}`,
		);
	}
}

function assertSafeBranch(branch: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
		throw new RepositoryDbError(
			"invalid_branch",
			`branch name has unexpected format: ${branch}`,
		);
	}
}

const DEFAULT_GENERATED_DIR = "generated";

const DATA_REPO_GITIGNORE = `# repository-db local engine layer (lock, conflict state, caches) — never committed
/${ENGINE_DIR}/
# Derived output: an ignored cache repository-db rebuilds from data/ on every Environment
/${DEFAULT_GENERATED_DIR}/
node_modules/
.DS_Store
`;

function defaultReadme(options: InitOptions): string {
	return `# ${options.app}-data

Application data repository managed by [@lazurio/repository-db](https://github.com/Lazurio/repository-db).

- Major data generation = Git branch (current: \`${options.branch}\`). Later
  generations start as clean orphan branches (e.g. \`v4\`), not directories.
- \`data/\` holds canonical YAML collections (source of truth).
- \`generated/\` holds derived output declared in \`generated_manifest\` of
  \`${CONFIG_FILE_NAME}\`. It is ignored by Git: repository-db rebuilds it from
  \`data/\` whenever the data changed. Never read it from Git or treat it as a
  contract between modules; read \`data/\` or the owner's API instead.
- \`scripts/\` holds data-repo-local materializers and validators. They run
  with cwd = repo root and must not reach outside this repository.
- Writes happen as local drafts in the working tree; \`repository-db publish\`
  turns the current batch into one audited commit with Repository-Db-* trailers
  and pushes it.

Do not commit secrets, tokens or OAuth/session data. Credentials are provided
by the environment (gh credential store, deploy key, credential helper).
`;
}

export interface InitResult {
	mountPath: string;
	created: boolean;
	cloned: boolean;
	bootstrapped: boolean;
}

/**
 * Create or attach a data repo and mount it at an app-specific path.
 *
 * - With `createRemote`, creates the (default private) GitHub repo first.
 * - Clones the remote into the mount path when the path does not exist yet.
 * - On an empty repository, bootstraps the branch + structure
 *   (`data/`, `scripts/`, `${CONFIG_FILE_NAME}`, a `.gitignore` covering the
 *   engine layer and derived output) and pushes the
 *   initial commit so the generation branch exists on the remote.
 * - On a non-empty repository, verifies the checkout matches the expected
 *   branch and config.
 */
export async function initDataRepo(options: InitOptions): Promise<InitResult> {
	const mountPath = path.resolve(options.mountPath);
	assertSafeRemote(options.remote);
	assertSafeBranch(options.branch);
	await assertCredentials(options.remote);

	let created = false;
	if (options.createRemote) {
		const slug = remoteRepoSlug(options.remote);
		if (!slug) {
			throw new RepositoryDbError(
				"invalid_remote",
				`--create-remote requires a github.com remote, got: ${options.remote}`,
			);
		}
		const exists = gh(["repo", "view", slug, "--json", "name"]);
		if (exists.status !== 0) {
			const visibility = options.visibility ?? "private";
			const create = gh([
				"repo",
				"create",
				slug,
				`--${visibility}`,
				"--description",
				`${options.app} application data (repository-db managed, branch-per-major-version)`,
			]);
			if (create.status !== 0) {
				throw new RepositoryDbError(
					"create_remote_failed",
					`gh repo create ${slug} failed: ${create.out.trim()}`,
				);
			}
			created = true;
		}
	}

	let cloned = false;
	if (!existsSync(mountPath)) {
		mkdirSync(path.dirname(mountPath), { recursive: true });
		// `--` prevents option injection through a crafted remote URL
		// (CVE-2018-17456 family); library callers bypass the CLI flag guard.
		const clone = await runGitAsync(path.dirname(mountPath), [
			"clone",
			"--",
			options.remote,
			mountPath,
		]);
		if (clone.status !== 0) {
			throw new RepositoryDbError(
				"clone_failed",
				`git clone ${options.remote} failed: ${clone.stderr.trim()}`,
			);
		}
		cloned = true;
	}

	if (!existsSync(path.join(mountPath, ".git"))) {
		throw new RepositoryDbError(
			"mount_not_git",
			`mount path exists but is not a Git checkout: ${mountPath}`,
		);
	}

	// Empty repository (no commits yet) → bootstrap the generation branch.
	const headExists = runGit(mountPath, ["rev-parse", "--verify", "HEAD"]);
	let bootstrapped = false;
	if (headExists.status !== 0) {
		runGitOrThrow(mountPath, ["checkout", "-B", options.branch]);

		const config: RepositoryDbConfig = {
			schemaVersion: CONFIG_SCHEMA_VERSION,
			app: options.app,
			dataRepo: { remote: options.remote, branch: options.branch },
			schema: { name: options.schemaName, version: options.schemaVersion },
			layout: { data: "data", generated: DEFAULT_GENERATED_DIR, scripts: "scripts" },
			generatedManifest: [],
			validate: [],
		};
		writeFileAtomic(
			path.join(mountPath, CONFIG_FILE_NAME),
			toStableYaml(configToYamlValue(config)),
		);
		writeFileSync(path.join(mountPath, ".gitignore"), DATA_REPO_GITIGNORE, "utf8");
		writeFileSync(path.join(mountPath, "README.md"), defaultReadme(options), "utf8");
		for (const dir of ["data", "scripts"]) {
			mkdirSync(path.join(mountPath, dir), { recursive: true });
			writeFileSync(path.join(mountPath, dir, ".gitkeep"), "", "utf8");
		}

		runGitOrThrow(mountPath, ["add", "--all"]);
		runGitOrThrow(mountPath, [
			"commit",
			"--message",
			`${options.app}-data: bootstrap repository-db structure (branch ${options.branch})`,
		]);
		const push = await runGitAsync(mountPath, [
			"push",
			"--set-upstream",
			"origin",
			options.branch,
		]);
		if (push.status !== 0) {
			throw new RepositoryDbError(
				"bootstrap_push_failed",
				`git push --set-upstream origin ${options.branch} failed: ${push.stderr.trim() || push.stdout.trim()}`,
			);
		}
		bootstrapped = true;

		// Make the generation branch the default branch on GitHub remotes so
		// no active `main` data branch exists.
		const slug = remoteRepoSlug(options.remote);
		if (slug) {
			gh([
				"api",
				"--method",
				"PATCH",
				`repos/${slug}`,
				"-f",
				`default_branch=${options.branch}`,
			]);
		}
	} else {
		const branch = runGitOrThrow(mountPath, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]).trim();
		if (branch !== options.branch) {
			const checkout = runGit(mountPath, ["checkout", options.branch]);
			if (checkout.status !== 0) {
				throw new RepositoryDbError(
					"branch_mismatch",
					`data repo is on "${branch}" and branch "${options.branch}" cannot be checked out: ${checkout.stderr.trim()}`,
				);
			}
		}
	}

	return { mountPath, created, cloned, bootstrapped };
}
