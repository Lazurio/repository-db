import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import { activeConflict } from "./conflict.ts";
import { isPathDeclared, isUndeclaredGenerated, undeclaredGeneratedDiffs } from "./generated.ts";
import {
	gitBatchShow,
	gitDirtyPaths,
	gitRenameSources,
	runGit,
} from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";
import { computeDraftRevision, parseDraftRevision } from "./draftRevision.ts";
import { type DraftOriginRecord, resolveDraftOrigins } from "./origin.ts";
import { structuralDiff } from "./structuralDiff.ts";
import {
	type PublishReadinessReference,
	type PublishReadinessSummary,
	type RepositoryDbConfig,
	type ResourceChange,
	type ResourceChangeKind,
	type ReviewFallbackLadder,
	type ReviewFallbackLevel,
	type ReviewInputChange,
	type ReviewSurfaceAdapter,
	type ReviewSurfaceSnapshot,
	type ReviewTechnicalReference,
	type ReviewTechnicalReferenceKind,
	type ReviewableResource,
	REVIEW_SURFACE_CONTRACT_VERSION,
} from "./types.ts";
import { parseYaml } from "./yamlIo.ts";

/**
 * Review Surface engine.
 *
 * Turns the current draft — a set of dirty paths in the data checkout — into
 * resources a person can read: business labels, app routes and structural
 * before/after field summaries, with the technical paths kept as evidence for
 * Git review and agent handoff rather than as the primary label.
 *
 * The governing rule is that a change is never hidden. When no app adapter
 * matches a path, the engine steps down the fallback ladder to a generic schema
 * diff and finally to a raw technical file diff. A missing adapter is a degraded
 * review state; silently dropping an unmapped path would let unreviewed data
 * reach a publish, which is exactly what this surface exists to prevent.
 */

const FALLBACK_LABELS: Record<ReviewFallbackLevel, string> = {
	resource_adapter: "Aplikace zná tento typ záznamu",
	generic_schema_diff: "Strukturální porovnání dokumentu bez znalosti aplikace",
	technical_file_diff: "Pouze technický rozdíl souboru",
	unknown: "Změnu zatím neumíme zařadit",
};

const FALLBACK_ORDER: ReviewFallbackLevel[] = [
	"resource_adapter",
	"generic_schema_diff",
	"technical_file_diff",
	"unknown",
];

export interface ReviewOptions {
	/** App adapters resolving technical paths into business resources. */
	adapters?: readonly ReviewSurfaceAdapter[];
	/** Keep the raw input changes in the snapshot (developer details, agents). */
	includeInputChanges?: boolean;
	/** Cap on structural field rows per change. */
	maxFieldsPerChange?: number;
	/** ISO timestamp override; tests pass a fixed value for determinism. */
	computedAt?: string;
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Content of a path in the last published commit, or undefined when it did not
 * exist there. App adapters need this to diff against the baseline without
 * running Git themselves.
 */
export function readBaselineFile(
	mountRoot: string,
	relativePath: string,
	/**
	 * The baseline to read from. Pass the ref resolved once per request —
	 * resolving it per path costs a `git merge-base` per record.
	 */
	baseline: RepositoryDbConfig | string,
): string | undefined {
	// Required: HEAD is not the published state when a commit waits to be sent.
	const ref = typeof baseline === "string" ? baseline : reviewBaselineRef(mountRoot, baseline);
	return baselineContent(mountRoot, ref, relativePath);
}

/** Content of a path at a given commit, or undefined when it was not there. */
function baselineContent(
	mountRoot: string,
	ref: string,
	relativePath: string,
): string | undefined {
	const result = runGit(mountRoot, ["show", `${ref}:${relativePath}`]);
	return result.status === 0 ? result.stdout : undefined;
}

function workingContent(mountRoot: string, relativePath: string): string | undefined {
	const absolute = path.join(mountRoot, relativePath);
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(absolute);
	} catch {
		return undefined;
	}
	// A symlink is reviewed as what Git stores — its target path — and never
	// followed. Following it would let a dirty link in the data checkout pull
	// an arbitrary host file into the review payload served to the browser.
	if (stats.isSymbolicLink()) {
		try {
			return readlinkSync(absolute);
		} catch {
			return undefined;
		}
	}
	try {
		return readFileSync(absolute, "utf8");
	} catch {
		// Binary or unreadable: still a visible change, just not a parseable one.
		return undefined;
	}
}

function technicalRefKind(
	relativePath: string,
	config: RepositoryDbConfig,
): ReviewTechnicalReferenceKind {
	if (relativePath.startsWith(`${config.layout.data}/`)) return "canonical_data_path";
	if (relativePath.startsWith(`${config.layout.generated}/`)) return "generated_path";
	if (relativePath.startsWith(`${config.layout.scripts}/`)) return "supporting_path";
	return "unknown_path";
}

function changeKindOf(
	baseline: string | undefined,
	draft: string | undefined,
	isGenerated: boolean,
): ResourceChangeKind {
	if (isGenerated) return "generated";
	if (baseline === undefined && draft !== undefined) return "created";
	if (baseline !== undefined && draft === undefined) return "deleted";
	if (baseline !== undefined && draft !== undefined) return "modified";
	return "unknown";
}

type ParsedDocument =
	| { status: "absent" }
	| { status: "parsed"; value: unknown }
	| { status: "unparseable" };

/**
 * YAML is a JSON superset here, so one parser covers both canonical formats.
 *
 * The three outcomes are kept distinct on purpose: a document that fails to
 * parse is not the same as a document that is not there. Collapsing them would
 * render a record whose draft is currently invalid as "deleted" to the
 * reviewer, which is both wrong and alarming.
 */
function parseDocument(content: string | undefined): ParsedDocument {
	if (content === undefined) return { status: "absent" };
	try {
		return { status: "parsed", value: parseYaml(content) };
	} catch {
		return { status: "unparseable" };
	}
}

/** Minimal glob support for adapter path registration: `**`, `*`, `?`. */
export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index] ?? "";
		if (char === "*") {
			if (glob[index + 1] === "*") {
				// `**/` may also match zero directories, so `a/**/b` matches `a/b`.
				if (glob[index + 2] === "/") {
					pattern += "(?:.*/)?";
					index += 2;
					continue;
				}
				pattern += ".*";
				index += 1;
				continue;
			}
			pattern += "[^/]*";
			continue;
		}
		if (char === "?") {
			pattern += "[^/]";
			continue;
		}
		pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
	return globs.some((glob) => globToRegExp(glob).test(relativePath));
}

function ladder(
	activeLevel: ReviewFallbackLevel,
	reason?: string,
	technicalRefs?: ReviewTechnicalReference[],
): ReviewFallbackLadder {
	return {
		activeLevel,
		steps: FALLBACK_ORDER.slice(FALLBACK_ORDER.indexOf(activeLevel)).map((level) => ({
			level,
			label: FALLBACK_LABELS[level],
			reason: level === activeLevel ? reason : undefined,
			technicalRefs: level === activeLevel ? technicalRefs : undefined,
		})),
	};
}

function toOrigin(record: DraftOriginRecord | undefined) {
	if (!record) return undefined;
	return {
		kind: record.kind,
		actor: record.actor,
		source: record.source,
		recordedAt: record.recordedAt || undefined,
	};
}

/**
 * Baseline for the review: the last commit this checkout shares with the
 * published branch.
 *
 * Using the merge base rather than HEAD means the review answers one question
 * — "what here is not published yet" — for both an ordinary draft and a
 * commit that was made but never sent. It also keeps a colleague's newer
 * published commits out of the picture: those are not our changes to review.
 */
export function reviewBaselineRef(mountRoot: string, config: RepositoryDbConfig): string {
	const remoteBranch = `origin/${config.dataRepo.branch}`;
	const mergeBase = runGit(mountRoot, ["merge-base", "HEAD", remoteBranch]);
	if (mergeBase.status === 0 && mergeBase.stdout.trim()) return mergeBase.stdout.trim();
	// Nothing published to compare with (no upstream yet): everything committed
	// is still unsent, so the baseline is the empty tree — never HEAD, which
	// would hide those commits.
	return EMPTY_TREE;
}

/** Git's well-known empty tree: a baseline in which nothing exists yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Everything not yet published: committed-but-unsent changes and the dirty set. */
export function collectInputChanges(
	mountRoot: string,
	config: RepositoryDbConfig,
	/** The published baseline to compare with; resolved here when omitted. */
	baselineRef: string = reviewBaselineRef(mountRoot, config),
): ReviewInputChange[] {
	// Git reports a rename by its new path only. The old path is a published
	// record that the publish will delete, so it is listed too — otherwise the
	// deletion would reach the remote without ever being shown.
	const dirtyPaths = [
		...gitDirtyPaths(mountRoot),
		...gitRenameSources(mountRoot).values(),
	].filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`));
	const committedPaths =
		baselineRef === "HEAD"
			? []
			: runGit(mountRoot, [
					"diff",
					"--name-only",
					// Both sides of a committed rename, for the same reason.
					"--no-renames",
					"-z",
					baselineRef,
					"HEAD",
				])
					.stdout.split("\0")
					.filter(Boolean)
					.filter((entry) => !entry.startsWith(`${ENGINE_DIR}/`));

	const unpublishedPaths = [...new Set([...committedPaths, ...dirtyPaths])].sort();
	// Committed-but-unsent changes keep their recorded origin too: provenance is
	// cleared only when the send succeeds.
	const origins = resolveDraftOrigins(mountRoot, unpublishedPaths);
	// One git process for every baseline, instead of one per record.
	const baselines = gitBatchShow(mountRoot, baselineRef, unpublishedPaths);

	return unpublishedPaths.map((relativePath) => {
		const refKind = technicalRefKind(relativePath, config);
		const baseline = baselines.get(relativePath);
		// The working tree is the current truth in both cases: a committed change
		// is also present there, so one read covers both.
		const draft = workingContent(mountRoot, relativePath);
		const kind = changeKindOf(baseline, draft, refKind === "generated_path");
		return {
			changeId: `path:${relativePath}`,
			kind,
			technicalRefs: [{ path: relativePath, kind: refKind }],
			draftContentHash: draft === undefined ? undefined : sha256(draft),
			baselineContentHash: baseline === undefined ? undefined : sha256(baseline),
			baselineText: baseline,
			origin: toOrigin(origins.get(relativePath)),
		} satisfies ReviewInputChange;
	});
}

/**
 * Generic resource for a path no adapter claimed. The label is the file name,
 * which is honest about being a technical fallback rather than pretending to be
 * a business label.
 */
function genericResource(
	mountRoot: string,
	config: RepositoryDbConfig,
	input: ReviewInputChange,
	maxFields: number | undefined,
): ReviewableResource {
	const relativePath = input.technicalRefs[0]?.path ?? "";
	// The baseline was already read when the change was collected; reading it
	// again here would put a git process back on the per-record path.
	const baseline = parseDocument(input.baselineText);
	const draft = parseDocument(workingContent(mountRoot, relativePath));
	// Either side failing to parse means the structural diff would be a lie, so
	// the change degrades to technical evidence instead.
	const parseable =
		baseline.status !== "unparseable" &&
		draft.status !== "unparseable" &&
		(baseline.status === "parsed" || draft.status === "parsed");

	const diff = parseable
		? structuralDiff(
				baseline.status === "parsed" ? baseline.value : undefined,
				draft.status === "parsed" ? draft.value : undefined,
				{ maxFields },
			)
		: { fields: [], truncated: 0 };
	const level: ReviewFallbackLevel = parseable
		? "generic_schema_diff"
		: "technical_file_diff";

	const summary = parseable
		? diff.truncated > 0
			? `${diff.fields.length} změněných polí (a ${diff.truncated} dalších)`
			: `${diff.fields.length} změněných polí`
		: "Technický rozdíl souboru";

	const change: ResourceChange = {
		changeId: input.changeId,
		kind: input.kind === "renamed" ? "modified" : input.kind,
		summary,
		technicalRefs: input.technicalRefs,
		fields: diff.fields,
		draftContentHash: input.draftContentHash,
		origin: input.origin,
	};

	return {
		appId: config.app,
		resourceType:
			input.technicalRefs[0]?.kind === "generated_path" ? "generated-artifact" : "file",
		stableResourceId: `path:${relativePath}`,
		label: path.basename(relativePath),
		contractMetadata: {
			reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
			schemaVersion: `${config.schema.name}@${config.schema.version}`,
		},
		changes: [change],
		reviewState: { value: "unreviewed" },
		fallback: ladder(
			level,
			parseable
				? "Žádný adaptér aplikace tuto cestu nezná; ukazujeme strukturální rozdíl dokumentu."
				: "Soubor nelze rozparsovat jako dokument; zůstává jen technický rozdíl.",
			input.technicalRefs,
		),
	};
}

/**
 * Change ids an adapter's output actually accounts for, by explicit change id or
 * by the technical path it carries.
 */
function coveredChangeIds(resources: readonly ReviewableResource[]): Set<string> {
	const covered = new Set<string>();
	for (const resource of resources) {
		for (const change of resource.changes) {
			covered.add(change.changeId);
			for (const ref of change.technicalRefs) covered.add(`path:${ref.path}`);
		}
	}
	return covered;
}

/** Attach provenance to adapter output that did not carry it through. */
function backfillOrigins(
	resources: readonly ReviewableResource[],
	inputs: readonly ReviewInputChange[],
): void {
	const byPath = new Map<string, ReviewInputChange>();
	for (const input of inputs) {
		for (const ref of input.technicalRefs) byPath.set(ref.path, input);
	}
	for (const resource of resources) {
		for (const change of resource.changes) {
			if (change.origin) continue;
			for (const ref of change.technicalRefs) {
				const input = byPath.get(ref.path);
				if (input?.origin) {
					change.origin = input.origin;
					break;
				}
			}
		}
	}
}

function worstLevel(levels: readonly ReviewFallbackLevel[]): ReviewFallbackLevel {
	return levels.reduce<ReviewFallbackLevel>(
		(worst, level) =>
			FALLBACK_ORDER.indexOf(level) > FALLBACK_ORDER.indexOf(worst) ? level : worst,
		"resource_adapter",
	);
}

function publishReadiness(
	mountRoot: string,
	config: RepositoryDbConfig,
	resources: readonly ReviewableResource[],
): PublishReadinessSummary {
	const references: PublishReadinessReference[] = [];

	const conflict = activeConflict(mountRoot);
	if (conflict) {
		references.push({
			kind: "conflict",
			blocking: true,
			message: `Repozitář je v konfliktním stavu (${conflict.operation}); publikace je zablokovaná.`,
		});
	}

	// Everything unsent counts, not only the dirty tree: a committed artifact
	// that is not declared is refused by the policy just the same.
	const undeclared = [
		...new Set([
			...undeclaredGeneratedDiffs(mountRoot, config),
			...resources
				.flatMap((resource) => resource.changes.flatMap((change) => change.technicalRefs))
				.map((ref) => ref.path)
				.filter((entry) => isUndeclaredGenerated(entry, config)),
		]),
	].sort();
	if (undeclared.length > 0) {
		references.push({
			kind: "generated_policy",
			blocking: true,
			message:
				"Změněné generované soubory nejsou deklarované v generated_manifest; publikace je odmítne.",
			technicalRefs: undeclared.map((entry) => ({
				path: entry,
				kind: "generated_path" as const,
			})),
		});
	}

	const technicalOnly = resources.filter(
		(resource) => resource.fallback.activeLevel === "technical_file_diff",
	);
	if (technicalOnly.length > 0) {
		references.push({
			kind: "unknown",
			blocking: false,
			message: `${technicalOnly.length} změn(a) jde zobrazit jen jako technický rozdíl souboru.`,
			stableResourceIds: technicalOnly.map((resource) => resource.stableResourceId),
		});
	}

	const blocking = references.some((reference) => reference.blocking);
	return {
		state: blocking ? "blocked" : references.length > 0 ? "warning" : "ready",
		canPublish: !blocking,
		references,
	};
}

/**
 * Compute the review snapshot for the current draft.
 *
 * Async because adapters may need IO to resolve labels; the engine itself stays
 * on local Git plumbing and never touches the network here.
 */
export async function computeReviewSnapshot(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: ReviewOptions = {},
): Promise<ReviewSurfaceSnapshot> {
	assertDataRepoBoundary(mountRoot, config);

	// Taken before the changes are collected: if a write lands while the review
	// is being built, the snapshot carries the older revision and the next
	// confirmation fails closed. Taking it afterwards would do the opposite —
	// confirm a draft holding a change that was never shown.
	const draftRevision = computeDraftRevision(mountRoot);
	// The published version the resources are compared with — reported as the
	// snapshot's baseline, not the local HEAD a waiting commit sits on.
	const baselineRef = reviewBaselineRef(mountRoot, config);
	const inputs = collectInputChanges(mountRoot, config, baselineRef);
	const remaining = new Map(inputs.map((input) => [input.changeId, input]));
	const resources: ReviewableResource[] = [];
	const adapterFailures: string[] = [];
	const adapterGaps: string[] = [];

	for (const adapter of options.adapters ?? []) {
		const globs = adapter.supportedPathGlobs ?? [];
		if (globs.length === 0) continue;
		const matched = [...remaining.values()].filter((input) =>
			input.technicalRefs.some((ref) => matchesAnyGlob(ref.path, globs)),
		);
		if (matched.length === 0) continue;
		try {
			const produced = await adapter.toReviewableResources(matched);
			backfillOrigins(produced, matched);
			resources.push(...produced);
			// An adapter that quietly returns fewer resources than the inputs it
			// was handed — a filter, a dedupe, a buggy early return — must not be
			// able to make a dirty path disappear. Only inputs the output actually
			// references are considered handled; the rest fall through to the
			// generic rung, which is the whole point of the ladder.
			const covered = coveredChangeIds(produced);
			for (const input of matched) {
				if (covered.has(input.changeId)) remaining.delete(input.changeId);
				else
					adapterGaps.push(
						`${adapter.id} claimed ${input.technicalRefs[0]?.path ?? input.changeId} but produced no resource for it`,
					);
			}
		} catch (error) {
			// An adapter failure must not swallow the changes it claimed: they fall
			// through to the generic rung so they stay visible and reviewable.
			adapterFailures.push(
				`${adapter.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	for (const input of remaining.values()) {
		resources.push(genericResource(mountRoot, config, input, options.maxFieldsPerChange));
	}

	const snapshotLevel = worstLevel(resources.map((resource) => resource.fallback.activeLevel));
	// The HEAD the revision was taken at, so finishing a send names exactly it.
	const revisionHead = parseDraftRevision(draftRevision).baseline;
	const head = revisionHead === "no-head" ? "" : revisionHead;
	const snapshot: ReviewSurfaceSnapshot = {
		reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
		baselineHead: baselineRef,
		draftRevision,
		head,
		computedAt: options.computedAt,
		resources,
		publishReadiness: publishReadiness(mountRoot, config, resources),
		fallback: ladder(
			snapshotLevel,
			[...adapterFailures, ...adapterGaps].length > 0
				? `Adaptér nepokryl všechny změny, spadly na obecnou úroveň: ${[...adapterFailures, ...adapterGaps].join("; ")}`
				: undefined,
		),
		inputChanges: options.includeInputChanges ? inputs : undefined,
	};

	snapshot.reviewRepresentationHash = sha256(
		JSON.stringify({
			baselineHead: snapshot.baselineHead,
			contract: snapshot.reviewContractVersion,
			level: snapshotLevel,
			resources: resources.map((resource) => ({
				id: resource.stableResourceId,
				label: resource.label,
				level: resource.fallback.activeLevel,
				changes: resource.changes.map((change) => ({
					id: change.changeId,
					kind: change.kind,
					hash: change.draftContentHash,
					fields: change.fields.map((field) => field.fieldPath),
				})),
			})),
		}),
	);
	return snapshot;
}

export { isPathDeclared };
