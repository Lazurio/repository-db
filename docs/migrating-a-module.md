# Migrating a module onto repository-db 3.2

This guide converts a module whose app commits, pushes or pulls its data itself,
or runs an older repository-db, onto the one sync path. It is written for an
agent with no other context. Read [`architecture.md`](architecture.md) and
[`app-contract.md`](app-contract.md) first.

A conversion is **two pull requests, released in one window**:

- a **data-repo PR** (the one-time migration);
- an **app PR** (the app moves onto the sync host and pins the release).

Their order matters: 3.2 refuses a data repo that still tracks derived output,
and an app on an older version keeps committing derived output.

When several conversions run at once (one agent per module, often in different
Organizations), keep every scratch file — PR bodies, fixtures, test servers'
state — in a directory unique to the conversion, never a shared path such as
`/tmp/pr-body.md`. A shared path lets one conversion's text land in another
Organization's pull request. Stop local test servers by their exact process id.

## 0. Inventory

In the module and its data repo, write down:

- **Derived output.** Every `generated_manifest` entry in `repository-db.yaml`,
  and anything under `generated/` that is tracked. For each one, decide:
  - **derived** — rebuilt from `data/` by a materializer; it becomes an ignored
    cache;
  - **static snapshot** — imported once, never rebuilt. It moves out of
    `generated_manifest`, to e.g. `imports/`, as ordinary read-only data.
- **Readers of derived output.** Grep the app, other modules, dashboards and CI
  for the derived paths. A reader in the app calls `ensureGenerated()` first. A
  reader elsewhere must switch to `data/` or the owner's API, because derived
  output is no longer in Git.
- **Data-repo commands.** Every materializer and validator. They must run from
  the data checkout and never reach outside it. Watch for `../`, imports from the
  app, and dependencies that are only installed in the app. Move what they need
  into the data repo: the engine runs only the data repo's commands, on the live
  and on the integrated checkout, so a blocking data rule must stay
  self-contained there. Only a genuinely app-local, non-blocking UI hint may
  live in the app; a data rule moved into the app lets a concurrent send publish
  a combined result that breaks it.
- **The app's own sync code.** Every `git` call on the data checkout; an
  integration lane or worktree; a write queue; a remote monitor or poll loop; a
  conflict file of its own; its own card state. All of it is deleted in step 3.
- **The installed engine version** (`package.json` and `bun.lock`).

## 1. Preflight on every Environment

Run this on every Environment that has the data checkout mounted: people's
Environments, team ones, automated ones. Do it right before the window.

```bash
cd <module>/db                         # the data checkout
git status --short                     # clean, or only drafts under data/
git log --oneline @{upstream}..HEAD    # empty: nothing waits to be sent
ls .repository-db/                     # no conflict.json; publish.lock only while a publish runs
git status --short generated/          # no drafts under generated/
```

- **A draft that touches `generated/`.** The derived file becomes untracked. Get
  the data drafts published or discarded first, through the current app.
- **A commit waits to be sent.** Finish the send in the current app.
- **`conflict.json` exists.** Resolve or abort it in the current app. 3.2 does
  not interpret a record without `pendingHead` (see `legacy_engine_state` in
  [`operations.md`](operations.md)).
- **`publish.lock` exists while nothing runs.** Confirm that no process holds it
  (`ps`), then remove it. 3.2 refuses old-format locks.
- **`.repository-db/` is tracked** (`git ls-files .repository-db`). The data-repo
  PR removes it.

Record each Environment's result in the PR. An Environment that cannot be
checked is named there as a risk.

## 2. Data-repo PR (control plane)

On a branch of the data repo:

```bash
git rm -r --cached --quiet --ignore-unmatch -- <each derived path> .repository-db
printf '%s\n' '/.repository-db/' '/<each derived path>' >> .gitignore
```

- **Static snapshots.** `git mv generated/<snapshot> imports/<snapshot>`, and
  remove their entries from `generated_manifest`. Repoint their readers.
- **Commands.** Make every materializer and validator self-contained in the data
  repo (`scripts/`, the data repo's own `package.json` if it needs
  dependencies). Each one writes only to declared paths, and is deterministic.
- **`repository-db.yaml`.** Keep `schema_version: repository-db.config.v1`. Keep
  `generated_manifest` entries only for real derived output, each with its
  `materializer`.
- **Verify** with the 3.2 CLI in a scratch clone of the data-repo branch (not a
  live checkout):

  ```bash
  git clone --branch v3.2.0 https://github.com/Lazurio/repository-db.git /tmp/rdb-3.2
  (cd /tmp/rdb-3.2 && bun install --frozen-lockfile)
  RDB="bun /tmp/rdb-3.2/src/cli.ts"
  $RDB status   --mount <scratch clone>
  $RDB generate --mount <scratch clone> --force
  $RDB validate --mount <scratch clone>
  git -C <scratch clone> status --short   # stays clean: derived output is ignored
  ```

  `status` must not report `derived_output_tracked` or `engine_state_tracked`.
  `generate` must leave the tree clean.

Merging this PR is a data publication. Do it in the window (step 5), on the
module owner's instruction, and by the data repo's own rules.

## 3. App PR

On a branch of the app (module) repo:

1. **Pin the release.** In `package.json`:
   `"@lazurio/repository-db": "github:Lazurio/repository-db#v3.2.0"`. Then
   `bun install` so `bun.lock` records the same commit. Commit both.
2. **Delete the parallel sync path.** Delete the app's `git` calls on the data,
   its lane or worktree, its mutation queue, its remote monitor or poll timer,
   its own conflict state, and its own card state machine. Delete `skipValidate`,
   `skipMaterialize` and `retryConflictSend` usages.
3. **Wire the host** as in [`app-contract.md`](app-contract.md):
   - one `createSyncHost({ mountRoot, recordOf? })` at server start, then
     `start()`;
   - every mutation through `host.run`;
   - every read through `host.read`, with `ensureGenerated()` before reading
     derived output;
   - events forwarded to the browser;
   - the card from `deriveDraftPanel` or `DraftPublishPanel`.
4. **Adapt to the API changes** listed in `CHANGELOG.md` under 3.2.0:
   - `DraftPanelInput` takes `status`;
   - `finishSend` also retries a conflict;
   - `validate()` is async;
   - `reviewState`, `uiAnchor` and the generated kinds are gone. A blocking app
     rule is a `publishReadiness` reference of kind `validation_error`.
5. **Prove there is no own Git left:**
   `grep -rnE "\bgit\b.*(commit|push|pull|fetch|rebase|merge|reset|stash)|runGit|execFile\(.git"`
   over the app source finds nothing that touches the data checkout.

## 4. Tests on the real module

Write them in the module repo, against its real schema, adapter and data-repo
commands. Use two clones of a temporary bare origin (synthetic records only).
Write them before the code change, and see them fail on the old code.

1. **Disjoint records.** Two clones change different records. Both publish. The
   derived output in each equals a fresh build, and nothing derived is tracked.
2. **Pull under a draft.** A clone with a draft of record A pulls a colleague's
   change to record B. B arrives, A's draft is unchanged, and the derived output
   rebuilds on the next read.
3. **Same record.** A mergeable edit (different fields) publishes on both sides.
   A competing edit is a typed `publish_conflict`. Recover by aborting,
   reverting that record, pulling and redoing it, without losing the other
   drafted records.
4. **Broken data rule.** A record that fails a validator or materializer is
   refused, nothing is staged, and the draft revision is unchanged.
5. **Late checkout.** The app's host is started before the data checkout exists.
   It recovers on the first check after the checkout appears.

Add the module's own cases: its review adapter labels, its nested record
mapping (`recordOf`), and its derived readers.

## 5. Rollout window

1. Announce the window. Nobody edits during it.
2. Run the preflight (step 1) on every Environment.
3. Merge the data-repo PR (step 2).
4. Release the app PR (step 3) and roll it out to every Environment in the same
   window. A pull on an older app version would otherwise meet the migrated repo
   and keep committing derived output.
5. On each Environment: let the host pull, then confirm `git status` is clean
   and the derived output exists (`repository-db generate` reports up to date).

**If something fails mid-window:** do not revert the data-repo PR. Go forward:
fix the app or the data-repo command, and leave the unconverted Environments
untouched until they get the fixed release.

## 6. Acceptance in the browser

On two real Environments, in the browser:

- Two people publish different records at the same time. Both succeed.
- One Environment, holding a draft of another record, receives the other's
  publication within one check, and its draft stays.
- A collision on the same record shows the way out, and following it keeps all
  other work.
- The card says the right thing in every state: draft, waiting to be sent,
  newer data, conflict, published.
- Sign-in, and publishing under the person's identity.

Record what was verified, or what could not be, in the app PR's handoff.

## A typical conversion, in outline

The shape the first conversions took, without the module-specific details:

- **Before.** A deals-style module kept a summary of all records under
  `generated/` and committed it with every publish. Its app ran its own
  integration lane, a write queue and a remote monitor, and pulled only when
  nothing was drafted.
- **Data-repo PR.** The summary is untracked and `/generated/` is ignored. A
  one-time import snapshot moves to `imports/`. Any validator that reached into
  the app gets its rule into `scripts/`.
- **App PR.** The lane, the queue and the monitor are deleted, typically
  thousands of lines. `createSyncHost` is wired, with `recordOf` for record files
  nested below their collection directory. `v3.2.0` is pinned.
- **Tests.** The five scenarios above, run against the module's real adapter and
  validators.
- **Rollout.** Both PRs and the app release in one window.
