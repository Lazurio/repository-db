import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import { assertNoActiveConflict, writeConflictState } from "./conflict.ts";
import { assertCredentials } from "./credentials.ts";
import { DraftChangedError } from "./discard.ts";
import { computeDraftRevision } from "./draftRevision.ts";
import {
	gitAheadBehind,
	gitDirtyPaths,
	gitFetchAsync,
	gitHeadCommit,
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
import {
	type FinishSendOptions,
	type PublishOptions,
	type PublishResult,
	type RepositoryDbConfig,
	RepositoryDbError,
} from "./types.ts";

/**
 * The publish lifecycle, owned here and nowhere else:
 *
 *   publish(revision)   gate -> confirm revision -> validate -> materialize ->
 *                       commit the draft -> send
 *   finishSend(head)    gate -> confirm head, no new draft -> send
 *   send (private)      fetch -> integrate a moved remote in a separate lane
 *                       worktree -> move the checkout to the result -> push
 *   pullRemote          fast-forward only; never merges into local work
 *
 * The live checkout is never left mid-rebase. Remote changes are integrated in
 * a temporary worktree; the checkout moves only when that succeeded, and with
 * `reset --keep`, which refuses rather than overwrites anything unexpected.
 * Every step runs inside the shared gate, so no supported write can land
 * between the confirmation and the push.
 */

function engineDirFree(paths: string[]): string[] {
	return paths.filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`));
}

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

function requireText(value: string | undefined, message: string): void {
	if (typeof value !== "string" || !value.trim()) {
		throw new RepositoryDbError("invalid_publish", message);
	}
}

function gated<T>(mountRoot: string, run: () => Promise<T>): Promise<T> {
	const release = acquirePublishLock(mountRoot);
	return run().finally(release);
}

type LaneResult =
	| { ok: true; head: string }
	| { ok: false; paths: string[]; detail: string };

/**
 * Replay the local commits onto the fetched remote in a throwaway worktree.
 * Whatever happens there, the live checkout is untouched.
 */
async function rebaseInLane(
	mountRoot: string,
	start: string,
	onto: string,
): Promise<LaneResult> {
	const parent = mkdtempSync(path.join(os.tmpdir(), "repository-db-lane-"));
	const laneRoot = path.join(parent, "lane");
	runGitOrThrow(mountRoot, ["worktree", "add", "--detach", laneRoot, start]);
	try {
		const rebase = await runGitAsync(laneRoot, ["rebase", onto]);
		const unmerged = gitUnmergedPaths(laneRoot);
		if (rebase.status !== 0 || unmerged.length > 0) {
			return {
				ok: false,
				paths: unmerged,
				detail: rebase.stderr.trim() || rebase.stdout.trim(),
			};
		}
		return { ok: true, head: gitHeadCommit(laneRoot) ?? start };
	} finally {
		runGit(mountRoot, ["worktree", "remove", "--force", laneRoot]);
		rmSync(parent, { recursive: true, force: true });
		runGit(mountRoot, ["worktree", "prune"]);
	}
}

function laneConflictHandoff(mountRoot: string, branch: string): string {
	return [
		"Někdo mezitím publikoval změny stejných souborů. Pracovní kopie zůstala beze změny.",
		"a) repository-db conflict --abort vrátí čekající publikaci zpět do draftu;",
		"   potom konfliktní záznamy vraťte nebo upravte a publikujte znovu.",
		`b) Nebo změny začleňte ručně: cd ${mountRoot} && git rebase origin/${branch},`,
		"   a spusťte repository-db conflict --resolved.",
		"Do té doby repository-db odmítá zápisy i publikaci.",
	].join("\n");
}

/**
 * Send the local commits: integrate a moved remote, then push. Caller holds
 * the gate. Returns `pushed: false` when the remote already has everything.
 */
async function send(
	mountRoot: string,
	config: RepositoryDbConfig,
	operation: "publish" | "finish-send",
): Promise<{ pushed: boolean; remoteChanges: string[] }> {
	const branch = config.dataRepo.branch;
	const remoteRef = `refs/remotes/origin/${branch}`;
	try {
		await gitFetchAsync(mountRoot);
	} catch (error) {
		throw new RepositoryDbError(
			"publish_push_failed",
			`Could not reach the remote; the commit stays waiting to be sent (committed_not_pushed). Detail: ${(error as Error).message}`,
		);
	}

	const head = gitHeadCommit(mountRoot);
	const remoteHead = runGit(mountRoot, ["rev-parse", "--verify", "--quiet", remoteRef]).stdout.trim();
	let remoteChanges: string[] = [];
	if (head && remoteHead) {
		if (runGit(mountRoot, ["merge-base", "--is-ancestor", head, remoteHead]).status === 0) {
			return { pushed: false, remoteChanges };
		}
		const behind = runGit(mountRoot, ["merge-base", "--is-ancestor", remoteHead, head]).status !== 0;
		if (behind) {
			remoteChanges = runGitOrThrow(mountRoot, ["diff", "--name-only", `${head}...${remoteHead}`])
				.split("\n")
				.filter(Boolean);
			const lane = await rebaseInLane(mountRoot, head, remoteHead);
			if (!lane.ok) {
				const state = writeConflictState(mountRoot, {
					detectedAt: new Date().toISOString(),
					operation,
					gitState: lane.detail || "rebase stopped",
					message: `${operation} stopped: remote changes to the same files could not be integrated (${
						lane.paths.join(", ") || "see gitState"
					})`,
					paths: lane.paths,
					handoff: laneConflictHandoff(mountRoot, branch),
				});
				throw new RepositoryDbError("publish_conflict", `${state.message}\n\n${state.handoff}`);
			}
			// --keep, not --hard: if anything unexpected sits in the working tree,
			// Git refuses instead of erasing it.
			runGitOrThrow(mountRoot, ["reset", "--keep", lane.head]);
		}
	}

	const push = await runGitAsync(mountRoot, ["push", "origin", `HEAD:${branch}`]);
	if (push.status !== 0) {
		throw new RepositoryDbError(
			"publish_push_failed",
			`git push failed; the commit stays waiting to be sent (committed_not_pushed). Finish the send to retry. Detail: ${
				push.stderr.trim() || push.stdout.trim()
			}`,
		);
	}
	// The draft the provenance markers described is now published.
	clearDraftProvenance(mountRoot);
	return { pushed: true, remoteChanges };
}

/**
 * Publish the confirmed draft as one auditable commit and send it.
 *
 * Refuses when the draft is no longer the confirmed revision. When the send
 * fails after the commit was made, the commit stays waiting to be sent —
 * finishing that is {@link finishSend}, a separate operation.
 */
export async function publish(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: PublishOptions,
): Promise<PublishResult> {
	requireText(options.actor, "publish requires an actor");
	requireText(options.source, "publish requires a source");
	requireText(
		options.expectedRevision,
		"publish confirms a specific draft; pass the revision that was shown (expectedRevision)",
	);

	assertDataRepoBoundary(mountRoot, config);
	assertNoActiveConflict(mountRoot);
	assertCredentials(config.dataRepo.remote);

	return gated(mountRoot, async () => {
		assertNoActiveConflict(mountRoot);
		const currentRevision = computeDraftRevision(mountRoot);
		if (currentRevision !== options.expectedRevision) {
			throw new DraftChangedError(currentRevision);
		}
		if (engineDirFree(gitDirtyPaths(mountRoot)).length === 0) {
			if (gitAheadBehind(mountRoot, config.dataRepo.branch).ahead > 0) {
				throw new RepositoryDbError(
					"send_pending",
					"There is no new draft to publish; a publish is waiting to be sent. Finish sending it instead.",
				);
			}
			return { state: "nothing_to_publish" };
		}

		if (!options.skipValidate) runValidateCommands(mountRoot, config);
		if (!options.skipMaterialize) materializeGenerated(mountRoot, config);
		assertDeclaredGeneratedOnly(mountRoot, config);

		const dirtyPaths = engineDirFree(gitDirtyPaths(mountRoot));
		runGitOrThrow(mountRoot, ["add", "--all"]);
		// The engine layer (lock, conflict and provenance files) is runtime
		// state. It never ships, whatever the checkout's ignore rules say; a
		// lock tracked by an old engine version leaves the index here.
		runGitOrThrow(mountRoot, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ENGINE_DIR]);
		const staged = runGitOrThrow(mountRoot, ["diff", "--cached", "--name-only"])
			.split("\n")
			.filter(Boolean);
		if (staged.length === 0) return { state: "nothing_to_publish" };

		const changeId = newChangeId();
		const message = buildCommitMessage(
			options.summary?.trim() || defaultSubject(config, dirtyPaths, options.entities),
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

		const { remoteChanges } = await send(mountRoot, config, "publish");
		return {
			state: "published",
			commit: gitHeadCommit(mountRoot),
			changeId,
			pushedTo: `${config.dataRepo.remote}#${config.dataRepo.branch}`,
			remoteChanges,
		};
	});
}

/**
 * Finish sending the commit that was shown as waiting. Never makes a commit,
 * never validates or materializes: the commit was validated when it was made.
 * If a colleague published in the meantime, the waiting commit is replayed
 * onto their work before the push — the same commit content, a new parent.
 */
export async function finishSend(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: FinishSendOptions,
): Promise<PublishResult> {
	requireText(
		options.expectedHead,
		"finishing a send requires the commit that was shown (expectedHead)",
	);

	assertDataRepoBoundary(mountRoot, config);
	assertNoActiveConflict(mountRoot);
	assertCredentials(config.dataRepo.remote);

	return gated(mountRoot, async () => {
		assertNoActiveConflict(mountRoot);
		const head = gitHeadCommit(mountRoot);
		if (head !== options.expectedHead) {
			throw new RepositoryDbError(
				"head_changed",
				`The commit waiting to be sent is no longer the one that was shown (expected ${options.expectedHead}, found ${head ?? "none"}). Refresh and decide again.`,
			);
		}
		if (engineDirFree(gitDirtyPaths(mountRoot)).length > 0) {
			throw new RepositoryDbError(
				"new_draft_present",
				"There are draft changes beyond the commit waiting to be sent. Finishing the send would publish them unreviewed; review the draft and publish it explicitly instead.",
			);
		}
		const { pushed, remoteChanges } = await send(mountRoot, config, "finish-send");
		if (!pushed) return { state: "nothing_to_publish" };
		return {
			state: "published",
			commit: gitHeadCommit(mountRoot),
			pushedTo: `${config.dataRepo.remote}#${config.dataRepo.branch}`,
			remoteChanges,
		};
	});
}

export interface PullResult {
	state: "up_to_date" | "pulled";
	/** Remote commits integrated by this pull. */
	behind: number;
	/** Paths the pulled commits changed. */
	remoteChanges: string[];
}

/**
 * Bring in colleagues' published work by fast-forward only.
 *
 * A draft may stay in place: Git carries local changes across a fast-forward
 * and refuses when an incoming change touches a file the draft also changed.
 * Nothing is merged into local work, so a pull never creates a conflict. When
 * local commits are waiting to be sent, finishing the send integrates instead.
 *
 * The fetch runs outside the gate so a background poll never collides with a
 * running publish; only the fast-forward itself is gated.
 */
export async function pullRemote(
	mountRoot: string,
	config: RepositoryDbConfig,
): Promise<PullResult> {
	assertDataRepoBoundary(mountRoot, config);
	assertNoActiveConflict(mountRoot);

	await gitFetchAsync(mountRoot);
	const { behind } = gitAheadBehind(mountRoot, config.dataRepo.branch);
	if (behind === 0) return { state: "up_to_date", behind: 0, remoteChanges: [] };

	return gated(mountRoot, async () => {
		assertNoActiveConflict(mountRoot);
		const branch = config.dataRepo.branch;
		const { ahead, behind: behindNow } = gitAheadBehind(mountRoot, branch);
		if (behindNow === 0) return { state: "up_to_date", behind: 0, remoteChanges: [] };
		if (ahead > 0) {
			throw new RepositoryDbError(
				"send_pending",
				"A publish is waiting to be sent; finishing the send integrates the remote changes too.",
			);
		}
		const remoteRef = `refs/remotes/origin/${branch}`;
		const remoteChanges = runGitOrThrow(mountRoot, ["diff", "--name-only", `HEAD...${remoteRef}`])
			.split("\n")
			.filter(Boolean);
		const merge = runGit(mountRoot, ["merge", "--ff-only", remoteRef]);
		if (merge.status !== 0) {
			throw new RepositoryDbError(
				"pull_blocked_by_draft",
				`Colleagues published changes to files this draft also changes; nothing was pulled. Publish or revert those records first. Detail: ${
					merge.stderr.trim() || merge.stdout.trim()
				}`,
			);
		}
		return { state: "pulled", behind: behindNow, remoteChanges };
	});
}
