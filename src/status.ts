import { assertDataRepoBoundary } from "./boundary.ts";
import { activeConflict } from "./conflict.ts";
import {
	gitAheadBehind,
	gitCurrentBranch,
	gitDirtyPaths,
	gitFetchAsync,
	gitHeadCommit,
} from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";
import type { RepositoryDbConfig, SyncStatus } from "./types.ts";

export interface StatusOptions {
	/** Run `git fetch origin` first so `behind` reflects the actual remote. */
	fetch?: boolean;
}

/** Local-only status read (no network); shared by the sync and async paths. */
function computeSyncStatus(
	mountRoot: string,
	config: RepositoryDbConfig,
	fetched: boolean,
): SyncStatus {
	const conflict = activeConflict(mountRoot);
	const branch = gitCurrentBranch(mountRoot);
	const dirtyPaths = gitDirtyPaths(mountRoot).filter(
		(entry) => !entry.startsWith(`${ENGINE_DIR}/`),
	);
	const { ahead, behind } = gitAheadBehind(mountRoot, config.dataRepo.branch);

	const state = conflict
		? "conflict"
		: dirtyPaths.length > 0
			? "draft"
			: ahead > 0
				? "committed_not_pushed"
				: behind > 0
					? "pull_needed"
					: "published";

	return {
		state,
		branch,
		ahead,
		behind,
		dirtyPaths,
		head: gitHeadCommit(mountRoot) ?? null,
		conflict: Boolean(conflict),
		fetched,
	};
}

/**
 * Local sync state of a data checkout, read from the working tree without any
 * network. Use {@link deriveSyncStatusAsync} when a fresh `behind` count is
 * needed — `git fetch` is a network op and must not block the event loop.
 *
 * Priority: conflict > draft > committed_not_pushed > pull_needed > published.
 */
export function deriveSyncStatus(
	mountRoot: string,
	config: RepositoryDbConfig,
): SyncStatus {
	assertDataRepoBoundary(mountRoot, config);
	return computeSyncStatus(mountRoot, config, false);
}

/**
 * Same as {@link deriveSyncStatus} but optionally runs an async `git fetch`
 * first so `behind` reflects the actual remote.
 */
export async function deriveSyncStatusAsync(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: StatusOptions = {},
): Promise<SyncStatus> {
	assertDataRepoBoundary(mountRoot, config);

	let fetched = false;
	if (options.fetch) {
		await gitFetchAsync(mountRoot);
		fetched = true;
	}

	return computeSyncStatus(mountRoot, config, fetched);
}
