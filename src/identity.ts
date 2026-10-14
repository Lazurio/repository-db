import { runGit } from "./git.ts";

export interface CommitIdentity {
	name: string;
	email: string;
}

/**
 * The identity this Environment commits with, resolved exactly as the publish
 * preflight resolves it: `git var GIT_AUTHOR_IDENT` with `user.useConfigOnly`,
 * so only a configured (or explicitly passed) name and e-mail count and Git
 * never guesses one from the account and the host name. `null` when there is
 * none. Read-only: nothing is written or configured.
 */
export function readCommitIdentity(mountRoot: string): CommitIdentity | null {
	const ident = runGit(mountRoot, ["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]);
	if (ident.status !== 0) return null;
	const match = ident.stdout.trim().match(/^(.*?)\s*<([^>]*)>\s+\d+\s+[+-]\d{4}$/);
	if (!match) return null;
	const name = (match[1] ?? "").trim();
	const email = (match[2] ?? "").trim();
	return name && email ? { name, email } : null;
}
