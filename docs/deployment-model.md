# repository-db: generation and deployment model

This document describes how applications use repository-db data repositories
across major data generations and deployments. The engine is generic — the
examples reference the Deals pilot (DEV-6353), but nothing here is
Deals-specific.

## Layer boundaries

Three layers with strict responsibilities:

1. **Engine** (`@lazurio/repository-db`, public): Git-backed YAML mechanics —
   config contract, boundary guard, collections CRUD, sync status, publish
   and conflict lifecycle, generated manifest policy, credential preflight. The
   engine must never contain business schemas, business data or secrets.
2. **Schema package** (per app, e.g. `@spectoda/deals-data-schema`): the
   versioned typed data-shape contract (Zod). It starts as a package-shaped
   module inside the app (`app/v3/packages/deals-data-schema`) for fast
   iteration; extracting and publishing it is a **mandatory gate before any
   client cutover or source-of-truth switch**, because the app, import
   scripts, agent CLIs and client deployments must share one versioned
   contract.
3. **App adapter** (per app): wires the engine and the schema into the app
   runtime — data-root resolution, identity (e.g. Cloudflare Access actor
   stamping), UI sync states, publish action.

## Data repo anatomy

```
<app>-data/                  # private Git repo, e.g. Spectoda/deals-data
  repository-db.yaml         # config contract (expected remote, branch, schema, manifest)
  data/                      # canonical YAML collections (source of truth)
  generated/                 # committed deterministic read models (declared in manifest)
  scripts/                   # repo-local materializers/validators (run with cwd = repo root)
  .repository-db/            # ignored engine layer: lock, conflict state, caches
```

## Major generation = Git branch

- The current data generation lives on a branch named after it (`v3`), which
  is also the repo's default branch. There is no active `main` data branch.
- A new major generation (`v4`) starts as a **clean orphan branch**: create it
  with `git checkout --orphan v4` (or `git switch --orphan v4`) in a separate
  worktree, run the `v3 -> v4` migration script against a `v3` worktree, and
  commit the migrated dataset as the first commit. An ordinary branch from
  `v3` would inherit the whole history and defeat the purpose.
- Apps pin both the branch and the schema version: `repository-db.yaml` in the
  data repo declares `data_repo.branch` and `schema.version`; the app refuses
  to run against an unexpected pair (boundary guard).

### Cutover between generations

1. Freeze new publishes on the old branch (announce + publish lock window).
2. Run the migration into the orphan branch from an old-generation worktree.
3. Run the parity gate (old vs new read models) and the new generation's
   validate suite.
4. Switch the repo default branch to the new generation and release the app
   version pinned to it.
5. Rollback = repoint the app to the old branch (it still exists, untouched).
6. Retention: keep the old branch at least until the new generation survives
   one full business cycle; deleting it is an explicit decision. Note that
   GitHub may not release storage immediately after branch deletion
   (reflogs/hosting retention) — branch-per-generation is an auditability
   model first, a storage optimization second.

## Client deployments

A client deployment separates the shared app from client-owned data:

- The app ships as code (npm/hosted build) and depends on the published
  engine + schema packages.
- The client's data lives in their own `<app-name>-data` repo. The init
  wizard creates or attaches it:

  ```bash
  repository-db init --app <name> --remote git@github.com:<org>/<name>-data.git \
    --branch v3 --mount <app-specific path> \
    --schema-name <name>-data --schema-version <semver> [--create-remote]
  ```

  On an empty repo it bootstraps the structure, pushes the generation branch
  and makes it the default branch. On an existing repo it verifies the
  branch/config and mounts it.
- Missing access to the private data repo must degrade as a recognizable
  state in the app, not a crash.

## Sync and publish

- Drafts are working-tree changes; nothing commits on keypress.
- Remote changes are detected via `git fetch` (`status --fetch`); an inbound
  webhook is only an optional faster signal for hosts that can accept one.
- Publish is one explicit action producing one audited commit per batch:
  `validate → materialize generated → commit with Repository-Db-* trailers →
  send`, all inside the shared lock. Sending integrates a moved remote in a
  temporary worktree, never in the checkout. A conflict there is recorded and
  blocks all writes until an explicit `conflict --resolved` / `conflict --abort`.

## Commit contract

Every publish commit carries deterministic, parser-validated trailers:
`Repository-Db-App`, `Repository-Db-Data-Repo`, `Repository-Db-Branch`,
`Repository-Db-Schema-Version`, `Repository-Db-Actor`,
`Repository-Db-Machine`, `Repository-Db-Source`, `Repository-Db-Change-Id`
(optional `Repository-Db-Entities`). The default subject is generated from
the validated change summary with no AI involvement.

An AI-suggested human summary is strictly **opt-in and default-OFF**: publish
must work offline/without a model, the suggestion may only replace the
subject line (never the trailers), and the default prompt may contain only
normalized change types, counts, field names and entity ids — raw diffs or
customer values may leave the machine only under a runtime policy that
explicitly allows it.

## Credentials

The engine never stores tokens, SSH keys or webhook secrets in the code or
data repo. Local default: the GitHub CLI credential store (`gh auth status`
verified before any working-tree mutation). Non-interactive environments
(CI, hosted workspace hosts, client servers) must use an approved provider —
GitHub App installation, deploy key via ssh-agent, or a preconfigured Git
credential helper. With none present, publish fails in preflight with an
explicit error before touching the working tree; this preflight is a hard
gate before any hosted/client cutover.
