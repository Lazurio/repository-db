import { describe, expect, test } from "bun:test";
import { deriveDraftPanel, type DraftPanelInput } from "../src/draftPanel.ts";
import {
	type ConflictState,
	REVIEW_SURFACE_CONTRACT_VERSION,
	type ReviewableResource,
	type SyncStatus,
} from "../src/types.ts";

function resource(overrides: Partial<ReviewableResource> = {}): ReviewableResource {
	return {
		appId: "deals",
		resourceType: "deals",
		stableResourceId: "deals:deal-1",
		label: "Ukázkový obchod — partnerský kanál",
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
				origin: { kind: "agent", actor: "Agent <agent@example.com>" },
			},
		],
		fallback: { activeLevel: "resource_adapter", steps: [] },
		...overrides,
	};
}

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
	return {
		state: "draft",
		branch: "v3",
		ahead: 0,
		behind: 0,
		dirtyPaths: ["data/deals/deal-1.yaml"],
		head: "head000",
		conflict: false,
		fetched: false,
		...overrides,
	};
}

function conflictState(overrides: Partial<ConflictState> = {}): ConflictState {
	return {
		schemaVersion: "repository-db.conflict.v1",
		kind: "merge",
		detectedAt: "2026-10-14T00:00:00.000Z",
		operation: "publish",
		gitState: "rebase stopped",
		message: "Publikaci zastavil konflikt při slučování.",
		handoff: "repository-db conflict --abort",
		pendingHead: "abc123",
		...overrides,
	};
}

function input(overrides: Partial<DraftPanelInput> = {}): DraftPanelInput {
	return {
		status: status(),
		revision: "draft:abc",
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

		expect(record?.label).toBe("Ukázkový obchod — partnerský kanál");
		expect(record?.typeLabel).toBe("Deal");
		expect(record?.changeLabel).toBe("Upraveno");
		expect(record?.fields).toEqual([
			{ fieldPath: "/record/status", label: "Stav", before: "Zájem", after: "Cenová nabídka" },
		]);
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
							reason: "This record was renamed in the draft.",
						},
					},
				],
			}),
		);
		expect(model.records[0]?.revertSupported).toBe(false);
		expect(model.records[0]?.revertBlockedReason).toContain("renamed");
	});

	test("treats an unsent commit as finishing a send, not as a draft", () => {
		const model = deriveDraftPanel(
			input({ status: status({ state: "committed_not_pushed", ahead: 1, dirtyPaths: [] }) }),
		);

		expect(model.tone).toBe("sending");
		expect(model.pill).toBe("Čeká na odeslání");
		const discard = model.actions.find((action) => action.kind === "discard_draft");
		expect(discard?.enabled).toBe(false);
		expect(discard?.disabledReason).toContain("není totéž");
		const finish = model.actions.find((action) => action.kind === "finish_send");
		// The commit to name is the local head the status reports.
		expect(finish?.enabled).toBe(true);
		expect(model.pendingHead).toBe("head000");
		// The changes stay visible in this state.
		expect(model.records).toHaveLength(1);
	});

	test("keeps changes visible in a conflict and offers real recovery actions", () => {
		const model = deriveDraftPanel(
			input({
				status: status({ state: "conflict", conflict: true, dirtyPaths: [] }),
				conflict: conflictState({ retryable: false }),
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

	test("counts exact conflict paths separately from records held in the whole draft", () => {
		const second = resource({
			stableResourceId: "deals:deal-2",
			label: "Druhý čekající deal",
		});
		const model = deriveDraftPanel(
			input({
				status: status({ state: "conflict", conflict: true, dirtyPaths: [] }),
				conflict: conflictState({
					message: "Jedna technická kolize čeká na bezpečné sloučení.",
					paths: ["data/deals/deal-1.yaml"],
					retryable: true,
				}),
				records: [
					{ resource: resource(), technicalPath: "data/deals/deal-1.yaml", revert: { supported: true } },
					{ resource: second, technicalPath: "data/deals/deal-2.yaml", revert: { supported: true } },
				],
			}),
			{ finishSend: true },
		);

		expect(model.count).toBe(1);
		expect(model.waitingRecordCount).toBe(2);
		expect(model.wholeDraftNote).toContain("1 další záznam čeká");
		// Retrying is finishing the send of the commit the conflict names.
		expect(model.pendingHead).toBe("abc123");
		expect(model.actions.map((action) => action.kind)).toEqual([
			"finish_send",
			"abort_conflict",
			"publish",
		]);
	});

	test("disables publish with the blocking reason attached", () => {
		const model = deriveDraftPanel(
			input({
				publishReadiness: {
					state: "blocked",
					canPublish: false,
					references: [
						{
							kind: "validation_error",
							blocking: true,
							message: "Historický pohyb nejde přepsat.",
						},
					],
				},
			}),
		);
		const publish = model.actions.find((action) => action.kind === "publish");
		expect(publish?.enabled).toBe(false);
		expect(publish?.disabledReason).toContain("Historický pohyb");
	});

	test("is calm when everything is published", () => {
		const model = deriveDraftPanel(
			input({ status: status({ state: "published", dirtyPaths: [] }), records: [] }),
		);
		expect(model.tone).toBe("published");
		expect(model.pill).toBe("Publikováno");
		expect(model.count).toBe(0);
		expect(model.actions).toEqual([]);
	});
});

describe("an unsent commit underneath a draft", () => {
	test("does not offer a discard the engine would refuse", () => {
		const model = deriveDraftPanel(input({ status: status({ ahead: 1 }) }));
		const discard = model.actions.find((action) => action.kind === "discard_draft");

		expect(model.tone).toBe("draft");
		expect(discard?.enabled).toBe(false);
		expect(discard?.disabledReason).toContain("dokončete odeslání");
		// Publishing everything is still the way forward.
		expect(model.actions.find((action) => action.kind === "publish")?.enabled).toBe(true);
	});

	test("an ordinary draft still offers it", () => {
		const model = deriveDraftPanel(input({ status: status({ ahead: 0 }) }));
		expect(
			model.actions.find((action) => action.kind === "discard_draft")?.enabled,
		).toBe(true);
	});
});

describe("the card straight from the engine status", () => {
	test("without review records it counts the draft's paths", () => {
		const model = deriveDraftPanel({
			status: status({ dirtyPaths: ["data/deals/a.yaml", "data/deals/b.yaml"] }),
		});
		expect(model.tone).toBe("draft");
		expect(model.count).toBe(2);
		expect(model.records).toEqual([]);
	});

	test("an unavailable checkout is a quiet, explained state", () => {
		const model = deriveDraftPanel({ status: null, unavailableReason: "Data se připravují." });
		expect(model.tone).toBe("unavailable");
		expect(model.visible).toBe(false);
		expect(model.headline).toBe("Data se připravují.");
		expect(model.actions).toEqual([]);
	});

	test("colleagues' newer work under a draft offers a pull, or says which records stand in the way", () => {
		const open = deriveDraftPanel(input({ status: status({ behind: 2 }) }));
		expect(open.actions.find((action) => action.kind === "pull")?.enabled).toBe(true);

		const blocked = deriveDraftPanel(
			input({
				status: status({ behind: 2 }),
				pullBlocked: {
					paths: ["data/deals/deal-1.yaml"],
					message: "Vraťte záznam, stáhněte a úpravu udělejte znovu.",
				},
			}),
		);
		const pull = blocked.actions.find((action) => action.kind === "pull");
		expect(pull?.enabled).toBe(false);
		expect(pull?.disabledReason).toContain("Vraťte záznam");
	});

	test("newer data with nothing drafted is a pull", () => {
		const model = deriveDraftPanel({
			status: status({ state: "pull_needed", behind: 1, dirtyPaths: [] }),
		});
		expect(model.tone).toBe("remote");
		expect(model.actions.map((action) => action.kind)).toEqual(["pull"]);
	});
});
