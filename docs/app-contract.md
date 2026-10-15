# The contract for an app built on repository-db

An app supplies a schema, a review adapter, its routes and their authorization.
The engine does everything else. This page lists what that means in code. The
model behind it is in [`architecture.md`](architecture.md); the user-facing
standard for the card is [`draft-publish-standard.md`](draft-publish-standard.md).

## Must

1. **One sync host per data checkout**, created at server start:
   `createSyncHost({ mountRoot, expect: { remote, branch } })`, then `start()`.
   `expect` names the data repository the app serves. A checkout whose
   configuration names another remote or branch is then refused with
   `boundary_violation`, and nothing is fetched or pulled into it. Do not wait
   for the checkout to exist: the host opens it when it appears.
2. **Every mutation through `host.run(kind, db => …)`.** That covers record
   writes, publish, finish-send, pull, discard, conflict abort/resolve and
   `recordOrigin`. The queue serializes them per checkout. `kind` is a free
   label for diagnostics (`"write"`, `"publish"`, `"pull"`, …).
3. **Every read through `host.read(db => …)`.** Before every read and mutation
   the host checks that the checkout is still the one it opened. A missing
   mount or configuration is `mount_unavailable`; a boundary change is
   `config_changed`. Either way your callback does not run on stale state.
   `host.db()` exists for synchronous code, but errors that facade meets later
   are not seen by the host.
4. **Call `db.ensureGenerated()` before reading a derived path** (anything
   declared in `generated_manifest`). It returns at once when the output is
   current.
5. **Write records with their base revision.** Use `Collection.put/remove`, or
   `writeRecordDraft` for layouts a Collection does not describe. A save carries
   the `baseRevision` of the version that was edited (`null` for a new record),
   and a stale save is refused with `record_changed`. Capture the revision
   **when the editor opens** the record (it comes with the read), never at save
   time. A revision read at save time always matches, so it would overwrite a
   colleague's change unseen.
6. **Confirm what was shown.** Publish passes the `revision` the review returned.
   Finish-send passes the `pendingHead` the card shows. Discard passes the
   revision too.
7. **Record provenance after a write:**
   `db.recordOrigin(paths, { kind: "app", actor })`. It is information only.
8. **Attribute records with a known identity.** When no verified sign-in names
   the author of a record (a local Environment without a hosted sign-in), use
   `await host.read((db) => db.identity())`. It returns `{ name, email }`, the
   identity this Environment commits with, resolved exactly like the publish
   preflight: configured or explicitly passed, never guessed. It returns `null`
   when there is none; record the author as unknown then, never a guess.
9. **Render the card from the engine.** Build it with
   `deriveDraftPanel({ status, conflict, revision, records, pullBlocked })` from
   `host.status()` plus the review, or use `DraftPublishPanel` from
   `@lazurio/repository-db/ui`. Wire only the actions you implement; the rest
   show as unavailable with a reason.
10. **Forward host events to the browser** (SSE or similar). On `remote-pulled`
   (colleagues' records came in), reload the records named in `records` (or
   `paths`), and do the same after a discard. Every mounted view (lists, details,
   derived summaries) reloads, not only the one that triggered it. The host
   emits `remote-pulled` itself whenever a pull, a publish or a finish-send
   brought colleagues' work in, whatever your `run()` callback returns. If your
   record files are nested, pass `recordOf` to `createSyncHost`.
11. **Surface the error codes below** in the user's language.

## Must not

- Run Git on the data checkout in any form: `git commit`, `push`, `pull`,
  `fetch`, `rebase`, `merge`, `reset`, `stash`, `add`. The engine does all of
  it.
- Keep its own write queue, remote monitor, poll loop or conflict state.
- Read another module's derived output, from Git or from its checkout. Read that
  module's `data/` through its owner API instead.
- Commit derived output, or keep static snapshots under a `generated_manifest`
  path. A static import snapshot is ordinary read-only data in its own directory,
  e.g. `imports/`.
- Write data files while a publish runs, other than through the engine (the gate
  only holds back engine-routed writers).
- Read draft or baseline files from the filesystem in a review adapter. The
  adapter gets `draftText` (exactly what Git would publish: a symlink is its
  target path, a path under a symlinked directory is undefined) and `baselineText`
  from the engine. Reading the file itself would follow a symlink and could put
  a host file into the review payload.
- Invent an actor or a Git identity, or read one with Git. Pass `actor` when the
  app knows the signed-in person; otherwise publish records the Environment's
  Git identity. For record-level attribution without a verified sign-in, use
  `db.identity()` (below).

## Data-repo commands

Materializers (`generated_manifest[].materializer`) and validators (`validate`)
are commands **of the data repo**:

- They run with cwd = the data checkout, using dependencies installed there.
- They read only from the data checkout and never reach outside it (no `../`, no
  app code, no network).
- Materializers write only to declared `generated_manifest` paths. Validators
  write nothing.
- They are deterministic: stable order, stable serialization, LF, no wall-clock
  timestamps, no host paths.
- They get no input on stdin.
- **Validators do not follow symbolic links.** `lstat` every directory component
  and every file they read, and refuse a link (directory or file). Otherwise a
  link could make them validate content from outside the data repo, or skip the
  content that is really there.
- **Validators select files exactly like the app's reader.** If the app reads
  `.yaml` and `.yml` (or matches case-insensitively), the validator checks the
  same set. A file the app reads but the validator skips is unvalidated data.
- **Nested collections get the same checks as flat ones.** Records below their
  collection directory (e.g. `data/<collection>/<group>/<id>.yaml`) are
  validated against the same schema as `data/<collection>/<id>.yaml`.

A command that changes a tracked file refuses the publish
(`generated_side_effect`), and its changes are put back.

## Error codes to surface

Every engine error is a `RepositoryDbError` with a `code`. Recovery for each is
in [`operations.md`](operations.md).

| Code | What the user should read |
| --- | --- |
| `record_changed` | Someone saved this record in the meantime. Reload it; your typing is kept in the editor. |
| `draft_changed` | The draft changed since you looked at it. Look again and confirm. |
| `draft_write_blocked` | A publish is running; try again in a moment. |
| `conflict_active` | Publishing is stopped by a conflict; the changes stay visible. |
| `publish_conflict` | A colleague's newer work could not be combined with yours safely (`merge`), or the combination failed the data rules (`validation`). The card shows the way out. |
| `pull_blocked_by_draft` | A colleague changed the same record you are editing. Revert it, pull, and redo the edit. |
| `publish_push_failed` | Saved, but the server was not reached. Finish sending. |
| `send_pending` | A publish is waiting to be sent; finish it first. |
| `identity_missing` | This Environment has no Git name and e-mail; sign in to GitHub in the Launchpad. |
| `credentials` | This Environment cannot reach the data repository; sign in. |
| `validation_failed` / `materialize_failed` | The data breaks a rule of the data repo. Nothing was published. |
| `generated_side_effect` | A data-repo command misbehaved. Nothing was published. This is for the module owner. |
| `config_changed` | The data repository's configuration changed. Update the app; nothing was lost. |
| `derived_output_tracked` / `engine_state_tracked` | The data repository needs its one-time migration. This is for the module owner. |
| `legacy_engine_state` | An older version left state behind. This is for the module owner. |
| `mount_unavailable` | The data is not available yet. This is a quiet state, not an alarm. |

## Minimal wiring (framework-agnostic)

```ts
import {
  RepositoryDbError,
  createSyncHost,
  deriveDraftPanel,
  type SyncHostEvent,
} from "@lazurio/repository-db";
import { reviewAdapter } from "./reviewAdapter.ts"; // the app's paths → labels/routes
import { recordSchema } from "./schema.ts";

const host = createSyncHost({ mountRoot: "/path/to/module/db" });
host.start();

// GET /draft/status — the card
export async function draftStatus() {
  const status = host.status();
  const review = status.available
    ? await host.read((db) => db.review({ adapters: [reviewAdapter] }))
    : null;
  return deriveDraftPanel({
    status: status.sync,
    conflict: status.conflict,
    revision: review?.draftRevision,
    pullBlocked: status.pullBlocked,
    unavailableReason: status.error?.message,
    // records: map review.resources with db.canRevertRecords(...) for per-row reverts
  });
}

// PUT /records/:id — a write
export function saveRecord(id: string, record: unknown, baseRevision: string | null, actor: string) {
  return host.run("write", (db) => {
    const records = db.collection("records", { schemaVersion: "record.v1", parser: recordSchema });
    const revision = records.put(id, record, {}, { baseRevision });
    db.recordOrigin([`${db.config.layout.data}/records/${encodeURIComponent(id)}.yaml`], {
      kind: "app",
      actor,
    });
    return revision;
  });
}

// POST /draft/publish
export function publish(body: { expectedRevision?: string; finishSend?: boolean; expectedHead?: string }, actor?: string) {
  return host.run("publish", (db) =>
    body.finishSend
      ? db.finishSend({ expectedHead: body.expectedHead ?? "" })
      : db.publish({ actor, source: "my-app-v3", expectedRevision: body.expectedRevision ?? "" }),
  );
}

// POST /draft/discard, /draft/pull, /draft/conflict
export const discard = (scope: { kind: "draft" } | { kind: "record"; path: string }, expectedRevision: string) =>
  host.run("discard", (db) => db.discard({ scope, expectedRevision }));
export const pull = () => host.run("pull", (db) => db.pull());
export const abortConflict = () => host.run("conflict", (db) => db.abortConflict());

// GET /draft/events — forward to the browser
export function events(send: (event: SyncHostEvent) => void): () => void {
  return host.subscribe(send);
}

// Errors: answer with the code; the UI words it.
export function errorBody(error: unknown) {
  return error instanceof RepositoryDbError
    ? { code: error.code, message: error.message }
    : { code: "unexpected", message: String(error) };
}
```

Authorization belongs in front of these functions. Who may publish, and which
records a person may change, is the app's decision; the engine records the
`actor` it is given.
