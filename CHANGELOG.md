# Changelog

## Unreleased

- Add the shared Draft & Publish card under the `@lazurio/repository-db/ui`
  subpath: a pure view model (`deriveDraftPanel`) plus a React panel every v3
  app renders instead of its own. React is an optional peer dependency, so the
  engine itself stays framework-free for server and agent callers.

- Implement the two engine primitives the Draft & Publish standard requires.
  `review()` resolves the current draft into resources with business labels,
  app routes and structural before/after field summaries, degrading to a generic
  document diff and then to a technical file diff — a change is never hidden.
  `discard()` has exactly two scopes: one canonical record, or the whole draft.
  Anything in between is refused with a readable reason rather than guessed at,
  and unrelated changes are never touched.

- Add a draft revision (`computeDraftRevision`) so a confirmation always applies
  to the version the user was shown. `publish()` and `discard()` accept the
  displayed revision and refuse when the draft moved in the meantime.

- Refuse to discard while a committed-but-unpushed publish is waiting: returning
  to HEAD there would not be a return to the last published state.

- Add draft provenance as information only — `app`, `agent` or `unknown`, in a
  gitignored marker cleared by publish and discard. It never gates an operation
  and is never the audit record.

- Extend the CLI with `review`, `discard` and `origin` so an agent observes and
  acts on exactly the same draft state as the app UI.

- Add `docs/draft-publish-standard.md`, the normative Draft & Publish
  standard for every repository-db-backed v3 application: the shared
  floating card, business-language review of draft changes, per-resource
  origin hints, the discard ladder, the host API convention and agent
  obligations. The existing card and review-surface documents stay as its
  detailed type references.

- Move the public repository to `Lazurio/repository-db` and rename the package
  to `@lazurio/repository-db`; generated data-repo READMEs now point to the new
  canonical owner as well.

- `publish()` now repairs the legacy case where `.repository-db/publish.lock`
  was accidentally tracked: it stages a one-time index removal, ensures the
  engine layer is ignored, and never re-publishes the runtime PID/hostname lock.
  The publish fixture proves both the remote tree and local Git status are clean
  after the repair.

- Add the app-agnostic Draft Publish Card contract and
  `deriveDraftPublishCard()` helper so every repository-db-backed v3 app can
  render the same global draft/publish/pull/conflict card while keeping its own
  framework/UI shell.

- Add app-agnostic Review Surface contract types/docs/tests for
  `ReviewableResource`, `ResourceChange`, raw input changes, top-level review
  snapshots, field value/render metadata, adapter fallback levels, contract
  metadata, reviewed-state invalidation keys, JSON metadata boundaries and
  publish-readiness references (DEV-6383 task-2026-06-21-001).
- Network git ops (`clone`, `fetch`, `push`, bootstrap `push --set-upstream`)
  now run via an
  async runner (`runGitAsync` / `gitFetchAsync`) with an explicit
  `git_timeout` error instead of blocking the host event loop forever.
- Remote integration no longer shells out to `git pull` inside the publish lock:
  `pullRemote` fetches lock-free, then the locked section rebases against the
  already-fetched `origin/<branch>` ref.
  Local plumbing (status, rev-parse, add, commit, …) stays synchronous.
- `RepositoryDb.publish()` and `.pull()` are now async (return Promises);
  `initDataRepo()` is async because clone/bootstrap push are network-backed;
  `RepositoryDb.fetch()` is now `fetchAsync()`. Status splits into a local-only
  sync `status()` and an async `statusAsync({ fetch })` that may run a network
  fetch first. `deriveSyncStatus` no longer fetches; use `deriveSyncStatusAsync`.
- `pullRemote` runs its read-only fetch + ahead/behind probe lock-free and only
  takes the publish lock around the actual integration. A coordinator's
  background poll therefore never trips `PublishLockedError` against a running
  publish.
- `writeFileAtomic` temp files now carry a per-write random UUID
  (`atomicTempPath`), not just the pid, so two concurrent writes to the same
  path never share a temp file.
- The `repository-db` CLI runs its command pipeline asynchronously to await the
  network paths above.

## 0.2.0 — 20260610.2

- New public `pullRemote` / `RepositoryDb.pull()` / `repository-db sync
  --pull`: fetch + integrate remote changes via the same autostash-safe,
  conflict-guarded path the publish flow uses, under the publish lock.
  Designed for automatic background pulls from apps — local drafts survive
  via the autostash, conflicts record recovery state and block writes.

## 0.1.0 — 20260610

- Initial engine release for the DEV-6353 V3 data-engine pilot.
- `repository-db.yaml` config contract (`repository-db.config.v1`): app, data
  repo remote/branch, schema name/version, layout, generated manifest,
  validate commands.
- Git boundary guard: mount must be its own repo root with matching origin
  remote and generation branch; refuses to operate from a parent code repo.
- Typed collections over YAML documents (one file per document, stable
  serialization, atomic writes, zod-compatible parser injection).
- Sync status model: conflict / draft / committed_not_pushed / pull_needed /
  published, remote detection via `git fetch` without webhooks.
- Publish flow: validate → materialize generated → `git rebase --autostash`
  against the already-fetched `origin/<branch>` → single commit with
  parser-validated `Repository-Db-*` trailers → push; lock-file mutual
  exclusion; push-only recovery for committed_not_pushed.
- Conflict safety: detects mid-rebase stops and conflicted autostash applies
  (git exits 0 there), records a conflict state with an agent handoff, blocks
  writes until explicit `conflict --resolved` / `conflict --abort`; abort
  restores the pre-publish draft from the autostash.
- Generated read-model policy: publish refuses undeclared generated diffs;
  `.repository-db/` is the ignored per-machine cache/lock layer.
- Credential preflight: gh credential store as the local default, ssh-agent /
  git credential helper as non-interactive fallbacks, hard failure before any
  working-tree mutation; no tokens ever stored in the repo.
- CLI: `init` (create/attach + bootstrap data repo, set default branch),
  `status`, `validate`, `sync`, `publish`, `conflict`.
