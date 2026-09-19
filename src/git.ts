import { type ChildProcess, execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { RepositoryDbError } from "./types.ts";

/**
 * Terminate a timed-out git child: SIGTERM, then escalate to SIGKILL if it is
 * ignored. The escalation timer is cleared as soon as the child exits, so a
 * later, reused PID is never signalled.
 *
 * Scope note — no process-group / tree kill. The git process itself is killed;
 * a portable teardown of orphaned transport children (e.g. `ssh`) would need
 * detached process groups, which the bun runtime this engine targets does NOT
 * support for `execFile` (a detached child is not made a group leader, so a
 * negative-pid group kill returns ESRCH). detached would also break Ctrl-C
 * propagation on Node. In practice a hung `git fetch/push` over ssh tears its
 * transport down when the git process dies; the prompt rejection in
 * {@link runGitAsync} is what actually frees the slot. A fully portable
 * tree-kill is deferred until the runtime supports it.
 */
function terminateGitChild(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		child.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	const escalation = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, 2000);
	(escalation as { unref?: () => void }).unref?.();
	const clearEscalation = () => clearTimeout(escalation);
	child.once("exit", clearEscalation);
	child.once("close", clearEscalation);
}

export interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

/** Default kill-after deadline for network git ops (fetch/pull/push). */
export const DEFAULT_GIT_NETWORK_TIMEOUT_MS = 60_000;

/**
 * Run git scoped to a repository root. Every engine git call goes through
 * here so the boundary guard can rely on `-C <repoRoot>` being present.
 *
 * Synchronous — reserved for fast LOCAL plumbing (status, rev-parse, add,
 * commit, …). Network ops (fetch/pull/push) must use {@link runGitAsync} so a
 * slow or hung remote can never block the single-threaded event loop.
 */
export function runGit(repoRoot: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	if (result.error) {
		throw new RepositoryDbError(
			"git_unavailable",
			`git could not be executed: ${result.error.message}`,
		);
	}
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/**
 * Async git runner for network ops with an explicit kill-on-timeout deadline.
 * A non-zero exit resolves with the git status (callers decide); only a spawn
 * failure or a timeout rejects (`git_unavailable` / `git_timeout`). Never use
 * for the request path without `await` — that is the whole point of moving
 * fetch/pull/push off `spawnSync`.
 */
export function runGitAsync(
	repoRoot: string,
	args: string[],
	options: { timeoutMs?: number; gitBin?: string } = {},
): Promise<GitResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_NETWORK_TIMEOUT_MS;
	const gitBin = options.gitBin ?? "git";
	return new Promise<GitResult>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const child = execFile(
			gitBin,
			["-C", repoRoot, ...args],
			{
				encoding: "utf8",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				maxBuffer: 64 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (timer) clearTimeout(timer);
				if (settled) return; // already rejected by the timeout path
				settled = true;
				if (error) {
					const err = error as NodeJS.ErrnoException;
					if (typeof err.code === "number") {
						resolve({ status: err.code, stdout: stdout ?? "", stderr: stderr ?? "" });
						return;
					}
					reject(
						new RepositoryDbError(
							"git_unavailable",
							`git could not be executed: ${error.message}`,
						),
					);
					return;
				}
				resolve({ status: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			// Reject at the deadline and tear down the group immediately. We do
			// NOT wait for the close callback: an orphaned child can hold the
			// stdout pipe open, which would otherwise delay the rejection past
			// timeoutMs (the bug this guards against).
			terminateGitChild(child);
			reject(
				new RepositoryDbError(
					"git_timeout",
					`git ${args.join(" ")} timed out after ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);
	});
}

export async function runGitAsyncOrThrow(
	repoRoot: string,
	args: string[],
	options: { timeoutMs?: number; gitBin?: string } = {},
): Promise<string> {
	const result = await runGitAsync(repoRoot, args, options);
	if (result.status !== 0) {
		throw new RepositoryDbError(
			"git_failed",
			`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return result.stdout;
}

export function runGitOrThrow(repoRoot: string, args: string[]): string {
	const result = runGit(repoRoot, args);
	if (result.status !== 0) {
		throw new RepositoryDbError(
			"git_failed",
			`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return result.stdout;
}

export function gitToplevel(repoRoot: string): string | undefined {
	const result = runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

export function gitCurrentBranch(repoRoot: string): string {
	return runGitOrThrow(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

export function gitRemoteUrl(repoRoot: string, remote = "origin"): string | undefined {
	const result = runGit(repoRoot, ["remote", "get-url", remote]);
	if (result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

/**
 * Parse NUL-delimited `git status --porcelain -z` output into [xy, path]
 * pairs. The -z form is used everywhere so paths with tabs, quotes or
 * non-ASCII characters arrive verbatim instead of C-escaped — the generated
 * policy check and the conflict detector must never mis-read a path.
 */
function gitStatusEntries(repoRoot: string, extraArgs: string[]): Array<[string, string]> {
	const output = runGitOrThrow(repoRoot, [
		"status",
		"--porcelain=v1",
		"-z",
		...extraArgs,
	]);
	const tokens = output.split("\0").filter((token) => token.length > 0);
	const entries: Array<[string, string]> = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token.length < 4) continue;
		const xy = token.slice(0, 2);
		const path = token.slice(3);
		entries.push([xy, path]);
		// Renames/copies emit the original path as the next NUL token.
		if (xy.includes("R") || xy.includes("C")) index += 1;
	}
	return entries;
}

/**
 * Staged rename/copy sources, keyed by their new path.
 *
 * `git status -z` reports `R`/`C` entries as `<new>\0<old>`, and
 * {@link gitDirtyPaths} intentionally surfaces only the new path. A caller that
 * has to return a renamed record to its published state needs the old path too,
 * otherwise the source stays staged as deleted.
 */
export function gitRenameSources(repoRoot: string): Map<string, string> {
	const output = runGitOrThrow(repoRoot, [
		"status",
		"--porcelain=v1",
		"-z",
		// Explicit, so the guard does not depend on the user's status.renames.
		"--renames",
		"--untracked-files=all",
	]);
	const tokens = output.split("\0").filter((token) => token.length > 0);
	const sources = new Map<string, string>();
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token.length < 4) continue;
		const xy = token.slice(0, 2);
		const newPath = token.slice(3);
		if (xy.includes("R") || xy.includes("C")) {
			const oldPath = tokens[index + 1];
			if (oldPath) sources.set(newPath, oldPath);
			index += 1;
		}
	}
	return sources;
}

/** Porcelain dirty paths relative to the repo root (staged, unstaged and untracked). */
export function gitDirtyPaths(repoRoot: string): string[] {
	return gitStatusEntries(repoRoot, ["--untracked-files=all"]).map(
		([, path]) => path,
	);
}

export interface AheadBehind {
	ahead: number;
	behind: number;
}

export function gitAheadBehind(repoRoot: string, branch: string): AheadBehind {
	const result = runGit(repoRoot, [
		"rev-list",
		"--left-right",
		"--count",
		`${branch}...origin/${branch}`,
	]);
	if (result.status !== 0) {
		// No upstream yet (fresh data repo before the first push): every local
		// commit is still unsent.
		const local = runGit(repoRoot, ["rev-list", "--count", branch]);
		return { ahead: local.status === 0 ? Number(local.stdout.trim()) || 0 : 0, behind: 0 };
	}
	const [ahead = "0", behind = "0"] = result.stdout.trim().split(/\s+/);
	return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
}

/**
 * Paths with unresolved merge conflicts (porcelain XY containing U, or
 * AA/DD). Crucially this also catches the autostash-rebase case where git exits
 * 0 but leaves the autostash applied with conflict markers.
 */
export function gitUnmergedPaths(repoRoot: string): string[] {
	return gitStatusEntries(repoRoot, [])
		.filter(([xy]) => xy.includes("U") || xy === "AA" || xy === "DD")
		.map(([, path]) => path);
}

/** True when a rebase or merge is in progress inside the repository. */
export function gitOperationInProgress(repoRoot: string): string | undefined {
	const gitDir = runGitOrThrow(repoRoot, ["rev-parse", "--absolute-git-dir"]).trim();
	if (existsSync(`${gitDir}/rebase-merge`)) return "rebase-merge";
	if (existsSync(`${gitDir}/rebase-apply`)) return "rebase-apply";
	if (existsSync(`${gitDir}/MERGE_HEAD`)) return "merge";
	return undefined;
}

/** Network fetch via the async runner (kill-on-timeout). */
export async function gitFetchAsync(
	repoRoot: string,
	timeoutMs?: number,
	options: { gitBin?: string } = {},
): Promise<void> {
	await runGitAsyncOrThrow(repoRoot, ["fetch", "--quiet", "origin"], {
		timeoutMs,
		gitBin: options.gitBin,
	});
}

/**
 * Read many blobs from one commit in a single git process.
 *
 * A review reads the published version of every changed record. Doing that with
 * one `git show` per record is one subprocess per record — fine for three
 * changes, a stalled request for a bulk agent edit. `cat-file --batch` answers
 * the whole list from one process instead.
 *
 * Returns a map keyed by the requested path; a path absent from the commit maps
 * to `undefined`, which is how a newly created record looks.
 */
export function gitBatchShow(
	repoRoot: string,
	ref: string,
	relativePaths: readonly string[],
): Map<string, string | undefined> {
	const result = new Map<string, string | undefined>();
	if (relativePaths.length === 0) return result;

	// The batch protocol is newline-delimited. A path containing a newline would
	// shift every following answer onto the wrong path, so such a set is read
	// one blob at a time instead — rare, and correct beats fast.
	if (relativePaths.some((entry) => entry.includes("\n"))) {
		for (const relativePath of relativePaths) {
			const single = runGit(repoRoot, ["show", `${ref}:${relativePath}`]);
			result.set(relativePath, single.status === 0 ? single.stdout : undefined);
		}
		return result;
	}

	const request = spawnSync("git", ["-C", repoRoot, "cat-file", "--batch"], {
		input: `${relativePaths.map((entry) => `${ref}:${entry}`).join("\n")}\n`,
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	if (request.error) {
		throw new RepositoryDbError(
			"git_unavailable",
			`git could not be executed: ${request.error.message}`,
		);
	}
	const stdout: Buffer = request.stdout ?? Buffer.alloc(0);

	// Responses come back in request order: either "<oid> <type> <size>\n<bytes>\n"
	// or "<object> missing\n".
	let cursor = 0;
	for (const relativePath of relativePaths) {
		const newline = stdout.indexOf(0x0a, cursor);
		if (newline === -1) {
			result.set(relativePath, undefined);
			continue;
		}
		const header = stdout.subarray(cursor, newline).toString("utf8");
		cursor = newline + 1;
		if (header.endsWith(" missing")) {
			result.set(relativePath, undefined);
			continue;
		}
		const size = Number(header.split(" ").at(-1));
		if (!Number.isFinite(size)) {
			result.set(relativePath, undefined);
			continue;
		}
		result.set(relativePath, stdout.subarray(cursor, cursor + size).toString("utf8"));
		cursor += size + 1; // trailing newline after the blob
	}
	return result;
}

export function gitHeadCommit(repoRoot: string): string | undefined {
	const result = runGit(repoRoot, ["rev-parse", "HEAD"]);
	if (result.status !== 0) return undefined;
	return result.stdout.trim();
}
