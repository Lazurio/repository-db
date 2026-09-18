import { rmSync } from "node:fs";
import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import { activeConflict } from "./conflict.ts";
import { computeDraftRevision } from "./draftRevision.ts";
import {
	gitAheadBehind,
	gitDirtyPaths,
	gitRenameSources,
	runGit,
	runGitOrThrow,
} from "./git.ts";
import { acquirePublishLock, ENGINE_DIR } from "./lock.ts";
import { clearDraftOrigins, clearDraftOwner, pruneDraftOrigins } from "./origin.ts";
import { type RepositoryDbConfig, RepositoryDbError } from "./types.ts";

/**
 * Discard — taking work back out of the draft.
 *
 * Two scopes only, both predictable:
 *
 *   - `record`  — one canonical data file returns to its published content;
 *   - `draft`   — the whole shared draft returns to the published state.
 *
 * Anything in between is refused with a readable reason rather than guessed at.
 * A record whose revert would leave related data inconsistent (a stale generated
 * artifact, a half-undone rename) is not "reverted as best we can"; the action
 * is simply not available, and the panel says why. This engine does not model
 * dependencies between records, and it must never touch a change the user did
 * not ask about.
 *
 * Reverting a single field is not an engine primitive either: Git works per
 * file, so a field revert is an ordinary write of the baseline value by the app.
 */

export type DiscardScope =
	| { kind: "record"; path: string }
	| { kind: "draft" };

export interface DiscardOptions {
	scope: DiscardScope;
	/**
	 * Revision of the draft the user was looking at. The operation runs only if
	 * the draft still looks exactly like that.
	 */
	expectedRevision: string;
}

export interface DiscardResult {
	scope: DiscardScope["kind"];
	/** Paths returned to their published content. */
	restored: string[];
	/** Paths that only existed in the draft and were removed. */
	removed: string[];
	/** Dirty paths still present afterwards. */
	remainingDirtyPaths: string[];
	/** Revision of the draft after the discard. */
	revision: string;
}

/** The displayed draft is no longer the current one; refresh and decide again. */
export class DraftChangedError extends RepositoryDbError {
	readonly currentRevision: string;

	constructor(currentRevision: string) {
		super(
			"draft_changed",
			"The draft changed since it was shown. Nothing was modified — refresh the review and confirm again.",
		);
		this.name = "DraftChangedError";
		this.currentRevision = currentRevision;
	}
}

/** This particular revert is out of the supported scope; the reason explains why. */
export class RevertNotSupportedError extends RepositoryDbError {
	readonly reason:
		| "not_in_draft"
		| "generated_artifact"
		| "related_generated_changes"
		| "renamed_record"
		| "not_canonical_data";

	constructor(reason: RevertNotSupportedError["reason"], message: string) {
		super("revert_not_supported", message);
		this.name = "RevertNotSupportedError";
		this.reason = reason;
	}
}

function existsInHead(mountRoot: string, relativePath: string): boolean {
	return runGit(mountRoot, ["cat-file", "-e", `HEAD:${relativePath}`]).status === 0;
}

function isTrackedInIndex(mountRoot: string, relativePath: string): boolean {
	return runGit(mountRoot, ["ls-files", "--error-unmatch", "--", relativePath]).status === 0;
}

function dirtyPathsOf(mountRoot: string): string[] {
	return gitDirtyPaths(mountRoot).filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`));
}

/**
 * Guards that apply to both scopes.
 *
 * The unpushed-commit guard matters for honesty: once a publish has committed
 * but failed to push, HEAD is a local commit that nobody else has. Returning to
 * HEAD would not be "returning to the last published version", so discard steps
 * aside and the user finishes sending the existing commit instead.
 */
function assertDiscardable(mountRoot: string, config: RepositoryDbConfig): void {
	if (activeConflict(mountRoot)) {
		throw new RepositoryDbError(
			"conflict_active",
			"The data repository is in a conflict state. Resolve or abort the conflict first; the draft stays visible meanwhile.",
		);
	}
	const { ahead } = gitAheadBehind(mountRoot, config.dataRepo.branch);
	if (ahead > 0) {
		throw new RepositoryDbError(
			"unpushed_commit",
			"A published commit is still waiting to be sent. Finish sending it first — until then the local state is not the last published version.",
		);
	}
}

/**
 * Is a single-record revert safe and predictable here?
 *
 * Deliberately narrow: exactly one canonical data file, no rename involved, and
 * no dirty generated output that the revert would leave stale.
 */
function assertRecordRevertSupported(
	mountRoot: string,
	config: RepositoryDbConfig,
	relativePath: string,
	dirtyPaths: readonly string[],
	renameSources: Map<string, string> = gitRenameSources(mountRoot),
): void {
	if (!dirtyPaths.includes(relativePath)) {
		throw new RevertNotSupportedError(
			"not_in_draft",
			`"${relativePath}" is not part of the current draft.`,
		);
	}

	const generatedPrefix = `${config.layout.generated}/`;
	if (relativePath === config.layout.generated || relativePath.startsWith(generatedPrefix)) {
		throw new RevertNotSupportedError(
			"generated_artifact",
			"This is generated output, not a record. It is rebuilt on publish; revert the record it comes from instead.",
		);
	}
	if (!relativePath.startsWith(`${config.layout.data}/`)) {
		throw new RevertNotSupportedError(
			"not_canonical_data",
			"Only canonical records can be reverted individually. Discard the whole draft, or change this file the ordinary way.",
		);
	}

	const dirtyGenerated = dirtyPaths.filter(
		(entry) => entry === config.layout.generated || entry.startsWith(generatedPrefix),
	);
	if (dirtyGenerated.length > 0) {
		throw new RevertNotSupportedError(
			"related_generated_changes",
			"The draft also contains generated data built from these records. Reverting one record alone would leave it inconsistent — discard the whole draft instead.",
		);
	}

	if (renameSources.has(relativePath) || [...renameSources.values()].includes(relativePath)) {
		throw new RevertNotSupportedError(
			"renamed_record",
			"This record was renamed in the draft. Reverting one side alone would leave the other behind — discard the whole draft instead.",
		);
	}
}

/**
 * Return draft work to the published state.
 *
 * Holds the publish lock, so a discard can never race a publish over the same
 * working tree, and re-checks the displayed revision under that lock.
 */
export function discardDraft(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: DiscardOptions,
): DiscardResult {
	assertDataRepoBoundary(mountRoot, config);
	if (!options.expectedRevision) {
		throw new RepositoryDbError(
			"invalid_args",
			"discard requires the revision of the draft that was shown.",
		);
	}
	assertDiscardable(mountRoot, config);

	const release = acquirePublishLock(mountRoot);
	try {
		// Under the lock: the draft must still be exactly what the user saw.
		const currentRevision = computeDraftRevision(mountRoot);
		if (currentRevision !== options.expectedRevision) {
			throw new DraftChangedError(currentRevision);
		}

		const dirtyPaths = dirtyPathsOf(mountRoot);
		const restored: string[] = [];
		const removed: string[] = [];

		if (options.scope.kind === "draft") {
			// The whole draft is one unit, so it returns as one unit. Git's own
			// reset+clean is the smallest mechanism that also handles staged
			// edits, deletions and renames correctly. `clean -fd` leaves ignored
			// files alone, so the engine layer survives.
			for (const entry of dirtyPaths) {
				if (existsInHead(mountRoot, entry)) restored.push(entry);
				else removed.push(entry);
			}
			runGitOrThrow(mountRoot, ["reset", "--hard", "HEAD"]);
			runGitOrThrow(mountRoot, ["clean", "--force", "-d"]);
			clearDraftOrigins(mountRoot);
			clearDraftOwner(mountRoot);
		} else {
			const relativePath = options.scope.path;
			assertRecordRevertSupported(mountRoot, config, relativePath, dirtyPaths);

			if (existsInHead(mountRoot, relativePath)) {
				runGitOrThrow(mountRoot, ["checkout", "HEAD", "--", relativePath]);
				restored.push(relativePath);
			} else {
				if (isTrackedInIndex(mountRoot, relativePath)) {
					runGitOrThrow(mountRoot, ["rm", "--force", "--quiet", "--", relativePath]);
				}
				rmSync(path.join(mountRoot, relativePath), { force: true });
				removed.push(relativePath);
			}
			clearDraftOrigins(mountRoot, [relativePath]);
		}

		const remainingDirtyPaths = dirtyPathsOf(mountRoot);
		// Pruning stale hints is a write, so it happens here, under the lock.
		pruneDraftOrigins(mountRoot, remainingDirtyPaths);
		if (remainingDirtyPaths.length === 0) clearDraftOwner(mountRoot);

		return {
			scope: options.scope.kind,
			restored,
			removed,
			remainingDirtyPaths,
			revision: computeDraftRevision(mountRoot),
		};
	} finally {
		release();
	}
}

export interface RevertAvailability {
	supported: boolean;
	reason?: string;
}

/**
 * Can this record be reverted on its own right now? The panel asks before it
 * offers the action, so a user is never given a button that then refuses.
 */
export function recordRevertAvailability(
	mountRoot: string,
	config: RepositoryDbConfig,
	relativePath: string,
): RevertAvailability {
	return recordRevertAvailabilityBatch(mountRoot, config, [relativePath]).get(relativePath) ?? {
		supported: false,
		reason: "Unknown record.",
	};
}

/**
 * The same answer for many records at once.
 *
 * A review panel asks about every record it is about to draw, and each answer
 * needs the same three Git reads — ahead/behind, the dirty set, rename
 * detection. Asking per record turns a status poll into a subprocess storm on a
 * large draft, so the shared work happens once here.
 */
export function recordRevertAvailabilityBatch(
	mountRoot: string,
	config: RepositoryDbConfig,
	relativePaths: readonly string[],
): Map<string, RevertAvailability> {
	const results = new Map<string, RevertAvailability>();
	if (relativePaths.length === 0) return results;

	// One shared guard check: if the whole checkout cannot be discarded from,
	// no record can, and the reason is the same for all of them.
	try {
		assertDiscardable(mountRoot, config);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		for (const relativePath of relativePaths) {
			results.set(relativePath, { supported: false, reason });
		}
		return results;
	}

	const dirtyPaths = dirtyPathsOf(mountRoot);
	const renameSources = gitRenameSources(mountRoot);
	for (const relativePath of relativePaths) {
		try {
			assertRecordRevertSupported(mountRoot, config, relativePath, dirtyPaths, renameSources);
			results.set(relativePath, { supported: true });
		} catch (error) {
			results.set(relativePath, {
				supported: false,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}
