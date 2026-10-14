/**
 * Shared types of the repository-db engine.
 *
 * The engine is intentionally domain-agnostic: it knows about Git, YAML
 * documents, collections, derived output and the publish lifecycle.
 * Domain schemas are injected by the host application through
 * the {@link DocumentParser} contract, which is structurally compatible with
 * Zod schemas without depending on Zod.
 */

/** Structurally compatible with `zod` schemas (`schema.parse(value)`). */
export interface DocumentParser<T> {
	parse(value: unknown): T;
}

export interface RepositoryDbLayout {
	/** Directory with canonical collection data, relative to the mount root. */
	data: string;
	/**
	 * Conventional home of derived output, relative to the mount root. `init`
	 * ignores it in Git. Only `generated_manifest` entries are derived output to
	 * the engine; a tracked file elsewhere in this directory is ordinary data.
	 */
	generated: string;
	/** Directory with data-repo-local maintenance scripts, relative to the mount root. */
	scripts: string;
}

export interface GeneratedManifestEntry {
	/**
	 * Path of a derived artifact (file or directory), relative to the mount root.
	 * It is never tracked: the data repo ignores it and the engine rebuilds it.
	 */
	path: string;
	/**
	 * Command building the artifact, executed with cwd = mount root. It reads
	 * only from the data checkout and writes only to declared paths.
	 */
	materializer?: string;
	/** Human note about what the artifact contains. */
	note?: string;
}

export interface RepositoryDbConfig {
	schemaVersion: string;
	/** Application name owning this data repo, e.g. `sample-app`. */
	app: string;
	dataRepo: {
		/** Expected remote URL of the data repository. */
		remote: string;
		/** Expected major-generation branch, e.g. `v3`. */
		branch: string;
	};
	schema: {
		/** Data-shape contract name, e.g. `sample-data`. */
		name: string;
		/** Data-shape contract version, e.g. `3.0.0-alpha.0`. */
		version: string;
	};
	layout: RepositoryDbLayout;
	/**
	 * Declared derived output: an ignored cache the engine builds in the live
	 * checkout ({@link GeneratedManifestEntry}). Never part of a draft.
	 */
	generatedManifest: GeneratedManifestEntry[];
	/**
	 * Validation commands run before every publish and after integrating a
	 * colleague's work (cwd = mount root; they must not reach outside it).
	 */
	validate: string[];
}

export type SyncState =
	| "conflict"
	| "draft"
	| "committed_not_pushed"
	| "pull_needed"
	| "published";

export interface SyncStatus {
	/** Highest-priority state; see individual flags for the full picture. */
	state: SyncState;
	branch: string;
	/** Local commits not pushed to the remote branch. */
	ahead: number;
	/** Remote commits not present locally (as of the last fetch). */
	behind: number;
	/** Uncommitted (draft) paths relative to the mount root. */
	dirtyPaths: string[];
	/** Current local commit; the one a waiting send must name. Null before the first commit. */
	head: string | null;
	/** True when a rebase/merge is in progress or a conflict state is recorded. */
	conflict: boolean;
	/** True when `git fetch` was executed as part of this status call. */
	fetched: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	[key: string]: JsonValue;
}

/** Current public Review Surface representation contract. */
export const REVIEW_SURFACE_CONTRACT_VERSION = "repository-db.review-surface.v1" as const;

/** The coarse file/resource change kinds surfaced by review adapters. */
export type ResourceChangeKind = "created" | "modified" | "deleted" | "unknown";

/** Where a path reference comes from; paths are technical metadata, not labels. */
export type ReviewTechnicalReferenceKind =
	| "canonical_data_path"
	| "supporting_path"
	| "unknown_path";

export interface ReviewTechnicalReference {
	/** Path relative to the data-repo mount root. Not a primary UI label. */
	path: string;
	kind: ReviewTechnicalReferenceKind;
	/** Optional technical note for developer details or agent handoff. */
	note?: string;
}

export interface ReviewRouteTarget {
	/** Host-app route, URL path, hash or deep link for opening this resource. */
	href: string;
	/** Optional action label, e.g. "Open" translated by the host app. */
	label?: string;
	/** Stable route params when the host router separates route name from params. */
	params?: Record<string, string>;
	/** Extra non-secret JSON routing context for the host app. */
	context?: JsonObject;
}

export type ReviewFieldChangeKind =
	| "created"
	| "modified"
	| "deleted"
	| "unchanged"
	| "unknown";

/** App-agnostic value categories used to render field summaries safely. */
export type ReviewFieldValueKind =
	| "text"
	| "number"
	| "boolean"
	| "date"
	| "enum"
	| "money"
	| "url"
	| "email"
	| "object"
	| "array"
	| "unknown";

/** Generic rendering hints; host apps may map these to their own components. */
export type ReviewFieldRenderHint =
	| "plain"
	| "multiline"
	| "code"
	| "badge"
	| "link"
	| "currency"
	| "date"
	| "relative_time"
	| "json";

export interface ReviewFieldSummary {
	/** Structural JSON Pointer path inside the parsed record, not a filesystem path. */
	fieldPath: string;
	/** Human-facing field label supplied by the app/schema adapter. */
	label: string;
	changeKind: ReviewFieldChangeKind;
	/** Coarse value kind for app-agnostic review rendering and filtering. */
	valueKind?: ReviewFieldValueKind;
	/** Optional generic renderer hint; never a framework/component name. */
	renderHint?: ReviewFieldRenderHint;
	/** Deterministic short display value for review lists; raw diff can be lazy. */
	beforeSummary?: string;
	/** Deterministic short display value for review lists; raw diff can be lazy. */
	afterSummary?: string;
}

/**
 * Where a draft change came from, as far as the engine can tell: written in the
 * app, written by an agent, or not reliably known.
 *
 * Information only. Provenance never gates an operation, never decides whether
 * a discard is safe and is never the audit record — that remains the publish
 * commit and its trailers. When in doubt the answer is `unknown`, and the UI
 * says so plainly rather than guessing at an author.
 */
export type ReviewChangeOriginKind = "app" | "agent" | "unknown";

export interface ReviewChangeOrigin {
	kind: ReviewChangeOriginKind;
	/** Identity of the writer, in the same format as the publish actor. */
	actor?: string;
	/** Producing surface, e.g. `deals-v3` or `repository-db-cli`. */
	source?: string;
	/** ISO timestamp when the hint was recorded. */
	recordedAt?: string;
}

export interface ResourceChange {
	/** Stable within one draft/review computation; shared by panels, rows and publish readiness. */
	changeId: string;
	kind: ResourceChangeKind;
	/** Deterministic app/schema summary, e.g. a field count. */
	summary: string;
	/** Technical file evidence kept for developer details, Git review and agents. */
	technicalRefs: ReviewTechnicalReference[];
	/** Structural field summary; empty when only a raw technical diff is known. */
	fields: ReviewFieldSummary[];
	/** Hash of the draft content this change describes. */
	draftContentHash?: string;
	/** Informational provenance; never gates an operation. */
	origin?: ReviewChangeOrigin;
}

export type ReviewInputChangeKind = ResourceChangeKind | "renamed";

export interface ReviewInputChange {
	/** Stable raw change id before an app adapter enriches the review representation. */
	changeId: string;
	kind: ReviewInputChangeKind;
	/** Current technical refs for the changed path. */
	technicalRefs: ReviewTechnicalReference[];
	/** Previous refs for moves/renames when a caller can detect them. */
	previousTechnicalRefs?: ReviewTechnicalReference[];
	/** Optional deterministic raw status summary before app-specific enrichment. */
	summary?: string;
	/** Hash of the current draft file/content/representation when available. */
	draftContentHash?: string;
	/** Hash of the baseline file/content when available. */
	baselineContentHash?: string;
	/**
	 * Baseline file content, when the engine already read it.
	 *
	 * An app adapter has to diff against the published version, and the engine
	 * reads that same content to hash it — handing it over saves a second
	 * `git show` per record, which is the difference between a snappy review and
	 * a stalled request on a large draft.
	 */
	baselineText?: string;
	/** Informational provenance; never gates an operation. */
	origin?: ReviewChangeOrigin;
	/** Non-secret JSON metadata for diagnostics; not a UI label. */
	metadata?: JsonObject;
}

/** Ordered degradation levels for review surfaces. */
export type ReviewFallbackLevel =
	| "resource_adapter"
	| "generic_schema_diff"
	| "technical_file_diff"
	| "unknown";

export interface ReviewFallbackStep {
	level: ReviewFallbackLevel;
	/** User-facing description of what this step can still show. */
	label: string;
	/** Why the richer level was unavailable, or why this level was chosen. */
	reason?: string;
	/** Technical evidence exposed only in details/agent views. */
	technicalRefs?: ReviewTechnicalReference[];
}

export interface ReviewFallbackLadder {
	/** The level that produced the current review representation. */
	activeLevel: ReviewFallbackLevel;
	/** Ordered from richest app adapter down to raw technical fallback. */
	steps: ReviewFallbackStep[];
}

export interface ReviewSurfaceContractMetadata {
	/** Review representation contract that shaped this resource. */
	reviewContractVersion: string;
	/** Adapter that produced the user-facing representation, when known. */
	adapterId?: string;
	/** Semantic adapter version; bump only for review-invalidating changes. */
	adapterVersion?: string;
	/** Semantic schema version; bump when field meaning/shape invalidates review. */
	schemaVersion?: string;
	/** Explicit data/schema contract version; use when `schemaVersion` would be ambiguous. */
	dataSchemaVersion?: string;
	/** ISO timestamp when this review representation was computed. */
	computedAt?: string;
}

export type PublishReadinessReferenceKind =
	| "schema_error"
	| "conflict"
	| "validation_error"
	| "unknown";

export interface PublishReadinessReference {
	kind: PublishReadinessReferenceKind;
	/** True when publish must not continue until this reference is resolved. */
	blocking: boolean;
	/** Deterministic human-facing explanation. */
	message: string;
	/** Related review change ids, if the readiness item points at draft changes. */
	changeIds?: string[];
	/** Related stable resource ids, if known. */
	stableResourceIds?: string[];
	/** Technical evidence for developer details or agent handoff. */
	technicalRefs?: ReviewTechnicalReference[];
}

export type PublishReadinessState = "ready" | "blocked" | "warning" | "unknown";

export interface PublishReadinessSummary {
	/** Aggregate advisory state for the current review snapshot. */
	state: PublishReadinessState;
	/** Convenience flag; false when any blocking reference is active. */
	canPublish: boolean;
	references: PublishReadinessReference[];
}

export interface ReviewableResource {
	/** Host-app id used for grouping; not coupled to any specific product domain. */
	appId: string;
	/** App-defined generic resource type, e.g. a record/document/item category. */
	resourceType: string;
	/** Stable resource id shared by app UI, review panel and publish readiness. */
	stableResourceId: string;
	/** Primary user-facing label. Do not use a raw data-repo path here. */
	label: string;
	/** Optional jump target for opening the resource in the host app. */
	routeTarget?: ReviewRouteTarget;
	/** Version identity for the representation shown to reviewers. */
	contractMetadata?: ReviewSurfaceContractMetadata;
	/** Hash of the visible review representation. */
	reviewRepresentationHash?: string;
	changes: ResourceChange[];
	fallback: ReviewFallbackLadder;
	/** Blocking/non-blocking references shown in the final publish summary. */
	publishReadiness?: PublishReadinessReference[];
	/** Non-secret JSON app metadata for grouping/rendering. */
	metadata?: JsonObject;
}

export interface ReviewSurfaceSnapshot {
	reviewContractVersion: string;
	baselineHead: string;
	/**
	 * Revision of the draft these resources describe.
	 *
	 * Computed as part of the same review, so a confirmation carrying it applies
	 * to exactly what was shown. Reading it separately after a review would
	 * reintroduce the gap it exists to close.
	 */
	draftRevision?: string;
	/** HEAD at review time; used to finish sending exactly this commit. */
	head?: string;
	computedAt?: string;
	/** Raw input changes used to compute the resource representation, if retained. */
	inputChanges?: ReviewInputChange[];
	resources: ReviewableResource[];
	publishReadiness: PublishReadinessSummary;
	/** Aggregate fallback diagnostics for snapshot-level consumers. */
	fallback: ReviewFallbackLadder;
	/** Hash of the snapshot review representation for coarse invalidation. */
	reviewRepresentationHash?: string;
	/** Non-secret JSON metadata for diagnostics or host grouping. */
	metadata?: JsonObject;
}

export interface ReviewSurfaceAdapter<TChange = ReviewInputChange> {
	/** Stable adapter id for local metadata and diagnostics. */
	id: string;
	/** Host-app id whose resources this adapter resolves. */
	appId: string;
	/** Contract version supported by this adapter. */
	contractVersion: string;
	/** Semantic adapter version; bump only for review-invalidating changes. */
	adapterVersion: string;
	/** Semantic schema version for the app-provided parsed data shape. */
	schemaVersion?: string;
	/** Optional path globs documented by the host app for registry matching. */
	supportedPathGlobs?: string[];
	/** Resolve raw/generic changes into user-facing reviewable resources. */
	toReviewableResources(
		changes: readonly TChange[],
	): ReviewableResource[] | Promise<ReviewableResource[]>;
}

export interface CommitTrailers {
	app: string;
	dataRepo: string;
	branch: string;
	schemaVersion: string;
	actor: string;
	machine: string;
	source: string;
	changeId: string;
	entities?: string[];
}

export interface PublishOptions {
	/** Human actor recorded in the commit trailers, e.g. `Jana <jana@firma.cz>`. */
	actor: string;
	/**
	 * Revision of the draft being confirmed. Publish runs only if the draft is
	 * still exactly that version when the shared gate is taken. A caller with
	 * nothing displayed confirms what is there by passing `draftRevision()`.
	 */
	expectedRevision: string;
	/** Producing surface, e.g. `sample-app-v1` or `repository-db-cli`. */
	source: string;
	/** Optional human summary used as the first commit-message line. */
	summary?: string;
	/** Optional entity identifiers recorded in the optional trailer. */
	entities?: string[];
}

export interface FinishSendOptions {
	/**
	 * The commit waiting to be sent, as it was shown. Finishing a send pushes
	 * exactly the commits up to this one and never makes a new commit. The same
	 * call retries a send the engine stopped with a recorded conflict.
	 */
	expectedHead: string;
}

export interface PublishResult {
	/** `published` on success. */
	state: "published" | "nothing_to_publish";
	commit?: string;
	changeId?: string;
	pushedTo?: string;
	/**
	 * Paths a colleague had published in the meantime that this send
	 * integrated under the local work. Empty when the remote had not moved.
	 */
	remoteChanges?: string[];
}

/**
 * Why the engine stopped a send:
 *
 *   - `merge`      — a colleague changed the same record and the semantic merge
 *                    could not prove the combination safe;
 *   - `validation` — the integrated result (local work on top of the
 *                    colleague's) failed the materializers or validators.
 *
 * In both cases the live checkout holds the local commit, unchanged.
 */
export type ConflictKind = "merge" | "validation";

export interface ConflictState {
	schemaVersion: "repository-db.conflict.v1";
	/** Engine send conflicts carry it; external Git state and older records do not. */
	kind?: ConflictKind;
	detectedAt: string;
	operation: string;
	gitState: string;
	message: string;
	handoff: string;
	/** Files both sides changed, when the engine knows them. */
	paths?: string[];
	/** Structural JSON-pointer paths the semantic YAML merger could not prove safe. */
	unresolvedFields?: Record<string, string[]>;
	/** Exact local commit a retry (`finishSend`) must name. */
	pendingHead?: string;
	/** True only for a conflict the engine recorded while sending, never external Git state. */
	retryable?: boolean;
}

export class RepositoryDbError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "RepositoryDbError";
		this.code = code;
	}
}

export class BoundaryViolationError extends RepositoryDbError {
	constructor(message: string) {
		super("boundary_violation", message);
		this.name = "BoundaryViolationError";
	}
}

export class ConflictActiveError extends RepositoryDbError {
	constructor(message: string) {
		super("conflict_active", message);
		this.name = "ConflictActiveError";
	}
}

/**
 * A record write whose base revision is no longer what is stored: someone saved
 * the same record in the meantime. The write was not applied.
 */
export class RecordChangedError extends RepositoryDbError {
	/** Revision stored now; `null` when the record no longer exists. */
	readonly currentRevision: string | null;

	constructor(message: string, currentRevision: string | null) {
		super("record_changed", message);
		this.name = "RecordChangedError";
		this.currentRevision = currentRevision;
	}
}

export class PublishLockedError extends RepositoryDbError {
	constructor(message: string) {
		super("publish_locked", message);
		this.name = "PublishLockedError";
	}
}

export class CredentialsError extends RepositoryDbError {
	constructor(message: string) {
		super("credentials", message);
		this.name = "CredentialsError";
	}
}

export class ValidationFailedError extends RepositoryDbError {
	constructor(message: string) {
		super("validation_failed", message);
		this.name = "ValidationFailedError";
	}
}

/**
 * A materializer declared in `generated_manifest` failed. Readers get it from
 * `ensureGenerated()`; publish is refused with it. Nothing was staged and no
 * draft was created.
 */
export class MaterializeFailedError extends RepositoryDbError {
	/** The manifest entry whose materializer failed. */
	readonly entryPath: string;

	constructor(entryPath: string, message: string) {
		super("materialize_failed", message);
		this.name = "MaterializeFailedError";
		this.entryPath = entryPath;
	}
}

/**
 * The data checkout still tracks something the engine owns as a local cache:
 * a declared derived path, or the engine's own runtime directory. Derived
 * output is rebuilt by the engine and must never be in Git.
 */
export class TrackedDerivedOutputError extends RepositoryDbError {
	/** Paths that are tracked or not ignored. */
	readonly paths: string[];
	/** The exact migration, as commands. */
	readonly migration: string[];

	constructor(code: string, message: string, paths: string[], migration: string[]) {
		super(code, message);
		this.name = "TrackedDerivedOutputError";
		this.paths = paths;
		this.migration = migration;
	}
}

/**
 * A pull refused because colleagues changed records this draft also changes.
 * Nothing was pulled. The way out: revert those records, pull, redo the edit.
 */
export class PullBlockedError extends RepositoryDbError {
	/** Drafted paths the incoming work also changes; empty when Git refused for another reason. */
	readonly paths: string[];

	constructor(paths: string[], detail?: string) {
		super(
			"pull_blocked_by_draft",
			paths.length > 0
				? `Colleagues published changes to records this draft also changes (${paths.join(", ")}); nothing was pulled. Revert those records, pull, then make the edit again on top of their version — or publish the draft first.`
				: `Colleagues published changes that cannot be fast-forwarded under this draft; nothing was pulled. Revert the affected records or publish the draft first.${detail ? ` Detail: ${detail}` : ""}`,
		);
		this.name = "PullBlockedError";
		this.paths = paths;
	}
}

/**
 * The configuration in the checkout (or arriving with a pull) changed what this
 * checkout is: the data remote, the branch or the data layout — or it can no
 * longer be read. Nothing was pushed or pulled; reopen the data checkout.
 */
export class ConfigChangedError extends RepositoryDbError {
	/** Config fields that changed incompatibly, e.g. `layout.data`. */
	readonly changes: string[];

	constructor(changes: string[], message: string) {
		super("config_changed", message);
		this.name = "ConfigChangedError";
		this.changes = changes;
	}
}
