# Operations and recovery

What to do when repository-db refuses something. Every refusal leaves the data
safe, and the message names the way out. This page gives the exact commands.

All commands run inside the data checkout (`--mount <path>` after the command
does the same from elsewhere). `repository-db` is the package's CLI; without it
installed, run `bun <engine checkout>/src/cli.ts` instead.

```bash
cd <module>/db
repository-db status --fetch        # state, ahead/behind, draft paths
repository-db review                # the draft as resources, its revision and head
repository-db conflict              # the active conflict, if any (exit code 1 when there is one)
```

Rules that hold throughout:

- **Never run Git by hand in a live data checkout.** No `rebase`, `reset`,
  `stash`, `pull` or `push`. The commands below are the way. The exceptions are
  named where they apply.
- When an app is running on the checkout, prefer the app's card. It performs
  the same operations through the sync host.
- A revision or head you pass must be the one `review` or `status` just printed.

## `identity_missing`

**Meaning:** the Environment has no Git name or e-mail, so nothing can be
committed. Nothing changed.

**Fix:** sign in to GitHub in the Launchpad, which sets the identity. By hand:

```bash
git config --global user.name  "<GitHub name or login>"
git config --global user.email "<id>+<login>@users.noreply.github.com"
```

Then publish again. On a team Environment, the identity is set by the
Environment, not by the person.

## `publish_conflict` — kind `merge`

**Meaning:** a colleague changed the same record, and the semantic merge could
not prove the combination safe. The checkout still holds your commit, nothing
was pushed, and writes are blocked.

```bash
repository-db conflict              # paths and unresolved fields
repository-db conflict --json       # also pendingHead, the commit waiting to be sent
```

Then take one of two ways out:

- **The colleague's side converges** (they agree and change the record):

  ```bash
  repository-db finish-send --head <pendingHead from `conflict --json`>
  ```

- **Redo your edit on top of theirs** (keeps every other record you drafted):

  ```bash
  repository-db conflict --abort                       # your commit becomes a draft again
  repository-db discard --record data/<path of the conflicting record>
  repository-db sync --pull                            # their version comes in
  # make the edit again (in the app), then:
  repository-db review                                 # note the revision
  repository-db publish --revision <revision> --source <app>
  ```

## `publish_conflict` — kind `validation`

**Meaning:** your work on top of the colleague's newer work fails a materializer
or validator of the data repo. Or such a command changed tracked files; it is
put back. The checkout is back on your commit, and nothing was pushed.

```bash
repository-db conflict              # message names the failing command
repository-db validate              # reproduce locally (builds derived output first)
```

The ways out:

- **The colleague fixes their record or the rule:**
  `repository-db finish-send --head <pendingHead>` (read it with
  `repository-db conflict --json`).
- **Your record has to change:** the same sequence as for a merge conflict, so
  every other drafted record is kept. Fixing the record before the pull would
  leave it drafted, and the pull refuses an overlap (`pull_blocked_by_draft`):

  ```bash
  repository-db conflict --abort                       # your commit becomes a draft again
  repository-db discard --record data/<path of the failing record>
  repository-db sync --pull                            # the colleague's work comes in
  # make the corrected edit again (in the app), then:
  repository-db review                                 # note the revision
  repository-db publish --revision <revision> --source <app>
  ```
- **A command changed tracked files:** fix the command in the data repo. It may
  write only to `generated_manifest` paths.

## `config_changed`

**Meaning:** `repository-db.yaml` in the checkout, or arriving from a colleague,
changes the boundary (`data_repo.remote`, `data_repo.branch`, `layout.data`) or
cannot be read by this engine version. Nothing was pushed or pulled. A send
returned to your commit.

**Fix:**

- **Intended change** (a new remote, a new data generation): update the app to
  the engine version and settings that match, and open the checkout again (a
  restart, or the sync host's next check). A commit waiting to be sent is then
  finished with `repository-db finish-send --head <head>`.
- **Unintended change:** the data repo's owner reverts it, through a normal data
  PR.
- **`unsupported schema_version`:** upgrade the engine.

## `pull_blocked_by_draft`

**Meaning:** colleagues changed records that your draft also changes. Nothing was
pulled; the error names the records.

```bash
repository-db discard --record data/<named record>   # for each named record
repository-db sync --pull
# redo the edits on top of the colleague's version, then publish
```

Or publish your draft first. If it collides with theirs, the publish meets
`publish_conflict` (above).

## `publish_push_failed` / state `committed_not_pushed`

**Meaning:** the commit was made, but the push failed: offline, credentials, or
the remote refused. The commit waits, and nothing is lost.

```bash
repository-db status --fetch                          # committed_not_pushed, ahead ≥ 1
repository-db review                                  # prints the head
repository-db finish-send --head <head>
```

`publish` refuses here with `send_pending`. A new draft on top makes
`finish-send` refuse with `new_draft_present`. In that case publish the new draft
(which sends both), or discard it and finish.

## `legacy_engine_state`

**Meaning:** an older repository-db left state this version does not interpret.
It is either a `publish.lock` without `token` / `processStart`, or a
`conflict.json` without `pendingHead`.

- **Lock:** make sure no publish runs on the named host and pid (`ps -p <pid>`),
  then `rm <module>/db/.repository-db/publish.lock`.
- **Conflict record:** clean the checkout by hand. This is the one place where
  Git by hand is expected.

  ```bash
  git -C <module>/db status
  git -C <module>/db log --oneline @{upstream}..HEAD   # local commits not published
  git -C <module>/db stash list                        # an older engine may have stashed the draft
  ```

  Keep what is not published: re-create it as a draft, or apply the stash. Then
  bring the checkout to a plain state on the data branch, with no rebase or merge
  in progress, and run:

  ```bash
  repository-db conflict --resolved
  ```

## `derived_output_tracked` / `engine_state_tracked`

**Meaning:** the data repo still tracks derived output (or does not ignore it),
or tracks `.repository-db/`. The checkout is refused at open. The error's
`migration` lists the exact commands, typically:

```bash
git rm -r --cached --quiet --ignore-unmatch -- <path>
printf '%s\n' '/<path>' >> .gitignore
git add .gitignore && git commit -m "Derived output is an ignored cache built by repository-db" && git push
```

Do this as the data-repo PR of [`migrating-a-module.md`](migrating-a-module.md),
not ad hoc on a live checkout.

## Smaller refusals

| Code | Way out |
| --- | --- |
| `draft_changed` | The draft moved since it was shown: `repository-db review` again, then confirm the new revision. |
| `record_changed` | Someone saved the record meanwhile: reload it, reapply the edit, save with the new revision. |
| `draft_write_blocked` / `publish_locked` | A publish, pull or discard holds the gate: retry in a moment. |
| `conflict_active` | Resolve the conflict first (`repository-db conflict`). |
| `materialize_failed` / `validation_failed` | Fix the data or the data-repo command, then `repository-db validate`. |
| `generated_side_effect` | A materializer or validator changed tracked files; fix it to write only declared paths. |
| `credentials` | Sign in (`gh auth login`), or configure the Environment's credential helper / deploy key. |
| `boundary_violation` | Run the command against the data checkout itself, on its branch, with the right `origin`. |
| `revert_not_supported` | Discard the whole draft instead (`repository-db discard --draft`), or change the record by an ordinary edit. |
| `unpushed_commit` | Finish the waiting send before discarding. |
| `mount_unavailable` | The checkout is not there yet; the sync host opens it when it appears. |
