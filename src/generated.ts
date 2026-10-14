import { exec } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import { computeContentState } from "./draftRevision.ts";
import { runGit } from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";
import { toStableJson, writeFileAtomic } from "./yamlIo.ts";
import {
	MaterializeFailedError,
	type RepositoryDbConfig,
	TrackedDerivedOutputError,
	ValidationFailedError,
} from "./types.ts";

/**
 * Derived output: an ignored cache the engine builds in the live checkout.
 *
 * Every `generated_manifest` path is derived from the tracked data and nothing
 * else, so it is never in Git: the data repo ignores it, the engine rebuilds it
 * whenever the tracked content changed, and it therefore never takes part in a
 * draft, an overlap check, a merge, a conflict, review or discard. Two people
 * publishing different records cannot collide on it, and a stale copy cannot
 * be merged line by line.
 *
 * Materializers and validators are commands of the data repository. They run
 * with cwd = mount root, where the data repo's own dependencies live, read only
 * the data checkout and write only to declared paths. Determinism still
 * matters (stable sort, stable writer, LF, no wall clock, no host paths): the
 * same data must give the same output on every Environment.
 */

/**
 * Hard ceiling for config-supplied commands. A hung command would otherwise
 * hold the shared gate for good.
 */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const STAMP_FILE = "generated.stamp.json";
const STAMP_SCHEMA = "repository-db.generated-stamp.v1";

function stampPath(mountRoot: string): string {
	return path.join(mountRoot, ENGINE_DIR, STAMP_FILE);
}

type CommandOutcome = { ok: true } | { ok: false; detail: string };

/** Run one data-repo command with cwd = mount root, off the event loop. */
function runCommand(command: string, mountRoot: string): Promise<CommandOutcome> {
	return new Promise((resolve) => {
		const child = exec(
			command,
			{
				cwd: mountRoot,
				env: { ...process.env },
				timeout: COMMAND_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 64 * 1024 * 1024,
			},
			(error, _stdout, stderr) => {
				if (!error) {
					resolve({ ok: true });
					return;
				}
				const detail = [error.message, String(stderr ?? "")]
					.map((part) => part.trim())
					.filter(Boolean)
					.filter((part, index, all) => all.indexOf(part) === index)
					.join("\n");
				resolve({ ok: false, detail });
			},
		);
		// No input: a command that reads stdin gets EOF instead of waiting.
		child.stdin?.end();
	});
}

/**
 * Refuse a checkout that still tracks what the engine owns as a local cache:
 * a declared derived path (tracked or not ignored), or the engine's runtime
 * directory, which an older engine could leave tracked.
 *
 * The migration is one ordinary commit in the data repo, made with plain Git
 * (the engine refuses to publish until it is done).
 */
export function assertDerivedOutputIgnored(mountRoot: string, config: RepositoryDbConfig): void {
	const engineTracked = runGit(mountRoot, ["ls-files", "-z", "--", ENGINE_DIR])
		.stdout.split("\0")
		.filter(Boolean);
	if (engineTracked.length > 0) {
		throw new TrackedDerivedOutputError(
			"engine_state_tracked",
			`The data checkout tracks repository-db runtime files (${engineTracked.join(", ")}), left by an older repository-db. Clean the checkout before using this version: git rm -r --cached -- ${ENGINE_DIR}, add "/${ENGINE_DIR}/" to .gitignore, then commit and push that as an ordinary data commit.`,
			engineTracked,
			[
				`git rm -r --cached --quiet -- ${ENGINE_DIR}`,
				`printf '%s\\n' '/${ENGINE_DIR}/' >> .gitignore`,
				`git add .gitignore && git commit -m "Stop tracking repository-db runtime files" && git push`,
			],
		);
	}

	const declared = config.generatedManifest.map((entry) => entry.path);
	if (declared.length === 0) return;
	const tracked = new Set(
		runGit(mountRoot, ["ls-files", "-z", "--", ...declared]).stdout.split("\0").filter(Boolean),
	);
	const trackedEntries = declared.filter((entry) =>
		[...tracked].some((file) => file === entry || file.startsWith(`${entry}/`)),
	);
	// A directory pattern ("/generated/") matches a path that does not exist yet
	// only through a child, so a probe inside counts as well.
	const probes = declared.flatMap((entry) => [entry, `${entry}/.repository-db-probe`]);
	const ignored = new Set(
		runGit(mountRoot, ["check-ignore", "--no-index", "--stdin", "-z"], {
			input: `${probes.join("\0")}\0`,
		})
			.stdout.split("\0")
			.filter(Boolean),
	);
	const notIgnored = declared.filter(
		(entry) => !ignored.has(entry) && !ignored.has(`${entry}/.repository-db-probe`),
	);
	const problems = [...new Set([...trackedEntries, ...notIgnored])];
	if (problems.length === 0) return;
	throw new TrackedDerivedOutputError(
		"derived_output_tracked",
		`Derived output must not be in Git, and this data repository still ${
			trackedEntries.length > 0 ? "tracks" : "does not ignore"
		} ${problems.join(", ")}. Derived output is a cache repository-db rebuilds on every Environment. Migrate the data repository once, as an ordinary data commit: git rm -r --cached --ignore-unmatch -- ${problems.join(
			" ",
		)}; add ${problems.map((entry) => `"/${entry}"`).join(", ")} to .gitignore; commit and push. Nothing was changed.`,
		problems,
		[
			`git rm -r --cached --quiet --ignore-unmatch -- ${problems.join(" ")}`,
			...problems.map((entry) => `printf '%s\\n' '/${entry}' >> .gitignore`),
			`git add .gitignore && git commit -m "Derived output is an ignored cache built by repository-db" && git push`,
		],
	);
}

interface GeneratedStamp {
	schema: string;
	/** {@link computeContentState} the output was built from. */
	state: string;
}

function readStamp(mountRoot: string): GeneratedStamp | undefined {
	try {
		const parsed = JSON.parse(readFileSync(stampPath(mountRoot), "utf8")) as GeneratedStamp;
		return parsed.schema === STAMP_SCHEMA && typeof parsed.state === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function materializedEntries(config: RepositoryDbConfig) {
	return config.generatedManifest.filter(
		(entry): entry is typeof entry & { materializer: string } => Boolean(entry.materializer),
	);
}

/** Is the derived output built from exactly the content checked out now? */
export function isGeneratedFresh(mountRoot: string, config: RepositoryDbConfig): boolean {
	const entries = materializedEntries(config);
	if (entries.length === 0) return true;
	const stamp = readStamp(mountRoot);
	if (!stamp || stamp.state !== computeContentState(mountRoot)) return false;
	return entries.every((entry) => existsSync(path.join(mountRoot, entry.path)));
}

export interface EnsureGeneratedResult {
	/** True when the materializers ran in this call. */
	rebuilt: boolean;
	/** Materializer commands that ran. */
	ran: string[];
}

/** One build per checkout at a time within this process. */
const builds = new Map<string, Promise<EnsureGeneratedResult>>();

async function build(
	mountRoot: string,
	config: RepositoryDbConfig,
): Promise<EnsureGeneratedResult> {
	const state = computeContentState(mountRoot);
	// Dropped first: a build that fails halfway must not leave a stamp vouching
	// for output it did not finish.
	rmSync(stampPath(mountRoot), { force: true });
	const ran: string[] = [];
	for (const entry of materializedEntries(config)) {
		const outcome = await runCommand(entry.materializer, mountRoot);
		if (!outcome.ok) {
			throw new MaterializeFailedError(
				entry.path,
				`The derived output ${entry.path} could not be built: \`${entry.materializer}\` failed. Nothing was staged or published; fix the materializer or the data and try again.\n${outcome.detail}`,
			);
		}
		ran.push(entry.materializer);
	}
	const stamp: GeneratedStamp = { schema: STAMP_SCHEMA, state };
	writeFileAtomic(stampPath(mountRoot), toStableJson(stamp));
	return { rebuilt: true, ran };
}

/**
 * Make the derived output match the data checked out right now, building it
 * only when it is stale. Readers call this before they read a derived path;
 * publish calls it before validating and after integrating a colleague's work.
 *
 * Staleness needs no bookkeeping by callers: the stamp records the content it
 * was built from, so a pull, a send, a discard or a record write makes it
 * stale by changing that content. A failing materializer throws
 * {@link MaterializeFailedError}; it never stages anything and never creates a
 * draft (derived paths are ignored).
 */
export async function ensureGenerated(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: { force?: boolean } = {},
): Promise<EnsureGeneratedResult> {
	assertDataRepoBoundary(mountRoot, config);
	assertDerivedOutputIgnored(mountRoot, config);
	if (materializedEntries(config).length === 0) return { rebuilt: false, ran: [] };
	const key = path.resolve(mountRoot);
	for (let running = builds.get(key); running; running = builds.get(key)) {
		await running.catch(() => undefined);
	}
	// No await between the check and claiming the slot: one build starts.
	if (!options.force && isGeneratedFresh(mountRoot, config)) return { rebuilt: false, ran: [] };
	const running = build(mountRoot, config);
	builds.set(key, running);
	try {
		return await running;
	} finally {
		if (builds.get(key) === running) builds.delete(key);
	}
}

/** Run the configured validate commands with cwd = mount root. */
export async function runValidateCommands(
	mountRoot: string,
	config: RepositoryDbConfig,
): Promise<string[]> {
	const ran: string[] = [];
	for (const command of config.validate) {
		const outcome = await runCommand(command, mountRoot);
		if (!outcome.ok) {
			throw new ValidationFailedError(`validate command failed: ${command}\n${outcome.detail}`);
		}
		ran.push(command);
	}
	return ran;
}

/** Derived output first, then the validators that may read it. */
export async function validateCheckout(
	mountRoot: string,
	config: RepositoryDbConfig,
): Promise<string[]> {
	await ensureGenerated(mountRoot, config);
	return runValidateCommands(mountRoot, config);
}
