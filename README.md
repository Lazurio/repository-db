# @lazurio/repository-db

Git-backed YAML repository database engine. A thick client gets a local,
serverless data layer: canonical YAML documents in a Git "data repo", typed
collection CRUD, an explicit draft → publish lifecycle, derived read models as
an ignored cache, a host sync service, and hard guards against operating in the
wrong Git repository. An app built on it never runs Git on its data.

The engine is domain-agnostic. Application schemas are injected by the host app
through a zod-compatible parser contract; the engine itself depends only on
`yaml`.

## Model

- **Data repo** — a standalone (typically private) Git repository holding
  `data/` (canonical YAML collections), `scripts/` (repo-local
  materializers/validators), `repository-db.yaml` (the config contract) and a
  `.gitignore` covering the engine layer and every derived path. It is mounted into an
  app-specific path (e.g. `modules/sample-app/db/`) and managed by this engine —
  not by workspace sync tooling.
- **Major data generation = Git branch** (`v3`, `v4`, …). A later generation
  starts as a clean orphan branch migrated from the previous generation's
  worktree; the repo's default branch tracks the current generation.
- **Draft** — an uncommitted change in the data repo working tree. Reads and
  writes are plain filesystem operations; nothing commits on keypress.
- **Derived output** — read models declared in `generated_manifest`, built by
  the data repo's materializers. An ignored cache: never tracked, rebuilt in
  the live checkout by `ensureGenerated()` whenever the tracked content
  changed, never part of a draft, conflict, review or discard. A data repo that
  still tracks a derived path is refused with the exact one-time migration.
- **Publish** — one explicit action turning the confirmed draft revision into a
  single audited commit:
  `identity → build derived output → validate (live checkout) → one commit
  with Repository-Db-* trailers → send`. Sending replays the commit onto a
  moved remote in a temporary worktree (Git only), moves the checkout to the
  result, builds and validates there, and only then pushes; a remote that moved
  again meanwhile is integrated anew a bounded number of times. A failed push
  leaves the commit waiting; `finishSend` sends exactly that commit and never
  makes a new one.
- **Pull** — fast-forward only, also under a draft of other records. A draft
  that changes a record a colleague also changed refuses the pull
  (`PullBlockedError` names the records): revert that record, pull, redo.
- **Conflict** — a send whose commits cannot be replayed onto the remote
  (`kind: "merge"`), an integrated result that fails validation
  (`kind: "validation"`), or a rebase/merge someone left in progress. For canonical stable YAML mapping data
  files with three regular Git index stages, the replay first attempts a
  deterministic three-way structural merge: independent map fields and
  unchanged-order objects keyed by `id` may combine; competing business leaves,
  unordered arrays, comments/aliases, noncanonical presentation, deletions and
  ordering changes stay hard conflicts. Only direct `record.updatedAt` and
  `record.updatedBy*` are audit metadata: when both timestamps are valid and
  every business leaf merged safely, the later timestamp selects that matching
  audit bundle. The engine records unresolved files/fields with a handoff and
  refuses further writes and publishes until `conflict --abort` (the commit
  returns to the draft), `finish-send --head <sha>` (retries the integration),
  or a conscious `conflict --resolved`. The checkout always stays on the local
  commit.
- **Record revision** — a save carries the revision of the record version it
  was edited from and is refused if someone saved that record meanwhile.

## Sync states

`status` derives: `conflict` > `draft` > `committed_not_pushed` >
`pull_needed` > `published`, plus raw flags (`ahead`, `behind`, `dirtyPaths`,
`head`). Remote changes are detected via `git fetch` — the sync host does it in
the background; no inbound webhook is required; webhooks are only a faster
signal where a host can accept them.

## Host sync service

`createSyncHost({ mountRoot, intervalMs?, autoPull? })` is the host side of
synchronisation, so no app rebuilds it. It is framework-agnostic; the app keeps
only its HTTP/SSE wiring.

- `run(kind, db => …)` — a serialized mutation queue per checkout (across every
  host in the process); every write, publish, pull and discard goes through it.
- `status()` / `refresh()` — the snapshot the card is derived from: engine
  status, conflict, draft revision, draft owner, a refused pull, a failed fetch.
- `subscribe(listener)` — `status`, `remote-pulled` (changed paths and
  Collection record refs), `conflict`, `error`.
- `start()` / `stop()` — a background check every `intervalMs` (default 30 s):
  fetch, then fast-forward whenever the engine allows it, also under a draft of
  other records.
- A checkout that does not exist yet, or vanished, is opened again on every
  check; a failed open is never cached.

## Draft & Publish standard

[`docs/draft-publish-standard.md`](docs/draft-publish-standard.md) is the
normative standard for every repository-db-backed v3 application: how a draft is
presented, reviewed in business language, reverted and published, and what an
agent must do around it. Read it first; the two contract documents below are its
detailed type references.

## Review Surface and the Draft & Publish card

- The Review Surface: `ReviewableResource`, `ResourceChange`,
  `ReviewSurfaceAdapter`, fallback levels, raw input changes, review snapshots
  and publish-readiness summaries. Host apps provide adapters that map technical
  data-repo changes to stable resource ids, readable labels, app route targets
  and structural field summaries. Data-repo paths remain technical metadata,
  never the primary label. See
  [`docs/review-surface-contract.md`](docs/review-surface-contract.md).
- The card: `deriveDraftPanel({ status, conflict, revision, records, … })` is the
  one view model of what an app says about its data checkout (Czech labels,
  state priority from the engine, actions only where the engine would accept
  them). It lives in the core package so a host without React says the same
  thing; `@lazurio/repository-db/ui` renders it as `DraftPublishPanel`.

## CLI

```bash
repository-db init --app sample --remote git@github.com:example/repository-data.git \
  --branch v1 --mount ../sample/db --schema-name sample-data --schema-version 1.0.0 \
  [--create-remote] [--visibility private]
repository-db status [--fetch] [--json]
repository-db validate        # builds derived output, then runs the validators
repository-db generate [--force]
repository-db sync [--pull]
repository-db publish --actor "Example User <user@example.com>" --source sample-app-v1 \
  [--summary "…"] [--entity record-123]...
repository-db finish-send --head <sha>   # also retries a recorded conflict
repository-db conflict [--abort | --resolved]
```

Every command verifies the Git boundary first: the mount path must be the
repository root, `origin` must match `data_repo.remote`, and the checkout must
be on `data_repo.branch`. Commands refuse to run from a parent code repository
— the data checkout is typically nested inside an app module repo.

## Commit contract

Publish commits carry deterministic, parser-validated Git trailers:
`Repository-Db-App`, `Repository-Db-Data-Repo`, `Repository-Db-Branch`,
`Repository-Db-Schema-Version`, `Repository-Db-Actor`, `Repository-Db-Machine`,
`Repository-Db-Source`, `Repository-Db-Change-Id` (+ optional
`Repository-Db-Entities`). The default subject is generated from the change
summary with no AI involvement; an AI-suggested human summary is strictly
opt-in, never required for publish, and never touches the trailers.

## Derived output and data-repo commands

Derived artifacts are declared in the `generated_manifest` of
`repository-db.yaml` and ignored by the data repo's `.gitignore` (`init` writes
`/generated/`). They are a cache:

- `ensureGenerated()` (also `db.ensureGenerated()`, `repository-db generate`)
  rebuilds them only when the tracked content — HEAD tree plus draft bytes —
  changed since the last build, recorded in `.repository-db/generated.stamp.json`.
  Readers call it before reading a derived path.
- A failing materializer throws `MaterializeFailedError` (`materialize_failed`)
  to the reader and blocks publish; it stages nothing and creates no draft.
- A data repo that still tracks a declared path is refused by `open()` with
  `TrackedDerivedOutputError` (`derived_output_tracked`), whose `migration`
  lists the exact one-time commands: `git rm -r --cached <path>`, the
  `.gitignore` line, an ordinary commit and push.

Materializers and validators are commands of the data repo. They run with
cwd = the data checkout (where its own dependencies are installed), read only
from it, and write only to declared paths; a command that changes a tracked
file refuses the publish (`generated_side_effect`). Keep them deterministic:
stable sort by canonical id, stable YAML/JSON serialization (LF, UTF-8), no
wall-clock timestamps, no host paths. Derived output is not a contract between
modules: another module reads `data/` or the owner's API.

## Credentials

The engine never stores tokens, SSH keys or webhook secrets in the code or
data repository. The local default mechanism is the GitHub CLI credential
store (`gh auth status` is verified before any mutation, off the event loop; a
successful answer is reused in-process for five minutes, a failure never). Non-interactive
environments (CI, hosted, client deployments) must provide an approved
provider — GitHub App installation, deploy key via ssh-agent, or a
preconfigured Git credential helper — otherwise publish fails in preflight,
before touching the working tree.

## Library usage

```ts
import { createSyncHost, deriveDraftPanel } from "@lazurio/repository-db";

const host = createSyncHost({ mountRoot: "/path/to/app/db" });
host.start(); // background fetch + fast-forward; recovers if the checkout appears later
host.subscribe((event) => {
  // forward to the browser (SSE): status, remote-pulled, conflict, error
});

// Every mutation goes through the queue.
await host.run("write", (db) => {
  const records = db.collection("records", { schemaVersion: "record.v1", parser: recordSchema });
  return records.put("record-123", record, {}, { baseRevision: null });
});

// The card.
const status = host.status();
const card = deriveDraftPanel({ status: status.sync, conflict: status.conflict, revision: status.revision ?? undefined });

// Publish confirms the draft as it was shown.
await host.run("publish", (db) =>
  db.publish({ actor: "Example User <user@example.com>", source: "sample-app-v1", expectedRevision }),
);
```

Without the host, the facade does the same operations directly:

```ts
import { RepositoryDb } from "@lazurio/repository-db";

const db = RepositoryDb.open("/path/to/app/db");
const records = db.collection("records", {
  schemaVersion: "record.v1",
  parser: recordSchema, // any zod-compatible { parse(value) } object
});

// A save names the stored version it was edited from (null = new record);
// a stale one is refused with RecordChangedError instead of overwriting.
const revision = records.put("record-123", record, {}, { baseRevision: null });
const status = await db.statusAsync({ fetch: true });

// Publish confirms the draft as it was shown: the revision from review().
const { draftRevision } = await db.review();
const result = await db.publish({
  actor: "Example User <user@example.com>",
  source: "sample-app-v1",
  expectedRevision: draftRevision as string,
});
// If the push failed or a conflict stopped it, the commit waits; finish it by its
// head, never re-publish.
// await db.finishSend({ expectedHead });
// Derived output is a cache; build it before reading it.
await db.ensureGenerated();
```

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
