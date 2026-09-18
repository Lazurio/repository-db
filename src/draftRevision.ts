import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gitDirtyPaths, gitHeadCommit } from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";

/**
 * Draft revision — the identity of "the draft as it was shown".
 *
 * A confirmation always applies to a specific displayed version. The panel
 * receives this value with the review snapshot and hands it back when the user
 * publishes or discards; if the draft moved in between — a colleague saved a
 * record, an agent wrote a file — the operation does not run and the panel
 * refreshes instead.
 *
 * This is deliberately the smallest mechanism that can answer "is this still
 * the same draft": the baseline commit plus the content of every dirty path.
 * It is not a review history, not a version log and not an approval workflow.
 */

export function computeDraftRevision(mountRoot: string): string {
	const dirtyPaths = gitDirtyPaths(mountRoot)
		.filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`))
		.sort();

	const hash = createHash("sha256");
	hash.update(gitHeadCommit(mountRoot) ?? "no-head");
	for (const relativePath of dirtyPaths) {
		const absolute = path.join(mountRoot, relativePath);
		hash.update("\0");
		hash.update(relativePath);
		hash.update("\0");
		if (!existsSync(absolute)) {
			// A path that is dirty but absent is a deletion; that is a state the
			// revision must distinguish from the file being present.
			hash.update("deleted");
			continue;
		}
		try {
			hash.update(readFileSync(absolute));
		} catch {
			hash.update("unreadable");
		}
	}
	return `draft:${hash.digest("hex")}`;
}
