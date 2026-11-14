import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { RepositoryDbError } from "./types.ts";

/**
 * `REPOSITORY_DB_TRANSPORT`: the data repository reached through a host's own
 * command instead of Git's network.
 *
 * A host that must not hold credentials for the data repository (for example
 * a production applications host whose apps run without any token) sets
 * `REPOSITORY_DB_TRANSPORT` to the absolute path of an executable. The engine
 * then runs no network Git (`fetch`, `push`, `clone`, `ls-remote`) and no
 * credential probe (`gh auth status`, `ssh-add`, `git credential fill`):
 * fetch, push and the credential check are that command's `fetch`, `push` and
 * `check`. It never falls back to Git. Everything else stays as it is: the
 * boundary guard (`assertPushTarget` included), the gate, the lane rebase and
 * semantic merge, validators, conflicts and at most three send attempts.
 *
 * Unset or empty, the engine uses Git and its credential preflight exactly as
 * before. This module is the protocol; `git.ts` runs it, in the one place
 * every network operation of the engine goes through.
 *
 *   <transport> check --mount <m> --remote <r> --branch <b> --deadline-ms <ms>
 *   <transport> fetch --mount <m> --remote <r> --branch <b> --deadline-ms <ms>
 *   <transport> push  --mount <m> --remote <r> --branch <b> --deadline-ms <ms>
 *                     --commit <sha> --expect <sha|none>
 *
 * stdout is one JSON line of at most 4 KiB; the exit code decides: 0 done,
 * 1 (push only) not a fast-forward of the moved remote, 2 refused for good,
 * 3 unavailable for now. Any other exit, a signal, the engine's deadline or an
 * answer that is not valid counts as 3.
 */

export const TRANSPORT_ENV = "REPOSITORY_DB_TRANSPORT";
export const TRANSPORT_SCHEMA_VERSION = "repository-db.transport.v1";

/** The transport is told the engine's deadline minus this, so it can answer before the engine stops it. */
export const TRANSPORT_DEADLINE_MARGIN_MS = 2000;
/** The largest stdout the engine reads as an answer. */
const MAX_ANSWER_BYTES = 4096;
/** How much of the answer's `detail` the engine keeps. */
const MAX_DETAIL_CHARS = 2000;
/** How much of the transport's stderr goes into a message. */
const MAX_STDERR_BYTES = 4096;

export type TransportOperation = "check" | "fetch" | "push";
export type TransportCode = 0 | 1 | 2 | 3;

/** The outcomes an exit code may carry, per operation; anything else counts as 3. */
const OUTCOMES: Record<TransportOperation, Partial<Record<number, readonly string[]>>> = {
	check: { 0: ["ok"], 2: ["refused"], 3: ["unavailable"] },
	fetch: { 0: ["fetched", "up-to-date"], 2: ["refused"], 3: ["unavailable"] },
	push: {
		0: ["pushed", "up-to-date"],
		1: ["rejected-non-fast-forward"],
		2: ["refused"],
		3: ["unavailable"],
	},
};

/** The transport the environment names, or undefined when the engine uses Git (unset or empty). */
export function configuredTransport(): string | undefined {
	const value = process.env[TRANSPORT_ENV];
	return value ? value : undefined;
}

export function transportUnavailable(detail: string): RepositoryDbError {
	return new RepositoryDbError(
		"transport_unavailable",
		`The data repository cannot be reached through the transport: ${detail}. Nothing was fetched or pushed.`,
	);
}

/**
 * The named transport, checked before it runs: an absolute path to an
 * executable file. Anything else is `transport_unavailable`. The engine never
 * looks the command up in PATH and never falls back to Git.
 */
export function usableTransport(transport: string): string {
	if (!path.isAbsolute(transport)) {
		throw transportUnavailable(`${TRANSPORT_ENV} must be an absolute path to an executable, not "${transport}"`);
	}
	let isFile: boolean;
	try {
		isFile = statSync(transport).isFile();
	} catch {
		throw transportUnavailable(`${TRANSPORT_ENV} names ${transport}, which does not exist`);
	}
	if (!isFile) throw transportUnavailable(`${TRANSPORT_ENV} names ${transport}, which is not a file`);
	try {
		accessSync(transport, constants.X_OK);
	} catch {
		throw transportUnavailable(`${TRANSPORT_ENV} names ${transport}, which is not executable`);
	}
	return transport;
}

export interface TransportRequest {
	/** Real path of the data checkout; also the transport's working directory. */
	mount: string;
	/** `data_repo.remote` from `repository-db.yaml`, never the URL of `origin`. */
	remote: string;
	/** `data_repo.branch`. */
	branch: string;
	deadlineMs: number;
	/** push: the commit to send, the checkout's HEAD. */
	commit?: string | undefined;
	/** push: the remote head the send integrated onto; none when the remote branch is missing. */
	expect?: string | undefined;
}

/** The deadline the transport is told: the engine's own limit minus the margin. */
export function transportDeadline(timeoutMs: number): number {
	return Math.max(1, timeoutMs - TRANSPORT_DEADLINE_MARGIN_MS);
}

/** The argument vector after the executable. */
export function transportArgs(operation: TransportOperation, request: TransportRequest): string[] {
	const args = [
		operation,
		"--mount",
		request.mount,
		"--remote",
		request.remote,
		"--branch",
		request.branch,
		"--deadline-ms",
		String(request.deadlineMs),
	];
	if (operation === "push") {
		args.push("--commit", request.commit ?? "", "--expect", request.expect || "none");
	}
	return args;
}

/** What running the command came to, as the bounded runner in `git.ts` reports it. */
export type TransportRun =
	| { kind: "exited"; status: number; stdout: string; stderr: string }
	| { kind: "failed"; reason: string; stderr: string }
	| { kind: "timed-out"; timeoutMs: number };

export interface TransportAnswer {
	/** How the engine reads the run: the exit code of a valid answer, 3 for anything else. */
	code: TransportCode;
	/** The answer's outcome; `unavailable` when the engine counts the run as 3. */
	outcome: string;
	remoteHead: string | null;
	/** The transport's own words, bounded: its `detail`, then the start of its stderr. */
	detail: string;
}

/** At most `max` bytes of `text`, cut on a character boundary, marked when shortened. */
function boundBytes(text: string, max: number): string {
	if (Buffer.byteLength(text) <= max) return text;
	const marker = " … (shortened)";
	const room = max - Buffer.byteLength(marker);
	return `${Buffer.from(text).subarray(0, room).toString("utf8").replace(/�$/, "")}${marker}`;
}

function joinDetail(detail: string, stderr: string): string {
	return [detail.trim(), stderr ? `stderr: ${stderr}` : ""].filter(Boolean).join("; ");
}

function unavailableAnswer(reason: string, stderr = ""): TransportAnswer {
	return { code: 3, outcome: "unavailable", remoteHead: null, detail: joinDetail(reason, stderr) };
}

type ParsedAnswer = { outcome: string; remoteHead: string | null; detail: string };

/** The one JSON line of stdout, or why it is not an answer. */
function parseAnswerLine(operation: TransportOperation, stdout: string): ParsedAnswer | string {
	if (stdout.length === 0) return "no output";
	if (Buffer.byteLength(stdout) > MAX_ANSWER_BYTES) return `more than ${MAX_ANSWER_BYTES} bytes`;
	const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (line.includes("\n")) return "more than one line";
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return "not JSON";
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
	const answer = value as Record<string, unknown>;
	if (answer.schema_version !== TRANSPORT_SCHEMA_VERSION) return `schema_version is not ${TRANSPORT_SCHEMA_VERSION}`;
	if (answer.operation !== operation) return `operation is not ${operation}`;
	if (typeof answer.outcome !== "string") return "no outcome";
	const remoteHead = answer.remote_head;
	if (remoteHead !== null && !(typeof remoteHead === "string" && /^[0-9a-f]{40}$/.test(remoteHead))) {
		return "remote_head is neither null nor a 40-hex commit";
	}
	if (typeof answer.detail !== "string") return "no detail";
	return { outcome: answer.outcome, remoteHead, detail: answer.detail.slice(0, MAX_DETAIL_CHARS) };
}

/**
 * Read a transport run the way the engine acts on it. The exit code decides,
 * but only with a valid answer whose outcome goes with it; everything else —
 * another exit code, a signal, the deadline, an invalid or inconsistent
 * answer — counts as 3, unavailable for now.
 */
export function readTransportAnswer(operation: TransportOperation, run: TransportRun): TransportAnswer {
	if (run.kind === "timed-out") {
		return unavailableAnswer(`no answer within ${run.timeoutMs} ms, so the engine stopped it`);
	}
	const stderr = boundBytes(run.stderr.trim(), MAX_STDERR_BYTES);
	if (run.kind === "failed") return unavailableAnswer(run.reason, stderr);
	const parsed = parseAnswerLine(operation, run.stdout);
	if (typeof parsed === "string") {
		return unavailableAnswer(`exit ${run.status} without a valid ${TRANSPORT_SCHEMA_VERSION} answer (${parsed})`, stderr);
	}
	if (!OUTCOMES[operation][run.status]?.includes(parsed.outcome)) {
		return unavailableAnswer(`exit ${run.status} does not go with the outcome "${parsed.outcome}"`, stderr);
	}
	return {
		code: run.status as TransportCode,
		outcome: parsed.outcome,
		remoteHead: parsed.remoteHead,
		detail: joinDetail(parsed.detail, stderr),
	};
}

/** What the transport said, for a message: `transport push: refused (…)`. */
export function describeTransportAnswer(operation: TransportOperation, answer: TransportAnswer): string {
	return `transport ${operation}: ${answer.outcome}${answer.detail ? ` (${answer.detail})` : ""}`;
}
