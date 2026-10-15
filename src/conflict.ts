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

function cleanCheckoutHandoff(): string {
	return [
		"This repository-db does not undo it automatically. Clean the checkout by hand:",
		"1. Look at `git status` and `git log @{upstream}..HEAD` in the data checkout and keep what is not published yet.",
		"2. Bring the checkout back to a plain state on the data branch (no rebase or merge in progress).",
		`3. Run \`repository-db conflict --resolved\`, which removes ${ENGINE_DIR}/${CONFLICT_FILE}.`,
	].join("\n");
}

/**
 * A recorded conflict this engine can act on carries the pending commit. One
 * without it was written by an older engine (or is unreadable): it is reported
 * with a clean-the-checkout handoff, never interpreted.
 */
function isUsableRecord(state: ConflictState): boolean {
	return typeof state.pendingHead === "string" && state.pendingHead.length > 0;
}

export function readConflictState(mountRoot: string): ConflictState | undefined {
	const filePath = conflictPath(mountRoot);
	if (!existsSync(filePath)) return undefined;
	let parsed: ConflictState | undefined;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8")) as ConflictState;
	} catch {
		parsed = undefined;
	}
	if (parsed && isUsableRecord(parsed)) return parsed;
	return {
		schemaVersion: "repository-db.conflict.v1",
		detectedAt: parsed?.detectedAt ?? "unknown",
		operation: "legacy",
		gitState: parsed?.gitState ?? "unknown",
		message: parsed
			? `A conflict recorded by an older repository-db is still in this checkout (${parsed.message ?? "no message"}).`
			: `The conflict record ${ENGINE_DIR}/${CONFLICT_FILE} is unreadable.`,
		handoff: cleanCheckoutHandoff(),
		retryable: false,
	};
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
				"1. Neprováděj v aktivním data mountu ruční rebase, reset ani stash.",
				"2. Ověř panel nebo `repository-db conflict`; uvádí přesně nevyřešené soubory a pole.",
				"3. Pokud je k dispozici `finish-send`, potvrď zobrazený HEAD; engine zkusí bezpečné sloučení znovu.",
				"4. Jinak konflikt zruš přes `repository-db conflict --abort`, načti publikovaný stav a změnu proveď znovu.",
				"5. Externí Git operaci nebo nejednoznačný business rozpor eskaluj stewardovi; data se nemění automaticky.",
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
 * - A git rebase/merge in progress (started by hand) is aborted; Git restores
 *   what it held.
 * - A conflict an older engine recorded is refused with a clean-the-checkout
 *   handoff; this engine does not guess how that engine left the checkout.
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
	// Before anything moves: a record this engine cannot interpret is cleaned
	// by hand, whatever else is going on in the checkout.
	const recorded = readConflictState(mountRoot);
	if (recorded?.operation === "legacy") {
		throw new RepositoryDbError("legacy_engine_state", `${recorded.message}\n\n${recorded.handoff}`);
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
	if (recorded) {
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

export function clearRecordedConflictState(mountRoot: string): void {
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
