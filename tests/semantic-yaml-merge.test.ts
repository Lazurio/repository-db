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
});
