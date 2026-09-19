import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ENGINE_DIR } from "./lock.ts";
import type { ReviewChangeOrigin, ReviewChangeOriginKind } from "./types.ts";
import { toStableJson, writeFileAtomic } from "./yamlIo.ts";

/**
 * Draft provenance hints.
 *
 * A repository-db draft is one shared unit of unpublished work that both people
 * (through an app API) and agents (through the filesystem or the CLI) write
 * into. Reviewing your own typing and reviewing what an agent proposed are
 * different activities, so the engine records a best-effort hint of where each
 * dirty path came from.
 *
 * Hard boundary: this is information, nothing else. It never gates an
 * operation, never decides whether a discard is safe and is never the audit
 * record — that remains the publish commit and its trailers. A path with no
 * recorded hint is reported as `unknown`, and the UI says exactly that.
 *
 * Both markers live in the gitignored engine layer, so they never reach the
 * data repository, and both are cleared by publish and by discard.
 */

const ORIGIN_FILE = "draft-origin.json";
const OWNER_FILE = "draft-owner.json";
const ORIGIN_SCHEMA = "repository-db.draft-origin.v1";
const OWNER_SCHEMA = "repository-db.draft-owner.v1";

/** Where a draft change entered the data checkout from. */
export type DraftOriginKind = ReviewChangeOriginKind;

/** Stored form of {@link ReviewChangeOrigin}; the timestamp is always written. */
export interface DraftOriginRecord extends ReviewChangeOrigin {
	recordedAt: string;
}

export interface DraftOwner {
	actor: string;
	kind: DraftOriginKind;
	since: string;
}

interface OriginFile {
	schema: string;
	entries: Record<string, DraftOriginRecord>;
}

interface OwnerFile {
	schema: string;
	owner: DraftOwner;
}

function originPath(mountRoot: string): string {
	return path.join(mountRoot, ENGINE_DIR, ORIGIN_FILE);
}

function ownerPath(mountRoot: string): string {
	return path.join(mountRoot, ENGINE_DIR, OWNER_FILE);
}

function readJsonFile<T>(filePath: string): T | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch {
		// A corrupt marker must never break status, review, discard or publish;
		// losing a hint degrades provenance to `external`, which is safe.
		return undefined;
	}
}

function readOriginFile(mountRoot: string): OriginFile {
	const parsed = readJsonFile<OriginFile>(originPath(mountRoot));
	if (!parsed || parsed.schema !== ORIGIN_SCHEMA || typeof parsed.entries !== "object") {
		return { schema: ORIGIN_SCHEMA, entries: {} };
	}
	return { schema: ORIGIN_SCHEMA, entries: parsed.entries ?? {} };
}

function writeOriginFile(mountRoot: string, file: OriginFile): void {
	if (Object.keys(file.entries).length === 0) {
		rmSync(originPath(mountRoot), { force: true });
		return;
	}
	writeFileAtomic(originPath(mountRoot), toStableJson(file));
}

/** All recorded provenance hints, keyed by repo-relative path. */
export function readDraftOrigins(mountRoot: string): Record<string, DraftOriginRecord> {
	return readOriginFile(mountRoot).entries;
}

/**
 * Record where a set of paths was written from. Hosts call this right after a
 * successful write through their own API; the CLI calls it for agent writes.
 * Re-recording a path overwrites the previous hint — the latest writer is the
 * one a reviewer cares about.
 */
export function recordDraftOrigin(
	mountRoot: string,
	paths: readonly string[],
	origin: { kind: DraftOriginKind; actor?: string; source?: string },
): void {
	if (paths.length === 0) return;
	const file = readOriginFile(mountRoot);
	const recordedAt = new Date().toISOString();
	for (const entry of paths) {
		file.entries[entry] = {
			kind: origin.kind,
			actor: origin.actor,
			source: origin.source,
			recordedAt,
		};
	}
	writeOriginFile(mountRoot, file);

	if (origin.actor) {
		setDraftOwnerIfAbsent(mountRoot, { actor: origin.actor, kind: origin.kind });
	}
}

/** Drop hints for the given paths, or all of them when no path is given. */
export function clearDraftOrigins(mountRoot: string, paths?: readonly string[]): void {
	if (!paths) {
		rmSync(originPath(mountRoot), { force: true });
		return;
	}
	const file = readOriginFile(mountRoot);
	for (const entry of paths) delete file.entries[entry];
	writeOriginFile(mountRoot, file);
}

/**
 * Resolve provenance for the current dirty set. Paths without a hint resolve to
 * `external`.
 *
 * Strictly read-only. Pruning here would race the ordinary host sequence
 * "write the file, then record the origin": a review that listed the dirty set
 * before the write but read the marker after the record would delete the fresh
 * hint, and the writer's own change would come back as `external` — and then
 * demand a foreign-change confirmation to discard. Pruning belongs to
 * {@link pruneDraftOrigins}, called under the publish lock.
 */
export function resolveDraftOrigins(
	mountRoot: string,
	dirtyPaths: readonly string[],
): Map<string, DraftOriginRecord> {
	const file = readOriginFile(mountRoot);
	const resolved = new Map<string, DraftOriginRecord>();
	for (const entry of dirtyPaths) {
		resolved.set(
			entry,
			file.entries[entry] ?? { kind: "unknown", recordedAt: "" },
		);
	}
	return resolved;
}

/**
 * Drop hints for paths that are no longer part of the draft, so the marker
 * cannot grow without bound or describe already published work. Call only from
 * a writer that holds the publish lock.
 */
export function pruneDraftOrigins(
	mountRoot: string,
	dirtyPaths: readonly string[],
): void {
	const file = readOriginFile(mountRoot);
	const dirty = new Set(dirtyPaths);
	let pruned = false;
	for (const key of Object.keys(file.entries)) {
		if (dirty.has(key)) continue;
		delete file.entries[key];
		pruned = true;
	}
	if (pruned) writeOriginFile(mountRoot, file);
}

export function readDraftOwner(mountRoot: string): DraftOwner | undefined {
	const parsed = readJsonFile<OwnerFile>(ownerPath(mountRoot));
	if (!parsed || parsed.schema !== OWNER_SCHEMA || !parsed.owner?.actor) return undefined;
	return parsed.owner;
}

/**
 * Coarse label for the whole draft: the first writer after a publish. It is not
 * re-stamped by later writers, so it stays the "who started this draft" summary
 * the card shows next to the per-change hints.
 */
export function setDraftOwnerIfAbsent(
	mountRoot: string,
	owner: { actor: string; kind: DraftOriginKind },
): DraftOwner {
	const existing = readDraftOwner(mountRoot);
	if (existing) return existing;
	const next: DraftOwner = {
		actor: owner.actor,
		kind: owner.kind,
		since: new Date().toISOString(),
	};
	writeFileAtomic(ownerPath(mountRoot), toStableJson({ schema: OWNER_SCHEMA, owner: next }));
	return next;
}

export function clearDraftOwner(mountRoot: string): void {
	rmSync(ownerPath(mountRoot), { force: true });
}

/** Clear both markers — the draft they described no longer exists. */
export function clearDraftProvenance(mountRoot: string): void {
	clearDraftOrigins(mountRoot);
	clearDraftOwner(mountRoot);
}
