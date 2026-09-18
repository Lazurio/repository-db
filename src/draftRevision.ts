import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { gitDirtyPaths, gitHeadCommit } from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";

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
		if (!existsSync(absolute)) {
			// Dirty but absent is a deletion, a state the revision must
			// distinguish from the file being present.
			hash.update("deleted");
			continue;
		}
		try {
			const stats = lstatSync(absolute);
			hash.update(stats.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute));
		} catch {
			hash.update("unreadable");
		}
	}
	return hash.digest("hex");
}

export function computeDraftRevisionParts(mountRoot: string): DraftRevisionParts {
	const dirtyPaths = gitDirtyPaths(mountRoot).filter(
		(entry) => !entry.startsWith(`${ENGINE_DIR}/`),
	);
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
 * Does the working tree still hold exactly the content that was confirmed?
 *
 * Deliberately ignores the baseline: publish integrates remote work between the
 * confirmation and the commit, which moves the baseline without changing what
 * the user reviewed. This is the check that runs immediately before staging.
 */
export function draftContentMatches(mountRoot: string, expectedRevision: string): boolean {
	const expected = parseDraftRevision(expectedRevision);
	if (!expected.content) return false;
	return expected.content === computeDraftRevisionParts(mountRoot).content;
}
