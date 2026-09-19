# Changelog

## Unreleased

- Review hides nothing unsent: without an upstream it compares against the empty
  tree; committed-but-unsent changes keep their recorded origin; an undeclared
  generated file in an unsent commit blocks publish readiness. The draft
  revision covers a nested repository's checked-out commit. The panel lists
  every change a resource groups. **Breaking:** `readBaselineFile` needs the
  baseline (ref or config); it no longer defaults to HEAD. Finishing a send
  refuses a waiting commit that carries an undeclared generated file
  (`generated_policy`), as review reports it.

- **The engine owns the whole publish lifecycle.** `publish` confirms the draft
  revision, validates, materializes, commits and sends. Sending replays onto a
  moved remote in a temporary worktree — never in the checkout, which moves
  only by `reset --keep` after success — then pushes. A replay conflict is
  recorded with the files involved; `abortConflict` returns the unsent commits
  to the draft. The autostash machinery, the second pre-staging content check
  (`computeCanonicalContentHash`) and the legacy `.gitignore` repair are gone;
  the engine layer is simply never staged.
- **Breaking:** `publish` requires `expectedRevision`. A caller with nothing
  displayed passes `db.draftRevision()`. `finishSendOnly`/`expectedHead` are
  replaced by a separate `finishSend({ expectedHead })`, which never commits,
  validates, materializes or repairs. `publish` with no new draft but a waiting
  commit refuses with `send_pending` instead of pushing it. CLI: `publish`
  needs `--revision`; `finish-send --head <sha>` replaces
  `publish --finish-send`.
- **Breaking:** `pull` / `sync --pull` only fast-forwards. A draft may stay in
  place; when an incoming change touches a drafted file the pull is refused
  (`pull_blocked_by_draft`) and nothing moves. With a commit waiting it refuses
  with `send_pending`. `PullResult` and `PublishResult` report `remoteChanges`.
- **Record revisions.** `recordRevision(file)` (and `recordRevisionFromBytes`
  for a host that parses the same read), `Collection.revision(id)`, and a
  `baseRevision` option on `Collection.put/remove` and the new
  `writeRecordDraft` (for layouts a collection does not describe): the version
  check and the write run under the shared gate; a stale save fails with
  `RecordChangedError` (`record_changed`) carrying the current revision.
  `put` now returns the new revision.
- Consumers pinned to earlier commits (Warehouse, General, Lumbio apps) keep
  working until they bump; a bump needs the revision on `publish` and
  `finishSend` for push recovery. The low-level `abortConflict(mountRoot,
  branch)` helper refuses without the branch instead of clearing a conflict
  it could not undo; `RepositoryDb.abortConflict()` supplies it.

- Finishing a send skips the legacy-lock repair as well and refuses, rather
  than making a commit, if anything dirtied the tree after its first check.
  The card keys field rows by path, since labels repeat across nested fields.

- Finishing a send checks for draft changes first and runs neither validation
  nor materializers, so a materializer that is not byte-identical on every run
  can no longer make it refuse itself or add a commit.
- An own-pid lock written by an older engine version (no recorded process
  start) ages out after 15 minutes as before, so an upgrade after a crash does
  not shut the gate for good. Reclaiming removes a stale lock only if it is still
  the lock that was judged, so the slower of two acquirers cannot delete the
  faster one's fresh lock.

- A confirmed publish of a draft with a staged rename no longer refuses itself:
  the revision and the pre-staging check hash one path set that does not depend
  on how Git splits a rename, which an autostash apply changes.
- A lock carrying this process's own pid is told apart from a crashed
  predecessor's by the OS record of the process start (the same across threads
  and module copies), so a container restarting with the same pid is not
  blocked for good and a worker thread's live lock is never taken over. An
  unreadable lock is reclaimed after a short grace period. The standard lists
  the remaining pid-reuse and cross-host limits.
- Record revert availability treats declared artifacts outside `generated/` as
  generated output, and refuses the deleted side of a staged rename as
  "renamed" rather than "not part of the draft".

- A lock held by a running process on this machine is never taken over,
  however old it is; only a dead local holder or a lock from another host older
  than 15 minutes is reclaimed. Previously any lock past 15 minutes could be
  taken, which would open the write gate in the middle of a long publish. The
  standard names the remaining cross-host limit explicitly.

- Review lists both sides of a rename — staged or committed but unsent — so the
  deleted source record is shown before publish removes it.
- The pre-staging comparison also excludes declared generated artifacts that
  live outside the generated layout, so their materializer cannot make a
  confirmed publish refuse itself.

- Finishing a send requires the commit it finishes: `finishSendOnly` without a
  non-empty `expectedHead`, and `--finish-send` without `--head`, are refused
  before any fetch, lock or push. The card cannot offer the action until the
  review has supplied the pending commit.
- The lock now releases only its own acquisition (a random token), so a
  reclaimed lock's former holder can no longer remove its successor's lock and
  silently open the write gate.
- Collection writes re-check the conflict state under the gate.
- Revision hashing is length-framed and treats a dangling symlink as a link,
  not a deletion. Review never follows a symlink out of the data checkout into
  the payload. Rename detection no longer depends on `status.renames`; paths
  are read NUL-delimited; a path with a newline falls back to per-blob reads;
  layout paths ignore a trailing slash; the document root is the empty JSON
  Pointer.
- The card ignores out-of-order review responses, clears a stale review when a
  refresh fails, and never offers a per-record revert where the engine refuses
  discards as a whole.
- The standard now states the contract precisely: the shared gate is the
  guarantee for supported writers; the pre-staging comparison is best-effort
  for anything that writes the checkout directly.

- The pre-staging check now compares canonical draft content captured after
  publish's own repair steps, instead of the revision's content part: a declared
  materializer rewriting generated output was making a correctly confirmed
  publish refuse itself.
- The write gate fails immediately instead of waiting. A host runs publish on
  the same thread, so a synchronous wait would block the event loop that has to
  finish that publish and release the lock.

- The card no longer offers "Zahodit vše" while a commit is waiting to be sent:
  the engine refuses it there, because HEAD is not the published state.

- Close the confirmation gaps QA found. The draft revision is now two parts
  (`draft:<baseline>.<content>`) and covers the Git file mode; `publish()`
  re-checks the content part immediately before staging, so a write landing
  during integration stops the publish instead of riding along. An empty
  `expectedRevision` is treated as a malformed confirmation, not an absent one,
  and `review()` returns the revision describing its own resources.

- Add the shared write gate: `Collection.put`/`remove` take the publish lock
  briefly, so a supported write cannot land inside a publish or a discard. The
  engine does not claim to hold back writers outside the gate; for those the
  content check is the backstop.

- Finishing a send is its own operation: `finishSendOnly` with `expectedHead`
  pushes exactly the commit that was shown and refuses when any draft change
  exists, so a failed push cannot become a one-click unreviewed publish.

- Whole-draft discard removes untracked files by name from the confirmed set
  instead of running `git clean -fd`, so work created after the confirmation is
  never deleted.

- The CLI honours `--revision` on publish and prints the review's own revision.
  The shared card disables recovery actions the host has not wired instead of
  rendering buttons that silently do nothing.

- Read every record's published version with one `git cat-file --batch` process
  instead of one `git show` per record. A 150-record draft reviews in ~0.3 s
  instead of ~1.4 s, and the cost no longer grows with the number of changes.

- `ReviewInputChange` now carries the baseline content the engine already read,
  so an app adapter can diff against the published version without a second
  `git show` per record.

- Add `canRevertRecords()` and let `readBaselineFile()` take an already resolved
  baseline ref, so a review panel answers "can this be reverted" for a whole
  draft with one set of Git reads instead of six per record.

- The card's conflict state now carries the engine's own message and recovery
  handoff and offers the two real actions (abort, mark resolved) instead of one
  generic button the host had to implement itself.

- `review()` now reports everything that is not published yet, not only the
  dirty working tree: a publish that committed but never reached the server
  stays visible and reviewable instead of disappearing from the card. The
  baseline is the last commit shared with the published branch, so a colleague's
  newer published commits are never reported as our changes.

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
