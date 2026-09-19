import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { isPathDeclared } from "./generated.ts";
import { gitDirtyPaths, gitHeadCommit, gitRenameSources } from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";
import type { RepositoryDbConfig } from "./types.ts";

/**
 * Draft revision — the identity of "the draft as it was shown".
 *
 * A confirmation always applies to a specific displayed version. The review
 * carries this value and the panel hands it back when publishing or discarding;
 * if the draft moved in between, the operation does not run.
 *
 * The value has two parts, `draft:<baseline>.<content>`, because they answer
 * two different questions and integration changes only one of them:
 *
 *   - `baseline` — which commit the draft sits on. Changes when a colleague's
 *     work is pulled in, which invalidates the review the user read.
 *   - `content`  — what is actually in the working tree right now. This is what
 *     publish stages, so it is re-checked immediately before staging, after
 *     integration has moved the baseline.
 *
 * The content hash covers the file mode too: a `chmod +x` is a real change to
 * what would be published, and hashing bytes alone would let it ride along
 * unreviewed.
 */

const REVISION_PREFIX = "draft:";

export interface DraftRevisionParts {
	baseline: string;
	content: string;
}

/** Git-visible mode of a working-tree path, in the form Git records it. */
function fileMode(absolutePath: string): string {
	try {
		const stats = lstatSync(absolutePath);
		if (stats.isSymbolicLink()) return "120000";
		return (stats.mode & 0o111) === 0 ? "100644" : "100755";
	} catch {
		return "absent";
	}
}

function contentHash(mountRoot: string, dirtyPaths: readonly string[]): string {
	const hash = createHash("sha256");
	for (const relativePath of [...dirtyPaths].sort()) {
		const absolute = path.join(mountRoot, relativePath);
		hash.update("\0");
		hash.update(relativePath);
		hash.update("\0");
		hash.update(fileMode(absolute));
		hash.update("\0");
		let stats: ReturnType<typeof lstatSync> | undefined;
		try {
			// lstat, not exists: a dangling symlink is a directory entry with a
			// target that can change, not a deletion.
			stats = lstatSync(absolute);
		} catch {
			// Dirty but absent is a deletion, a state the revision must
			// distinguish from the file being present.
			hash.update("deleted");
			continue;
		}
		let content: Buffer | string;
		try {
			content = stats.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute);
		} catch {
			hash.update("unreadable");
			continue;
		}
		// Length-framed, so two different sets of files cannot concatenate into
		// the same byte stream and share a revision.
		hash.update(`${Buffer.byteLength(content)}\0`);
		hash.update(content);
	}
	return hash.digest("hex");
}

/**
 * Every path the draft touches, independent of how Git happens to split it.
 *
 * A staged rename is one entry reported by its new path; the same change after
 * an autostash apply is a staged add plus an unstaged delete. Hashing Git's
 * report as-is would make the two look like different drafts — and publish,
 * which integrates between its two checks, would refuse its own confirmed
 * draft. Adding rename sources makes both shapes the same set of paths.
 */
function draftPaths(mountRoot: string): string[] {
	return [
		...new Set([...gitDirtyPaths(mountRoot), ...gitRenameSources(mountRoot).values()]),
	].filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`));
}

export function computeDraftRevisionParts(mountRoot: string): DraftRevisionParts {
	const dirtyPaths = draftPaths(mountRoot);
	return {
		baseline: gitHeadCommit(mountRoot) ?? "no-head",
		content: contentHash(mountRoot, dirtyPaths),
	};
}

export function formatDraftRevision(parts: DraftRevisionParts): string {
	return `${REVISION_PREFIX}${parts.baseline}.${parts.content}`;
}

export function computeDraftRevision(mountRoot: string): string {
	return formatDraftRevision(computeDraftRevisionParts(mountRoot));
}

/**
 * Split a revision back into its parts. An unparseable value yields empty
 * parts, which can never equal a computed revision — a malformed confirmation
 * is refused rather than waved through.
 */
export function parseDraftRevision(revision: string): DraftRevisionParts {
	if (!revision.startsWith(REVISION_PREFIX)) return { baseline: "", content: "" };
	const rest = revision.slice(REVISION_PREFIX.length);
	const separator = rest.indexOf(".");
	if (separator === -1) return { baseline: "", content: "" };
	return { baseline: rest.slice(0, separator), content: rest.slice(separator + 1) };
}

/**
 * Fingerprint of the canonical draft content — everything dirty except
 * generated output.
 *
 * This is what publish compares before staging. It cannot be derived from the
 * revision, because publishing legitimately rewrites generated artifacts on the
 * way: materializing a rollup would otherwise look exactly like a colleague's
 * write and make a correct publish refuse itself. So publish captures this
 * fingerprint right after the confirmation and compares the same measure again
 * at the moment it stages.
 */
export function computeCanonicalContentHash(
	mountRoot: string,
	config: RepositoryDbConfig,
): string {
	const generatedPrefix = `${config.layout.generated}/`;
	const dirtyPaths = draftPaths(mountRoot)
		.filter((entry) => entry !== config.layout.generated)
		.filter((entry) => !entry.startsWith(generatedPrefix))
		// A declared artifact may live outside the generated layout; its
		// materializer rewrites it just the same.
		.filter((entry) => !isPathDeclared(entry, config));
	return contentHash(mountRoot, dirtyPaths);
}
