# @lazurio/repository-db

Git-backed YAML repository database engine. A thick client gets a local,
serverless data layer: canonical YAML documents in a Git "data repo", typed
collection CRUD, an explicit draft → publish lifecycle, deterministic
generated read models and hard guards against operating in the wrong Git
repository.

The engine is domain-agnostic. Application schemas are injected by the host app
through a zod-compatible parser contract; the engine itself depends only on
`yaml`.

## Model

- **Data repo** — a standalone (typically private) Git repository holding
  `data/` (canonical YAML collections), `generated/` (committed deterministic
  read models), `scripts/` (repo-local materializers/validators) and
  `repository-db.yaml` (the config contract). It is mounted into an
  app-specific path (e.g. `modules/sample-app/db/`) and managed by this engine —
  not by workspace sync tooling.
- **Major data generation = Git branch** (`v3`, `v4`, …). A later generation
  starts as a clean orphan branch migrated from the previous generation's
  worktree; the repo's default branch tracks the current generation.
- **Draft** — an uncommitted change in the data repo working tree. Reads and
  writes are plain filesystem operations; nothing commits on keypress.
- **Publish** — one explicit action turning the confirmed draft revision into a
  single audited commit:
  `validate → materialize generated → one commit with Repository-Db-* trailers
  → send`. Sending replays the commit onto a moved remote in a temporary
  worktree, never in the checkout, then pushes. A failed push leaves the commit
  waiting; `finishSend` sends exactly that commit and never makes a new one.
- **Conflict** — a send whose commits cannot be replayed onto the remote, or a
  rebase/merge someone left in progress. The engine records it with a handoff
  and refuses further writes and publishes until `conflict --abort` (the unsent
  commits return to the draft) or `conflict --resolved`.
- **Record revision** — a save carries the revision of the record version it
  was edited from and is refused if someone saved that record meanwhile.

## Sync states

`status` derives: `conflict` > `draft` > `committed_not_pushed` >
`pull_needed` > `published`, plus raw flags (`ahead`, `behind`, `dirtyPaths`).
Remote changes are detected via `git fetch` (`status --fetch`, `sync`) — no
inbound webhook is required; webhooks are only a faster signal where a host
can accept them.

## Draft & Publish standard

[`docs/draft-publish-standard.md`](docs/draft-publish-standard.md) is the
normative standard for every repository-db-backed v3 application: how a draft is
presented, reviewed in business language, reverted and published, and what an
agent must do around it. Read it first; the two contract documents below are its
detailed type references.

## Review Surface and Draft Publish Card contracts

Repository DB exposes app-agnostic TypeScript contracts for higher-level v3 UI
surfaces:

- a future Review Surface: `ReviewableResource`, `ResourceChange`,
  `ReviewSurfaceAdapter`, review state, fallback levels, raw input changes,
  top-level review snapshots and publish-readiness summaries. Host apps provide
  adapters that map technical data-repo changes to stable resource ids, readable
  labels, app route targets and structural field summaries. Data-repo paths remain
  available as technical metadata for Git review and agent handoff, but they are
  not the primary normal-user label;
- a framework-agnostic Draft Publish Card view-model:
  `deriveDraftPublishCard()` turns `SyncStatus` plus host freshness/pending
  review evidence into a stable card snapshot (`conflict` > `draft` > `pending`
  > `remote` > `published`) with semantic actions (`publish`, `pull`,
  `open_review`, `resolve_conflict`, `details`). Every repository-db-backed v3
  app should render this card globally instead of inventing a separate
  app-local draft/publish popup.

See [`docs/review-surface-contract.md`](docs/review-surface-contract.md) and
[`docs/draft-publish-card-contract.md`](docs/draft-publish-card-contract.md) for
the contract shapes, fallback ladder, adapter/schema versioning policy and v3 app
behavior requirements.

## CLI

```bash
repository-db init --app sample --remote git@github.com:example/repository-data.git \
  --branch v1 --mount ../sample/db --schema-name sample-data --schema-version 1.0.0 \
  [--create-remote] [--visibility private]
repository-db status [--fetch] [--json]
repository-db validate
repository-db sync
repository-db publish --actor "Example User <user@example.com>" --source sample-app-v1 \
  [--summary "…"] [--entity record-123]...
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

## Generated read models

Committed generated artifacts must be declared in the `generated_manifest`
of `repository-db.yaml`; publish refuses undeclared generated diffs.
Declared materializers must be byte-deterministic: stable sort by canonical
id, stable YAML/JSON serialization (LF, UTF-8), no wall-clock timestamps, no
host paths, no per-machine values. Per-machine caches belong to the ignored
`.repository-db/` directory.

## Credentials

The engine never stores tokens, SSH keys or webhook secrets in the code or
data repository. The local default mechanism is the GitHub CLI credential
store (`gh auth status` is verified before any mutation). Non-interactive
environments (CI, hosted, client deployments) must provide an approved
provider — GitHub App installation, deploy key via ssh-agent, or a
preconfigured Git credential helper — otherwise publish fails in preflight,
before touching the working tree.

## Library usage

```ts
import { RepositoryDb } from "@lazurio/repository-db";

const db = RepositoryDb.open("/path/to/app/db");
const records = db.collection("records", {
  schemaVersion: "record.v1",
  parser: recordSchema, // any zod-compatible { parse(value) } object
});

records.put("record-123", record);      // local draft (no commit)
const status = await db.statusAsync({ fetch: true });
const result = await db.publish({ actor: "Example User <user@example.com>", source: "sample-app-v1" });
```

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
