import type {
	ReviewFieldChangeKind,
	ReviewFieldRenderHint,
	ReviewFieldSummary,
	ReviewFieldValueKind,
} from "./types.ts";

/**
 * Generic structural diff between a baseline and a draft document.
 *
 * This is the `generic_schema_diff` rung of the review fallback ladder: what
 * the engine can say about a changed record without any app knowledge. An app
 * adapter that knows the schema produces better labels and route anchors; this
 * exists so a record still reads as "Status: Interested → Price offer" instead
 * of a raw file path when no adapter covers it.
 *
 * Deliberately shallow in two ways: arrays are compared as whole values rather
 * than per index (index churn is noise, not information for a reviewer), and
 * the output is capped, because a review list is a summary — the full diff
 * stays available as technical evidence.
 */

const DEFAULT_MAX_FIELDS = 50;
const MAX_SUMMARY_LENGTH = 120;
const MAX_DEPTH = 8;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL = /^https?:\/\/\S+$/;

export interface StructuralDiffResult {
	fields: ReviewFieldSummary[];
	/** Number of changed fields beyond the returned cap. */
	truncated: number;
}

function valueKindOf(value: unknown): ReviewFieldValueKind {
	if (value === null || value === undefined) return "unknown";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "string") {
		if (ISO_DATE.test(value)) return "date";
		if (EMAIL.test(value)) return "email";
		if (URL.test(value)) return "url";
		return "text";
	}
	return "unknown";
}

function renderHintOf(kind: ReviewFieldValueKind): ReviewFieldRenderHint {
	switch (kind) {
		case "date":
			return "date";
		case "url":
		case "email":
			return "link";
		case "object":
		case "array":
			return "json";
		default:
			return "plain";
	}
}

/** Short, deterministic display value; never a dump of a whole record. */
export function summarizeValue(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (value === null) return "—";
	if (Array.isArray(value)) return `${value.length} položek`;
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return `${keys.length} polí`;
	}
	const text = String(value);
	return text.length > MAX_SUMMARY_LENGTH
		? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
		: text;
}

/** RFC 6901 escaping so a key containing `/` or `~` stays addressable. */
function pointerSegment(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function equalValues(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== typeof right) return false;
	if (left === null || right === null) return false;
	if (typeof left !== "object") return false;
	return JSON.stringify(left) === JSON.stringify(right);
}

function changeKindOf(before: unknown, after: unknown): ReviewFieldChangeKind {
	if (before === undefined && after !== undefined) return "created";
	if (before !== undefined && after === undefined) return "deleted";
	return "modified";
}

/**
 * Compare two parsed documents and summarize what changed.
 *
 * `label` defaults to the field key: readable enough for the generic rung, and
 * replaced wholesale by an adapter that knows the real field names.
 */
export function structuralDiff(
	before: unknown,
	after: unknown,
	options: { maxFields?: number } = {},
): StructuralDiffResult {
	const maxFields = options.maxFields ?? DEFAULT_MAX_FIELDS;
	const fields: ReviewFieldSummary[] = [];
	let overflow = 0;

	const push = (
		pointer: string,
		label: string,
		beforeValue: unknown,
		afterValue: unknown,
	) => {
		if (fields.length >= maxFields) {
			overflow += 1;
			return;
		}
		const kind = valueKindOf(afterValue === undefined ? beforeValue : afterValue);
		fields.push({
			fieldPath: pointer,
			label,
			changeKind: changeKindOf(beforeValue, afterValue),
			valueKind: kind,
			renderHint: renderHintOf(kind),
			beforeSummary: summarizeValue(beforeValue),
			afterSummary: summarizeValue(afterValue),
		});
	};

	const walk = (
		beforeValue: unknown,
		afterValue: unknown,
		pointer: string,
		label: string,
		depth: number,
	): void => {
		if (equalValues(beforeValue, afterValue)) return;

		if (
			depth < MAX_DEPTH &&
			isPlainObject(beforeValue) &&
			isPlainObject(afterValue)
		) {
			const keys = [
				...new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]),
			].sort();
			for (const key of keys) {
				walk(
					beforeValue[key],
					afterValue[key],
					`${pointer}/${pointerSegment(key)}`,
					key,
					depth + 1,
				);
			}
			return;
		}

		push(pointer === "" ? "/" : pointer, label, beforeValue, afterValue);
	};

	walk(before, after, "", "dokument", 0);
	return { fields, truncated: overflow };
}
