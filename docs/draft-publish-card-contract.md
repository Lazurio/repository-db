# Draft Publish Card contract

> This document is the detailed reference for the card view-model.
> The normative application-facing rules live in
> [`draft-publish-standard.md`](draft-publish-standard.md).

Repository DB owns the generic state model for repository-backed v3 applications:
local draft changes, committed-but-unpushed work, remote freshness, and conflicts.
Every v3 application should render that state through the same **Draft Publish
Card** contract instead of inventing an app-local status popup.

This contract is framework-agnostic. Repository DB exports a TypeScript view-model
builder; host apps decide whether the card is a React popover, a sidebar panel, a
bottom-right toast, a terminal indicator, or a native shell surface.

## Why this belongs in repository-db

A repository-db app always has the same operational lifecycle:

1. data lives in a mounted Git data checkout;
2. edits create a local draft or host-level pending review changeset;
3. publish turns approved/publishable work into a committed and pushed data repo
   change;
4. a clean checkout may still be behind remote data;
5. conflict/wrong-branch/divergence must fail closed before publish or pull.

Those rules are not Deals-specific or Mission-Control-specific. App code may add
domain labels and routes, but the top-level card semantics must be shared.

## Public API

```ts
import {
  deriveDraftPublishCard,
  DRAFT_PUBLISH_CARD_CONTRACT_VERSION,
  type DraftPublishCardSnapshot,
} from "@lazurio/repository-db";

const snapshot: DraftPublishCardSnapshot = deriveDraftPublishCard({
  status,               // repository-db SyncStatus
  expectedBranch: "v3", // from repository-db.yaml
  pendingReviewCount: pendingChangesets.length,
  publishableChangeCount: approvedChangesets.length,
  freshness: {
    newerAvailable: remoteBehind > 0,
    pullSafe: canFastForward,
    pullBlockedReason,
    staleFreshness,
  },
});
```

The returned snapshot is safe to serialize to an API response. It contains:

- `contractVersion` — currently `repository-db.draft-publish-card.v1`;
- `visible` and `tone` — whether to render and which state wins;
- `label` / `detail` — generic English fallback copy (host apps may localize);
- counts: `dirtyCount`, `pendingReviewCount`, `publishableChangeCount`,
  `ahead`, `behind`;
- `dirtyPathSamples` — capped technical samples for details/agent handoff;
- `primaryAction` and `actions` — semantic actions (`publish`, `pull`,
  `open_review`, `resolve_conflict`, `details`) with enabled/disabled reasons.

## State priority

The helper deliberately applies the same priority for every v3 app:

1. `conflict` — repository conflict, wrong branch, or local/remote divergence;
2. `draft` — dirty data checkout paths exist;
3. `pending` — host-level review/pending changesets exist;
4. `pending` — local commit exists but still needs push;
5. `remote` — newer remote data is visible;
6. `published` / hidden — clean and up to date with the last known remote state.

A clean/published state is hidden by default so the card does not create noise.
Pass `showPublished: true` only for hosts that intentionally want a persistent
"published" indicator.

## Host responsibilities

Repository DB does **not** render React, fetch remote freshness, approve
changesets, pull, or publish from this helper. A host v3 app must wire actions to
its own API layer:

- `publish` must call the app's approved publish path, which in turn calls
  repository-db publish/changeset semantics with scoped credentials.
- `open_review` must open the app's review/details page when a dirty draft is not
  directly publishable yet.
- `pull` must be enabled only when a host/coordinator has proven it is safe
  (`pullSafe: true`); otherwise render the `disabledReason`.
- `resolve_conflict` must lead to an explicit conflict handoff or recovery flow.
- Do not expose secrets, credential material, cookies, or absolute host paths in
  `freshness`, action metadata, or card details.

## Required v3-app behavior

Every repository-db-backed v3 application should expose a top-level card using
this contract:

- visible from every main page, not only from a hidden tools route;
- shows dirty draft count and review/publish count;
- can open a detail/review surface;
- can publish only through the same backend flow agents use;
- can pull newer data only through a fail-closed host/coordinator path;
- treats conflict/wrong branch/divergence as blocking states.

Concrete apps may customize visual placement. Deals v3 can keep its bottom-right
sync card shape; Mission Control v3 can keep its header popover shape. Both should
consume the shared view-model so the behavior and wording do not drift.
