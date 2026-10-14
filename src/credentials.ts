import { execFile } from "node:child_process";
import { CredentialsError } from "./types.ts";

/**
 * Credential preflight for private data repositories.
 *
 * First-phase policy (DEV-6353): the GitHub CLI credential store is the
 * default mechanism. repository-db never stores tokens, SSH keys or webhook
 * secrets in the code or data repository — it only verifies that an external
 * credential mechanism is present before any working-tree mutation.
 *
 * Non-interactive environments (CI, hosted Workspace Host, client cutover)
 * must configure an approved non-interactive provider instead: a GitHub App
 * installation, a deploy key via ssh-agent, or a preconfigured Git credential
 * helper. When none is detected the publish fails here, before any change.
 *
 * The check runs off the event loop (`gh auth status` asks GitHub over the
 * network) and a successful answer is reused for a short while in this
 * process, so a burst of publishes does not ask GitHub every time. A failed
 * answer is never cached: signing in takes effect on the next attempt.
 */

/** How long a successful check is reused in this process. */
const CREDENTIAL_CACHE_MS = 5 * 60 * 1000;
/** A credential command that hangs must not hold a publish. */
const CREDENTIAL_COMMAND_TIMEOUT_MS = 15_000;


export interface CredentialCheck {
	ok: boolean;
	mechanism: "gh" | "ssh-agent" | "ssh-config" | "credential-helper" | "local-remote" | "none";
	detail: string;
}

function isGithubRemote(remote: string): boolean {
	return /github\.com/.test(remote);
}

function isLocalRemote(remote: string): boolean {
	return remote.startsWith("/") || remote.startsWith("file://") || remote.startsWith(".");
}

function ghBin(): string {
	return process.env.REPOSITORY_DB_GH_BIN || "gh";
}

interface RunResult {
	status: number;
	out: string;
	stdout: string;
}

function tryRun(
	cmd: string,
	args: string[],
	options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = execFile(
			cmd,
			args,
			{
				encoding: "utf8",
				// env is passed explicitly: Bun's child processes do not inherit
				// runtime process.env mutations by default.
				env: options.env ?? { ...process.env },
				timeout: CREDENTIAL_COMMAND_TIMEOUT_MS,
				killSignal: "SIGKILL",
			},
			(error, stdout, stderr) => {
				const out = `${stdout ?? ""}${stderr ?? ""}`;
				if (!error) {
					resolve({ status: 0, out, stdout: stdout ?? "" });
					return;
				}
				const code = (error as NodeJS.ErrnoException).code;
				resolve({
					status: typeof code === "number" ? code : 127,
					out: out || error.message,
					stdout: stdout ?? "",
				});
			},
		);
		child.stdin?.end(options.input ?? "");
	});
}

function credentialFillInput(remote: string): string | null {
	try {
		const url = new URL(remote);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		const credentialPath = url.pathname.replace(/^\//, "");
		return `protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\npath=${credentialPath}\n\n`;
	} catch {
		return null;
	}
}

async function checkCredentialHelper(remote: string, helperDetail: string): Promise<CredentialCheck> {
	const input = credentialFillInput(remote);
	if (!input) {
		return {
			ok: false,
			mechanism: "none",
			detail: `git credential.helper is configured (${helperDetail}) but remote is not an HTTP(S) URL repository-db can preflight`,
		};
	}
	const result = await tryRun("git", ["credential", "fill"], {
		input,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "Never",
		},
	});
	const stdout = result.stdout;
	if (result.status === 0 && /^username=.+$/m.test(stdout) && /^password=.+$/m.test(stdout)) {
		return {
			ok: true,
			mechanism: "credential-helper",
			detail: `git credential.helper = ${helperDetail}; credential fill returned a non-interactive credential`,
		};
	}
	return {
		ok: false,
		mechanism: "none",
		detail: `git credential.helper is configured (${helperDetail}) but did not return a non-interactive credential for this remote`,
	};
}

const cache = new Map<string, { check: CredentialCheck; at: number }>();

/** Forget cached answers (after a sign-out, or in tests). */
export function clearCredentialCache(): void {
	cache.clear();
}

export async function checkCredentials(remote: string): Promise<CredentialCheck> {
	const key = `${ghBin()}\0${remote}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.at < CREDENTIAL_CACHE_MS) return cached.check;
	const check = await detectCredentials(remote);
	if (check.ok) cache.set(key, { check, at: Date.now() });
	else cache.delete(key);
	return check;
}

async function detectCredentials(remote: string): Promise<CredentialCheck> {
	if (isLocalRemote(remote)) {
		return {
			ok: true,
			mechanism: "local-remote",
			detail: "remote is a local path; no credentials required",
		};
	}

	const isGithub = isGithubRemote(remote);
	const gh = isGithub ? await tryRun(ghBin(), ["auth", "status"]) : null;
	if (gh?.status === 0) {
		return { ok: true, mechanism: "gh", detail: "gh auth status: authenticated" };
	}

	// Approved non-interactive fallbacks for hosted/client environments.
	if (remote.startsWith("git@") || remote.startsWith("ssh://")) {
		const ssh = await tryRun("ssh-add", ["-l"]);
		if (ssh.status === 0 && ssh.out.trim() && !/no identities/i.test(ssh.out)) {
			return {
				ok: true,
				mechanism: "ssh-agent",
				detail: "ssh-agent holds at least one identity",
			};
		}
	}

	// A key the SSH client finds on its own (a deploy key in ~/.ssh/config, a
	// default key file) is invisible to ssh-agent; ask the remote itself,
	// non-interactively, before refusing.
	if (remote.startsWith("git@") || remote.startsWith("ssh://")) {
		const probe = await tryRun("git", ["ls-remote", "--heads", remote], {
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
			},
		});
		if (probe.status === 0) {
			return {
				ok: true,
				mechanism: "ssh-config",
				detail: "git ls-remote reached the remote non-interactively (SSH key from the client configuration)",
			};
		}
	}

	const helper = await tryRun("git", ["config", "--get", "credential.helper"]);
	if (helper.status === 0 && helper.out.trim()) {
		return checkCredentialHelper(remote, helper.out.trim());
	}

	const fillInput = credentialFillInput(remote);
	if (fillInput) {
		return {
			ok: false,
			mechanism: "none",
			detail: isGithub
				? gh?.status === 127
					? "GitHub CLI (gh) is not installed and no git credential.helper is configured for this HTTP(S) remote"
					: "GitHub CLI is installed but not authenticated (gh auth login), and no git credential.helper is configured for this HTTP(S) remote"
				: "HTTP(S) remote has no git credential.helper configured; configure an approved non-interactive credential provider first",
		};
	}

	return {
		ok: false,
		mechanism: "none",
		detail: isGithub
			? gh?.status === 127
				? "GitHub CLI (gh) is not installed and no non-interactive credential provider was detected"
				: "GitHub CLI is installed but not authenticated (gh auth login), and no non-interactive credential provider was detected"
			: "remote is not an HTTP(S) URL and no ssh-agent identity or supported non-interactive credential provider was detected",
	};
}

/** Throw a {@link CredentialsError} before any working-tree mutation. */
export async function assertCredentials(remote: string): Promise<CredentialCheck> {
	const check = await checkCredentials(remote);
	if (!check.ok) {
		throw new CredentialsError(
			`credential preflight failed for remote ${remote}: ${check.detail}. ` +
				"repository-db never stores tokens in the repo; authenticate gh (local default) " +
				"or configure an approved non-interactive provider (GitHub App, deploy key via ssh-agent, git credential helper).",
		);
	}
	return check;
}
