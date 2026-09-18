/**
 * Shared types of the repository-db engine.
 *
 * The engine is intentionally domain-agnostic: it knows about Git, YAML
 * documents, collections, generated read models and the publish lifecycle.
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
	/** Directory with committed generated read models, relative to the mount root. */
	generated: string;
	/** Directory with data-repo-local maintenance scripts, relative to the mount root. */
	scripts: string;
}

export interface GeneratedManifestEntry {
	/** Path of the committed generated artifact, relative to the mount root. */
	path: string;
	/** Command materializing the artifact, executed with cwd = mount root. */
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
	 * Declared committed generated read models. Generated diffs outside these
	 * paths are refused by publish.
	 */
	generatedManifest: GeneratedManifestEntry[];
	/** Validation commands executed by `repository-db validate` (cwd = mount root). */
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

/**
 * Current public Review Surface representation contract.
 *
 * Persisted review marks should include this value in their invalidation key so
 * a future incompatible contract can clear stale reviewed state safely.
 */
export const REVIEW_SURFACE_CONTRACT_VERSION = "repository-db.review-surface.v1" as const;

/** The coarse file/resource change kinds surfaced by review adapters. */
export type ResourceChangeKind =
	| "created"
	| "modified"
	| "deleted"
	| "generated"
	| "unknown";

/** Where a path reference comes from; paths are technical metadata, not labels. */
export type ReviewTechnicalReferenceKind =
	| "canonical_data_path"
	| "generated_path"
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

export interface ReviewUiAnchor {
	/** Host-app stable anchor id for row/card/detail/field highlighting. */
	id: string;
	/** Optional host-app route when a field has a more precise target. */
	routeTarget?: ReviewRouteTarget;
	/** Optional non-secret hint consumed by the host UI. */
	hint?: string;
}

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
	/** Optional UI anchor for inline draft highlighting. */
	uiAnchor?: ReviewUiAnchor;
}

/**
 * Best-effort provenance of a draft change: written through an app API by an
 * identified person, written by a task agent, or written outside the
 * application (plain filesystem/Git edit, or no recorded hint at all).
 *
 * Advisory only. It is never an authorization input and never the audit
 * record — that remains the publish commit and its trailers.
 */
export type ReviewChangeOriginKind = "app" | "agent" | "external";

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
	/** Deterministic app/schema summary, e.g. field count or generated artifact note. */
	summary: string;
	/** Technical file evidence kept for developer details, Git review and agents. */
	technicalRefs: ReviewTechnicalReference[];
	/** Structural field summary; empty when only a raw technical diff is known. */
	fields: ReviewFieldSummary[];
	/** Draft representation hash used to invalidate reviewed state after edits. */
	draftContentHash?: string;
	/** Source technical refs for generated outputs, when known. */
	generatedFrom?: ReviewTechnicalReference[];
	/** Advisory provenance hint for the reviewer; never an authorization input. */
	origin?: ReviewChangeOrigin;
}

export type ReviewInputChangeKind = ResourceChangeKind | "renamed";

export interface ReviewInputChange {
	/** Stable raw change id before an app adapter enriches the review representation. */
	changeId: string;
	kind: ReviewInputChangeKind;
	/** Current technical refs for the dirty/generated/unknown path. */
	technicalRefs: ReviewTechnicalReference[];
	/** Previous refs for moves/renames when a caller can detect them. */
	previousTechnicalRefs?: ReviewTechnicalReference[];
	/** Optional deterministic raw status summary before app-specific enrichment. */
	summary?: string;
	/** Hash of the current draft file/content/representation when available. */
	draftContentHash?: string;
	/** Hash of the baseline file/content when available. */
	baselineContentHash?: string;
	/** Source technical refs for generated outputs, when known. */
	generatedFrom?: ReviewTechnicalReference[];
	/** Advisory provenance hint for the reviewer; never an authorization input. */
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

export type ReviewStateValue =
	| "unreviewed"
	| "reviewed"
	| "stale"
	| "blocked"
	| "not_required";

export interface ReviewedStateKey {
	/** Baseline HEAD used when the draft review representation was computed. */
	baselineHead: string;
	/** Stable app/resource id; never a filesystem path. */
	stableResourceId: string;
	/** Resource-related paths included only to invalidate moves/renames. */
	resourcePaths: string[];
	/** Hash of the draft review representation or backing draft content. */
	draftContentHash: string;
	/** Review contract version, usually REVIEW_SURFACE_CONTRACT_VERSION. */
	reviewContractVersion: string;
	/** Semantic adapter version; bump only for review-invalidating changes. */
	adapterVersion?: string;
	/** Semantic schema version; bump when field meaning/shape invalidates review. */
	schemaVersion?: string;
}

export interface ReviewState {
	value: ReviewStateValue;
	/** Persistence/invalidation key for durable reviewed marks. */
	key?: ReviewedStateKey;
	reviewedAt?: string;
	reviewedBy?: string;
	/** Human or deterministic reason for blocked/stale/not-required states. */
	reason?: string;
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
	| "unreviewed_change"
	| "validation_error"
	| "generated_policy"
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
	/** Hash of the visible review representation for invalidating stale marks. */
	reviewRepresentationHash?: string;
	changes: ResourceChange[];
	reviewState: ReviewState;
	fallback: ReviewFallbackLadder;
	/** Blocking/non-blocking references shown in the final publish summary. */
	publishReadiness?: PublishReadinessReference[];
	/** Non-secret JSON app metadata for grouping/rendering. */
	metadata?: JsonObject;
}

export interface ReviewSurfaceSnapshot {
	reviewContractVersion: string;
	baselineHead: string;
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
	/** Producing surface, e.g. `sample-app-v1` or `repository-db-cli`. */
	source: string;
	/** Optional human summary used as the first commit-message line. */
	summary?: string;
	/** Optional entity identifiers recorded in the optional trailer. */
	entities?: string[];
	/** Skip the validate step (used by tests and trusted callers only). */
	skipValidate?: boolean;
	/** Skip materializer commands (used when the caller already materialized). */
	skipMaterialize?: boolean;
}

export interface PublishResult {
	/** `published` on success. */
	state: "published" | "nothing_to_publish";
	commit?: string;
	changeId?: string;
	pushedTo?: string;
}

export interface ConflictState {
	schemaVersion: "repository-db.conflict.v1";
	detectedAt: string;
	operation: string;
	gitState: string;
	message: string;
	handoff: string;
	/** HEAD commit before the failed operation; used by safe abort/recovery. */
	preOperationHead?: string;
	/** Commit of the autostash holding the local draft, when one exists. */
	autostashSha?: string;
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
