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

## Seven rules

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
7. **People working in the same app instance never overwrite each other
   silently.** Different records can be edited at the same time. A save of a
   record someone else saved in the meantime is refused; the person keeps what
   they typed and gets a clear choice. The saved shared draft is visible to the
   others before publish, and an update from the server never replaces a form
   someone is typing into. Publish still confirms the whole, specific draft.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Draft** | All uncommitted changes in the mounted data checkout. One shared unit. |
| **Draft revision** | Identity of the whole draft as displayed; a publish or discard is bound to it. |
| **Record** | One canonical data file, shown by its business label. |
| **Record revision** | Identity of one stored record; a save is bound to the version it was edited from. |
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

### The publish lifecycle — one owner

The engine owns the whole lifecycle; a host app does not orchestrate commits,
integration, resets or pushes of its own. Every step below runs inside the
shared gate.

| Operation | Takes | Does | Never |
| --- | --- | --- | --- |
| `publish` | the draft revision that was shown (required) | checks it, validates, materializes generated output, makes one audited commit, sends | publishes a draft other than the confirmed one |
| `finishSend` | the head of the commit shown as waiting (required) | checks it and that no new draft exists, sends | makes a commit, validates, materializes or repairs anything |
| `pull` | — | fast-forwards to colleagues' published work | merges into local work |

**Sending** fetches first. When a colleague published in the meantime, the local
commits are replayed onto their work in a **separate temporary worktree**; the
checkout moves to the result only if that succeeded, and with `reset --keep`,
which refuses rather than erases anything unexpected. The checkout is never left
mid-rebase. A replayed waiting commit keeps its content and message and gets a
new parent; finishing a send never adds a commit.

A **push that fails** after the commit leaves that commit waiting (rule 5). The
next step is `finishSend` with the head the review showed. `publish` with no new
draft refuses and points there.

**A conflict** while replaying — someone changed the same files — stops the
send, records the conflict with the files involved, and blocks further writes
and publishes. The checkout is untouched. **Abort** returns the commits that
could not be sent to the draft, unchanged on disk; the user reverts the
conflicting records, pulls, and redoes the edit on top. (Adjusting them in place
does not help: pull is fast-forward only, and the next send would conflict
again.) **Resolved** is for someone who
integrated by hand.

`pull` never creates a conflict: Git carries a draft across a fast-forward and
refuses when an incoming change touches a file the draft also changed. It also
refuses while a commit is waiting — finishing the send integrates instead.

### Record revisions — saves in a shared app instance

Several people can work in one running app on the same shared draft. Their
saves must not overwrite each other silently, and must not block each other
either. That is a per-record question, so it has its own revision, separate from
the draft revision:

- `recordRevision(file)` is a hash of the record file as stored, `null` when it
  does not exist;
- a client keeps the revision of the version it started editing from and sends
  it with every save; `Collection.put/remove` and `writeRecordDraft` (for layouts
  a collection does not describe) check it and write **under the shared gate**,
  so no supported write fits between the check and the write;
- a mismatch is refused with `record_changed` and the current revision. Nothing
  is written. `null` means "must not exist yet", so two people creating the same
  record cannot both win;
- the revision belongs to **one concrete edit**. After a successful save that
  edit continues from the returned revision — and only that edit: another
  editor, or the same record opened again later, sends the revision of the
  content it actually loaded. Nothing takes a newer revision on its own and
  re-sends an old whole record with it; overwriting is a decision the person
  makes on the version that is there;
- a record reopened while an unsaved edit of it is still pending resumes that
  edit, so there is one owner of that content: it is not lost, and it is not
  sent later on its own over a newer save.

Saving one record never depends on another record. The draft revision is not
used for saves: with it, a colleague's change to a different deal would refuse
your save for no reason.

### What the confirmation covers

The guarantee is **the shared gate**, and it holds for writers that pass through
it.

| Writer | Held back during publish / finish / pull / discard |
| --- | --- |
| `Collection.put` / `remove`, `writeRecordDraft` | yes — the shared gate |
| the CLI's own writes | yes — the same gate |
| any other direct filesystem write | **no** |

The gate is the publish lock itself, not a second mechanism. A supported write
takes it briefly and fails immediately if a publish, discard or integration
holds it, rather than waiting — a host runs publish on the same thread, so
waiting would stall the very operation the write is waiting for.

A lock is taken over only when its holder is provably gone. On the same machine
that means the holding process is no longer running; a running holder keeps the
gate however long it takes. A lock that carries this process's own pid is ours
if it records this process's start as the operating system reports it — the
same from every thread and module copy — and a crashed predecessor's otherwise,
as when a container restarts and hands out the same pid. Where the platform
gives no such reading (Windows), an own-pid lock is kept rather than guessed at.

Two limits remain, stated rather than hidden:

- a lock written by **another host** cannot be checked from here, so it is
  treated as abandoned after 15 minutes; two machines sharing one data checkout
  could overlap after a publish on the other machine has run that long;
- a lock left by a crashed process whose pid was later reused by a **different,
  unrelated** local process looks live and stays until removed by hand — the
  error names the lock file and says to remove it only once that process is
  known to be gone. An unreadable (empty or corrupt) lock is reclaimed after a
  few seconds, so it never becomes such a dead end.

The pilot runs each data checkout on a single machine, where the first does not
arise and the second needs an unlikely coincidence.

A process that writes the data checkout directly — a script, an editor, an
agent not using the CLI — is not held back and is responsible for not doing so
while a publish runs; such a write can end up in a publish nobody reviewed.
There is no second content check to catch it: a check-and-hope comparison would
promise more than it can keep. Generated output belongs to its materializer,
which runs inside publish.

### CLI parity

```bash
repository-db review  [--json]              # prints the draft revision and head
repository-db discard (--record <path> | --draft) [--revision <draft-revision>]
repository-db origin  --path <p>... --kind app|agent --actor <actor>
repository-db publish --revision <draft-revision> --actor "…" --source "…"
repository-db finish-send --head <sha>
repository-db sync --pull                   # fast-forward only
```

Publish requires the revision and finish-send the head; both are refused before
anything is fetched, locked or pushed when they are missing. For discard, an
omitted revision means "the draft as it stands right now".

## Host API convention

| Route | Purpose |
| --- | --- |
| `GET /api/<app>/draft/status` | card state, counts, draft revision |
| `GET /api/<app>/draft/review` | resources, field diffs, origins, revision |
| `POST /api/<app>/draft/discard` | `{ scope, expectedRevision }` |
| `POST /api/<app>/draft/publish` | `{ expectedRevision }`, or `{ finishSend: true, expectedHead }` to finish a send |
| record writes | carry the `baseRevision` of the version edited; a stale one is refused with the current revision |
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
- unsent commits and conflicts as distinct, clearly explained states;
- several people in one app instance: different records in parallel, a stale
  save of the same record refused without losing what was typed.

**Not supported yet — deliberately**

- selective publish of part of a draft;
- per-author drafts or per-author attribution of individual changes;
- reverting a single field (an ordinary write of the baseline value instead);
- reverting a record spanning several files, or one involved in a rename;
- reverting a record while generated data is in the draft;
- reviewed-state persistence and approval workflows;
- collaboration across machines or offline, automatic field merge, shared
  cursors or CRDTs — a stale save is refused and the person decides;
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
