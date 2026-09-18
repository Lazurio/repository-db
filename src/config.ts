import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseYaml } from "./yamlIo.ts";
import {
	type GeneratedManifestEntry,
	type RepositoryDbConfig,
	RepositoryDbError,
} from "./types.ts";

export const CONFIG_FILE_NAME = "repository-db.yaml";
export const CONFIG_SCHEMA_VERSION = "repository-db.config.v1";

function expectString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new RepositoryDbError(
			"invalid_config",
			`${CONFIG_FILE_NAME}: field "${field}" must be a non-empty string`,
		);
	}
	return value;
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RepositoryDbError(
			"invalid_config",
			`${CONFIG_FILE_NAME}: field "${field}" must be a mapping`,
		);
	}
	return value as Record<string, unknown>;
}

function parseGeneratedManifest(value: unknown): GeneratedManifestEntry[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new RepositoryDbError(
			"invalid_config",
			`${CONFIG_FILE_NAME}: "generated_manifest" must be a list`,
		);
	}
	return value.map((entry, index) => {
		const record = expectRecord(entry, `generated_manifest[${index}]`);
		const entryPath = expectString(record.path, `generated_manifest[${index}].path`);
		if (path.isAbsolute(entryPath) || entryPath.split("/").includes("..")) {
			throw new RepositoryDbError(
				"invalid_config",
				`${CONFIG_FILE_NAME}: generated_manifest path must be repo-relative: ${entryPath}`,
			);
		}
		return {
			path: entryPath.replace(/\/+$/, ""),
			materializer:
				record.materializer === undefined
					? undefined
					: expectString(record.materializer, `generated_manifest[${index}].materializer`),
			note:
				record.note === undefined
					? undefined
					: expectString(record.note, `generated_manifest[${index}].note`),
		};
	});
}

/**
 * `generated/` and `generated` must mean the same directory: every prefix check
 * builds `<layout>/`, and a trailing slash would turn it into `generated//`,
 * which matches nothing.
 */
function normalizeLayoutPath(value: string): string {
	return value.replace(/\/+$/, "");
}

export function parseRepositoryDbConfig(raw: unknown): RepositoryDbConfig {
	const root = expectRecord(raw, "<root>");
	const schemaVersion = expectString(root.schema_version, "schema_version");
	if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
		throw new RepositoryDbError(
			"invalid_config",
			`${CONFIG_FILE_NAME}: unsupported schema_version "${schemaVersion}" (expected ${CONFIG_SCHEMA_VERSION})`,
		);
	}
	const dataRepo = expectRecord(root.data_repo, "data_repo");
	const schema = expectRecord(root.schema, "schema");
	const layoutRaw =
		root.layout === undefined ? {} : expectRecord(root.layout, "layout");
	const validateRaw = root.validate ?? [];
	if (!Array.isArray(validateRaw) || validateRaw.some((v) => typeof v !== "string")) {
		throw new RepositoryDbError(
			"invalid_config",
			`${CONFIG_FILE_NAME}: "validate" must be a list of commands`,
		);
	}
	const remote = expectString(dataRepo.remote, "data_repo.remote");
	const branch = expectString(dataRepo.branch, "data_repo.branch");
	// Config values feed git argv (clone/pull/push/rev-list); a crafted value
	// starting with "-" would be parsed as a git option (option injection).
	if (remote.startsWith("-")) {
		throw new RepositoryDbError(
			"invalid_config",
			`${CONFIG_FILE_NAME}: data_repo.remote must not start with "-"`,
		);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
		throw new RepositoryDbError(
			"invalid_config",
			`${CONFIG_FILE_NAME}: data_repo.branch has unexpected format: ${branch}`,
		);
	}
	return {
		schemaVersion,
		app: expectString(root.app, "app"),
		dataRepo: {
			remote,
			branch,
		},
		schema: {
			name: expectString(schema.name, "schema.name"),
			version: expectString(schema.version, "schema.version"),
		},
		layout: {
			data: normalizeLayoutPath(typeof layoutRaw.data === "string" ? layoutRaw.data : "data"),
			generated:
				normalizeLayoutPath(
					typeof layoutRaw.generated === "string" ? layoutRaw.generated : "generated",
				),
			scripts: normalizeLayoutPath(
				typeof layoutRaw.scripts === "string" ? layoutRaw.scripts : "scripts",
			),
		},
		generatedManifest: parseGeneratedManifest(root.generated_manifest),
		validate: validateRaw as string[],
	};
}

export function loadRepositoryDbConfig(mountRoot: string): RepositoryDbConfig {
	const configPath = path.join(mountRoot, CONFIG_FILE_NAME);
	if (!existsSync(configPath)) {
		throw new RepositoryDbError(
			"config_missing",
			`${CONFIG_FILE_NAME} not found in ${mountRoot}; this directory is not a repository-db data checkout`,
		);
	}
	return parseRepositoryDbConfig(parseYaml(readFileSync(configPath, "utf8")));
}

/** Serializable config shape used by the init flow. */
export function configToYamlValue(config: RepositoryDbConfig): Record<string, unknown> {
	return {
		schema_version: config.schemaVersion,
		app: config.app,
		data_repo: {
			remote: config.dataRepo.remote,
			branch: config.dataRepo.branch,
		},
		schema: {
			name: config.schema.name,
			version: config.schema.version,
		},
		layout: { ...config.layout },
		generated_manifest: config.generatedManifest.map((entry) => ({
			path: entry.path,
			...(entry.materializer ? { materializer: entry.materializer } : {}),
			...(entry.note ? { note: entry.note } : {}),
		})),
		validate: [...config.validate],
	};
}
