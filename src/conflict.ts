import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	gitOperationInProgress,
	gitUnmergedPaths,
	runGit,
	runGitOrThrow,
} from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";
import {
	ConflictActiveError,
	type ConflictState,
	RepositoryDbError,
} from "./types.ts";

const CONFLICT_FILE = "conflict.json";

function conflictPath(mountRoot: string): string {
	return path.join(mountRoot, ENGINE_DIR, CONFLICT_FILE);
}

export function readConflictState(mountRoot: string): ConflictState | undefined {
	const filePath = conflictPath(mountRoot);
	if (!existsSync(filePath)) return undefined;
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as ConflictState;
	} catch {
		return {
			schemaVersion: "repository-db.conflict.v1",
			detectedAt: "unknown",
			operation: "unknown",
			gitState: "unknown",
			message: `conflict state file is unreadable: ${filePath}`,
			handoff: "Inspect the data repository manually before continuing.",
		};
	}
}

export function writeConflictState(
	mountRoot: string,
	state: Omit<ConflictState, "schemaVersion" | "handoff"> & { handoff?: string },
): ConflictState {
	const payload: ConflictState = {
		schemaVersion: "repository-db.conflict.v1",
		handoff:
			state.handoff ??
			[
				"repository-db zastavil další zápisy do vyřešení konfliktu.",
				`1. Otevři data checkout: cd ${mountRoot}`,
				"2. Prohlédni stav: git status",
				"3a. Vyřeš konflikt ručně/agentem, dokonči rebase (git rebase --continue) a spusť: repository-db conflict --resolved",
				"3b. Nebo rebase bezpečně zruš: repository-db conflict --abort",
				"Do té doby repository-db odmítá writes i publish.",
			].join("\n"),
		...state,
	};
	const filePath = conflictPath(mountRoot);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	return payload;
}

/**
 * A conflict is active when the engine recorded one or when git itself is in
 * the middle of a rebase/merge (e.g. a crashed publish).
 */
export function activeConflict(mountRoot: string): ConflictState | undefined {
	const recorded = readConflictState(mountRoot);
	if (recorded) return recorded;
	const operation = gitOperationInProgress(mountRoot);
	if (operation) {
		return {
			schemaVersion: "repository-db.conflict.v1",
			detectedAt: "unknown",
			operation: "external",
			gitState: operation,
			message: `git ${operation} is in progress in the data repository`,
			handoff:
				"A git rebase/merge is in progress without a recorded repository-db conflict state. " +
				"Finish or abort it manually, then run `repository-db status` to verify.",
		};
	}
	const unmerged = gitUnmergedPaths(mountRoot);
	if (unmerged.length > 0) {
		return {
			schemaVersion: "repository-db.conflict.v1",
			detectedAt: "unknown",
			operation: "external",
			gitState: `unmerged: ${unmerged.join(", ")}`,
			message: "the data repository has unresolved merge conflicts",
			handoff:
				// Abort only undoes what repository-db itself started; these
				// markers come from elsewhere, so resolving them is the way out.
				"Resolve the conflict markers, `git add` the files, then run " +
				"`repository-db conflict --resolved`.",
		};
	}
	return undefined;
}

export function assertNoActiveConflict(mountRoot: string): void {
	const conflict = activeConflict(mountRoot);
	if (conflict) {
		throw new ConflictActiveError(
			`${conflict.message}\n\n${conflict.handoff}`,
		);
	}
}

/**
 * Leave the conflict and return to a state the user can act on.
 *
 * - A git rebase/merge in progress (started by hand or by an older engine) is
 *   aborted; Git restores what it held.
 * - A conflict the engine recorded while sending means local commits could
 *   not be replayed onto the remote. Those commits return to the draft
 *   (`reset --mixed` to where they branched off): nothing is lost, the files
 *   stay exactly as they are. The way on is to revert the conflicting
 *   records, pull the colleague's changes and redo the edit on top: pull is
 *   fast-forward only, so an adjusted record would conflict again.
 */
export function abortConflict(mountRoot: string, branch: string): void {
	if (typeof branch !== "string" || !branch.trim()) {
		// Without the branch the unsent commits cannot be found, and clearing the
		// record anyway would unblock writes while they stay committed.
		throw new RepositoryDbError(
			"invalid_args",
			"abortConflict needs the data branch (use RepositoryDb.abortConflict())",
		);
	}
	const operation = gitOperationInProgress(mountRoot);
	if (operation === "rebase-merge" || operation === "rebase-apply") {
		runGitOrThrow(mountRoot, ["rebase", "--abort"]);
	} else if (operation === "merge") {
		runGitOrThrow(mountRoot, ["merge", "--abort"]);
	}
	const unmerged = gitUnmergedPaths(mountRoot);
	if (unmerged.length > 0) {
		throw new RepositoryDbError(
			"abort_incomplete",
			`unresolved conflict markers remain that repository-db did not create (${unmerged.join(", ")}); resolve them by hand, then run conflict --resolved`,
		);
	}
	if (readConflictState(mountRoot)) {
		const base = runGit(mountRoot, ["merge-base", "HEAD", `refs/remotes/origin/${branch}`]).stdout.trim();
		if (!base) {
			throw new RepositoryDbError(
				"abort_incomplete",
				`cannot find where the unsent commits branched off origin/${branch}; the conflict stays recorded — inspect ${mountRoot} by hand`,
			);
		}
		runGitOrThrow(mountRoot, ["reset", "--mixed", "--quiet", base]);
	}
	rmSync(conflictPath(mountRoot), { force: true });
}

/**
 * Clear the recorded conflict state after a manual resolve. Refuses while a
 * git operation is still in progress or conflict markers remain unresolved.
 */
export function markConflictResolved(mountRoot: string): void {
	const operation = gitOperationInProgress(mountRoot);
	if (operation) {
		throw new RepositoryDbError(
			"conflict_unresolved",
			`git ${operation} is still in progress; finish it (git rebase --continue / git merge --continue) before marking resolved`,
		);
	}
	const unmerged = gitUnmergedPaths(mountRoot);
	if (unmerged.length > 0) {
		throw new RepositoryDbError(
			"conflict_unresolved",
			`unresolved conflict markers remain (${unmerged.join(", ")}); resolve and \`git add\` them before marking resolved`,
		);
	}
	rmSync(conflictPath(mountRoot), { force: true });
}
