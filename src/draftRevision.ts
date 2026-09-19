import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { gitDirtyPaths, gitHeadCommit, gitRenameSources, runGit } from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";

/**
 * Draft revision — the identity of "the draft as it was shown".
 *
 * A confirmation always applies to a specific displayed version. The review
 * carries this value and the panel hands it back when publishing or discarding;
 * if the draft moved in between, the operation does not run.
 *
 * The value has two parts, `draft:<baseline>.<content>`:
 *
 *   - `baseline` — which commit the draft sits on. Changes when a colleague's
 *     work is pulled in, which invalidates the review the user read.
 *   - `content`  — what is in the working tree right now: exactly what publish
 *     commits. Publish compares the whole revision once, inside the shared
 *     gate, and keeps the gate until the commit is made, so no supported
 *     write can change the draft in between.
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
			// A directory in the dirty set is a submodule: what would be committed
			// is the commit it has checked out.
			content = stats.isSymbolicLink()
				? readlinkSync(absolute)
				: stats.isDirectory()
					? `gitlink:${runGit(absolute, ["rev-parse", "HEAD"]).stdout.trim()}`
					: readFileSync(absolute);
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
 * A staged rename is one entry reported by its new path; the same change
 * unstaged is an add plus a delete. Hashing Git's report as-is would make one
 * draft look like two different ones depending on the index. Adding rename
 * sources makes both shapes the same set of paths.
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
