import { realpathSync } from "node:fs";
import {
	gitCurrentBranch,
	gitOperationInProgress,
	gitRemoteUrl,
	gitToplevel,
	runGit,
} from "./git.ts";
import { BoundaryViolationError, type RepositoryDbConfig, RepositoryDbError } from "./types.ts";

/**
 * Normalize Git remote URLs so that the ssh and https spellings of the same
 * GitHub repository compare equal:
 *   git@github.com:example-org/deals-data.git
 *   https://github.com/example-org/deals-data.git
 *   ssh://git@github.com/example-org/deals-data
 * For non-GitHub/local remotes the absolute path is compared verbatim.
 */
export function normalizeRemoteUrl(url: string): string {
	let value = url.trim();
	const sshMatch = value.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
	if (sshMatch) {
		value = `https://${sshMatch[1]}/${sshMatch[2]}`;
	}
	if (/^https?:\/\//.test(value)) {
		return value.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
	}
	// Local/other remotes (filesystem paths) compare verbatim — paths can be
	// case-sensitive and a `.git` suffix is significant there.
	return value;
}

/**
 * Hard guard against operating in the wrong Git repository.
 *
 * The data checkout is a nested Git repo inside an already nested module
 * repo (e.g. modules/deals/db/ inside modules/deals/ inside the workspace
 * super-repo). A git command escaping the mount root would silently hit the
 * parent code repository, so every repository-db operation must pass here
 * first.
 */
/**
 * Where a push to `origin` really goes must be `data_repo.remote` too. Git
 * applies `remote.origin.pushurl` and `url.*.pushInsteadOf` / `insteadOf`
 * (from any config level) only when pushing, so the fetch URL alone does not
 * say it. `git remote get-url --push --all` expands them; every URL a push
 * would reach must match. Publish checks this before it commits, and the send
 * again right before it pushes.
 */
export function assertPushTarget(mountRoot: string, config: RepositoryDbConfig): void {
	const listed = runGit(mountRoot, ["remote", "get-url", "--push", "--all", "origin"]);
	const urls = listed.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
	if (listed.status !== 0 || urls.length === 0) {
		throw new BoundaryViolationError(
			`cannot tell where a push to "origin" goes; expected ${config.dataRepo.remote}`,
		);
	}
	const expected = normalizeRemoteUrl(config.dataRepo.remote);
	const diverted = urls.filter((url) => normalizeRemoteUrl(url) !== expected);
	if (diverted.length > 0) {
		throw new BoundaryViolationError(
			`a push to "origin" would go to ${diverted.map((url) => `"${url}"`).join(", ")}, but repository-db.yaml expects "${config.dataRepo.remote}". Remove remote.origin.pushurl or the url.*.pushInsteadOf / insteadOf rewrite that diverts it. Nothing was committed or pushed.`,
		);
	}
}

export function assertDataRepoBoundary(
	mountRoot: string,
	config: RepositoryDbConfig,
): void {
	let resolvedMount: string;
	try {
		resolvedMount = realpathSync(mountRoot);
	} catch {
		throw new BoundaryViolationError(
			`mount path does not exist: ${mountRoot}`,
		);
	}

	const toplevel = gitToplevel(resolvedMount);
	if (!toplevel) {
		throw new BoundaryViolationError(
			`mount path is not inside a Git repository: ${resolvedMount}`,
		);
	}
	const resolvedToplevel = realpathSync(toplevel);
	if (resolvedToplevel !== resolvedMount) {
		throw new BoundaryViolationError(
			`mount path is not the root of its Git repository (mount: ${resolvedMount}, repo root: ${resolvedToplevel}). ` +
				"Refusing to operate: this would target a parent repository such as the module code repo.",
		);
	}

	const remote = gitRemoteUrl(resolvedMount);
	if (!remote) {
		throw new BoundaryViolationError(
			`data repository has no "origin" remote; expected ${config.dataRepo.remote}`,
		);
	}
	if (normalizeRemoteUrl(remote) !== normalizeRemoteUrl(config.dataRepo.remote)) {
		throw new BoundaryViolationError(
			`origin remote mismatch: repository has "${remote}", repository-db.yaml expects "${config.dataRepo.remote}"`,
		);
	}
	assertPushTarget(resolvedMount, config);

	// A data repository without a first commit has no branch to check yet;
	// say so instead of failing in Git ("ambiguous argument 'HEAD'").
	if (runGit(resolvedMount, ["rev-parse", "--verify", "--quiet", "HEAD"]).status !== 0) {
		throw new RepositoryDbError(
			"empty_repository",
			`the data repository has no commits yet; publish or clone its first commit (branch ${config.dataRepo.branch}) before opening it`,
		);
	}

	const branch = gitCurrentBranch(resolvedMount);
	if (branch !== config.dataRepo.branch) {
		// A rebase/merge in progress detaches HEAD; the conflict machinery
		// (status, conflict --abort/--resolved) must still be able to operate.
		const detachedByOperation =
			branch === "HEAD" && gitOperationInProgress(resolvedMount) !== undefined;
		if (!detachedByOperation) {
			throw new BoundaryViolationError(
				`branch mismatch: checkout is on "${branch}", repository-db.yaml expects "${config.dataRepo.branch}"`,
			);
		}
	}
}
