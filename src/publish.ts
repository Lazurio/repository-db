import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import {
	activeConflict,
	assertNoActiveConflict,
	clearRecordedConflictState,
	writeConflictState,
} from "./conflict.ts";
import { CONFIG_FILE_NAME, compatibleConfig, liveConfig } from "./config.ts";
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
import { assertDerivedOutputIgnored, ensureGenerated, runValidateCommands } from "./generated.ts";
import { ENGINE_DIR, acquirePublishLock } from "./lock.ts";
import { clearDraftProvenance } from "./origin.ts";
import { mergeCanonicalYamlThreeWay } from "./semanticYamlMerge.ts";
import { buildCommitMessage, newChangeId } from "./trailers.ts";
import { writeFileAtomic } from "./yamlIo.ts";
import {
	ConflictActiveError,
	type ConflictKind,
	type FinishSendOptions,
	MaterializeFailedError,
	PullBlockedError,
	type PublishOptions,
	type PublishResult,
	type RepositoryDbConfig,
	RepositoryDbError,
	ValidationFailedError,
} from "./types.ts";

/**
 * The publish lifecycle, owned here and nowhere else:
 *
 *   publish(revision)   gate -> confirm revision -> identity -> build derived
 *                       output and validate in the live checkout -> commit
 *                       the tracked draft -> send
 *   finishSend(head)    gate -> confirm head, no new draft -> send; also the
 *                       retry of a send the engine stopped with a conflict
 *   send (private)      fetch -> if behind, replay the local commits onto the
 *                       remote in a separate lane worktree (Git only: text
 *                       rebase plus the semantic YAML merge) -> move the live
 *                       checkout to the result -> build and validate there ->
 *                       push; a push the remote moved under is integrated
 *                       again, a bounded number of times
 *   pullRemote          fast-forward only; never merges into local work
 *
 * The live checkout is never left mid-rebase. It moves only with
 * `reset --keep`, which refuses rather than overwrites anything unexpected,
 * and an integrated result that fails validation is moved back to the local
 * commit before anything is pushed. Derived output is an ignored cache, so it
 * never takes part in any of this. Every step runs inside the shared gate, so
 * no supported write can land between the confirmation and the push.
 */

/** Pushes rejected because the remote moved again are integrated anew this often. */
const MAX_SEND_ATTEMPTS = 3;

function engineDirFree(paths: string[]): string[] {
	return paths.filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`));
}

function defaultSubject(
	config: RepositoryDbConfig,
	dirtyPaths: string[],
	entities: string[] | undefined,
): string {
	const dataPrefix = `${config.layout.data}/`;
	const dataChanges = dirtyPaths.filter((p) => p.startsWith(dataPrefix)).length;
	const otherChanges = dirtyPaths.length - dataChanges;
	const parts: string[] = [];
	if (dataChanges > 0) parts.push(`${dataChanges} data file(s)`);
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

/**
 * Commits made here need an author and a committer; a send that replays a
 * waiting commit onto a colleague's work needs a committer too. Ask Git the
 * same question `git commit` asks, before anything is built, staged or
 * replayed, so a missing identity refuses cleanly instead of failing halfway.
 * The engine never invents an identity; the Environment provides one.
 */
function assertCommitIdentity(mountRoot: string): void {
	for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
		const ident = runGit(mountRoot, ["var", variable]);
		if (ident.status === 0) continue;
		const detail = ident.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
		throw new RepositoryDbError(
			"identity_missing",
			`This Environment has no Git name and e-mail, so the changes cannot be published. Sign in to GitHub in the Launchpad to set them, then publish again. Nothing was changed.${
				detail ? ` Detail: ${detail}` : ""
			}`,
		);
	}
}

/** Derived output first, then the validators that may read it; both in the live checkout. */
async function verifyLiveCheckout(mountRoot: string, config: RepositoryDbConfig): Promise<void> {
	await ensureGenerated(mountRoot, config);
	await runValidateCommands(mountRoot, config);
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
 * Replay the local commits onto the fetched remote in a throwaway worktree.
 * Whatever happens there, the live checkout is untouched. The lane does Git
 * work only: Git's normal merge, and for text-conflicted canonical YAML a
 * conservative structural merge before the rebase continues. Building and
 * validating the result happens in the live checkout, where the data repo's
 * dependencies are.
 */
async function rebaseInLane(
	mountRoot: string,
	start: string,
	onto: string,
	config: RepositoryDbConfig,
): Promise<LaneResult> {
	const parent = mkdtempSync(path.join(os.tmpdir(), "repository-db-lane-"));
	const laneRoot = path.join(parent, "lane");
	try {
		runGitOrThrow(mountRoot, ["worktree", "add", "--detach", laneRoot, start]);
		let rebase = await runGitAsync(laneRoot, ["rebase", onto]);
		for (let attempts = 0; attempts < 64; attempts += 1) {
			const unmerged = gitUnmergedPaths(laneRoot);
			if (rebase.status === 0 && unmerged.length === 0) {
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

function conflictHandoff(mountRoot: string, branch: string, kind: ConflictKind): string {
	return [
		kind === "merge"
			? "repository-db bezpečně neprokázal sloučení všech změn. Pracovní kopie zůstala beze změny."
			: "Vaše změny spojené s novější prací kolegy neprošly ověřením dat. Pracovní kopie zůstala na vašem čekajícím commitu.",
		"a) Až kolega problém opraví, dokončete odeslání znovu (finish-send se zobrazeným commitem).",
		"b) Jinak repository-db conflict --abort vrátí čekající publikaci zpět do konceptu;",
		"   vraťte dotčený záznam, stáhněte práci kolegy, změnu proveďte znovu a publikujte.",
		`Větev ${branch} se nesmí ručně rebasovat v aktivním data mountu.`,
		`Technický detail zůstává v ${mountRoot}/.repository-db/conflict.json.`,
		"Do té doby repository-db odmítá zápisy i publikaci.",
	].join("\n");
}

function recordSendConflict(
	mountRoot: string,
	config: RepositoryDbConfig,
	operation: "publish" | "finish-send",
	pendingHead: string,
	detail: {
		kind: ConflictKind;
		gitState: string;
		message: string;
		paths: string[];
		unresolvedFields?: Record<string, string[]>;
	},
): never {
	const state = writeConflictState(mountRoot, {
		kind: detail.kind,
		detectedAt: new Date().toISOString(),
		operation,
		gitState: detail.gitState,
		message: detail.message,
		paths: detail.paths,
		...(detail.unresolvedFields && Object.keys(detail.unresolvedFields).length > 0
			? { unresolvedFields: detail.unresolvedFields }
			: {}),
		pendingHead,
		// The live checkout holds exactly the pending commit and no Git operation
		// runs in it, so a later explicit retry may fetch and integrate again.
		retryable: true,
		handoff: conflictHandoff(mountRoot, config.dataRepo.branch, detail.kind),
	});
	throw new RepositoryDbError("publish_conflict", `${state.message}\n\n${state.handoff}`);
}

async function fetchForSend(mountRoot: string): Promise<void> {
	try {
		await gitFetchAsync(mountRoot);
	} catch {
		// Once more after a moment: another fetch in this repository (a host's
		// background check, an agent's CLI) can hold the ref lock briefly.
		await new Promise((resolve) => setTimeout(resolve, 500));
		await retryFetch(mountRoot);
	}
}

async function retryFetch(mountRoot: string): Promise<void> {
	try {
		await gitFetchAsync(mountRoot);
	} catch (error) {
		throw new RepositoryDbError(
			"publish_push_failed",
			`Could not reach the remote; the commit stays waiting to be sent (committed_not_pushed). Detail: ${(error as Error).message}`,
		);
	}
}

/**
 * Undo what the data repo's commands changed in tracked files. A send starts
 * from a committed checkout, so every path that became dirty while they ran is
 * theirs; paths dirty before are left alone. Returns the paths it restored.
 */
function restoreCommandSideEffects(mountRoot: string, before: ReadonlySet<string>): string[] {
	const touched = engineDirFree(gitDirtyPaths(mountRoot)).filter((entry) => !before.has(entry));
	for (const entry of touched) {
		const inHead = runGit(mountRoot, ["cat-file", "-e", `HEAD:${entry}`]).status === 0;
		if (inHead) runGitOrThrow(mountRoot, ["checkout", "HEAD", "--", entry]);
		else {
			runGit(mountRoot, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", entry]);
			rmSync(path.join(mountRoot, entry), { force: true, recursive: true });
		}
	}
	return touched;
}

/** The drafted bytes of regular files, so a command that rewrites them can be undone. */
function snapshotDraft(mountRoot: string, dirtyPaths: readonly string[]): Map<string, Buffer | null> {
	const snapshot = new Map<string, Buffer | null>();
	for (const entry of dirtyPaths) {
		const absolute = path.join(mountRoot, entry);
		const stats = lstatSync(absolute, { throwIfNoEntry: false });
		if (!stats) snapshot.set(entry, null);
		else if (stats.isFile()) snapshot.set(entry, readFileSync(absolute));
	}
	return snapshot;
}

function restoreDraft(mountRoot: string, snapshot: ReadonlyMap<string, Buffer | null>): void {
	for (const [entry, bytes] of snapshot) {
		const absolute = path.join(mountRoot, entry);
		if (bytes === null) rmSync(absolute, { force: true, recursive: true });
		else writeFileSync(absolute, bytes);
	}
}

function remoteHeadOf(mountRoot: string, branch: string): string {
	return runGit(mountRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).stdout.trim();
}

/**
 * Send the local commits: integrate a moved remote, verify the integrated
 * result in the live checkout, push. Caller holds the gate. Returns
 * `pushed: false` when the remote already has everything.
 */
async function send(
	mountRoot: string,
	config: RepositoryDbConfig,
	operation: "publish" | "finish-send",
): Promise<{ pushed: boolean; remoteChanges: string[] }> {
	const branch = config.dataRepo.branch;
	const remoteChanges = new Set<string>();
	// The commit the caller confirmed. Whatever an attempt integrated, a failure
	// returns the checkout to it, so the recorded pending commit is the shown one.
	const localHead = gitHeadCommit(mountRoot);
	let fetched = false;
	for (let attempt = 1; ; attempt += 1) {
		if (!fetched) await fetchForSend(mountRoot);
		fetched = false;
		const head = gitHeadCommit(mountRoot);
		const remoteHead = remoteHeadOf(mountRoot, branch);
		if (head && remoteHead) {
			if (runGit(mountRoot, ["merge-base", "--is-ancestor", head, remoteHead]).status === 0) {
				// The remote already has these commits — an earlier push arrived even
				// though it reported failure — and maybe colleagues' work on top.
				// Nothing to send; catch the checkout up to what is published.
				if (head !== remoteHead) {
					const caughtUp = gitChangedPaths(mountRoot, [head, remoteHead]);
					// Catching up is a pull: the configuration it brings is held to the
					// opened boundary before anything moves.
					if (caughtUp.includes(CONFIG_FILE_NAME)) {
						const incoming = runGit(mountRoot, ["show", `${remoteHead}:${CONFIG_FILE_NAME}`]);
						compatibleConfig(config, incoming.status === 0 ? incoming.stdout : undefined, "published by a colleague");
					}
					for (const entry of caughtUp) remoteChanges.add(entry);
					runGitOrThrow(mountRoot, ["reset", "--keep", remoteHead]);
				}
				clearDraftProvenance(mountRoot);
				return { pushed: false, remoteChanges: [...remoteChanges] };
			}
			const behind = runGit(mountRoot, ["merge-base", "--is-ancestor", remoteHead, head]).status !== 0;
			if (behind) {
				const pending = localHead ?? head;
				const incoming = gitChangedPaths(mountRoot, [`${head}...${remoteHead}`]);
				for (const entry of incoming) remoteChanges.add(entry);
				const lane = await rebaseInLane(mountRoot, head, remoteHead, config);
				if (!lane.ok) {
					if (head !== pending) runGitOrThrow(mountRoot, ["reset", "--keep", pending]);
					recordSendConflict(mountRoot, config, operation, pending, {
						kind: "merge",
						gitState: lane.detail || "rebase stopped",
						message: `${operation} stopped: remote changes could not be safely integrated (${
							lane.paths.join(", ") || "see gitState"
						})`,
						paths: lane.paths,
						unresolvedFields: Object.fromEntries(
							lane.conflicts
								.filter((entry) => entry.unresolvedFields && entry.unresolvedFields.length > 0)
								.map((entry) => [entry.path, entry.unresolvedFields ?? []]),
						),
					});
				}
				const dirtyBefore = new Set(engineDirFree(gitDirtyPaths(mountRoot)));
				// --keep, not --hard: if anything unexpected sits in the working tree,
				// Git refuses instead of erasing it.
				runGitOrThrow(mountRoot, ["reset", "--keep", lane.head]);
				// The integrated result is validated by the rules it now holds — a
				// colleague may have published stricter ones — never by the config
				// parsed when the checkout was opened. A changed boundary fails closed.
				let integrated: RepositoryDbConfig;
				try {
					integrated = liveConfig(mountRoot, config);
				} catch (error) {
					runGitOrThrow(mountRoot, ["reset", "--keep", pending]);
					throw error;
				}
				let failure: string | undefined;
				try {
					await verifyLiveCheckout(mountRoot, integrated);
				} catch (error) {
					if (!(error instanceof MaterializeFailedError || error instanceof ValidationFailedError)) {
						restoreCommandSideEffects(mountRoot, dirtyBefore);
						runGitOrThrow(mountRoot, ["reset", "--keep", pending]);
						throw error;
					}
					failure = error.message.split("\n")[0];
				}
				// The commands must not change tracked files; what they changed is
				// put back before anything moves, so nothing unreviewed is left.
				const sideEffects = restoreCommandSideEffects(mountRoot, dirtyBefore);
				if (!failure && sideEffects.length > 0) {
					failure = `materializers or validators changed tracked files (${sideEffects.join(", ")}); they may write only to declared generated_manifest paths`;
				}
				if (failure) {
					runGitOrThrow(mountRoot, ["reset", "--keep", pending]);
					recordSendConflict(mountRoot, config, operation, pending, {
						kind: "validation",
						gitState: "integrated result failed validation",
						message: `${operation} stopped: the local changes on top of the colleagues' newer work failed validation; nothing was sent. ${failure}`,
						paths: incoming,
					});
				}
			}
		}

		const push = await runGitAsync(mountRoot, ["push", "origin", `HEAD:${branch}`]);
		if (push.status === 0) {
			// The draft the provenance markers described is now published.
			clearDraftProvenance(mountRoot);
			return { pushed: true, remoteChanges: [...remoteChanges] };
		}
		// Rejected because a colleague published in the meantime? Then the next
		// attempt integrates their work too. Any other refusal is final.
		if (attempt < MAX_SEND_ATTEMPTS && remoteHead) {
			const moved = await gitFetchAsync(mountRoot).then(
				() => remoteHeadOf(mountRoot, branch) !== remoteHead,
				() => false,
			);
			if (moved) {
				fetched = true;
				continue;
			}
		}
		// Back to the confirmed commit: the integration is redone on the next
		// attempt, and a recorded conflict keeps naming the commit it was for.
		const now = gitHeadCommit(mountRoot);
		if (localHead && now !== localHead) runGitOrThrow(mountRoot, ["reset", "--keep", localHead]);
		throw new RepositoryDbError(
			"publish_push_failed",
			`git push failed; the commit stays waiting to be sent (committed_not_pushed). Finish the send to retry. Detail: ${
				push.stderr.trim() || push.stdout.trim()
			}`,
		);
	}
}

/**
 * Publish the confirmed draft as one auditable commit and send it.
 *
 * Refuses when the draft is no longer the confirmed revision, when derived
 * output cannot be built or validation fails (nothing is staged then), and
 * when the Environment has no Git identity. When the send fails after the
 * commit was made, the commit stays waiting to be sent — finishing that is
 * {@link finishSend}, a separate operation.
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
	assertDerivedOutputIgnored(mountRoot, config);
	assertNoActiveConflict(mountRoot);
	await assertCredentials(config.dataRepo.remote);

	return gated(mountRoot, async () => {
		assertNoActiveConflict(mountRoot);
		const currentRevision = computeDraftRevision(mountRoot);
		if (currentRevision !== options.expectedRevision) {
			throw new DraftChangedError(currentRevision);
		}
		// The rules in the checkout now, not the ones read when it was opened.
		const current = liveConfig(mountRoot, config);
		const dirtyPaths = engineDirFree(gitDirtyPaths(mountRoot));
		if (dirtyPaths.length === 0) {
			if (gitAheadBehind(mountRoot, config.dataRepo.branch).ahead > 0) {
				throw new RepositoryDbError(
					"send_pending",
					"There is no new draft to publish; a publish is waiting to be sent. Finish sending it instead.",
				);
			}
			return { state: "nothing_to_publish" };
		}
		assertCommitIdentity(mountRoot);

		// Materializers and validators read the checkout; they must not change
		// what is about to be committed. Nothing is staged yet, and whatever they
		// changed is put back — whether they passed or failed — so neither this
		// attempt nor the next can commit it.
		const drafted = snapshotDraft(mountRoot, dirtyPaths);
		const undoCommands = () => {
			const appeared = restoreCommandSideEffects(mountRoot, new Set(dirtyPaths));
			restoreDraft(mountRoot, drafted);
			return appeared;
		};
		try {
			await verifyLiveCheckout(mountRoot, current);
		} catch (error) {
			if (computeDraftRevision(mountRoot) !== options.expectedRevision) undoCommands();
			throw error;
		}
		if (computeDraftRevision(mountRoot) !== options.expectedRevision) {
			const appeared = undoCommands();
			throw new RepositoryDbError(
				"generated_side_effect",
				`Building derived output or validating changed tracked files${
					appeared.length > 0 ? ` (${appeared.join(", ")})` : ""
				}; nothing was published. Materializers and validators may write only to paths declared in generated_manifest, which the data repo ignores.`,
			);
		}

		const changeId = newChangeId();
		try {
			// The whole draft; never the engine's runtime layer, whatever the data
			// repo's ignore rules say. Derived output is ignored and stays out.
			runGitOrThrow(mountRoot, ["add", "--all"]);
			runGitOrThrow(mountRoot, ["reset", "--quiet", "--", ENGINE_DIR]);
			const staged = runGitOrThrow(mountRoot, ["diff", "--cached", "--name-only"])
				.split("\n")
				.filter(Boolean);
			if (staged.length === 0) return { state: "nothing_to_publish" };

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
		} catch (error) {
			// No commit was made, so the draft is still the working tree. Put the
			// index back to HEAD (a mixed reset never touches the working tree);
			// nothing publish staged is left behind.
			runGit(mountRoot, ["reset", "--quiet"]);
			throw error;
		}

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
 * Finish sending the commit that was shown as waiting — after a failed push,
 * or as the retry of a send the engine stopped with a recorded conflict. Never
 * makes a commit. If a colleague published in the meantime, the waiting commit
 * is replayed onto their work, the result is built and validated in the live
 * checkout, and only then pushed — the same commit content, a new parent.
 *
 * A conflict someone else left (a rebase or merge started by hand, markers in
 * the index, a record from an older engine) is never retried here.
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
	assertDerivedOutputIgnored(mountRoot, config);
	await assertCredentials(config.dataRepo.remote);

	return gated(mountRoot, async () => {
		const conflict = activeConflict(mountRoot);
		const head = gitHeadCommit(mountRoot);
		if (conflict) {
			const engineSend =
				conflict.retryable === true &&
				(conflict.operation === "publish" || conflict.operation === "finish-send");
			if (!engineSend || gitOperationInProgress(mountRoot) || gitUnmergedPaths(mountRoot).length > 0) {
				throw new ConflictActiveError(`${conflict.message}\n\n${conflict.handoff}`);
			}
			if (conflict.pendingHead !== head) {
				throw new RepositoryDbError(
					"head_changed",
					`The checkout no longer holds the commit the conflict was recorded for (${conflict.pendingHead}, found ${head ?? "none"}). Refresh and decide again.`,
				);
			}
		}
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
		assertCommitIdentity(mountRoot);
		// A new failure replaces the old record inside send(); success clears it.
		const { pushed, remoteChanges } = await send(mountRoot, config, "finish-send");
		if (conflict) clearRecordedConflictState(mountRoot);
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

export interface PullOptions {
	/**
	 * Fetch first (default). A host that has just fetched passes `false`, so the
	 * network call does not run twice.
	 */
	fetch?: boolean;
}

/**
 * Bring in colleagues' published work by fast-forward only.
 *
 * A draft may stay in place: the pull checks the drafted files against the
 * incoming ones and refuses only when a colleague changed a record the draft
 * also changes ({@link PullBlockedError} names them). The way out is to revert
 * that record, pull, and redo the edit on top. Nothing is merged into local
 * work, so a pull never creates a conflict. Derived output is not part of the
 * check; it is rebuilt from the new content on its next read. When local
 * commits wait to be sent, finishing the send integrates instead.
 *
 * The fetch runs outside the gate so a background poll never collides with a
 * running publish; only the fast-forward itself is gated.
 */
export async function pullRemote(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: PullOptions = {},
): Promise<PullResult> {
	assertDataRepoBoundary(mountRoot, config);
	assertDerivedOutputIgnored(mountRoot, config);
	assertNoActiveConflict(mountRoot);

	if (options.fetch !== false) await gitFetchAsync(mountRoot);
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
		if (overlap.length > 0) throw new PullBlockedError(overlap);
		// The configuration that would arrive: refused before anything moves when
		// it cannot be read or changes the boundary this checkout was opened with.
		if (remoteChanges.includes(CONFIG_FILE_NAME)) {
			const incoming = runGit(mountRoot, ["show", `${remoteRef}:${CONFIG_FILE_NAME}`]);
			compatibleConfig(config, incoming.status === 0 ? incoming.stdout : undefined, "published by a colleague");
		}
		const merge = runGit(mountRoot, ["merge", "--ff-only", remoteRef]);
		if (merge.status !== 0) {
			throw new PullBlockedError(
				[],
				merge.stderr.trim() || merge.stdout.trim(),
			);
		}
		return { state: "pulled", behind: behindNow, remoteChanges };
	});
}
