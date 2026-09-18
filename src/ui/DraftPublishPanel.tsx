import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type DraftPanelInput,
	type DraftPanelModel,
	type DraftPanelRecord,
	deriveDraftPanel,
} from "./draftPanelModel.ts";

/**
 * The shared Draft & Publish card.
 *
 * Every repository-db-backed v3 app renders this same component, so the state
 * priority, the wording and the confirmation behaviour cannot drift between
 * apps. The app supplies only three things: how to load the review, and how to
 * publish and discard. Business labels and routes come from its review adapter,
 * which the engine has already applied by the time the data arrives here.
 *
 * Styling is class-name based (`rdb-draft-*`) so each app keeps its own look
 * without forking the behaviour.
 */

export interface DraftPublishPanelApi {
	/** GET the current review; must include the draft revision. */
	loadReview(): Promise<DraftPanelInput>;
	/** Publish the whole draft, confirming the displayed revision. */
	publish(expectedRevision: string): Promise<void>;
	/** Discard one record or the whole draft, confirming the displayed revision. */
	discard(
		scope: { kind: "draft" } | { kind: "record"; path: string },
		expectedRevision: string,
	): Promise<void>;
	/**
	 * Finish sending the commit that was shown. The head is passed through so
	 * the host can refuse if the pending commit is no longer that one.
	 */
	finishSend?(expectedHead: string | undefined): Promise<void>;
	/** Pull newer published data. */
	pull?(): Promise<void>;
	/** Abort the failed operation and restore the pre-publish state. */
	abortConflict?(): Promise<void>;
	/** Record that the conflict was resolved by hand. */
	markConflictResolved?(): Promise<void>;
}

export interface DraftPanelSessionRecovery {
	/** Message explaining what happened and what not to do meanwhile. */
	message: string;
	/** Where to sign in again; opened in a new tab so the draft page survives. */
	href: string;
	label: string;
}

export interface DraftPublishPanelProps {
	api: DraftPublishPanelApi;
	/**
	 * What to show when the host reports an expired session. Without it an
	 * expired session simply hides the card; with it the user gets the one clear
	 * next step a blocked state owes them.
	 */
	sessionRecovery?: DraftPanelSessionRecovery;
	/** Recognises a host error as "the session expired". */
	isSessionExpired?(error: unknown): boolean;
	/** Poll interval in ms; an app with live events can pass a large number. */
	pollIntervalMs?: number;
	/** Subscribe to app events that mean "the draft moved"; returns unsubscribe. */
	subscribe?(onChange: () => void): () => void;
	/** Follow a record route; defaults to setting window.location.hash. */
	onOpenRecord?(href: string): void;
}

const DEFAULT_POLL_MS = 30_000;

function RecordRow({
	record,
	busy,
	onOpen,
	onRevert,
}: {
	record: DraftPanelRecord;
	busy: boolean;
	onOpen(href: string): void;
	onRevert(record: DraftPanelRecord): void;
}) {
	const [showTechnical, setShowTechnical] = useState(false);
	return (
		<li className={`rdb-draft-record rdb-draft-origin-${record.originKind}`}>
			<div className="rdb-draft-record-head">
				<span className="rdb-draft-chip">{record.changeLabel}</span>
				<span className="rdb-draft-type">{record.typeLabel}</span>
				<strong className="rdb-draft-label">{record.label}</strong>
				<span className="rdb-draft-origin" title="Odkud změna přišla">
					{record.originLabel}
				</span>
			</div>
			<p className="rdb-draft-summary">{record.summary}</p>
			{record.fields.length > 0 && (
				<ul className="rdb-draft-fields">
					{record.fields.map((field) => (
						<li key={field.label}>
							<span className="rdb-draft-field-label">{field.label}</span>
							<span className="rdb-draft-before">{field.before}</span>
							<span className="rdb-draft-arrow" aria-hidden="true">
								→
							</span>
							<span className="rdb-draft-after">{field.after}</span>
						</li>
					))}
				</ul>
			)}
			<div className="rdb-draft-record-actions">
				{record.href && (
					<button type="button" onClick={() => onOpen(record.href as string)}>
						{record.openLabel}
					</button>
				)}
				{record.revertSupported ? (
					<button
						type="button"
						className="rdb-draft-revert"
						disabled={busy}
						onClick={() => onRevert(record)}
					>
						Vrátit změnu
					</button>
				) : (
					// Not a disabled button with a mystery: the reason is the text.
					<span className="rdb-draft-revert-blocked">{record.revertBlockedReason}</span>
				)}
				<button
					type="button"
					className="rdb-draft-technical-toggle"
					onClick={() => setShowTechnical((value) => !value)}
				>
					{showTechnical ? "Skrýt detail" : "Technický detail"}
				</button>
			</div>
			{showTechnical && <code className="rdb-draft-technical">{record.technicalPath}</code>}
		</li>
	);
}

export function DraftPublishPanel({
	api,
	sessionRecovery,
	isSessionExpired,
	pollIntervalMs = DEFAULT_POLL_MS,
	subscribe,
	onOpenRecord,
}: DraftPublishPanelProps) {
	const [input, setInput] = useState<DraftPanelInput | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ text: string; tone: "info" | "error" } | null>(null);
	const [available, setAvailable] = useState(true);
	const [sessionExpired, setSessionExpired] = useState(false);

	// Refreshes overlap (poll, draft events, after an action). Only the newest
	// request may update the card; a slower older answer would otherwise put a
	// superseded draft and its revision back on screen.
	const latestRequest = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latestRequest.current;
		try {
			const next = await api.loadReview();
			if (request !== latestRequest.current) return;
			setInput(next);
			setAvailable(true);
			setSessionExpired(false);
		} catch (error) {
			if (request !== latestRequest.current) return;
			// Whatever the reason, the last review is no longer trustworthy, so
			// its records and actions must not stay on screen.
			setInput(null);
			// An expired session is a blocked state the user can act on, so it is
			// shown. Anything else — typically no mounted data checkout — stays
			// silent rather than shouting an error at someone who cannot fix it.
			if (isSessionExpired?.(error)) {
				setSessionExpired(true);
				setAvailable(true);
				return;
			}
			setAvailable(false);
		}
	}, [api, isSessionExpired]);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), pollIntervalMs);
		const unsubscribe = subscribe?.(() => void refresh());
		return () => {
			clearInterval(timer);
			unsubscribe?.();
		};
	}, [refresh, pollIntervalMs, subscribe]);

	const model: DraftPanelModel | null = useMemo(
		() =>
			input
				? deriveDraftPanel(input, {
						// Actions the host did not wire are shown as unavailable
						// instead of as buttons that do nothing.
						finishSend: Boolean(api.finishSend),
						pull: Boolean(api.pull),
						abortConflict: Boolean(api.abortConflict),
						markConflictResolved: Boolean(api.markConflictResolved),
					})
				: null,
		[input, api],
	);

	const run = useCallback(
		async (action: () => Promise<void>, successText: string) => {
			setBusy(true);
			setMessage(null);
			try {
				await action();
				setMessage({ text: successText, tone: "info" });
			} catch (error) {
				const code = (error as { code?: string })?.code;
				setMessage({
					text:
						code === "draft_changed"
							? "Mezitím se rozpracované změny změnily. Nic jsme neprovedli — zkontrolujte je znovu."
							: error instanceof Error
								? error.message
								: String(error),
					tone: "error",
				});
			} finally {
				setBusy(false);
				await refresh();
			}
		},
		[refresh],
	);

	const openRecord = useCallback(
		(href: string) => {
			if (onOpenRecord) onOpenRecord(href);
			else if (typeof window !== "undefined") window.location.hash = href.replace(/^#/, "");
		},
		[onOpenRecord],
	);

	const revertRecord = useCallback(
		(record: DraftPanelRecord) => {
			if (!model) return;
			if (
				typeof window !== "undefined" &&
				!window.confirm(`Vrátit změnu záznamu "${record.label}" na publikovanou verzi?`)
			) {
				return;
			}
			void run(
				() =>
					api.discard({ kind: "record", path: record.technicalPath }, model.revision),
				`Změna záznamu "${record.label}" byla vrácena.`,
			);
		},
		[api, model, run],
	);

	const runAction = useCallback(
		(kind: string) => {
			if (!model) return;
			if (kind === "publish") {
				void run(() => api.publish(model.revision), "Publikováno.");
				return;
			}
			if (kind === "discard_draft") {
				if (
					typeof window !== "undefined" &&
					!window.confirm(
						`Zahodit všechny rozpracované změny (${model.count})? Vrátí se poslední publikovaná verze.`,
					)
				) {
					return;
				}
				void run(
					() => api.discard({ kind: "draft" }, model.revision),
					"Rozpracované změny byly zahozené.",
				);
				return;
			}
			if (kind === "finish_send" && api.finishSend) {
				void run(
					() => api.finishSend?.(model.pendingHead) ?? Promise.resolve(),
					"Odesláno.",
				);
				return;
			}
			if (kind === "pull" && api.pull) {
				void run(() => api.pull?.() ?? Promise.resolve(), "Staženo.");
				return;
			}
			if (kind === "abort_conflict" && api.abortConflict) {
				if (
					typeof window !== "undefined" &&
					!window.confirm(
						"Zrušit probíhající synchronizaci a vrátit rozpracované změny? Publikovaná data na serveru zůstanou beze změny.",
					)
				) {
					return;
				}
				void run(() => api.abortConflict?.() ?? Promise.resolve(), "Synchronizace zrušena.");
				return;
			}
			if (kind === "mark_conflict_resolved" && api.markConflictResolved) {
				void run(
					() => api.markConflictResolved?.() ?? Promise.resolve(),
					"Konflikt označen za vyřešený.",
				);
			}
		},
		[api, model, run],
	);

	if (sessionExpired && sessionRecovery) {
		return (
			<section className="rdb-draft-card rdb-draft-conflict" aria-label="Přihlášení vypršelo">
				<div className="rdb-draft-body rdb-draft-session">
					<p className="rdb-draft-headline">Přihlášení vypršelo</p>
					<p className="rdb-draft-note">{sessionRecovery.message}</p>
					<a
						className="rdb-draft-session-link"
						href={sessionRecovery.href}
						target="_blank"
						rel="noopener noreferrer"
					>
						{sessionRecovery.label}
					</a>
				</div>
			</section>
		);
	}

	if (!available || !model?.visible) return null;

	return (
		<section
			className={`rdb-draft-card rdb-draft-${model.tone}${open ? " rdb-draft-open" : ""}`}
			aria-label="Rozpracované změny a publikace"
		>
			<button
				type="button"
				className="rdb-draft-pill"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="rdb-draft-dot" aria-hidden="true" />
				<span>{model.pill}</span>
				{model.count > 0 && <span className="rdb-draft-count">{model.count}</span>}
			</button>

			{open && (
				<div className="rdb-draft-body">
					<p className="rdb-draft-headline">{model.headline}</p>
					{model.wholeDraftNote && (
						<p className="rdb-draft-note">{model.wholeDraftNote}</p>
					)}
					{model.ownerNote && <p className="rdb-draft-owner">{model.ownerNote}</p>}
					{model.conflict?.handoff && (
						<details className="rdb-draft-handoff">
							<summary>Podrobnosti pro vyřešení</summary>
							<pre>{model.conflict.handoff}</pre>
						</details>
					)}
					{message && (
						<p className={`rdb-draft-message rdb-draft-message-${message.tone}`} role="status">
							{message.text}
						</p>
					)}

					{model.records.length > 0 && (
						<ul className="rdb-draft-records">
							{model.records.map((record) => (
								<RecordRow
									key={record.id}
									record={record}
									busy={busy}
									onOpen={openRecord}
									onRevert={revertRecord}
								/>
							))}
						</ul>
					)}

					<div className="rdb-draft-actions">
						{model.actions.map((action) => (
							<span key={action.kind} className="rdb-draft-action">
								<button
									type="button"
									className={action.destructive ? "rdb-draft-destructive" : undefined}
									disabled={!action.enabled || busy}
									onClick={() => runAction(action.kind)}
								>
									{action.label}
								</button>
								{!action.enabled && action.disabledReason && (
									<small className="rdb-draft-disabled-reason">{action.disabledReason}</small>
								)}
							</span>
						))}
					</div>
				</div>
			)}
		</section>
	);
}
