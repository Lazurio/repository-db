import { describe, expect, test } from "bun:test";
import {
	REVIEW_SURFACE_CONTRACT_VERSION,
	type JsonObject,
	type PublishReadinessReference,
	type PublishReadinessSummary,
	type ResourceChange,
	type ResourceChangeKind,
	type ReviewFallbackLevel,
	type ReviewFieldRenderHint,
	type ReviewFieldValueKind,
	type ReviewInputChange,
	type ReviewableResource,
	type ReviewSurfaceContractMetadata,
	type ReviewSurfaceSnapshot,
	type ReviewSurfaceAdapter,
} from "../src/index.ts";

const fixturePath = "data/fixture-records/fixture-alpha.yaml";
const stableResourceId = "fixture-record:alpha";

const changeKinds = [
	"created",
	"modified",
	"deleted",
	"unknown",
] satisfies ResourceChangeKind[];

const fallbackLevels = [
	"resource_adapter",
	"generic_schema_diff",
	"technical_file_diff",
	"unknown",
] satisfies ReviewFallbackLevel[];

const fieldValueKinds = [
	"text",
	"number",
	"boolean",
	"date",
	"enum",
	"money",
	"url",
	"email",
	"object",
	"array",
	"unknown",
] satisfies ReviewFieldValueKind[];

const fieldRenderHints = [
	"plain",
	"multiline",
	"code",
	"badge",
	"link",
	"currency",
	"date",
	"relative_time",
	"json",
] satisfies ReviewFieldRenderHint[];

const readinessReferences = [
	{
		kind: "schema_error",
		blocking: true,
		message: "Fixture schema validation failed.",
		stableResourceIds: [stableResourceId],
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
	},
	{
		kind: "conflict",
		blocking: true,
		message: "Fixture draft has an unresolved repository conflict.",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
	},
	{
		kind: "validation_error",
		blocking: true,
		message: "Fixture validation command reported a blocking issue.",
	},
	{
		kind: "unknown",
		blocking: false,
		message: "Fixture unknown path remains visible through technical review.",
	},
] satisfies PublishReadinessReference[];

const changes = [
	{
		changeId: "fixture-change:created",
		kind: "created",
		summary: "Fixture resource was created.",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
		fields: [
			{
				fieldPath: "/title",
				label: "Title",
				changeKind: "created",
				valueKind: "text",
				renderHint: "plain",
				afterSummary: "Fixture Alpha",
			},
		],
		draftContentHash: "sha256:created-fixture",
	},
	{
		changeId: "fixture-change:modified",
		kind: "modified",
		summary: "Fixture resource has one modified field.",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
		fields: [
			{
				fieldPath: "/details/status",
				label: "Status",
				changeKind: "modified",
				valueKind: "enum",
				renderHint: "badge",
				beforeSummary: "Draft",
				afterSummary: "Ready for review",
			},
		],
		draftContentHash: "sha256:modified-fixture",
	},
	{
		changeId: "fixture-change:deleted",
		kind: "deleted",
		summary: "Fixture resource was deleted.",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
		fields: [
			{
				fieldPath: "/title",
				label: "Title",
				changeKind: "deleted",
				valueKind: "text",
				renderHint: "plain",
				beforeSummary: "Fixture Alpha",
			},
		],
		draftContentHash: "sha256:deleted-fixture",
	},
	{
		changeId: "fixture-change:unknown",
		kind: "unknown",
		summary: "Unknown fixture-side file changed.",
		technicalRefs: [{ path: "notes/fixture-sidecar.txt", kind: "unknown_path" }],
		fields: [],
		draftContentHash: "sha256:unknown-fixture",
	},
] satisfies ResourceChange[];

const baselineHead = "0123456789abcdef0123456789abcdef01234567";

const contractMetadata = {
	reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
	adapterId: "fixture-review-adapter",
	adapterVersion: "1.0.0",
	schemaVersion: "fixture.schema.v1",
	dataSchemaVersion: "fixture-data@1.0.0",
	computedAt: "2026-06-21T00:00:00.000Z",
} satisfies ReviewSurfaceContractMetadata;

const resource = {
	appId: "fixture-app",
	resourceType: "fixture-record",
	stableResourceId,
	label: "Fixture Alpha",
	routeTarget: {
		href: "/fixture/records/alpha?review=1",
		label: "Open fixture",
		params: { id: "alpha" },
		context: { review: true },
	},
	contractMetadata,
	reviewRepresentationHash: "sha256:resource-review-fixture",
	changes,
	fallback: {
		activeLevel: "resource_adapter",
		steps: [
			{ level: "resource_adapter", label: "Fixture resource adapter" },
			{ level: "generic_schema_diff", label: "Generic structural diff" },
			{
				level: "technical_file_diff",
				label: "Technical file diff",
				technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
			},
			{ level: "unknown", label: "Unknown changed file" },
		],
	},
	publishReadiness: readinessReferences,
	metadata: { fixtureOnly: true, tags: ["synthetic", "review-surface"] },
} satisfies ReviewableResource;

const inputChanges = [
	{
		changeId: "fixture-input:modified",
		kind: "modified",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
		summary: "Fixture path changed before adapter enrichment.",
		draftContentHash: "sha256:input-draft",
		baselineContentHash: "sha256:input-baseline",
		metadata: { source: "synthetic-test" },
	},
	{
		changeId: "fixture-input:renamed",
		kind: "renamed",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
		previousTechnicalRefs: [
			{ path: "data/fixture-records/fixture-old-alpha.yaml", kind: "canonical_data_path" },
		],
		summary: "Fixture path was renamed before adapter enrichment.",
	},
] satisfies ReviewInputChange[];

const publishReadiness = {
	state: "blocked",
	canPublish: false,
	references: readinessReferences,
} satisfies PublishReadinessSummary;

const snapshotMetadata = {
	fixtureOnly: true,
	counts: { resources: 1, changes: changes.length },
	tags: ["synthetic", "review-surface"],
} satisfies JsonObject;

const snapshot = {
	reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
	baselineHead,
	computedAt: contractMetadata.computedAt,
	inputChanges,
	resources: [resource],
	publishReadiness,
	fallback: resource.fallback,
	reviewRepresentationHash: "sha256:snapshot-review-fixture",
	metadata: snapshotMetadata,
} satisfies ReviewSurfaceSnapshot;

const adapter = {
	id: "fixture-review-adapter",
	appId: "fixture-app",
	contractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
	adapterVersion: "1.0.0",
	schemaVersion: "fixture.schema.v1",
	supportedPathGlobs: ["data/fixture-records/*.yaml"],
	toReviewableResources(rawChanges) {
		return [
			{
				...resource,
				changes: rawChanges.map((change) => ({
					changeId: change.changeId,
					kind: change.kind === "renamed" ? "modified" : change.kind,
					summary: change.summary ?? "Fixture raw input change.",
					technicalRefs: change.technicalRefs,
					fields: [],
					draftContentHash: change.draftContentHash,
				})),
			},
		];
	},
} satisfies ReviewSurfaceAdapter;

describe("Review Surface contract types", () => {
	test("cover generic change kinds and fallback levels", () => {
		expect(changeKinds).toEqual(["created", "modified", "deleted", "unknown"]);
		expect(fallbackLevels).toEqual([
			"resource_adapter",
			"generic_schema_diff",
			"technical_file_diff",
			"unknown",
		]);
		expect(fieldValueKinds).toContain("money");
		expect(fieldValueKinds).toContain("unknown");
		expect(fieldRenderHints).toContain("badge");
		expect(fieldRenderHints).toContain("json");
	});

	test("keeps technical paths out of the primary user-facing label", () => {
		expect(resource.label).toBe("Fixture Alpha");
		expect(resource.label).not.toContain("data/");
		expect(resource.stableResourceId).toBe(stableResourceId);
		expect(resource.routeTarget?.href).toBe("/fixture/records/alpha?review=1");
		expect(resource.changes.map((change) => change.kind)).toEqual(changeKinds);
		expect(resource.changes[0]?.technicalRefs[0]?.path).toBe(fixturePath);
		expect(resource.changes[1]?.fields[0]?.fieldPath).toBe("/details/status");
		expect(resource.changes[1]?.fields[0]?.valueKind).toBe("enum");
		expect(resource.changes[1]?.fields[0]?.renderHint).toBe("badge");
	});

	test("allows publish readiness to point at blocking and non-blocking review evidence", () => {
		expect(resource.publishReadiness?.map((ref) => ref.kind)).toEqual([
			"schema_error",
			"conflict",
			"validation_error",
			"unknown",
		]);
		expect(resource.publishReadiness?.filter((ref) => ref.blocking)).toHaveLength(3);
		expect(resource.contractMetadata?.adapterId).toBe("fixture-review-adapter");
		expect(resource.contractMetadata?.adapterVersion).toBe("1.0.0");
		expect(resource.contractMetadata?.dataSchemaVersion).toBe("fixture-data@1.0.0");
		expect(snapshot.publishReadiness.canPublish).toBe(false);
	});

	test("lets a synthetic app adapter resolve raw input changes to reviewable resources", async () => {
		const resolved = await adapter.toReviewableResources(inputChanges);

		expect(adapter.supportedPathGlobs).toEqual(["data/fixture-records/*.yaml"]);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.appId).toBe("fixture-app");
		expect(resolved[0]?.fallback.activeLevel).toBe("resource_adapter");
		expect(resolved[0]?.changes.map((change) => change.changeId)).toEqual(
			inputChanges.map((change) => change.changeId),
		);
		expect(resolved[0]?.changes[1]?.kind).toBe("modified");
	});

	test("describes a top-level review snapshot with JSON-safe metadata", () => {
		expect(snapshot.reviewContractVersion).toBe(REVIEW_SURFACE_CONTRACT_VERSION);
		expect(snapshot.resources[0]?.stableResourceId).toBe(stableResourceId);
		expect(snapshot.inputChanges?.[1]?.previousTechnicalRefs?.[0]?.path).toBe(
			"data/fixture-records/fixture-old-alpha.yaml",
		);
		expect(snapshot.metadata?.counts).toEqual({ resources: 1, changes: 4 });
		expect(snapshot.reviewRepresentationHash).toBe("sha256:snapshot-review-fixture");
	});
});
