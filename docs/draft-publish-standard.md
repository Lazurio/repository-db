# Draft & Publish standard for repository-db-backed v3 apps

Every repository-db app has the same operational lifecycle: humans edit through an
app UI, agents edit the same canonical YAML through the filesystem and Git, both
produce a **draft** in the mounted data checkout, and a person turns that draft
into a **published** audited commit. This document is the single normative
standard for how that lifecycle is presented, reviewed, reverted and published.

It supersedes the two earlier contract slices as the primary entry point:
[`draft-publish-card-contract.md`](draft-publish-card-contract.md) (the card
view-model) and [`review-surface-contract.md`](review-surface-contract.md) (the
resource/change types). Those documents remain the detailed type references; this
one states what an application must do.

## The product problem this solves

A normal user must be able to answer four questions without opening Git:

1. **Is anything unpublished right now?** — otherwise people forget to publish and
   their colleagues never see the work.
2. **What exactly changed, in business language?** — `data/deals/deal-1002.yaml`
   is not an answer; "Deal ANTANA Group — Status: Interested → Price offer" is.
3. **Who or what changed it — me, a colleague, or an agent working outside the
   app?** — reviewing your own typing and reviewing an agent's proposal are
   different activities.
4. **How do I undo something I did not want?** — an unwanted change must be
   revertible from the app, per record or as a whole draft.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Draft** | Uncommitted change in the mounted data checkout (working tree). The single shared unit of unpublished work. |
| **Resource** | The user-facing object a change belongs to (deal, quote, company, plan, item). Identified by a stable id, never by a path. |
| **Origin** | Best-effort provenance hint of a change: `app` (written through the app API by an identified person), `agent` (written by a task agent), `external` (any other filesystem/Git write). Advisory, never an authorization input. |
| **Publish** | The one explicit action turning the draft into a validated, audited commit and pushing it. Always the Principal's act. |
| **Discard** | Returning one resource, one path or the whole draft to the last published state. |

## Architecture: four layers

```
┌─ App screens ─────────────── inline "Rozpracováno" chips (useDraftResources)
├─ @lazurio/repository-db-ui ─ floating Draft & Publish card (React)
├─ Host app API ───────────── /api/<app>/draft/{status,review,discard,publish} + SSE
└─ @lazurio/repository-db ─── status · review() · discard() · publish() · CLI
```

Rules:

- The engine owns Git/filesystem truth, structural diffing, discard and publish.
  It never renders UI and never contains business schemas.
- The UI package owns the visual card and the inline chip hook. It is React
  because every v3 app is React; a non-React host may consume the view-model
  directly.
- The host app owns only three things: the **review adapter** (paths → resources,
  labels, routes, field labels), the **routing hook**, and **authorization** of
  mutating endpoints.
- An app must not implement its own draft state priority, its own discard logic
  or its own publish path.

## 1. Engine contract

### `status()` / `deriveDraftPublishCard()`

State priority, identical in every app:

`conflict` > `draft` (dirty working tree) > `pending` (host-level pending review)
> `pending` (committed, not pushed) > `remote` (newer data available) >
`published`.

### `review(options?): ReviewSurfaceSnapshot`

Turns the current dirty set into reviewable resources:

1. collect dirty/untracked/generated paths from `status()`;
2. resolve each path through the registered adapter (glob match) into a
   `ReviewableResource` with a stable id, human label and route target;
3. parse `HEAD` and working-tree versions of the document and emit
   `ReviewFieldSummary` rows (`beforeSummary` → `afterSummary`);
4. attach the origin hint;
5. on any failure step down the fallback ladder — `resource_adapter` →
   `generic_schema_diff` → `technical_file_diff` → `unknown`.

**A change is never hidden because no adapter matched it.** A missing adapter is
a degraded review state, not an invisible one.

### `discard(target)`

| Target | Behavior |
| --- | --- |
| a resource / path set | `git checkout HEAD -- <path>` for tracked files, delete for untracked ones |
| the whole draft | the same over the current dirty set — never `conflict --abort` |

- runs under the same lock as publish; refuses to run in `conflict` state;
- declared generated artifacts are discarded together with the source that
  produced them;
- when the target contains changes whose origin is not the requesting actor, the
  engine fails with `foreign_change_requires_confirm` and the host must re-issue
  the call with an explicit confirmation flag. This is a safety prompt, not an
  access control decision.

### Origin tracking

Origin lives in the gitignored `.repository-db/draft-origin.json`, written when a
change enters through a known path (app API, agent CLI) and reconciled with the
dirty set on read; an unknown path is `external`. It is cleared by publish and by
discard. It is a hint for humans: never a permission, never an audit record — the
audit record is the publish commit and its trailers.

The coarse draft owner marker (`.repository-db/draft-owner.json`, set on the first
write after a publish, cleared by publish) stays as the summary label for the
whole draft.

### CLI parity

Everything the card can do, an agent can do headlessly, and both see the same
truth:

```bash
repository-db review [--json]
repository-db discard --resource <id> | --path <p> | --all [--confirm-foreign]
repository-db publish --actor "…" --source "…"
```

## 2. Host API convention

Each app exposes these routes as a thin wrapper — authorization and identity
only, no state logic:

| Route | Purpose |
| --- | --- |
| `GET /api/<app>/draft/status` | card snapshot (view-model + counts + freshness) |
| `GET /api/<app>/draft/review` | review snapshot (resources, fields, origins) |
| `POST /api/<app>/draft/discard` | `{ resourceIds? , paths?, all?, confirmForeign? }` |
| `POST /api/<app>/draft/publish` | explicit publish, host credential policy |
| `GET /api/<app>/draft/events` | SSE: `draft-changed`, `conflict`, `remote-data-pulled` |

Publish and pull stay explicit and fail-closed. No browser-owned automatic
publish or pull loop exists in any app.

## 3. UI standard

The card is a **floating card in the bottom-right corner**, present on every main
screen of the app.

**Collapsed pill**

| Tone | Pill | Note |
| --- | --- | --- |
| published | quiet dot + "Publikováno" | persistent in business apps, silent-when-clean allowed for admin tooling |
| draft | "Rozpracováno · N · <age>" | age is the time since the oldest unpublished change |
| pending | "Dokončit odeslání" | commit exists, push missing |
| remote | "Novější data" | only actionable when `pullSafe` |
| conflict | "Konflikt" | blocking, red |

**Expanded panel**

- changes grouped by resource type, each row: origin icon, change kind (Nový /
  Upraveno / Smazáno / Generováno), human label, changed-field summary
  (`Status: Interested → Price offer`), **Otevřít** (app route) and **Vrátit**;
- footer: **Zahodit vše** (confirmation with an explicit list) and
  **Publikovat**;
- a "Technické detaily" disclosure holding data-repo paths and the raw diff, for
  agents, Git review and power users — never the primary label;
- conflict state replaces the list with the engine handoff text and the recovery
  actions.

**Inline in the app** — `useDraftResources()` exposes the same resource ids so
list rows and detail screens can carry a "Rozpracováno" chip. Draft highlighting
is always on for dirty resources; the card is a navigation and publish surface,
not the only place draft state is visible.

**Language** — the shared package ships Czech user copy with English machine
reasons. Hosts may override labels; they may not override state semantics.

## 4. Agent obligations

An agent working in a repository-db mount:

- writes canonical YAML as usual and **does not publish** without the
  Principal's explicit instruction in the current thread;
- identifies itself when writing through the CLI so the origin hint is `agent`;
- ends its handoff by naming where the review happens: "změny jsou v draftu
  aplikace *X* — otevři kartu vpravo dole, zkontroluj je a publikuj, nebo mi
  řekni *Publikuj*".

The module `AGENTS.md` of every repository-db-backed module carries that
sentence.

## Conformance checklist

A repository-db-backed v3 app conforms when:

1. it renders the shared card from `@lazurio/repository-db-ui` on every main
   screen;
2. it registers a review adapter for every canonical collection it writes;
3. all four card actions go through the host API into the engine — no second
   write path;
4. a change with no adapter still appears, as a technical file diff;
5. discarding a resource and the whole draft works from the UI, with confirmation
   for foreign-origin changes;
6. inline chips mark dirty resources in lists and detail screens;
7. no app-local draft state priority, discard implementation or publish path
   remains in the codebase.
