# Draft & Publish standard for repository-db-backed v3 apps

Every repository-db app has the same lifecycle: people edit through an app UI,
agents edit the same canonical YAML through the filesystem and Git, both produce
a **draft** in the mounted data checkout, and a person turns that draft into a
**published** commit. This document is the normative standard for how that
lifecycle is presented, reviewed, reverted and published.

It is deliberately small. Where something cannot be supported simply and safely,
the standard says so and the app does not offer it, rather than growing another
mechanism. [`draft-publish-card-contract.md`](draft-publish-card-contract.md) and
[`review-surface-contract.md`](review-surface-contract.md) remain the detailed
type references for the shapes used here.

## The product problem

A person must be able to answer four questions without opening Git:

1. **Is anything unpublished right now?**
2. **What exactly changed, in business language?** — `data/deals/deal-1002.yaml`
   is not an answer; "ANTANA Group — Stav: Interested → Price offer" is.
3. **Where did the change come from?** — the app, an agent, or not known.
4. **How do I take back something I did not want?**

## Six rules

These govern everything below. Where an older plan says otherwise, these win.

1. **One data checkout is one shared draft, and it publishes as a whole.** There
   is no selective publish and no per-author draft. The UI says this plainly, so
   nobody expects to send "just their part".
2. **A confirmation applies to the version that was shown.** The review carries
   the draft revision that describes its own records, and the panel hands it
   back when publishing or discarding. If the draft moved in between, the
   operation does not run and the panel offers a refreshed view. This is a
   revision check, not a review history and not an approval workflow.
3. **Reverting has a simple, predictable scope**: one record (one canonical file)
   or the whole draft. Nothing in between. Where that does not hold, the action
   is not offered and the reason is shown. Unrelated changes are never touched.
4. **Provenance is information only.** It never decides whether an operation is
   allowed or whether a discard is safe. When it is not reliably known, the UI
   says "neznámý" instead of guessing at an author.
5. **An unsent commit is not a draft.** After a commit succeeds and the push
   fails, the user finishes sending that commit; returning to HEAD is not
   "returning to the last published version" and is not offered as such. A
   blocked state still shows the changes and offers one clear next step.
6. **Mission Control is not migrated yet.** Deals proves the whole flow first;
   only then is the smallest unification path assessed, and only if it preserves
   Mission Control's existing guarantees. A consistent look is not a reason to
   rewrite a data model.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Draft** | All uncommitted changes in the mounted data checkout. One shared unit. |
| **Draft revision** | Identity of the draft as displayed; a confirmation is bound to it. |
| **Record** | One canonical data file, shown by its business label. |
| **Origin** | Where a change came from: `app`, `agent` or `unknown`. Information only. |
| **Publish** | The one explicit action turning the whole draft into a validated, audited commit and pushing it. The Principal's act. |
| **Discard** | Returning one record, or the whole draft, to the published state. |

**Paths in this document are relative to the data checkout**, which a module
mounts at `db/`. A path written here as `data/deals/deal-1002.yaml` is
`db/data/deals/deal-1002.yaml` from the module root. It is not the module's own
`data/` directory — in a module that still carries a v2 layer, `data/v2/` is
legacy v2 data and `db/` is the v3 repository-db mount.

## Architecture

```
app screens ──────────── inline "Rozpracováno" marks
shared card ──────────── one draft, its changes, publish / revert
host app API ─────────── /api/<app>/draft/{status,review,discard,publish}
repository-db engine ─── status · review() · discard() · publish() · CLI
```

- The engine owns Git truth, the review computation, discard and publish. No UI,
  no business schemas.
- The app supplies three things only: a review adapter (paths → business labels
  and routes), routing, and authorization of its endpoints.
- An app does not implement its own draft state priority, discard logic or
  publish path.

## The write contract — the same for the app and for an agent

Both writers work on the same shared draft and follow the same three steps:

1. **Write the canonical file** in the data checkout. No commit on save.
2. **Record the origin** of the write: the app calls `recordOrigin` after its API
   write; an agent runs `repository-db origin --kind agent --actor "…"`. A write
   that skips this step is not rejected — it simply shows as `unknown`.
3. **Do not publish on your own.** An agent publishes only on the Principal's
   explicit instruction in the current thread, and says in its handoff where the
   changes are: "změny jsou v draftu aplikace *X* — otevři kartu vpravo dole,
   zkontroluj je a publikuj, nebo mi řekni *Publikuj*".

Neither writer holds a private draft, and neither can publish a subset.

## Engine surface

### `review()`

Resolves dirty paths into resources: business label, app route, structural
before/after field summary, origin, and the draft revision. Resolution goes
through the app adapter; if no adapter matches, the change appears as a generic
document diff, and if the document cannot be parsed, as a technical file diff.
**A change is never hidden** — a dropped path is a path that reaches publish
unreviewed.

### `discard({ scope, expectedRevision })`

`scope` is `{ kind: "record", path }` or `{ kind: "draft" }`. The whole-draft
scope returns everything, including staged edits and renames. The record scope
returns exactly one canonical file and touches nothing else.

A record revert is **not offered** when:

| Situation | Why |
| --- | --- |
| generated data is also in the draft | reverting one record alone would leave it inconsistent |
| the record was renamed in the draft | reverting one side would leave the other behind |
| the path is generated output | it is rebuilt on publish; revert its source record |
| the path is not canonical data | not a record |
| a commit is waiting to be sent | HEAD is not the published state (rule 5) |
| the repository is in conflict | recovery finishes first; the draft stays visible |

`canRevertRecord()` answers this before the UI draws a button, so a user is never
offered an action that then refuses.

### `publish({ actor, source, expectedRevision })`

Unchanged in its guarantees (validate → materialize → rebase → one audited commit
→ push), plus the revision check. The whole draft goes out as one commit.

The revision is checked **twice**: when the lock is taken, and again immediately
before staging. The second check matters because integration happens in between
and involves the network — a write landing in that window would otherwise be
staged although nobody reviewed it. Only the content part is compared the second
time: integration moves the baseline by design, the reviewed content must not
have moved at all.

### Finishing a send

A publish that commits but fails to push leaves an unsent commit. Finishing that
send is its own operation, not a publish: `finishSendOnly` with the
`expectedHead` the review showed. It refuses when any draft change exists,
because otherwise a failed push becomes a way to publish unreviewed work with
one click.

### What the confirmation covers

| Writer | Held back during publish/discard | Caught by the revision check |
| --- | --- | --- |
| `Collection.put` / `remove` | yes — the shared write gate | yes |
| the CLI's own writes | yes — the same gate | yes |
| a host app that takes the gate | yes | yes |
| any other direct filesystem write | no | yes — publish refuses rather than including it |

The gate is the publish lock itself, not a second mechanism: a supported write
takes it briefly and waits if a publish or discard holds it. The engine does not
claim to hold back a process that writes the checkout without passing through
it; for those, the content check before staging is the guarantee — such a write
makes the publish stop, it never rides along.

### CLI parity

```bash
repository-db review  [--json]                      # prints the draft revision
repository-db discard (--record <path> | --draft) [--revision <draft-revision>]
repository-db origin  --path <p>... --kind app|agent --actor <actor>
repository-db publish --actor "…" --source "…" [--revision <draft-revision>]
repository-db publish --finish-send --head <sha> --actor "…" --source "…"
```

A revision supplied to the CLI is a confirmation of a specific draft and is
enforced; omitting it means "act on the draft as it stands right now".

## Host API convention

| Route | Purpose |
| --- | --- |
| `GET /api/<app>/draft/status` | card state, counts, draft revision |
| `GET /api/<app>/draft/review` | resources, field diffs, origins, revision |
| `POST /api/<app>/draft/discard` | `{ scope, expectedRevision }` |
| `POST /api/<app>/draft/publish` | `{ expectedRevision }` |
| `GET /api/<app>/draft/events` | SSE: draft changed, conflict, remote pulled |

A stale revision returns a conflict response carrying the current one, so the
panel can refresh and let the user decide again. Publish and pull stay explicit
and fail-closed; no browser-owned automatic loop exists.

## UI standard

A floating card in the bottom-right corner, on every main screen.

| State | Pill | Panel |
| --- | --- | --- |
| published | "Publikováno" | last publish info |
| draft | "Rozpracováno · N" | the changes, **Publikovat vše** and **Zahodit vše** |
| unsent commit | "Čeká na odeslání" | the changes, **Dokončit odeslání** only |
| newer data | "Novější data" | **Stáhnout** when safe |
| conflict | "Konflikt" | the changes stay visible, one clear next step |

The panel states that publishing sends the whole draft. Each row shows the origin
(`V aplikaci` / `Agent` / `Neznámý`), the change kind, the business label, the
changed fields, **Otevřít** and — where supported — **Vrátit**; where it is not
supported the row explains why instead. Technical paths live behind a details
disclosure. Inline marks in list and detail screens use the same resource ids.

## What the pilot supports

**Supported**

- one shared draft per data checkout, published as a whole;
- business-language review of changed records with before/after fields;
- jumping from a change to the record in the app;
- reverting one record (one canonical file) or the whole draft;
- confirmation bound to the displayed revision, for publish and discard;
- origin shown as app / agent / unknown;
- unsent commits and conflicts as distinct, clearly explained states.

**Not supported yet — deliberately**

- selective publish of part of a draft;
- per-author drafts or per-author attribution of individual changes;
- reverting a single field (an ordinary write of the baseline value instead);
- reverting a record spanning several files, or one involved in a rename;
- reverting a record while generated data is in the draft;
- reviewed-state persistence and approval workflows;
- Mission Control's changeset model — see rule 6.

## Relation to earlier plans

This standard supersedes the parts of the earlier plans that conflict with it.

- **DEV-6383 (review surface)** — the contract, the fallback ladder and the
  "never hide a change" rule are kept. Reviewed-state persistence, an adapter
  registry and shared panel primitives are out of the pilot.
- **DEV-6392 (Deals draft UX and revert)** — the revert ladder is narrowed to
  record and whole draft; no field revert primitive, no dependency handling. Its
  no-per-change-attribution decision stands: origin is a hint, not authorship.
- **DEV-6418 (draft publish card)** — the shared card and state priority are
  kept. Its expectation that Mission Control converges onto the shared model is
  deferred by rule 6.
