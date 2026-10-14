import { realpathSync } from "node:fs";
import {
	gitCurrentBranch,
	gitOperationInProgress,
	gitRemoteUrl,
	gitToplevel,
} from "./git.ts";
import { BoundaryViolationError, type RepositoryDbConfig } from "./types.ts";

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
