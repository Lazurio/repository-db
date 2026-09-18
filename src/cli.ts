#!/usr/bin/env bun
import path from "node:path";
import { initDataRepo } from "./init.ts";
import { RepositoryDb } from "./repositoryDb.ts";
import type { DraftOriginKind } from "./origin.ts";
import { RepositoryDbError } from "./types.ts";

const HELP = `repository-db — Git-backed YAML data layer

Usage:
  repository-db init --app <name> --remote <url> --branch <vN> --mount <path> \\
                     --schema-name <name> --schema-version <semver> \\
                     [--create-remote] [--visibility private|public]
  repository-db status   [--mount <path>] [--fetch] [--json]
  repository-db validate [--mount <path>]
  repository-db sync     [--mount <path>] [--pull] [--json]
  repository-db publish  [--mount <path>] --actor <actor> --source <source>
                         [--summary <text>] [--entity <id>]... [--json]
  repository-db review   [--mount <path>] [--json] [--inputs]
  repository-db discard  [--mount <path>] (--path <p>... | --all) [--actor <actor>]
                         [--confirm-foreign] [--json]
  repository-db origin   [--mount <path>] --path <p>... --kind app|agent|external
                         --actor <actor> [--source <source>] [--json]
  repository-db conflict [--mount <path>] [--abort | --resolved] [--json]

Notes:
  --mount defaults to the current working directory. Every command verifies
  the Git boundary (repo root, origin remote, branch) against repository-db.yaml
  before touching anything; commands refuse to run from a parent code repo.
  Publish = validate -> materialize generated -> rebase fetched origin/<branch>
  with autostash -> one commit with Repository-Db-* trailers -> push.
  Review reports the current draft as reviewable resources; discard returns
  draft work to the last published state. An agent stamps its own writes with
  "origin --kind agent" so a reviewer can tell them apart from app writes.
`;

interface Args {
	command: string;
	flags: Map<string, string | boolean>;
	entities: string[];
	paths: string[];
}

function parseArgs(argv: string[]): Args {
	const [command = "help", ...rest] = argv;
	const flags = new Map<string, string | boolean>();
	const entities: string[] = [];
	const paths: string[] = [];
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i] ?? "";
		if (!arg.startsWith("--")) {
			throw new RepositoryDbError("invalid_args", `unexpected argument: ${arg}`);
		}
		const name = arg.slice(2);
		const boolFlags = new Set([
			"fetch",
			"json",
			"abort",
			"resolved",
			"create-remote",
			"pull",
			"all",
			"confirm-foreign",
			"inputs",
		]);
		if (boolFlags.has(name)) {
			flags.set(name, true);
			continue;
		}
		const value = rest[i + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new RepositoryDbError("invalid_args", `flag --${name} expects a value`);
		}
		if (name === "entity") entities.push(value);
		else if (name === "path") paths.push(value);
		else flags.set(name, value);
		i += 1;
	}
	return { command, flags, entities, paths };
}

function requireFlag(args: Args, name: string): string {
	const value = args.flags.get(name);
	if (typeof value !== "string" || !value) {
		throw new RepositoryDbError("invalid_args", `missing required flag --${name}`);
	}
	return value;
}

function mountPath(args: Args): string {
	const value = args.flags.get("mount");
	return path.resolve(typeof value === "string" ? value : process.cwd());
}

function emit(args: Args, value: unknown, human: () => string): void {
	if (args.flags.get("json")) {
		console.log(JSON.stringify(value, null, 2));
	} else {
		console.log(human());
	}
}

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	switch (args.command) {
		case "help":
		case "--help":
		case "-h": {
			console.log(HELP);
			return 0;
		}
		case "init": {
			const result = await initDataRepo({
				app: requireFlag(args, "app"),
				remote: requireFlag(args, "remote"),
				branch: requireFlag(args, "branch"),
				mountPath: requireFlag(args, "mount"),
				schemaName: requireFlag(args, "schema-name"),
				schemaVersion: requireFlag(args, "schema-version"),
				createRemote: args.flags.get("create-remote") === true,
				visibility:
					args.flags.get("visibility") === "public" ? "public" : "private",
			});
			console.log(
				[
					`mount: ${result.mountPath}`,
					`remote created: ${result.created}`,
					`cloned: ${result.cloned}`,
					`bootstrapped: ${result.bootstrapped}`,
				].join("\n"),
			);
			return 0;
		}
		case "status": {
			const db = RepositoryDb.open(mountPath(args));
			const status =
				args.flags.get("fetch") === true
					? await db.statusAsync({ fetch: true })
					: db.status();
			emit(args, status, () =>
				[
					`state: ${status.state}`,
					`branch: ${status.branch}`,
					`ahead: ${status.ahead}, behind: ${status.behind}${status.fetched ? "" : " (run with --fetch for fresh remote state)"}`,
					status.dirtyPaths.length > 0
						? `draft paths:\n${status.dirtyPaths.map((p) => `  - ${p}`).join("\n")}`
						: "no local draft changes",
				].join("\n"),
			);
			return 0;
		}
		case "validate": {
			const db = RepositoryDb.open(mountPath(args));
			const ran = db.validate();
			console.log(
				ran.length > 0
					? `validate OK (${ran.length} command(s)):\n${ran.map((c) => `  - ${c}`).join("\n")}`
					: "validate OK (no validate commands configured)",
			);
			return 0;
		}
		case "sync": {
			const db = RepositoryDb.open(mountPath(args));
			if (args.flags.get("pull") === true) {
				const pulled = await db.pull();
				const status = db.status();
				emit(args, { pulled, status }, () =>
					[
						pulled.state === "pulled"
							? `pulled ${pulled.behind} remote commit(s) (rebase --autostash)`
							: "already up to date with the remote",
						`state: ${status.state}`,
					].join("\n"),
				);
				return 0;
			}
			const status = await db.statusAsync({ fetch: true });
			emit(args, status, () =>
				[
					`fetched origin; state: ${status.state}`,
					`ahead: ${status.ahead}, behind: ${status.behind}`,
					status.behind > 0
						? "remote changes available — run `repository-db sync --pull` (autostash-safe) or publish"
						: "checkout is up to date with the remote",
				].join("\n"),
			);
			return 0;
		}
		case "publish": {
			const db = RepositoryDb.open(mountPath(args));
			const result = await db.publish({
				actor: requireFlag(args, "actor"),
				source: requireFlag(args, "source"),
				summary:
					typeof args.flags.get("summary") === "string"
						? (args.flags.get("summary") as string)
						: undefined,
				entities: args.entities.length > 0 ? args.entities : undefined,
			});
			emit(args, result, () =>
				result.state === "nothing_to_publish"
					? "nothing to publish (working tree clean)"
					: `published ${result.commit} (change ${result.changeId}) -> ${result.pushedTo}`,
			);
			return 0;
		}
		case "review": {
			const db = RepositoryDb.open(mountPath(args));
			const snapshot = await db.review({
				includeInputChanges: args.flags.get("inputs") === true,
			});
			emit(args, snapshot, () => {
				if (snapshot.resources.length === 0) return "no draft changes to review";
				const owner = db.draftOwner();
				const lines = snapshot.resources.map((resource) => {
					const change = resource.changes[0];
					const origin = change?.origin?.kind ?? "external";
					const fields = (change?.fields ?? [])
						.slice(0, 4)
						.map(
							(field) =>
								`      ${field.label}: ${field.beforeSummary ?? "—"} -> ${field.afterSummary ?? "—"}`,
						);
					return [
						`  - [${origin}] ${change?.kind ?? "unknown"} ${resource.label}`,
						`      ${resource.stableResourceId} (${resource.fallback.activeLevel})`,
						...fields,
					].join("\n");
				});
				return [
					owner ? `draft owner: ${owner.actor} (${owner.kind})` : "draft owner: unknown",
					`publish readiness: ${snapshot.publishReadiness.state}`,
					...lines,
				].join("\n");
			});
			return 0;
		}
		case "discard": {
			const db = RepositoryDb.open(mountPath(args));
			const all = args.flags.get("all") === true;
			if (!all && args.paths.length === 0) {
				throw new RepositoryDbError(
					"invalid_args",
					"discard requires --path <p> (repeatable) or --all",
				);
			}
			const result = db.discard({
				all,
				paths: args.paths,
				actor:
					typeof args.flags.get("actor") === "string"
						? (args.flags.get("actor") as string)
						: undefined,
				confirmForeign: args.flags.get("confirm-foreign") === true,
			});
			emit(args, result, () =>
				result.discarded.length === 0
					? "nothing to discard (no matching draft changes)"
					: [
							`discarded ${result.discarded.length} path(s):`,
							...result.discarded.map((entry) => `  - ${entry.action} ${entry.path}`),
							result.generatedIncluded.length > 0
								? `generated artifacts included: ${result.generatedIncluded.join(", ")}`
								: "",
							`remaining draft paths: ${result.remainingDirtyPaths.length}`,
						]
							.filter(Boolean)
							.join("\n"),
			);
			return 0;
		}
		case "origin": {
			const db = RepositoryDb.open(mountPath(args));
			if (args.paths.length === 0) {
				throw new RepositoryDbError(
					"invalid_args",
					"origin requires at least one --path <p>",
				);
			}
			const kind = requireFlag(args, "kind");
			if (kind !== "app" && kind !== "agent" && kind !== "external") {
				throw new RepositoryDbError(
					"invalid_args",
					`--kind must be app, agent or external (got ${kind})`,
				);
			}
			db.recordOrigin(args.paths, {
				kind: kind as DraftOriginKind,
				actor: requireFlag(args, "actor"),
				source:
					typeof args.flags.get("source") === "string"
						? (args.flags.get("source") as string)
						: "repository-db-cli",
			});
			emit(args, { recorded: args.paths, kind }, () =>
				`recorded ${kind} origin for ${args.paths.length} path(s)`,
			);
			return 0;
		}
		case "conflict": {
			const db = RepositoryDb.open(mountPath(args));
			if (args.flags.get("abort") === true) {
				db.abortConflict();
				console.log("conflict aborted; data repository restored to the pre-publish state");
				return 0;
			}
			if (args.flags.get("resolved") === true) {
				db.markConflictResolved();
				console.log("conflict state cleared; writes are allowed again");
				return 0;
			}
			const conflict = db.conflict();
			emit(args, conflict ?? null, () =>
				conflict
					? `ACTIVE CONFLICT (${conflict.operation}, detected ${conflict.detectedAt})\n${conflict.message}\n\n${conflict.handoff}`
					: "no active conflict",
			);
			return conflict ? 1 : 0;
		}
		default: {
			console.error(`unknown command: ${args.command}\n`);
			console.log(HELP);
			return 1;
		}
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((error) => {
		if (error instanceof RepositoryDbError) {
			console.error(`repository-db error [${error.code}]: ${error.message}`);
			process.exit(2);
		}
		throw error;
	});
