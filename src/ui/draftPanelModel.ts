import type {
	PublishReadinessSummary,
	ReviewChangeOriginKind,
	ReviewableResource,
} from "../types.ts";

/**
 * View model of the Draft & Publish panel.
 *
 * Pure data: no React, no fetch, no Git. The host app hands in what its
 * `/draft/review` endpoint returned and gets back exactly what the card should
 * say — which is also what makes the wording testable without a browser.
 *
 * The rules it encodes are the ones from the standard:
 * one shared draft that publishes as a whole; an unsent commit is finishing a
 * send, not a draft; a blocked state still shows the changes and offers one
 * next step; provenance is information only.
 */

export type DraftPanelTone = "published" | "draft" | "sending" | "remote" | "conflict";

export interface DraftPanelRecordInput {
	resource: ReviewableResource;
	technicalPath: string;
	revert: { supported: boolean; reason?: string };
}

export interface DraftPanelConflict {
	/** What happened, in the user's language. */
	message: string;
	/** Recovery handoff text for an agent or a developer. */
	handoff?: string;
}

export interface DraftPanelInput {
	revision: string;
	/** Commit waiting to be sent; finishing a send must name exactly this one. */
	pendingHead?: string;
	state: "conflict" | "draft" | "committed_not_pushed" | "pull_needed" | "published";
	branch?: string;
	ahead?: number;
	behind?: number;
	draftOwner?: { actor: string } | null;
	/** Present when the checkout is in a conflict the user has to resolve. */
	conflict?: DraftPanelConflict | null;
	publishReadiness?: PublishReadinessSummary;
	records: DraftPanelRecordInput[];
}

export interface DraftPanelFieldRow {
	label: string;
	before: string;
	after: string;
}

export interface DraftPanelRecord {
	id: string;
	/** Business label; never a path. */
	label: string;
	/** Human name of the record type, e.g. "Deal". */
	typeLabel: string;
	changeLabel: string;
	summary: string;
	originLabel: string;
	originKind: ReviewChangeOriginKind;
	href?: string;
	openLabel: string;
	fields: DraftPanelFieldRow[];
	technicalPath: string;
	revertSupported: boolean;
	revertBlockedReason?: string;
}

export interface DraftPanelAction {
	kind:
		| "publish"
		| "discard_draft"
		| "finish_send"
		| "pull"
		| "abort_conflict"
		| "mark_conflict_resolved";
	label: string;
	enabled: boolean;
	/** Why it is disabled; shown next to the action rather than hidden. */
	disabledReason?: string;
	/** True when the action needs an explicit confirmation step. */
	destructive?: boolean;
}

export interface DraftPanelModel {
	visible: boolean;
	/** Commit the "finish sending" action must carry. */
	pendingHead?: string;
	tone: DraftPanelTone;
	/** Collapsed pill text. */
	pill: string;
	/** Count shown next to the pill; 0 hides it. */
	count: number;
	/** One-line explanation at the top of the open panel. */
	headline: string;
	/** Says out loud that the whole draft goes out together. */
	wholeDraftNote?: string;
	ownerNote?: string;
	conflict?: DraftPanelConflict | null;
	records: DraftPanelRecord[];
	actions: DraftPanelAction[];
	revision: string;
}

const ORIGIN_LABELS: Record<ReviewChangeOriginKind, string> = {
	app: "V aplikaci",
	agent: "Agent",
	unknown: "Neznámý původ",
};

const CHANGE_LABELS: Record<string, string> = {
	created: "Nový",
	modified: "Upraveno",
	deleted: "Smazáno",
	generated: "Generováno",
	unknown: "Změna",
};

function recordOf(input: DraftPanelRecordInput): DraftPanelRecord {
	const change = input.resource.changes[0];
	const originKind = change?.origin?.kind ?? "unknown";
	const typeLabel =
		typeof input.resource.metadata?.typeLabel === "string"
			? input.resource.metadata.typeLabel
			: input.resource.resourceType;

	return {
		id: input.resource.stableResourceId,
		label: input.resource.label,
		typeLabel,
		changeLabel: CHANGE_LABELS[change?.kind ?? "unknown"] ?? "Změna",
		summary: change?.summary ?? "",
		originKind,
		originLabel: ORIGIN_LABELS[originKind],
		href: input.resource.routeTarget?.href,
		openLabel: input.resource.routeTarget?.label ?? "Otevřít",
		fields: (change?.fields ?? []).map((field) => ({
			label: field.label,
			before: field.beforeSummary ?? "—",
			after: field.afterSummary ?? "—",
		})),
		technicalPath: input.technicalPath,
		revertSupported: input.revert.supported,
		revertBlockedReason: input.revert.reason,
	};
}

/** Which optional recovery actions the host actually implements. */
export interface DraftPanelCapabilities {
	finishSend?: boolean;
	pull?: boolean;
	abortConflict?: boolean;
	markConflictResolved?: boolean;
}

const MISSING_ACTION_REASON = "Tuto akci aplikace zatím nepodporuje.";

/**
 * An action whose handler the host did not supply is shown as unavailable with
 * a reason, never as an enabled button that quietly does nothing.
 */
function applyCapabilities(
	actions: DraftPanelAction[],
	capabilities: DraftPanelCapabilities | undefined,
): DraftPanelAction[] {
	if (!capabilities) return actions;
	const supported: Record<string, boolean | undefined> = {
		finish_send: capabilities.finishSend,
		pull: capabilities.pull,
		abort_conflict: capabilities.abortConflict,
		mark_conflict_resolved: capabilities.markConflictResolved,
	};
	return actions.map((action) =>
		action.enabled && supported[action.kind] === false
			? { ...action, enabled: false, disabledReason: MISSING_ACTION_REASON }
			: action,
	);
}

export function deriveDraftPanel(
	input: DraftPanelInput,
	capabilities?: DraftPanelCapabilities,
): DraftPanelModel {
	const records = input.records.map(recordOf);
	const count = records.length;
	const base = {
		records,
		revision: input.revision,
		pendingHead: input.pendingHead,
		ownerNote: input.draftOwner?.actor
			? `Rozpracované změny začal: ${input.draftOwner.actor}`
			: undefined,
	};

	if (input.state === "conflict") {
		return {
			...base,
			visible: true,
			tone: "conflict",
			pill: "Konflikt",
			count,
			conflict: input.conflict ?? null,
			headline:
				input.conflict?.message ??
				"Data se rozešla se serverem. Změny zůstávají vidět, ale publikovat ani vracet teď nejde.",
			actions: applyCapabilities([
				{
					kind: "abort_conflict",
					label: "Zrušit a vrátit rozpracované změny",
					enabled: true,
					destructive: true,
				},
				{ kind: "mark_conflict_resolved", label: "Označit za vyřešené", enabled: true },
				{
					kind: "publish",
					label: "Publikovat vše",
					enabled: false,
					disabledReason: "Nejdřív je potřeba vyřešit konflikt.",
				},
			], capabilities),
		};
	}

	// An unsent commit is not a draft: the work is already committed, it just did
	// not reach the server. Offering "discard" here would claim to return to the
	// last published version, which is not what it would do.
	if (input.state === "committed_not_pushed") {
		return {
			...base,
			visible: true,
			tone: "sending",
			pill: "Čeká na odeslání",
			count,
			headline:
				count > 0
					? `Publikace ${count === 1 ? "jedné změny" : `${count} změn`} je uložená, ale nedorazila na server. Zbývá dokončit odeslání.`
					: "Publikace je uložená, ale nedorazila na server. Zbývá dokončit odeslání.",
			actions: applyCapabilities([
				{ kind: "finish_send", label: "Dokončit odeslání", enabled: true },
				{
					kind: "discard_draft",
					label: "Zahodit vše",
					enabled: false,
					disabledReason:
						"Publikace už je uložená. Nejdřív ji dokončete; vracet ji zpět není totéž co zahodit rozpracované změny.",
				},
			], capabilities),
		};
	}

	if (count > 0) {
		const readiness = input.publishReadiness;
		const blocking = readiness?.references.filter((reference) => reference.blocking) ?? [];
		return {
			...base,
			visible: true,
			tone: "draft",
			pill: "Rozpracováno",
			count,
			headline:
				count === 1
					? "Jedna rozpracovaná změna čeká na publikaci."
					: `${count} rozpracovaných změn čeká na publikaci.`,
			wholeDraftNote:
				"Publikuje se celý rozpracovaný obsah najednou — i změny, které přidal někdo jiný.",
			actions: applyCapabilities([
				{
					kind: "publish",
					label: "Publikovat vše",
					enabled: blocking.length === 0,
					disabledReason: blocking[0]?.message,
				},
				{ kind: "discard_draft", label: "Zahodit vše", enabled: true, destructive: true },
			], capabilities),
		};
	}

	if (input.state === "pull_needed") {
		return {
			...base,
			visible: true,
			tone: "remote",
			pill: "Novější data",
			count: 0,
			headline: "Kolega publikoval novější data.",
			actions: applyCapabilities([{ kind: "pull", label: "Stáhnout", enabled: true }], capabilities),
		};
	}

	return {
		...base,
		visible: true,
		tone: "published",
		pill: "Publikováno",
		count: 0,
		headline: "Všechno je publikované. Nic nečeká na odeslání.",
		actions: [],
	};
}
