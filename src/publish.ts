import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import {
	assertNoActiveConflict,
	currentAutostashSha,
	writeConflictState,
} from "./conflict.ts";
import { assertCredentials } from "./credentials.ts";
import {
	gitAheadBehind,
	gitDirtyPaths,
	gitFetchAsync,
	gitHeadCommit,
	gitOperationInProgress,
	gitUnmergedPaths,
	runGit,
	runGitAsync,
	runGitOrThrow,
} from "./git.ts";
import {
	assertDeclaredGeneratedOnly,
	materializeGenerated,
	runValidateCommands,
} from "./generated.ts";
import { ENGINE_DIR, acquirePublishLock } from "./lock.ts";
import { clearDraftProvenance } from "./origin.ts";
import { buildCommitMessage, newChangeId } from "./trailers.ts";
import { writeFileAtomic } from "./yamlIo.ts";
import {
	type PublishOptions,
	type PublishResult,
	type RepositoryDbConfig,
	RepositoryDbError,
} from "./types.ts";

function defaultSubject(
	config: RepositoryDbConfig,
	dirtyPaths: string[],
	entities: string[] | undefined,
): string {
	const dataPrefix = `${config.layout.data}/`;
	const generatedPrefix = `${config.layout.generated}/`;
	const dataChanges = dirtyPaths.filter((p) => p.startsWith(dataPrefix)).length;
	const generatedChanges = dirtyPaths.filter((p) =>
		p.startsWith(generatedPrefix),
	).length;
	const otherChanges = dirtyPaths.length - dataChanges - generatedChanges;
	const parts: string[] = [];
	if (dataChanges > 0) parts.push(`${dataChanges} data file(s)`);
	if (generatedChanges > 0) parts.push(`${generatedChanges} generated file(s)`);
	if (otherChanges > 0) parts.push(`${otherChanges} other file(s)`);
	const entitySuffix =
		entities && entities.length > 0
			? ` [${entities.slice(0, 3).join(", ")}${entities.length > 3 ? ", …" : ""}]`
			: "";
	return `${config.app}: publish ${parts.join(", ") || "no changes"}${entitySuffix}`;
}

const PUBLISH_LOCK_RELATIVE_PATH = `${ENGINE_DIR}/publish.lock`;
const ENGINE_GITIGNORE_RULE = `/${ENGINE_DIR}/`;

function ensureEngineDirectoryIgnored(mountRoot: string): void {
	const gitignorePath = path.join(mountRoot, ".gitignore");
	const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
	if (existing.split(/\r?\n/).some((line) => line.trim() === ENGINE_GITIGNORE_RULE)) return;
	const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
	writeFileAtomic(gitignorePath, `${prefix}${ENGINE_GITIGNORE_RULE}\n`);
}

/**
 * Old repository-db versions could stage the runtime lock through `git add --all`.
 * Remove only that non-authoritative runtime file from the index while the lock is
 * held, then keep the engine directory ignored so the new lock cannot re-enter the
 * same publish batch. Conflict state remains protected by assertNoActiveConflict.
 */
function stageTrackedPublishLockCleanup(mountRoot: string): void {
	if (runGit(mountRoot, ["ls-files", "--error-unmatch", "--", PUBLISH_LOCK_RELATIVE_PATH]).status !== 0) {
		return;
	}
	ensureEngineDirectoryIgnored(mountRoot);
	runGitOrThrow(mountRoot, ["rm", "--cached", "--ignore-unmatch", "--", PUBLISH_LOCK_RELATIVE_PATH]);
}

function stagePublishBatch(mountRoot: string): void {
	runGitOrThrow(mountRoot, ["add", "--all"]);
	// `git add --all` stages tracked files even when they are ignored. Re-assert
	// the one-time deletion after staging so a runtime lock cannot be committed.
	stageTrackedPublishLockCleanup(mountRoot);
}

/**
 * Integrate already-fetched remote changes via `git rebase --autostash` with
 * conflict detection from the repository state. CAUTION: git exits 0 even when
 * applying the autostash produced conflicts ("Applying autostash resulted in
 * conflicts."), and committing that working tree would persist conflict
 * markers into canonical data — hence the explicit rebase/unmerged checks.
 * On conflict a recovery state (pre-pull HEAD + autostash SHA) is recorded,
 * further writes are blocked and a {@link RepositoryDbError} is thrown.
 * The caller must hold the publish lock.
 */
async function integrateRemoteChanges(
	mountRoot: string,
	config: RepositoryDbConfig,
	operation: "publish" | "pull",
): Promise<void> {
	const headBefore = gitHeadCommit(mountRoot);
	const remoteRef = `refs/remotes/origin/${config.dataRepo.branch}`;
	const rebase = await runGitAsync(mountRoot, [
		"rebase",
		"--autostash",
		remoteRef,
	]);
	const midOperation = gitOperationInProgress(mountRoot);
	const unmerged = gitUnmergedPaths(mountRoot);
	if (rebase.status !== 0 || midOperation || unmerged.length > 0) {
		const state = writeConflictState(mountRoot, {
			detectedAt: new Date().toISOString(),
			operation: `${operation}:rebase--autostash-fetched-remote`,
			gitState:
				[
					midOperation ? `in-progress: ${midOperation}` : undefined,
					unmerged.length > 0 ? `unmerged: ${unmerged.join(", ")}` : undefined,
					rebase.stderr.trim() || rebase.stdout.trim(),
				]
					.filter(Boolean)
					.join("\n") || "unknown",
			message: `${operation} stopped: conflict while integrating fetched remote changes (rebase --autostash ${remoteRef})`,
			preOperationHead: headBefore,
			autostashSha: currentAutostashSha(mountRoot),
		});
		throw new RepositoryDbError(
			`${operation}_conflict`,
			`${state.message}\n\n${state.handoff}`,
		);
	}
}

export interface PullResult {
	state: "up_to_date" | "pulled";
	/** Remote commits integrated by this pull. */
	behind: number;
}

/**
 * Fetch and integrate remote changes into the local checkout, preserving any
 * local draft via the autostash machinery (same conflict-safe path the
 * publish flow uses). Intended for the app's automatic background pull, so
 * remote publishes from other machines appear locally without manual git
 * work.
 *
 * The read-only fetch + ahead/behind probe runs lock-free so a coordinator's
 * background poll never trips `PublishLockedError` against a running publish.
 * The publish lock is taken only around the actual integration (when there
 * are remote commits to rebase in).
 */
export async function pullRemote(
	mountRoot: string,
	config: RepositoryDbConfig,
): Promise<PullResult> {
	assertDataRepoBoundary(mountRoot, config);
	assertNoActiveConflict(mountRoot);

	await gitFetchAsync(mountRoot);
	const { behind } = gitAheadBehind(mountRoot, config.dataRepo.branch);
	if (behind === 0) {
		return { state: "up_to_date", behind: 0 };
	}

	const releaseLock = acquirePublishLock(mountRoot);
	try {
		// A publish can finish with a recorded conflict after our lock-free fetch
		// but before this integration section starts. Re-check under the lock so
		// an auto-pull never integrates on top of an active conflict lane.
		assertNoActiveConflict(mountRoot);
		await integrateRemoteChanges(mountRoot, config, "pull");
		return { state: "pulled", behind };
	} finally {
		releaseLock();
	}
}

/**
 * Publish the current local draft batch as a single auditable commit:
 *
 *   boundary guard -> conflict guard -> credential preflight -> lock ->
 *   validate -> materialize generated -> generated policy check ->
 *   rebase against the already-fetched origin/<branch> with autostash -> git add
 *   (data, declared generated, scripts, config) -> single commit with
 *   deterministic trailers -> push.
 *
 * A rebase conflict stops the flow, records a conflict state with an agent
 * handoff and blocks further writes until explicit resolve/abort. The
 * default commit message is fully deterministic; an AI-assisted summary may
 * only replace `options.summary` upstream after explicit opt-in and never
 * touches the trailers.
 */
export async function publish(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: PublishOptions,
): Promise<PublishResult> {
	if (!options.actor?.trim()) {
		throw new RepositoryDbError("invalid_publish", "publish requires an actor");
	}
	if (!options.source?.trim()) {
		throw new RepositoryDbError("invalid_publish", "publish requires a source");
	}

	assertDataRepoBoundary(mountRoot, config);
	assertNoActiveConflict(mountRoot);
	assertCredentials(config.dataRepo.remote);

	// Refresh origin/<branch> before taking the publish lock. The locked section
	// rebases against this already-fetched ref, so no read-only network fetch is
	// hidden inside the publish-lock window.
	await gitFetchAsync(mountRoot);

	const releaseLock = acquirePublishLock(mountRoot);
	try {
		stageTrackedPublishLockCleanup(mountRoot);
		if (!options.skipValidate) {
			runValidateCommands(mountRoot, config);
		}
		if (!options.skipMaterialize) {
			materializeGenerated(mountRoot, config);
		}
		assertDeclaredGeneratedOnly(mountRoot, config);

		const dirtyPaths = gitDirtyPaths(mountRoot).filter(
			(entry) => !entry.startsWith(`${ENGINE_DIR}/`),
		);
		if (dirtyPaths.length === 0) {
			// Recovery path: a previous publish committed but could not push
			// (or a conflict was resolved into a local commit). Just push.
			const { ahead } = gitAheadBehind(mountRoot, config.dataRepo.branch);
			if (ahead > 0) {
				const pushOnly = await runGitAsync(mountRoot, [
					"push",
					"origin",
					`${config.dataRepo.branch}:${config.dataRepo.branch}`,
				]);
				if (pushOnly.status !== 0) {
					throw new RepositoryDbError(
						"publish_push_failed",
						`git push failed; local commits stay unpushed (committed_not_pushed). Detail: ${pushOnly.stderr.trim()}`,
					);
				}
				// The draft that the provenance markers described is now published.
				clearDraftProvenance(mountRoot);
				return {
					state: "published",
					commit: gitHeadCommit(mountRoot),
					pushedTo: `${config.dataRepo.remote}#${config.dataRepo.branch}`,
				};
			}
			return { state: "nothing_to_publish" };
		}

		// Integrate remote changes before committing the local batch.
		await integrateRemoteChanges(mountRoot, config, "publish");

		// Stage the publishable batch while preserving the runtime engine layer.
		stagePublishBatch(mountRoot);

		const staged = runGitOrThrow(mountRoot, ["diff", "--cached", "--name-only"])
			.split("\n")
			.filter(Boolean);
		if (staged.length === 0) {
			return { state: "nothing_to_publish" };
		}

		const changeId = newChangeId();
		const message = buildCommitMessage(
			options.summary?.trim() ||
				defaultSubject(config, dirtyPaths, options.entities),
			{
				app: config.app,
				dataRepo: config.dataRepo.remote,
				branch: config.dataRepo.branch,
				schemaVersion: `${config.schema.name}@${config.schema.version}`,
				actor: options.actor,
				machine: os.hostname(),
				source: options.source,
				changeId,
				entities: options.entities,
			},
		);
		runGitOrThrow(mountRoot, ["commit", "--message", message]);

		const push = await runGitAsync(mountRoot, [
			"push",
			"origin",
			`${config.dataRepo.branch}:${config.dataRepo.branch}`,
		]);
		if (push.status !== 0) {
			// Not a conflict: the batch is committed locally and the next
			// publish retries fetched-remote rebase + push. Writes stay allowed.
			throw new RepositoryDbError(
				"publish_push_failed",
				`git push failed; the publish batch stays local (committed_not_pushed). ` +
					`Re-run publish to retry. Detail: ${push.stderr.trim() || push.stdout.trim()}`,
			);
		}

		clearDraftProvenance(mountRoot);
		return {
			state: "published",
			commit: gitHeadCommit(mountRoot),
			changeId,
			pushedTo: `${config.dataRepo.remote}#${config.dataRepo.branch}`,
		};
	} finally {
		releaseLock();
	}
}
