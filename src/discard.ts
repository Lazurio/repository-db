import { rmSync } from "node:fs";
import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import { activeConflict } from "./conflict.ts";
import { isPathDeclared } from "./generated.ts";
import { gitDirtyPaths, runGit, runGitOrThrow } from "./git.ts";
import { acquirePublishLock, ENGINE_DIR } from "./lock.ts";
import {
	clearDraftOrigins,
	clearDraftOwner,
	isForeignChange,
	resolveDraftOrigins,
} from "./origin.ts";
import { type RepositoryDbConfig, RepositoryDbError } from "./types.ts";

/**
 * Discard — returning draft work to the last published state.
 *
 * This is the counterpart of publish: the same lock, the same fail-closed
 * posture, the opposite direction. It is deliberately NOT a reuse of
 * `conflict --abort`; dropping unwanted work is an ordinary, targeted
 * operation over the current dirty set, not a side effect of a recovery path.
 *
 * Reverting a single field is not an engine primitive: Git works per file, so a
 * field revert is an ordinary write of the baseline value by the host app.
 */

export interface DiscardOptions {
	/** Repo-relative paths to discard. Ignored when `all` is set. */
	paths?: readonly string[];
	/** Discard the whole current dirty set. */
	all?: boolean;
	/** Identity of the requester, matched against recorded draft provenance. */
	actor?: string;
	/** Proceed even when the target contains changes the actor cannot claim. */
	confirmForeign?: boolean;
}

export interface DiscardedPath {
	path: string;
	/** `restored` = returned to its HEAD content, `removed` = untracked addition deleted. */
	action: "restored" | "removed";
}

export interface DiscardResult {
	discarded: DiscardedPath[];
	/** Declared generated artifacts pulled in because their source was discarded. */
	generatedIncluded: string[];
	/** Dirty paths still present after the discard. */
	remainingDirtyPaths: string[];
}

export class ForeignChangeError extends RepositoryDbError {
	readonly foreignPaths: string[];

	constructor(foreignPaths: string[]) {
		super(
			"foreign_change_requires_confirm",
			`discard refused: ${foreignPaths.length} change(s) were not written by the requesting actor ` +
				`(${foreignPaths.slice(0, 5).join(", ")}${foreignPaths.length > 5 ? ", …" : ""}). ` +
				"Re-run with an explicit confirmation to discard them.",
		);
		this.name = "ForeignChangeError";
		this.foreignPaths = foreignPaths;
	}
}

/** Does `relativePath` exist in the current HEAD commit? */
function existsInHead(mountRoot: string, relativePath: string): boolean {
	return runGit(mountRoot, ["cat-file", "-e", `HEAD:${relativePath}`]).status === 0;
}

function isTrackedInIndex(mountRoot: string, relativePath: string): boolean {
	const result = runGit(mountRoot, ["ls-files", "--error-unmatch", "--", relativePath]);
	return result.status === 0;
}

/**
 * Expand the requested target set.
 *
 * Declared generated artifacts are derived data: once a canonical source is
 * returned to its published state, a dirty generated artifact built from the
 * newer draft is stale. Rather than leave that inconsistency behind, discarding
 * any canonical path also discards dirty declared generated output, which the
 * next publish re-materializes deterministically.
 */
function expandTargets(
	requested: readonly string[],
	dirtyPaths: readonly string[],
	config: RepositoryDbConfig,
): { targets: string[]; generatedIncluded: string[] } {
	const generatedPrefix = `${config.layout.generated}/`;
	const isGenerated = (entry: string) =>
		entry === config.layout.generated || entry.startsWith(generatedPrefix);

	const targets = new Set(requested);
	const generatedIncluded: string[] = [];
	const touchesCanonical = requested.some((entry) => !isGenerated(entry));
	if (touchesCanonical) {
		for (const entry of dirtyPaths) {
			if (!isGenerated(entry) || targets.has(entry)) continue;
			if (!isPathDeclared(entry, config)) continue;
			targets.add(entry);
			generatedIncluded.push(entry);
		}
	}
	return { targets: [...targets], generatedIncluded };
}

/**
 * Return draft changes to the last published state.
 *
 * Refuses while a conflict is recorded — recovery has to finish first — and
 * holds the publish lock so a discard can never race a publish over the same
 * working tree.
 */
export function discardDraft(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: DiscardOptions = {},
): DiscardResult {
	assertDataRepoBoundary(mountRoot, config);

	if (activeConflict(mountRoot)) {
		throw new RepositoryDbError(
			"conflict_active",
			"discard refused: the repository is in a conflict state. Resolve or abort the conflict first.",
		);
	}
	if (!options.all && (!options.paths || options.paths.length === 0)) {
		throw new RepositoryDbError(
			"invalid_args",
			"discard requires either explicit paths or the whole-draft option.",
		);
	}

	const release = acquirePublishLock(mountRoot);
	try {
		const dirtyPaths = gitDirtyPaths(mountRoot).filter(
			(entry) => !entry.startsWith(`${ENGINE_DIR}/`),
		);
		if (dirtyPaths.length === 0) {
			return { discarded: [], generatedIncluded: [], remainingDirtyPaths: [] };
		}

		const requested = options.all ? dirtyPaths : [...(options.paths ?? [])];
		const dirtySet = new Set(dirtyPaths);
		const unknown = requested.filter((entry) => !dirtySet.has(entry));
		if (unknown.length > 0) {
			throw new RepositoryDbError(
				"not_in_draft",
				`discard refused: not part of the current draft: ${unknown.join(", ")}`,
			);
		}

		const { targets, generatedIncluded } = expandTargets(requested, dirtyPaths, config);

		if (!options.confirmForeign) {
			const origins = resolveDraftOrigins(mountRoot, dirtyPaths);
			const foreign = targets.filter((entry) =>
				isForeignChange(origins.get(entry), options.actor),
			);
			if (foreign.length > 0) throw new ForeignChangeError(foreign);
		}

		const discarded: DiscardedPath[] = [];
		for (const target of targets) {
			if (existsInHead(mountRoot, target)) {
				// Restores both the index and the working tree, so a staged edit
				// and an unstaged one return to the same published content.
				runGitOrThrow(mountRoot, ["checkout", "HEAD", "--", target]);
				discarded.push({ path: target, action: "restored" });
				continue;
			}
			// New in this draft: drop it from the index when it was staged, then
			// remove the file itself.
			if (isTrackedInIndex(mountRoot, target)) {
				runGitOrThrow(mountRoot, ["rm", "--force", "--quiet", "--", target]);
			}
			rmSync(path.join(mountRoot, target), { force: true, recursive: true });
			discarded.push({ path: target, action: "removed" });
		}

		clearDraftOrigins(
			mountRoot,
			discarded.map((entry) => entry.path),
		);
		const remainingDirtyPaths = gitDirtyPaths(mountRoot).filter(
			(entry) => !entry.startsWith(`${ENGINE_DIR}/`),
		);
		if (remainingDirtyPaths.length === 0) clearDraftOwner(mountRoot);

		return { discarded, generatedIncluded, remainingDirtyPaths };
	} finally {
		release();
	}
}
