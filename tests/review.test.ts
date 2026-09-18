import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globToRegExp } from "../src/review.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { structuralDiff } from "../src/structuralDiff.ts";
import {
	REVIEW_SURFACE_CONTRACT_VERSION,
	type ReviewSurfaceAdapter,
	type ReviewableResource,
} from "../src/types.ts";
import { createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

const ANNA = "Anna <anna@example.com>";
const AGENT = "Henry <agent@example.com>";

/** A minimal host adapter: the app knows its records have a readable name. */
const thingAdapter: ReviewSurfaceAdapter = {
	id: "fixture-thing-adapter",
	appId: "fixture",
	contractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
	adapterVersion: "1.0.0",
	supportedPathGlobs: ["data/things/**/*.yaml"],
	toReviewableResources(changes): ReviewableResource[] {
		return changes.map((change) => {
			const filePath = change.technicalRefs[0]?.path ?? "";
			const id = path.basename(filePath, ".yaml");
			return {
				appId: "fixture",
				resourceType: "thing",
				stableResourceId: `thing:${id}`,
				label: `Věc ${id}`,
				routeTarget: { href: `/things/${id}` },
				changes: [
					{
						changeId: change.changeId,
						kind: change.kind === "renamed" ? "modified" : change.kind,
						summary: "adapter summary",
						technicalRefs: change.technicalRefs,
						fields: [],
					},
				],
				reviewState: { value: "unreviewed" },
				fallback: { activeLevel: "resource_adapter", steps: [] },
			};
		});
	},
};

describe("review surface engine", () => {
	test("labels adapter-covered changes and keeps paths as technical evidence", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "alpha", { name: "Alfa" });
			db.recordOrigin(["data/things/alpha.yaml"], { kind: "app", actor: ANNA });

			const snapshot = await db.review({ adapters: [thingAdapter] });

			expect(snapshot.resources).toHaveLength(1);
			const resource = snapshot.resources[0];
			expect(resource?.label).toBe("Věc alpha");
			expect(resource?.routeTarget?.href).toBe("/things/alpha");
			expect(resource?.fallback.activeLevel).toBe("resource_adapter");
			// The path survives as evidence, never as the label.
			expect(resource?.changes[0]?.technicalRefs[0]?.path).toBe(
				"data/things/alpha.yaml",
			);
			// Provenance is backfilled even though the adapter did not carry it.
			expect(resource?.changes[0]?.origin?.kind).toBe("app");
			expect(resource?.changes[0]?.origin?.actor).toBe(ANNA);
			expect(snapshot.publishReadiness.canPublish).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("falls back to a structural field diff when no adapter matches", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "beta", {
				name: "Beta",
				status: "interested",
			});
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "baseline"]);

			writeFixtureDocument(fixture.mountPath, "beta", {
				name: "Beta",
				status: "price_offer",
			});

			const snapshot = await db.review();

			const resource = snapshot.resources[0];
			expect(resource?.fallback.activeLevel).toBe("generic_schema_diff");
			const fields = resource?.changes[0]?.fields ?? [];
			expect(fields).toHaveLength(1);
			expect(fields[0]?.fieldPath).toBe("/record/status");
			expect(fields[0]?.beforeSummary).toBe("interested");
			expect(fields[0]?.afterSummary).toBe("price_offer");
			expect(resource?.changes[0]?.kind).toBe("modified");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("never hides an unparseable change; it degrades to a technical diff", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFileSync(
				path.join(fixture.mountPath, "data/things/broken.yaml"),
				"this: is: not: valid: yaml:\n\t- broken\n",
				"utf8",
			);

			const snapshot = await db.review();

			expect(snapshot.resources).toHaveLength(1);
			expect(snapshot.resources[0]?.fallback.activeLevel).toBe("technical_file_diff");
			// Visible but flagged as only technically reviewable — non-blocking.
			expect(snapshot.publishReadiness.state).toBe("warning");
			expect(snapshot.publishReadiness.canPublish).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("keeps changes visible when an adapter throws", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "gamma", { name: "Gama" });

			const brokenAdapter: ReviewSurfaceAdapter = {
				...thingAdapter,
				id: "broken-adapter",
				toReviewableResources() {
					throw new Error("adapter exploded");
				},
			};

			const snapshot = await db.review({ adapters: [brokenAdapter] });

			expect(snapshot.resources).toHaveLength(1);
			expect(snapshot.resources[0]?.fallback.activeLevel).toBe("generic_schema_diff");
			expect(snapshot.fallback.steps[0]?.reason).toContain("adapter exploded");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("marks undeclared generated diffs as blocking", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFileSync(
				path.join(fixture.mountPath, "generated/rollup.json"),
				'{"count":1}\n',
				"utf8",
			);

			const snapshot = await db.review();

			expect(snapshot.publishReadiness.state).toBe("blocked");
			expect(snapshot.publishReadiness.canPublish).toBe(false);
			expect(
				snapshot.publishReadiness.references.some(
					(reference) => reference.kind === "generated_policy" && reference.blocking,
				),
			).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("reports a created record and an agent-written one distinctly", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "from-app", { name: "App" });
			writeFixtureDocument(fixture.mountPath, "from-agent", { name: "Agent" });
			db.recordOrigin(["data/things/from-app.yaml"], { kind: "app", actor: ANNA });
			db.recordOrigin(["data/things/from-agent.yaml"], { kind: "agent", actor: AGENT });

			const snapshot = await db.review();
			const origins = new Map(
				snapshot.resources.map((resource) => [
					resource.stableResourceId,
					resource.changes[0]?.origin,
				]),
			);

			expect(origins.get("path:data/things/from-app.yaml")?.kind).toBe("app");
			expect(origins.get("path:data/things/from-agent.yaml")?.kind).toBe("agent");
			expect(origins.get("path:data/things/from-agent.yaml")?.actor).toBe(AGENT);
			// Every change is "created" — neither existed in HEAD.
			expect(snapshot.resources.every((r) => r.changes[0]?.kind === "created")).toBe(true);
			// Coarse owner label: the first writer after the last publish.
			expect(db.draftOwner()?.actor).toBe(ANNA);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("is quiet on a clean checkout", async () => {
		const fixture = createFixtureRepo();
		try {
			const snapshot = await RepositoryDb.open(fixture.mountPath).review();
			expect(snapshot.resources).toEqual([]);
			expect(snapshot.publishReadiness.state).toBe("ready");
			expect(snapshot.baselineHead).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("structural diff", () => {
	test("summarizes created, modified and deleted fields", () => {
		const result = structuralDiff(
			{ name: "before", dropped: 1, nested: { keep: true, value: 2 } },
			{ name: "after", added: "new", nested: { keep: true, value: 3 } },
		);
		const byPath = new Map(result.fields.map((field) => [field.fieldPath, field]));

		expect(byPath.get("/name")?.changeKind).toBe("modified");
		expect(byPath.get("/added")?.changeKind).toBe("created");
		expect(byPath.get("/dropped")?.changeKind).toBe("deleted");
		expect(byPath.get("/nested/value")?.afterSummary).toBe("3");
		expect(byPath.has("/nested/keep")).toBe(false);
	});

	test("escapes JSON Pointer segments and caps the output", () => {
		const before: Record<string, unknown> = { "a/b": 1, "c~d": 1 };
		const after: Record<string, unknown> = { "a/b": 2, "c~d": 2 };
		for (let index = 0; index < 60; index += 1) {
			before[`f${index}`] = index;
			after[`f${index}`] = index + 1;
		}
		const result = structuralDiff(before, after, { maxFields: 10 });

		expect(result.fields).toHaveLength(10);
		expect(result.truncated).toBe(52);
		const pointers = new Set(result.fields.map((field) => field.fieldPath));
		expect(pointers.has("/a~1b")).toBe(true);
		expect(pointers.has("/c~0d")).toBe(true);
	});

	test("treats arrays as whole values rather than per-index churn", () => {
		const result = structuralDiff({ tags: ["a", "b"] }, { tags: ["a", "b", "c"] });
		expect(result.fields).toHaveLength(1);
		expect(result.fields[0]?.fieldPath).toBe("/tags");
		expect(result.fields[0]?.valueKind).toBe("array");
		expect(result.fields[0]?.afterSummary).toBe("3 položek");
	});
});

describe("glob matching", () => {
	test("supports *, ? and ** including zero directories", () => {
		expect(globToRegExp("data/things/*.yaml").test("data/things/a.yaml")).toBe(true);
		expect(globToRegExp("data/things/*.yaml").test("data/things/sub/a.yaml")).toBe(false);
		expect(globToRegExp("data/**/*.yaml").test("data/a.yaml")).toBe(true);
		expect(globToRegExp("data/**/*.yaml").test("data/deep/nested/a.yaml")).toBe(true);
		expect(globToRegExp("data/thing-?.yaml").test("data/thing-1.yaml")).toBe(true);
		expect(globToRegExp("data/thing-?.yaml").test("data/thing-12.yaml")).toBe(false);
		// A literal dot must not act as a wildcard.
		expect(globToRegExp("data/a.yaml").test("data/axyaml")).toBe(false);
	});
});
