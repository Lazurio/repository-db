import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { RepositoryDb } from "../src/index.ts";
import { recordRevisionFromBytes } from "../src/collections.ts";
import { mergeCanonicalYamlThreeWay, mergedRevision } from "../src/semanticYamlMerge.ts";
import { createFixtureRepo, writeFixtureDocument } from "./fixtures.ts";
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
		expect(merged.revision).toMatch(/^merge-[0-9a-f]{64}$/);
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

describe("mergedRevision", () => {
	const expected = (pair: [string, string]) =>
		`merge-${createHash("sha256").update(JSON.stringify(pair)).digest("hex")}`;

	test("is the whole SHA-256 of the JSON array of the two revisions in code-point order", () => {
		expect(mergedRevision("r-b", "r-a")).toBe(expected(["r-a", "r-b"]));
		expect(mergedRevision("r-a", "r-b")).toBe(expected(["r-a", "r-b"]));
		expect(mergedRevision("r-a", "r-b")).toMatch(/^merge-[0-9a-f]{64}$/);
	});

	test("orders a character beyond the BMP after U+E000, by code point, not by UTF-16 unit", () => {
		// "\uE000" is U+E000; "😀" is U+1F600, whose first UTF-16 unit (0xD83D) is below 0xE000.
		expect(mergedRevision("😀", "\uE000")).toBe(expected(["\uE000", "😀"]));
		expect(mergedRevision("\uE000", "😀")).toBe(expected(["\uE000", "😀"]));
		expect(mergedRevision("a😀", "a\uE000")).toBe(expected(["a\uE000", "a😀"]));
	});
});

describe("a write after a merge", () => {
	test("is refused when based on either side's pre-merge version, and accepted on the merged one", () => {
		const fixture = createFixtureRepo();
		const base = { ...thing().record, revision: "r-base" };
		writeFixtureDocument(fixture.mountPath, "thing-1", base);
		const local = { ...base, amount: 110, updatedAt: "2026-10-03T10:00:00.000Z", revision: "r-local" };
		const remote = { ...base, stage: "approved", updatedAt: "2026-10-02T10:00:00.000Z", revision: "r-remote" };
		const document = (record: Record<string, unknown>) =>
			toStableYaml({ schemaVersion: "thing.v3", id: "thing-1", record });
		const merged = mergeCanonicalYamlThreeWay(document(base), document(local), document(remote));
		expect(merged.ok).toBe(true);
		const file = writeFixtureDocument(fixture.mountPath, "thing-1", local);
		writeFileSync(file, merged.text as string, "utf8");
		const mergedRecord = (parseYaml(readFileSync(file, "utf8")) as Thing).record as Thing["record"] & {
			revision: string;
		};
		// The port's own check: neither side's write revision names the merged record.
		expect([mergedRecord.revision === "r-local", mergedRecord.revision === "r-remote"]).toEqual([false, false]);

		const things = RepositoryDb.open(fixture.mountPath).collection("things", { schemaVersion: "thing.v3" });
		const next = { ...mergedRecord, amount: 200, revision: "r-next" };
		for (const side of [local, remote]) {
			const stale = recordRevisionFromBytes(Buffer.from(document(side), "utf8"));
			expect(() => things.put("thing-1", next, {}, { baseRevision: stale })).toThrow(
				expect.objectContaining({ code: "record_changed" }),
			);
		}
		expect(readFileSync(file, "utf8")).toBe(merged.text as string);
		things.put("thing-1", next, {}, { baseRevision: things.revision("thing-1") });
		expect((things.get("thing-1")?.record as { revision: string }).revision).toBe("r-next");
	});
});

describe("mixed writers: one replaces the revision, the other keeps it or has none", () => {
	const merge = (base: unknown, local: unknown, remote: unknown) =>
		mergeCanonicalYamlThreeWay(toStableYaml(base), toStableYaml(local), toStableYaml(remote));
	const withRevision = () => ({ ...thing(), record: { ...thing().record, revision: "r0" } });

	test("a writer that kept r0 against one that wrote r1 is refused on the revision, for any content", () => {
		for (const stage of ["approved", "rejected"]) {
			const base = withRevision();
			const local = structuredClone(base);
			local.record.amount = 110;
			local.record.revision = "r1";
			local.record.updatedAt = "2026-10-02T10:00:00.000Z";
			const remote = structuredClone(base);
			remote.record.stage = stage;
			remote.record.updatedAt = "2026-10-03T10:00:00.000Z";
			const result = merge(base, local, remote);
			expect([stage, result.ok, result.unresolvedPaths]).toEqual([stage, false, ["/record/revision"]]);
		}
	});

	test("a later side without a revision is refused on the revision, never dropping the new one", () => {
		const base = thing();
		const local = { ...thing(), record: { ...thing().record, amount: 110, revision: "r1", updatedAt: "2026-10-02T10:00:00.000Z" } };
		const remote = { ...thing(), record: { ...thing().record, stage: "approved", updatedAt: "2026-10-03T10:00:00.000Z" } };
		const result = merge(base, local, remote);
		expect([result.ok, result.unresolvedPaths]).toEqual([false, ["/record/revision"]]);
	});

	test("equal timestamps of a writer that kept r0 and one that wrote r1 are refused on the revision, not on the audit bundle", () => {
		const base = withRevision();
		const local = structuredClone(base);
		local.record.amount = 110;
		local.record.revision = "r1";
		local.record.updatedAt = "2026-10-03T10:00:00.000Z";
		local.record.updatedByName = "Aware writer";
		const remote = structuredClone(base);
		remote.record.stage = "approved";
		remote.record.updatedAt = "2026-10-03T10:00:00.000Z";
		remote.record.updatedByName = "Legacy writer";
		const result = merge(base, local, remote);
		expect([result.ok, result.unresolvedPaths]).toEqual([false, ["/record/revision"]]);
	});

	test("without a timestamp winner a kept r0 against r1 is refused too", () => {
		const base = withRevision();
		const local = structuredClone(base);
		local.record.amount = 110;
		local.record.revision = "r1";
		local.record.updatedAt = "2026-10-02T10:00:00.000Z";
		const remote = structuredClone(base);
		remote.record.stage = "approved";
		const result = merge(base, local, remote);
		expect([result.ok, result.unresolvedPaths]).toEqual([false, ["/record/revision"]]);
	});

	test("records without a revision on either side keep the 3.3.0 merge", () => {
		const result = merge(
			thing(),
			thing({ amount: 110, updatedAt: "2026-10-03T10:00:00.000Z" }),
			thing({ stage: "approved", updatedAt: "2026-10-02T10:00:00.000Z" }),
		);
		expect(result.ok).toBe(true);
		expect((decode(result.text).record as { revision?: string }).revision).toBeUndefined();
	});
});
