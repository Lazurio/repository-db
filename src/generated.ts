import { execSync } from "node:child_process";
import { gitDirtyPaths } from "./git.ts";

/**
 * Hard ceiling for config-supplied materializer/validate commands. A hung
 * command would otherwise wedge publish forever while the publish lock is
 * held (stale-lock reclaim only kicks in after 15 minutes on the same host).
 */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
import { ENGINE_DIR } from "./lock.ts";
import {
	type RepositoryDbConfig,
	RepositoryDbError,
	ValidationFailedError,
} from "./types.ts";

/**
 * Generated read-model policy.
 *
 * Committed generated artifacts must be declared in the generated manifest in
 * repository-db.yaml. Anything else under the generated layout directory is
 * an undeclared diff and publish refuses it. Per-machine caches belong to the
 * ignored `.repository-db/cache/` layer, never to Git.
 *
 * Determinism contract for declared artifacts: stable sort by canonical id,
 * stable YAML/JSON writer, LF newlines, UTF-8, no wall-clock timestamps, no
 * host paths, no per-machine values. Two materializations from the same
 * `data/` input must be byte-identical (`repository-db validate` can verify
 * this via the materializer commands).
 */

export function isPathDeclared(
	relativePath: string,
	config: RepositoryDbConfig,
): boolean {
	return config.generatedManifest.some(
		(entry) =>
			relativePath === entry.path || relativePath.startsWith(`${entry.path}/`),
	);
}

/**
 * A generated-layout path the manifest does not declare. The one exception is
 * the empty placeholder `init` commits so the directory exists; it is not
 * output and never needs declaring.
 */
export function isUndeclaredGenerated(relativePath: string, config: RepositoryDbConfig): boolean {
	const generatedPrefix = `${config.layout.generated}/`;
	return (
		relativePath.startsWith(generatedPrefix) &&
		relativePath !== `${generatedPrefix}.gitkeep` &&
		!isPathDeclared(relativePath, config)
	);
}

/**
 * Return dirty generated paths that are not declared in the manifest.
 * Publish refuses to continue while any exist.
 */
export function undeclaredGeneratedDiffs(
	mountRoot: string,
	config: RepositoryDbConfig,
): string[] {
	return gitDirtyPaths(mountRoot)
		.filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`))
		.filter((entry) => isUndeclaredGenerated(entry, config));
}

export function assertDeclaredGeneratedOnly(
	mountRoot: string,
	config: RepositoryDbConfig,
): void {
	const undeclared = undeclaredGeneratedDiffs(mountRoot, config);
	if (undeclared.length > 0) {
		throw new ValidationFailedError(
			`publish refused: undeclared generated diffs (${undeclared.join(", ")}). ` +
				"Declare the artifact in the generated_manifest of repository-db.yaml or keep it in the ignored .repository-db/cache/ layer.",
		);
	}
}

/** Run every declared materializer command with cwd = mount root. */
export function materializeGenerated(
	mountRoot: string,
	config: RepositoryDbConfig,
): string[] {
	const ran: string[] = [];
	for (const entry of config.generatedManifest) {
		if (!entry.materializer) continue;
		try {
			execSync(entry.materializer, {
				cwd: mountRoot,
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
				env: { ...process.env },
				timeout: COMMAND_TIMEOUT_MS,
				killSignal: "SIGKILL",
			});
		} catch (error) {
			const detail =
				error instanceof Error ? error.message : String(error);
			throw new RepositoryDbError(
				"materialize_failed",
				`materializer for ${entry.path} failed: ${detail}`,
			);
		}
		ran.push(entry.materializer);
	}
	return ran;
}

/** Run the configured validate commands with cwd = mount root. */
export function runValidateCommands(
	mountRoot: string,
	config: RepositoryDbConfig,
): string[] {
	const ran: string[] = [];
	for (const command of config.validate) {
		try {
			execSync(command, {
				cwd: mountRoot,
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
				env: { ...process.env },
				timeout: COMMAND_TIMEOUT_MS,
				killSignal: "SIGKILL",
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new ValidationFailedError(
				`validate command failed: ${command}\n${detail}`,
			);
		}
		ran.push(command);
	}
	return ran;
}
