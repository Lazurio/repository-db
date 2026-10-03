import YAML from "yaml";
import { toStableYaml } from "./yamlIo.ts";

type Missing = typeof MISSING;
type MergeValue = unknown | Missing;

const MISSING = Symbol("repository-db.semantic-merge.missing");

export interface SemanticYamlMergeResult {
	ok: boolean;
	/** Stable canonical YAML only when every structural conflict was resolved. */
	text?: string;
	/** JSON-pointer-like paths of leaves or collections that remain ambiguous. */
	unresolvedPaths: string[];
	/** Why parsing or canonical representation prevented a semantic merge. */
	reason?: string;
	/** True when the bounded updatedAt/updatedBy* audit bundle was selected. */
	usedAuditMetadataRule: boolean;
}

type MergeResult = {
	value: MergeValue;
	unresolvedPaths: string[];
	usedAuditMetadataRule: boolean;
};

type ParsedCanonicalYaml =
	| { ok: true; value: unknown }
	| { ok: false; reason: string };

function pointerChild(pointer: string, key: string): string {
	const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
	return `${pointer}/${escaped}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonLike(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonLike);
	if (isRecord(value)) return Object.values(value).every(isJsonLike);
	return false;
}

/** Structural equality that does not mistake YAML mapping key order for a data change. */
function equal(left: MergeValue, right: MergeValue): boolean {
	if (left === MISSING || right === MISSING) return left === right;
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((entry, index) => equal(entry, right[index]));
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]))
		);
	}
	return false;
}

function own(record: Record<string, unknown>, key: string): MergeValue {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : MISSING;
}

function isAuditMetadataKey(pointer: string, key: string): boolean {
	// Only the envelope's direct record audit bundle is non-domain metadata.
	// A nested object can legitimately have business fields named updatedAt or
	// updatedBy*, so treating those as a timestamp winner would silently make a
	// business decision.
	return pointer === "/record" && (key === "updatedAt" || key.startsWith("updatedBy"));
}

function parseIsoTimestamp(value: MergeValue): number | undefined {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
	) {
		return undefined;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * A record-level timestamp is audit metadata, not a domain decision. Once all
 * business children of an object merge safely, choose the later valid update
 * timestamp and the matching sibling `updatedBy*` values as one coherent
 * bundle. Any other metadata remains an ordinary structural value.
 */
function auditMetadataWinner(
	base: Record<string, unknown>,
	local: Record<string, unknown>,
	remote: Record<string, unknown>,
): "local" | "remote" | undefined {
	const baseAt = own(base, "updatedAt");
	const localAt = own(local, "updatedAt");
	const remoteAt = own(remote, "updatedAt");
	if (equal(localAt, baseAt) || equal(remoteAt, baseAt) || equal(localAt, remoteAt)) {
		return undefined;
	}
	const localTimestamp = parseIsoTimestamp(localAt);
	const remoteTimestamp = parseIsoTimestamp(remoteAt);
	if (localTimestamp === undefined || remoteTimestamp === undefined) return undefined;
	return localTimestamp >= remoteTimestamp ? "local" : "remote";
}

function mergeRecord(
	base: Record<string, unknown>,
	local: Record<string, unknown>,
	remote: Record<string, unknown>,
	pointer: string,
): MergeResult {
	const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();
	const value: Record<string, unknown> = {};
	const unresolvedPaths: string[] = [];
	let usedAuditMetadataRule = false;

	// Domain-bearing keys are always merged first. Audit metadata may be chosen
	// only after this pass has proven all actual business values unambiguous.
	for (const key of keys.filter((entry) => !isAuditMetadataKey(pointer, entry))) {
		const merged = mergeValue(own(base, key), own(local, key), own(remote, key), pointerChild(pointer, key));
		if (merged.value !== MISSING) value[key] = merged.value;
		unresolvedPaths.push(...merged.unresolvedPaths);
		usedAuditMetadataRule ||= merged.usedAuditMetadataRule;
	}

	if (unresolvedPaths.length > 0) {
		return { value: MISSING, unresolvedPaths, usedAuditMetadataRule };
	}

	const winner = pointer === "/record" ? auditMetadataWinner(base, local, remote) : undefined;
	if (winner) {
		const source = winner === "local" ? local : remote;
		for (const key of keys.filter((entry) => isAuditMetadataKey(pointer, entry))) {
			const selected = own(source, key);
			if (selected !== MISSING) value[key] = selected;
		}
		usedAuditMetadataRule = true;
		return { value, unresolvedPaths, usedAuditMetadataRule };
	}

	for (const key of keys.filter((entry) => isAuditMetadataKey(pointer, entry))) {
		const merged = mergeValue(own(base, key), own(local, key), own(remote, key), pointerChild(pointer, key));
		if (merged.value !== MISSING) value[key] = merged.value;
		unresolvedPaths.push(...merged.unresolvedPaths);
		usedAuditMetadataRule ||= merged.usedAuditMetadataRule;
	}
	return { value, unresolvedPaths, usedAuditMetadataRule };
}

function stableId(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const id = value.id;
	if (typeof id === "string" && id.trim()) return `string:${id}`;
	if (typeof id === "number" && Number.isFinite(id)) return `number:${id}`;
	return undefined;
}

function stableIds(values: unknown[]): string[] | undefined {
	const ids = values.map(stableId);
	if (ids.some((id) => !id)) return undefined;
	const resolved = ids as string[];
	return new Set(resolved).size === resolved.length ? resolved : undefined;
}

/**
 * Array members are only recursively mergeable when all three versions retain
 * the same unique stable ids in the same order. This deliberately rejects
 * concurrent adds/removals/reorders: their intended insertion semantics are a
 * domain decision, not something the repository engine can guess.
 */
function mergeStableIdArray(
	base: unknown[],
	local: unknown[],
	remote: unknown[],
	pointer: string,
): MergeResult {
	const baseIds = stableIds(base);
	const localIds = stableIds(local);
	const remoteIds = stableIds(remote);
	if (
		!baseIds ||
		!localIds ||
		!remoteIds ||
		!equal(baseIds, localIds) ||
		!equal(baseIds, remoteIds)
	) {
		return { value: MISSING, unresolvedPaths: [pointer], usedAuditMetadataRule: false };
	}
	const values: unknown[] = [];
	const unresolvedPaths: string[] = [];
	let usedAuditMetadataRule = false;
	for (let index = 0; index < base.length; index += 1) {
		const id = baseIds[index] ?? String(index);
		const merged = mergeValue(base[index], local[index], remote[index], `${pointer}/@${id}`);
		if (merged.value === MISSING) {
			return { value: MISSING, unresolvedPaths: [pointer], usedAuditMetadataRule };
		}
		values.push(merged.value);
		unresolvedPaths.push(...merged.unresolvedPaths);
		usedAuditMetadataRule ||= merged.usedAuditMetadataRule;
	}
	return { value: values, unresolvedPaths, usedAuditMetadataRule };
}

function mergeValue(
	base: MergeValue,
	local: MergeValue,
	remote: MergeValue,
	pointer: string,
): MergeResult {
	if (equal(local, remote)) return { value: local, unresolvedPaths: [], usedAuditMetadataRule: false };
	if (equal(base, local)) return { value: remote, unresolvedPaths: [], usedAuditMetadataRule: false };
	if (equal(base, remote)) return { value: local, unresolvedPaths: [], usedAuditMetadataRule: false };

	if (base === MISSING || local === MISSING || remote === MISSING) {
		return { value: MISSING, unresolvedPaths: [pointer], usedAuditMetadataRule: false };
	}
	if (isRecord(base) && isRecord(local) && isRecord(remote)) {
		return mergeRecord(base, local, remote, pointer);
	}
	if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
		return mergeStableIdArray(base, local, remote, pointer);
	}
	return { value: MISSING, unresolvedPaths: [pointer], usedAuditMetadataRule: false };
}

function hasUnsupportedPresentation(document: YAML.Document.Parsed): boolean {
	const visit = (node: unknown): boolean => {
		if (!node || typeof node !== "object") return false;
		const candidate = node as {
			anchor?: unknown;
			comment?: unknown;
			commentBefore?: unknown;
			tag?: unknown;
			items?: unknown[];
			key?: unknown;
			value?: unknown;
		};
		if (
			typeof candidate.anchor === "string" ||
			typeof candidate.comment === "string" ||
			typeof candidate.commentBefore === "string" ||
			typeof candidate.tag === "string"
		) {
			return true;
		}
		return (
			(candidate.items?.some(visit) ?? false) || visit(candidate.key) || visit(candidate.value)
		);
	};
	return Boolean(document.commentBefore || document.comment || visit(document.contents));
}

function parseCanonicalYaml(text: string | undefined, label: string): ParsedCanonicalYaml {
	if (text === undefined) return { ok: false, reason: `${label} document is absent` };
	try {
		const document = YAML.parseDocument(text, { prettyErrors: false, uniqueKeys: true });
		if (document.errors.length > 0) {
			return { ok: false, reason: `${label} YAML is invalid` };
		}
		if (hasUnsupportedPresentation(document)) {
			return { ok: false, reason: `${label} YAML uses comments, anchors or tags that cannot be preserved` };
		}
		const value = document.toJS({ maxAliasCount: 0 });
		if (!isJsonLike(value)) {
			return { ok: false, reason: `${label} YAML contains a non-canonical value` };
		}
		if (!isRecord(value)) {
			return { ok: false, reason: `${label} YAML root must be a canonical mapping` };
		}
		if (toStableYaml(value) !== text) {
			return { ok: false, reason: `${label} YAML is not in canonical stable representation` };
		}
		return { ok: true, value };
	} catch {
		return { ok: false, reason: `${label} YAML could not be parsed` };
	}
}

/**
 * Merge canonical YAML snapshots from Git stage 1 (base), stage 3 (local
 * pending commit) and stage 2 (remote target). It is intentionally conservative:
 * it returns no text whenever the engine cannot prove a value-preserving merge.
 */
export function mergeCanonicalYamlThreeWay(
	baseText: string | undefined,
	localText: string | undefined,
	remoteText: string | undefined,
): SemanticYamlMergeResult {
	const base = parseCanonicalYaml(baseText, "base");
	const local = parseCanonicalYaml(localText, "local");
	const remote = parseCanonicalYaml(remoteText, "remote");
	if (!base.ok) {
		return {
			ok: false,
			unresolvedPaths: ["/"],
			reason: base.reason,
			usedAuditMetadataRule: false,
		};
	}
	if (!local.ok) {
		return {
			ok: false,
			unresolvedPaths: ["/"],
			reason: local.reason,
			usedAuditMetadataRule: false,
		};
	}
	if (!remote.ok) {
		return {
			ok: false,
			unresolvedPaths: ["/"],
			reason: remote.reason,
			usedAuditMetadataRule: false,
		};
	}

	const merged = mergeValue(base.value, local.value, remote.value, "");
	if (merged.value === MISSING || merged.unresolvedPaths.length > 0) {
		return {
			ok: false,
			unresolvedPaths: [...new Set(merged.unresolvedPaths)].sort(),
			usedAuditMetadataRule: merged.usedAuditMetadataRule,
		};
	}
	return {
		ok: true,
		text: toStableYaml(merged.value),
		unresolvedPaths: [],
		usedAuditMetadataRule: merged.usedAuditMetadataRule,
	};
}
