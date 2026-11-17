import { describe, expect, test } from "bun:test";
import { mergeCanonicalYamlThreeWay } from "../src/semanticYamlMerge.ts";
import { parseYaml, toStableYaml } from "../src/yamlIo.ts";

type Thing = {
	schemaVersion: string;
	id: string;
	record: {
		amount: number;
		stage: string;
		updatedAt: string;
		updatedByName: string;
		lines: Array<{ id: string; quantity: number; unitPrice: number }>;
		tags?: string[];
	};
};

function thing(overrides: Partial<Thing["record"]> = {}): Thing {
	return {
		schemaVersion: "thing.v3",
		id: "thing-1",
		record: {
			amount: 100,
			stage: "draft",
			updatedAt: "2026-10-01T10:00:00.000Z",
			updatedByName: "Base editor",
			lines: [
				{ id: "line-a", quantity: 1, unitPrice: 10 },
				{ id: "line-b", quantity: 1, unitPrice: 20 },
			],
			...overrides,
		},
	};
}

function decode(text: string | undefined): Thing {
	if (!text) throw new Error("Expected merged YAML text");
	return parseYaml(text) as Thing;
}

describe("mergeCanonicalYamlThreeWay", () => {
	test("merges independent business fields and id-keyed array members while keeping the later audit bundle", () => {
		const base = thing();
		const local = thing({
			amount: 110,
			updatedAt: "2026-10-03T10:00:00.000Z",
			updatedByName: "Local editor",
			lines: [
				{ id: "line-a", quantity: 2, unitPrice: 10 },
				{ id: "line-b", quantity: 1, unitPrice: 20 },
			],
		});
		const remote = thing({
			stage: "approved",
			updatedAt: "2026-10-02T10:00:00.000Z",
			updatedByName: "Remote editor",
			lines: [
				{ id: "line-a", quantity: 1, unitPrice: 10 },
				{ id: "line-b", quantity: 1, unitPrice: 25 },
			],
		});

		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(base),
			toStableYaml(local),
			toStableYaml(remote),
		);

		expect(result.ok).toBe(true);
		expect(result.unresolvedPaths).toEqual([]);
		expect(result.usedAuditMetadataRule).toBe(true);
		expect(decode(result.text).record).toEqual({
			amount: 110,
			stage: "approved",
			updatedAt: "2026-10-03T10:00:00.000Z",
			updatedByName: "Local editor",
			lines: [
				{ id: "line-a", quantity: 2, unitPrice: 10 },
				{ id: "line-b", quantity: 1, unitPrice: 25 },
			],
		});
	});

	test("refuses a competing business leaf without adding timestamp noise", () => {
		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(thing()),
			toStableYaml(thing({ amount: 110, updatedAt: "2026-10-03T10:00:00.000Z" })),
			toStableYaml(thing({ amount: 120, updatedAt: "2026-10-02T10:00:00.000Z" })),
		);

		expect(result.ok).toBe(false);
		expect(result.text).toBeUndefined();
		expect(result.unresolvedPaths).toEqual(["/record/amount"]);
	});

	test("refuses concurrent edits to an unkeyed array", () => {
		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(thing({ tags: ["a"] })),
			toStableYaml(thing({ tags: ["a", "local"] })),
			toStableYaml(thing({ tags: ["a", "remote"] })),
		);

		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual(["/record/tags"]);
	});

	test("refuses an id-keyed array reorder rather than guessing business order", () => {
		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(thing()),
			toStableYaml(
				thing({
					lines: [
						{ id: "line-b", quantity: 1, unitPrice: 20 },
						{ id: "line-a", quantity: 1, unitPrice: 10 },
					],
				}),
			),
			toStableYaml(
				thing({
					lines: [
						{ id: "line-a", quantity: 1, unitPrice: 11 },
						{ id: "line-b", quantity: 1, unitPrice: 20 },
					],
				}),
			),
		);

		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual(["/record/lines"]);
	});

	test("refuses non-canonical audit timestamps instead of treating them as merge metadata", () => {
		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(thing()),
			toStableYaml(thing({ amount: 110, updatedAt: "tomorrow", updatedByName: "Local editor" })),
			toStableYaml(thing({ stage: "approved", updatedAt: "later", updatedByName: "Remote editor" })),
		);

		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual(["/record/updatedAt", "/record/updatedByName"]);
	});

	test("refuses YAML comments instead of dropping presentation content during canonical rewrite", () => {
		const base = "# Keep this human note\n" + toStableYaml(thing());
		const result = mergeCanonicalYamlThreeWay(
			base,
			toStableYaml(thing({ amount: 110 })),
			toStableYaml(thing({ stage: "approved" })),
		);

		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual(["/"]);
		expect(result.reason).toContain("comments");
	});

	test("refuses non-canonical stable representation and a non-mapping document root", () => {
		const nonCanonical = toStableYaml(thing()).replace("stage: draft", 'stage: "draft"');
		const representation = mergeCanonicalYamlThreeWay(
			nonCanonical,
			toStableYaml(thing({ amount: 110 })),
			toStableYaml(thing({ stage: "approved" })),
		);
		expect(representation.ok).toBe(false);
		expect(representation.reason).toContain("canonical stable representation");

		const listRoot = toStableYaml([{ id: "not-an-envelope" }]);
		const root = mergeCanonicalYamlThreeWay(listRoot, listRoot, listRoot);
		expect(root.ok).toBe(false);
		expect(root.reason).toContain("root must be a canonical mapping");
	});

	test("does not treat nested updatedAt fields as audit metadata", () => {
		const base = {
			...thing(),
			record: {
				...thing().record,
				metadata: {
					updatedAt: "2026-10-01T10:00:00.000Z",
					updatedByName: "Base editor",
					localNote: "base",
					remoteNote: "base",
				},
			},
		};
		const local = structuredClone(base);
		local.record.metadata.updatedAt = "2026-10-03T10:00:00.000Z";
		local.record.metadata.updatedByName = "Local editor";
		local.record.metadata.localNote = "local";
		const remote = structuredClone(base);
		remote.record.metadata.updatedAt = "2026-10-02T10:00:00.000Z";
		remote.record.metadata.updatedByName = "Remote editor";
		remote.record.metadata.remoteNote = "remote";

		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(base),
			toStableYaml(local),
			toStableYaml(remote),
		);
		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual([
			"/record/metadata/updatedAt",
			"/record/metadata/updatedByName",
		]);
	});

	test("keeps the later write revision with its audit bundle when independent fields merge", () => {
		const base = { ...thing(), record: { ...thing().record, revision: "r-base" } };
		const local = structuredClone(base);
		local.record.amount = 110;
		local.record.updatedAt = "2026-10-03T10:00:00.000Z";
		local.record.updatedByName = "Local editor";
		local.record.revision = "r-local";
		const remote = structuredClone(base);
		remote.record.stage = "approved";
		remote.record.updatedAt = "2026-10-02T10:00:00.000Z";
		remote.record.updatedByName = "Remote editor";
		remote.record.revision = "r-remote";

		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(base),
			toStableYaml(local),
			toStableYaml(remote),
		);
		expect(result.ok).toBe(true);
		expect(result.usedAuditMetadataRule).toBe(true);
		const merged = decode(result.text).record as Thing["record"] & { revision: string };
		expect(merged.amount).toBe(110);
		expect(merged.stage).toBe("approved");
		expect(merged.updatedByName).toBe("Local editor");
		// New content gets a new revision, never one side's.
		expect(merged.revision).toMatch(/^merge-[0-9a-f]{32}$/);
		expect(merged.revision).not.toBe("r-local");
		expect(merged.revision).not.toBe("r-remote");
		// The same two revisions merge to the same value on either side.
		const swapped = mergeCanonicalYamlThreeWay(
			toStableYaml(base),
			toStableYaml(remote),
			toStableYaml(local),
		);
		expect((decode(swapped.text).record as unknown as { revision: string }).revision).toBe(merged.revision);
	});

	test("equal timestamps with two new revisions merge deterministically", () => {
		const base = { ...thing(), record: { ...thing().record, revision: "r-base" } };
		const local = structuredClone(base);
		local.record.amount = 110;
		local.record.updatedAt = "2026-10-03T10:00:00.000Z";
		local.record.updatedByName = "Local editor";
		local.record.revision = "r-a";
		const remote = structuredClone(base);
		remote.record.stage = "approved";
		remote.record.updatedAt = "2026-10-03T10:00:00.000Z";
		remote.record.updatedByName = "Remote editor";
		remote.record.revision = "r-b";

		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(base),
			toStableYaml(local),
			toStableYaml(remote),
		);
		expect(result.ok).toBe(true);
		const merged = decode(result.text).record as Thing["record"] & { revision: string };
		expect([merged.amount, merged.stage]).toEqual([110, "approved"]);
		// The bundle of the greater revision ("r-b") wins the tie.
		expect(merged.updatedByName).toBe("Remote editor");
		expect(merged.revision).toMatch(/^merge-/);
	});

	test("equal timestamps without revisions keep the 3.3.0 rule", () => {
		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(thing()),
			toStableYaml(thing({ amount: 110, updatedAt: "2026-10-03T10:00:00.000Z", updatedByName: "Local" })),
			toStableYaml(thing({ stage: "approved", updatedAt: "2026-10-03T10:00:00.000Z", updatedByName: "Remote" })),
		);
		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual(["/record/updatedByName"]);
	});

	test("a competing business leaf stays a conflict even when both revisions changed", () => {
		const base = { ...thing(), record: { ...thing().record, revision: "r-base" } };
		const local = structuredClone(base);
		local.record.amount = 110;
		local.record.updatedAt = "2026-10-03T10:00:00.000Z";
		local.record.revision = "r-local";
		const remote = structuredClone(base);
		remote.record.amount = 120;
		remote.record.updatedAt = "2026-10-02T10:00:00.000Z";
		remote.record.revision = "r-remote";

		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(base),
			toStableYaml(local),
			toStableYaml(remote),
		);
		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual(["/record/amount"]);
	});

	test("a revision changed on both sides without a newer updatedAt stays a conflict", () => {
		const base = { ...thing(), record: { ...thing().record, revision: "r-base" } };
		const local = structuredClone(base);
		local.record.amount = 110;
		local.record.revision = "r-local";
		const remote = structuredClone(base);
		remote.record.stage = "approved";
		remote.record.revision = "r-remote";

		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(base),
			toStableYaml(local),
			toStableYaml(remote),
		);
		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual(["/record/revision"]);
	});

	test("does not treat a nested revision field as audit metadata", () => {
		const base = {
			...thing(),
			record: { ...thing().record, document: { revision: "A", note: "base" } },
		};
		const local = structuredClone(base);
		local.record.document.revision = "B";
		local.record.updatedAt = "2026-10-03T10:00:00.000Z";
		const remote = structuredClone(base);
		remote.record.document.revision = "C";
		remote.record.updatedAt = "2026-10-02T10:00:00.000Z";

		const result = mergeCanonicalYamlThreeWay(
			toStableYaml(base),
			toStableYaml(local),
			toStableYaml(remote),
		);
		expect(result.ok).toBe(false);
		expect(result.unresolvedPaths).toEqual(["/record/document/revision"]);
	});
});
