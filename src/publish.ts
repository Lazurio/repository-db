import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import {
	assertNoActiveConflict,
	clearRecordedConflictState,
	readConflictState,
	writeConflictState,
} from "./conflict.ts";
import { assertCredentials } from "./credentials.ts";
import { DraftChangedError } from "./discard.ts";
import { computeDraftRevision } from "./draftRevision.ts";
import {
	gitAheadBehind,
	gitChangedPaths,
	gitDirtyPaths,
	gitFetchAsync,
	gitHeadCommit,
	gitOperationInProgress,
	gitRenameSources,
	gitUnmergedPaths,
	runGit,
	runGitAsync,
	runGitOrThrow,
} from "./git.ts";
import {
	assertDeclaredGeneratedOnly,
	isPathDeclared,
	isUndeclaredGenerated,
	materializeGenerated,
	runValidateCommands,
} from "./generated.ts";
import { ENGINE_DIR, acquirePublishLock } from "./lock.ts";
import { clearDraftProvenance } from "./origin.ts";
import { mergeCanonicalYamlThreeWay } from "./semanticYamlMerge.ts";
import { buildCommitMessage, newChangeId } from "./trailers.ts";
import { writeFileAtomic } from "./yamlIo.ts";
import {
	type FinishSendOptions,
	type PublishOptions,
	type PublishResult,
	type RepositoryDbConfig,
	type RetryConflictSendOptions,
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

type LaneConflictDetail = {
	path: string;
	unresolvedFields?: string[];
	reason?: string;
};

type LaneResult =
	| { ok: true; head: string }
	| { ok: false; paths: string[]; detail: string; conflicts: LaneConflictDetail[] };

function isCanonicalDataYamlPath(config: RepositoryDbConfig, relativePath: string): boolean {
	const prefix = `${config.layout.data}/`;
	return relativePath.startsWith(prefix) && /\.ya?ml$/i.test(relativePath);
}

function laneAbsolutePath(laneRoot: string, relativePath: string): string | undefined {
	if (path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) return undefined;
	const resolved = path.resolve(laneRoot, relativePath);
	return resolved.startsWith(`${laneRoot}${path.sep}`) ? resolved : undefined;
}

function laneStageText(laneRoot: string, stage: 1 | 2 | 3, relativePath: string): string | undefined {
	const result = runGit(laneRoot, ["show", `:${stage}:${relativePath}`]);
	return result.status === 0 ? result.stdout : undefined;
}

/** Git index stages used by semantic resolution must all be regular files. */
function laneHasOnlyRegularConflictStages(laneRoot: string, relativePath: string): boolean {
	const listed = runGit(laneRoot, ["ls-files", "-u", "--stage", "-z", "--", relativePath]);
	if (listed.status !== 0) return false;
	const entries = listed.stdout.split("\0").filter(Boolean);
	if (entries.length !== 3) return false;
	return entries.every((entry) => {
		const separator = entry.indexOf("	");
		if (separator === -1 || entry.slice(separator + 1) !== relativePath) return false;
		const mode = entry.slice(0, separator).split(" ")[0];
		return mode === "100644" || mode === "100755";
	});
}

/**
 * Git has already proved a text-level conflict in the isolated lane. Try only
 * canonical YAML data files and stage a result only when the structural merger
 * proves every business value safe. Any other path stays a hard conflict.
 */
function resolveSemanticLaneConflicts(
	laneRoot: string,
	config: RepositoryDbConfig,
	paths: readonly string[],
): { resolved: boolean; conflicts: LaneConflictDetail[] } {
	const conflicts: LaneConflictDetail[] = [];
	for (const relativePath of paths) {
		if (!isCanonicalDataYamlPath(config, relativePath)) {
			conflicts.push({ path: relativePath, reason: "path is not canonical YAML data" });
			continue;
		}
		if (!laneHasOnlyRegularConflictStages(laneRoot, relativePath)) {
			conflicts.push({ path: relativePath, reason: "conflict stages are not three regular files" });
			continue;
		}
		const absolutePath = laneAbsolutePath(laneRoot, relativePath);
		if (!absolutePath) {
			conflicts.push({ path: relativePath, reason: "path escapes the integration lane" });
			continue;
		}
		// During `git rebase <remote>`, stage 2 is the remote target and stage 3
		// is the local commit being replayed. Stage 1 is their merge base.
		const merged = mergeCanonicalYamlThreeWay(
			laneStageText(laneRoot, 1, relativePath),
			laneStageText(laneRoot, 3, relativePath),
			laneStageText(laneRoot, 2, relativePath),
		);
		if (!merged.ok || !merged.text) {
			conflicts.push({
				path: relativePath,
				...(merged.unresolvedPaths.length > 0
					? { unresolvedFields: merged.unresolvedPaths }
					: {}),
				...(merged.reason ? { reason: merged.reason } : {}),
			});
			continue;
		}
		writeFileAtomic(absolutePath, merged.text);
		const add = runGit(laneRoot, ["add", "--", relativePath]);
		if (add.status !== 0) {
			conflicts.push({
				path: relativePath,
				reason: add.stderr.trim() || add.stdout.trim() || "could not stage semantic merge",
			});
		}
	}
	return { resolved: conflicts.length === 0, conflicts };
}

/**
 * A semantic union may change declared read models even when Git did not see a
 * text conflict in their files. Rebuild only in the disposable lane, reject
 * every non-declared side effect, validate there, then amend the replayed tip.
 */
function materializeSemanticLane(laneRoot: string, config: RepositoryDbConfig): void {
	if (engineDirFree(gitDirtyPaths(laneRoot)).length > 0) {
		throw new RepositoryDbError(
			"semantic_lane_dirty",
			"semantic integration lane is unexpectedly dirty before generated output is rebuilt",
		);
	}
	materializeGenerated(laneRoot, config);
	const changed = engineDirFree(gitDirtyPaths(laneRoot));
	const undeclared = changed.filter((entry) => !isPathDeclared(entry, config));
	if (undeclared.length > 0) {
		throw new RepositoryDbError(
			"generated_policy",
			`semantic integration materializer changed paths outside generated_manifest (${undeclared.join(", ")})`,
		);
	}
	assertDeclaredGeneratedOnly(laneRoot, config);
	runValidateCommands(laneRoot, config);
	if (changed.length === 0) return;
	runGitOrThrow(laneRoot, ["add", "--", ...changed]);
	runGitOrThrow(laneRoot, ["commit", "--amend", "--no-edit"]);
}

/**
 * Replay the local commits onto the fetched remote in a throwaway worktree.
 * Whatever happens there, the live checkout is untouched. Git first tries its
 * normal merge; only text-conflicted canonical YAML gets a conservative
 * structural merge before the rebase is continued.
 */
async function rebaseInLane(
	mountRoot: string,
	start: string,
	onto: string,
	config: RepositoryDbConfig,
): Promise<LaneResult> {
	const parent = mkdtempSync(path.join(os.tmpdir(), "repository-db-lane-"));
	const laneRoot = path.join(parent, "lane");
	let usedSemanticMerge = false;
	try {
		runGitOrThrow(mountRoot, ["worktree", "add", "--detach", laneRoot, start]);
		let rebase = await runGitAsync(laneRoot, ["rebase", onto]);
		for (let attempts = 0; attempts < 64; attempts += 1) {
			const unmerged = gitUnmergedPaths(laneRoot);
			if (rebase.status === 0 && unmerged.length === 0) {
				if (usedSemanticMerge) materializeSemanticLane(laneRoot, config);
				return { ok: true, head: gitHeadCommit(laneRoot) ?? start };
			}
			if (unmerged.length === 0) {
				return {
					ok: false,
					paths: [],
					detail: rebase.stderr.trim() || rebase.stdout.trim() || "rebase stopped",
					conflicts: [],
				};
			}
			const semantic = resolveSemanticLaneConflicts(laneRoot, config, unmerged);
			if (!semantic.resolved) {
				return {
					ok: false,
					paths: unmerged,
					detail: rebase.stderr.trim() || rebase.stdout.trim() || "rebase stopped",
					conflicts: semantic.conflicts,
				};
			}
			usedSemanticMerge = true;
			rebase = runGit(laneRoot, ["-c", "core.editor=true", "rebase", "--continue"]);
		}
		return {
			ok: false,
			paths: gitUnmergedPaths(laneRoot),
			detail: "semantic rebase exceeded the safe continuation limit",
			conflicts: [],
		};
	} finally {
		runGit(mountRoot, ["worktree", "remove", "--force", laneRoot]);
		rmSync(parent, { recursive: true, force: true });
		runGit(mountRoot, ["worktree", "prune"]);
	}
}

function laneConflictHandoff(mountRoot: string, branch: string): string {
	return [
		"repository-db bezpečně neprokázal sloučení všech změn. Pracovní kopie zůstala beze změny.",
		"a) Pokud panel nabízí bezpečný opakovaný pokus, použijte ho jen pro zobrazený čekající commit.",
		"b) Jinak repository-db conflict --abort vrátí čekající publikaci zpět do draftu;",
		"   potom upravte konfliktní záznam nad aktuálními kolegovými daty a publikujte znovu.",
		`Větev ${branch} se nesmí ručně rebasovat v aktivním data mountu.`,
		`Technický detail zůstává v ${mountRoot}/.repository-db/conflict.json.`,
		"Do té doby repository-db odmítá zápisy i publikaci.",
	].join("\n");
}

/**
 * The generated-output policy for commits that wait to be sent. Publish checks
 * it before committing; a waiting commit made any other way is held to the same
 * rule before it leaves, the same way review reports it.
 */
function assertUnsentGeneratedDeclared(mountRoot: string, config: RepositoryDbConfig): void {
	const remoteRef = `refs/remotes/origin/${config.dataRepo.branch}`;
	const hasRemote = runGit(mountRoot, ["rev-parse", "--verify", "--quiet", remoteRef]).status === 0;
	const unsent = hasRemote
		? gitChangedPaths(mountRoot, [`${remoteRef}...HEAD`])
		: runGitOrThrow(mountRoot, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])
				.split("\0")
				.filter(Boolean);
	const undeclared = unsent.filter((entry) => isUndeclaredGenerated(entry, config));
	if (undeclared.length > 0) {
		throw new RepositoryDbError(
			"generated_policy",
			`The commit waiting to be sent contains generated files not declared in generated_manifest (${undeclared.join(", ")}); it was not sent.`,
		);
	}
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
			// The remote already has these commits — an earlier push arrived even
			// though it reported failure — and maybe colleagues' work on top.
			// Nothing to send; catch the checkout up to what is published.
			if (head !== remoteHead) {
				remoteChanges = gitChangedPaths(mountRoot, [head, remoteHead]);
				runGitOrThrow(mountRoot, ["reset", "--keep", remoteHead]);
			}
			clearDraftProvenance(mountRoot);
			return { pushed: false, remoteChanges };
		}
		const behind = runGit(mountRoot, ["merge-base", "--is-ancestor", remoteHead, head]).status !== 0;
		if (behind) {
			remoteChanges = gitChangedPaths(mountRoot, [`${head}...${remoteHead}`]);
			const lane = await rebaseInLane(mountRoot, head, remoteHead, config);
			if (!lane.ok) {
				const unresolvedFields = Object.fromEntries(
					lane.conflicts
						.filter((entry) => entry.unresolvedFields && entry.unresolvedFields.length > 0)
						.map((entry) => [entry.path, entry.unresolvedFields ?? []]),
				);
				const state = writeConflictState(mountRoot, {
					detectedAt: new Date().toISOString(),
					operation,
					gitState: lane.detail || "rebase stopped",
					message: `${operation} stopped: remote changes could not be safely integrated (${
						lane.paths.join(", ") || "see gitState"
					})`,
					paths: lane.paths,
					...(Object.keys(unresolvedFields).length > 0 ? { unresolvedFields } : {}),
					pendingHead: head,
					retryable: false,
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

		if (!options.skipMaterialize) materializeGenerated(mountRoot, config);
		assertDeclaredGeneratedOnly(mountRoot, config);
		if (!options.skipValidate) runValidateCommands(mountRoot, config);
		// A commit already waiting below this draft leaves with it, so it is
		// held to the same rule as when it is finished on its own.
		assertUnsentGeneratedDeclared(mountRoot, config);

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
		assertUnsentGeneratedDeclared(mountRoot, config);
		const { pushed, remoteChanges } = await send(mountRoot, config, "finish-send");
		if (!pushed) return { state: "nothing_to_publish", remoteChanges };
		return {
			state: "published",
			commit: gitHeadCommit(mountRoot),
			pushedTo: `${config.dataRepo.remote}#${config.dataRepo.branch}`,
			remoteChanges,
		};
	});
}

/**
 * Retry an engine-recorded send only after reconfirming the exact waiting head,
 * a clean checkout and the absence of any external Git operation. The old
 * conflict marker remains in place during the retry; a new failed integration
 * replaces it, while a successful send clears it atomically at the end.
 */
export async function retryConflictSend(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: RetryConflictSendOptions,
): Promise<PublishResult> {
	requireText(
		options.expectedHead,
		"retrying a conflicted send requires the commit that was shown (expectedHead)",
	);
	assertDataRepoBoundary(mountRoot, config);
	assertCredentials(config.dataRepo.remote);

	return gated(mountRoot, async () => {
		const conflict = readConflictState(mountRoot);
		const isEngineSend = conflict?.operation === "publish" || conflict?.operation === "finish-send";
		const isRetryable =
			Boolean(conflict && isEngineSend && conflict.retryable) ||
			// v3.1 conflict files did not include a pending head. Preserve a safe
			// recovery path for them only through the exact current-head check below.
			Boolean(conflict && isEngineSend && conflict.pendingHead === undefined);
		if (!conflict || !isRetryable) {
			throw new RepositoryDbError(
				"conflict_not_retryable",
				"Only an engine-recorded pending send can be retried. External Git conflicts must be resolved or aborted outside this API.",
			);
		}
		const operation = gitOperationInProgress(mountRoot);
		const unmerged = gitUnmergedPaths(mountRoot);
		if (operation || unmerged.length > 0) {
			throw new RepositoryDbError(
				"conflict_not_retryable",
				"Retry requires a clean engine-recorded send; an external Git operation or unresolved index is active.",
			);
		}
		const head = gitHeadCommit(mountRoot);
		if (head !== options.expectedHead || (conflict.pendingHead && conflict.pendingHead !== head)) {
			throw new RepositoryDbError(
				"head_changed",
				`The commit waiting to be sent is no longer the one that was shown (expected ${options.expectedHead}, found ${head ?? "none"}). Refresh and decide again.`,
			);
		}
		if (engineDirFree(gitDirtyPaths(mountRoot)).length > 0) {
			throw new RepositoryDbError(
				"new_draft_present",
				"There are draft changes beyond the conflicted commit. Retrying would publish work that was not part of the shown commit.",
			);
		}
		assertUnsentGeneratedDeclared(mountRoot, config);
		const { pushed, remoteChanges } = await send(mountRoot, config, "finish-send");
		clearRecordedConflictState(mountRoot);
		if (!pushed) return { state: "nothing_to_publish", remoteChanges };
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
		const remoteChanges = gitChangedPaths(mountRoot, [`HEAD...${remoteRef}`]);
		// Checked here, not left to Git: a fast-forward overwrites a tracked
		// file missing from the working tree, so a drafted (unstaged) deletion
		// would silently come back with the colleague's content.
		const drafted = new Set([
			...engineDirFree(gitDirtyPaths(mountRoot)),
			...gitRenameSources(mountRoot).values(),
		]);
		const overlap = remoteChanges.filter((entry) => drafted.has(entry));
		if (overlap.length > 0) {
			throw new RepositoryDbError(
				"pull_blocked_by_draft",
				`Colleagues published changes to files this draft also changes (${overlap.join(", ")}); nothing was pulled. Publish or revert those records first.`,
			);
		}
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
