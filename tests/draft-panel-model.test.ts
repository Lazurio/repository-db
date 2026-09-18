import { describe, expect, test } from "bun:test";
import { deriveDraftPanel, type DraftPanelInput } from "../src/ui/draftPanelModel.ts";
import { REVIEW_SURFACE_CONTRACT_VERSION, type ReviewableResource } from "../src/types.ts";

function resource(overrides: Partial<ReviewableResource> = {}): ReviewableResource {
	return {
		appId: "deals",
		resourceType: "deals",
		stableResourceId: "deals:deal-1",
		label: "ANTANA Group — partnerský distribuční kanál",
		routeTarget: { href: "#all?deal=deal-1", label: "Otevřít deal" },
		metadata: { typeLabel: "Deal" },
		contractMetadata: { reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION },
		changes: [
			{
				changeId: "path:data/deals/deal-1.yaml",
				kind: "modified",
				summary: "1 změněné pole",
				technicalRefs: [{ path: "data/deals/deal-1.yaml", kind: "canonical_data_path" }],
				fields: [
					{
						fieldPath: "/record/status",
						label: "Stav",
						changeKind: "modified",
						beforeSummary: "Zájem",
						afterSummary: "Cenová nabídka",
					},
				],
				origin: { kind: "agent", actor: "Henry <agent@example.com>" },
			},
		],
		reviewState: { value: "unreviewed" },
		fallback: { activeLevel: "resource_adapter", steps: [] },
		...overrides,
	};
}

function input(overrides: Partial<DraftPanelInput> = {}): DraftPanelInput {
	return {
		revision: "draft:abc",
		state: "draft",
		records: [
			{
				resource: resource(),
				technicalPath: "data/deals/deal-1.yaml",
				revert: { supported: true },
			},
		],
		...overrides,
	};
}

describe("draft panel model", () => {
	test("shows a record by its business label, not its path", () => {
		const model = deriveDraftPanel(input());
		const record = model.records[0];

		expect(record?.label).toBe("ANTANA Group — partnerský distribuční kanál");
		expect(record?.typeLabel).toBe("Deal");
		expect(record?.changeLabel).toBe("Upraveno");
		expect(record?.fields).toEqual([{ label: "Stav", before: "Zájem", after: "Cenová nabídka" }]);
		expect(record?.href).toBe("#all?deal=deal-1");
		// The path is kept, but only as technical detail.
		expect(record?.technicalPath).toBe("data/deals/deal-1.yaml");
	});

	test("says out loud that publishing sends the whole draft", () => {
		const model = deriveDraftPanel(input());
		expect(model.tone).toBe("draft");
		expect(model.pill).toBe("Rozpracováno");
		expect(model.wholeDraftNote).toContain("celý rozpracovaný obsah");
		expect(model.actions.map((action) => action.kind)).toEqual([
			"publish",
			"discard_draft",
		]);
	});

	test("labels provenance and never claims an author it does not know", () => {
		const agentModel = deriveDraftPanel(input());
		expect(agentModel.records[0]?.originLabel).toBe("Agent");

		const unknown = resource();
		unknown.changes[0]!.origin = undefined;
		const unknownModel = deriveDraftPanel(
			input({
				records: [
					{ resource: unknown, technicalPath: "data/deals/deal-1.yaml", revert: { supported: true } },
				],
			}),
		);
		expect(unknownModel.records[0]?.originLabel).toBe("Neznámý původ");
		expect(unknownModel.records[0]?.originKind).toBe("unknown");
	});

	test("explains an unavailable revert instead of offering a dead button", () => {
		const model = deriveDraftPanel(
			input({
				records: [
					{
						resource: resource(),
						technicalPath: "data/deals/deal-1.yaml",
						revert: {
							supported: false,
							reason: "The draft also contains generated data built from these records.",
						},
					},
				],
			}),
		);
		expect(model.records[0]?.revertSupported).toBe(false);
		expect(model.records[0]?.revertBlockedReason).toContain("generated data");
	});

	test("treats an unsent commit as finishing a send, not as a draft", () => {
		const model = deriveDraftPanel(input({ state: "committed_not_pushed" }));

		expect(model.tone).toBe("sending");
		expect(model.pill).toBe("Čeká na odeslání");
		const discard = model.actions.find((action) => action.kind === "discard_draft");
		expect(discard?.enabled).toBe(false);
		expect(discard?.disabledReason).toContain("není totéž");
		expect(model.actions.some((action) => action.kind === "finish_send")).toBe(true);
		// The changes stay visible in this state.
		expect(model.records).toHaveLength(1);
	});

	test("keeps changes visible in a conflict and offers real recovery actions", () => {
		const model = deriveDraftPanel(
			input({
				state: "conflict",
				conflict: {
					message: "Publikaci zastavil konflikt při slučování.",
					handoff: "repository-db conflict --abort",
				},
			}),
		);

		expect(model.tone).toBe("conflict");
		expect(model.records).toHaveLength(1);
		// The user's own words about what happened, plus the recovery detail.
		expect(model.headline).toBe("Publikaci zastavil konflikt při slučování.");
		expect(model.conflict?.handoff).toContain("conflict --abort");
		expect(model.actions.map((action) => action.kind)).toEqual([
			"abort_conflict",
			"mark_conflict_resolved",
			"publish",
		]);
		expect(model.actions.find((action) => action.kind === "publish")?.enabled).toBe(false);
	});

	test("disables publish with the blocking reason attached", () => {
		const model = deriveDraftPanel(
			input({
				publishReadiness: {
					state: "blocked",
					canPublish: false,
					references: [
						{
							kind: "generated_policy",
							blocking: true,
							message: "Změněné generované soubory nejsou deklarované.",
						},
					],
				},
			}),
		);
		const publish = model.actions.find((action) => action.kind === "publish");
		expect(publish?.enabled).toBe(false);
		expect(publish?.disabledReason).toContain("generované soubory");
	});

	test("is calm when everything is published", () => {
		const model = deriveDraftPanel(input({ state: "published", records: [] }));
		expect(model.tone).toBe("published");
		expect(model.pill).toBe("Publikováno");
		expect(model.count).toBe(0);
		expect(model.actions).toEqual([]);
	});
});
