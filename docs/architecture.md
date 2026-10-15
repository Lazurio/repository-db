# repository-db architecture

repository-db keeps an application's data in its own Git repository and
synchronises it between people and Environments. There is **one sync path**:
the engine owns every Git operation on the data and the derived output built
from it. An application never commits, pushes, rebases, merges or pulls its data
itself.

## Who owns what

| Owner | Owns |
| --- | --- |
| **Engine** (`@lazurio/repository-db`) | the boundary guard, collections and record writes, the draft, review, discard, publish, send, pull, conflicts, derived output, the shared gate, the sync host loop, the card view model |
| **Data repo** (`<app>-data`) | `repository-db.yaml`, canonical YAML under `data/`, its materializers and validators under `scripts/`, its `.gitignore` |
| **App** | the domain schema (a zod-compatible parser), the review adapter (paths → business labels and routes), its HTTP/SSE routes over the sync host, authorization of those routes |

Two consequences:

- A data rule (a uniqueness check, a derived summary) lives in the data repo, so
  every Environment and every app version runs the same one.
- An app's own Git code, write queue or remote monitor is a second sync path,
  and is a defect. [`app-contract.md`](app-contract.md) lists what an app does
  instead.

## Data repo layout

```
<app>-data/
  repository-db.yaml   # config contract: remote, branch, schema, layout, generated_manifest, validate
  data/                # canonical YAML records (the source of truth)
  scripts/             # materializers and validators; run with cwd = repo root
  generated/           # derived output: ignored by Git, rebuilt by the engine
  .gitignore           # /.repository-db/ and every derived path
  .repository-db/      # ignored engine state (below)
```

One major data generation is one Git branch (`v3`, `v4`, …); see
[`deployment-model.md`](deployment-model.md).

## Lifecycle

```
write ──► draft ──► publish ─────────────────────────────► send ──► push ──► published
 │         │         gate · revision · identity              │
 │         │         derived output + validate (live)        ├─ fetch
 │         │         commit the tracked draft                ├─ behind? replay in a lane (Git only:
 │         │                                                 │    text rebase + semantic YAML merge)
 │         │                                                 ├─ reset --keep onto the lane result
 │         │                                                 ├─ re-read repository-db.yaml (boundary)
 │         │                                                 ├─ derived output + validate (live)
 │         │                                                 ├─ push; remote moved again → integrate
 │         │                                                 │    again (up to 3 attempts)
 │         │                                                 └─ any failure → back to the local commit
 │         ├─► discard (one record, or the whole draft)
 │         └─► pull (fast-forward, also under a draft of other records)
 └─ Collection.put/remove · writeRecordDraft (record revision + shared gate)
```

- **Write.** A record write goes through the shared gate, is refused during a
  conflict, and — given the revision it was edited from — refuses a stale save
  with `record_changed`. Nothing commits on save.
- **Draft.** The uncommitted changes in the checkout; one shared draft per
  checkout, published as a whole. Its identity is the **draft revision**
  (`draft:<head>.<content hash>`). Every publish or discard confirms the revision
  that was shown.
- **Publish.** Inside the gate: confirm the revision, check the Git identity,
  re-read the configuration, build derived output and run the validators in
  the **live** checkout, then commit the tracked draft with `Repository-Db-*`
  trailers. A failing materializer or validator refuses the publish with
  nothing staged. A command that changes tracked files refuses it too
  (`generated_side_effect`), and what it changed is put back.
- **Send.** Fetch. If a colleague published meanwhile, the local commits are
  replayed in a disposable worktree that only does Git work. The live checkout
  moves to the result with `reset --keep` (which refuses rather than overwrites
  anything unexpected). There, with the data repo's own dependencies, the
  configuration is re-read, derived output is rebuilt and the validators run on
  the integrated result. Only then is it pushed. On any failure the checkout
  returns to the local commit, and nothing is pushed.
- **Finish send.** A commit that could not be pushed waits
  (`committed_not_pushed`). `finishSend(expectedHead)` sends exactly that commit
  and never makes a new one. The same call retries a send the engine stopped
  with a conflict.
- **Pull.** Fast-forward only. It runs under a draft of other records. It is
  refused (`pull_blocked_by_draft`, naming the records) only when a colleague
  changed a record the draft also changes. Nothing is ever merged into local
  work.
- **Discard.** Returns one canonical record, or the whole draft, to the published
  state, confirming the displayed revision.

## Conflicts and their exits

A conflict is recorded in `.repository-db/conflict.json`. While it exists, writes
and publishes are refused. The checkout always stays on the local commit.

| Kind | Cause | Exits |
| --- | --- | --- |
| `merge` | a colleague changed the same record and the semantic merge could not prove the combination safe | `finishSend(pendingHead)` once the colleague's side converged; or `conflict --abort` → the commit returns to the draft → revert that record, pull, redo the edit, publish |
| `validation` | the integrated result failed a materializer or validator, or a command changed tracked files | `finishSend(pendingHead)` after the colleague fixed their record or the rule; or abort as above |
| external | a rebase or merge someone started by hand, or conflict markers in the index | finish or abort it by hand, then `conflict --resolved` |
| `legacy` | a conflict an older engine recorded | clean the checkout by hand, then `conflict --resolved` |

`config_changed` is not recorded as a conflict: it means the checkout must be
opened again (see the configuration rules below).

Recovery steps per error code are in [`operations.md`](operations.md).

## State in `.repository-db/`

All ignored by Git, never published.

| File | Meaning |
| --- | --- |
| `publish.lock` | the shared gate (below) |
| `conflict.json` | the recorded conflict: kind, operation, paths, unresolved fields, `pendingHead`, `retryable`, handoff |
| `generated.stamp.json` | the content state the derived output was built from |
| `draft-origin.json` | per-path provenance hints (app / agent / unknown); information only |
| `draft-owner.json` | who started the draft; information only |

A checkout that tracks any of this (left by an older engine) is refused at open
with `engine_state_tracked`.

## The shared gate

`publish.lock` is the one gate that publish, finish-send, pull (its
fast-forward), discard and every engine-routed write pass through. It fails
fast instead of waiting, because a host runs publish on the same event loop that
would have to release the lock.

- A lock from this machine is taken over only when its holder is provably gone.
  The test is the process liveness plus its recorded OS start time.
- A lock from another host is treated as abandoned after 15 minutes.
- A lock without `token` and `processStart` was written by an older engine. It
  is refused with `legacy_engine_state`, never judged.

Writes that bypass the engine (a script writing files directly) are not held
back by the gate.

## The sync host

`createSyncHost({ mountRoot, intervalMs, autoPull, expect, recordOf })` is the
host side of synchronisation. It is framework-agnostic, one per checkout.

- **Live check.** Before every read and mutation and in the background check,
  the host checks that the checkout is still the one it opened. A missing mount
  or configuration is `mount_unavailable`; a boundary change is
  `config_changed`. It stays cheap: the configuration is re-read only when its
  file changed. With `expect: { remote, branch }`, a checkout of any other data
  repository is refused with `boundary_violation`, and nothing is fetched or
  pulled. Each refusal drops the facade, so the next call opens the checkout
  anew.

- **`run(kind, fn)`** — the serialized mutation queue, shared by every host of
  the same checkout in the process. Every write, publish, finish-send, pull and
  discard goes through it, so in-process work waits its turn instead of meeting
  the fail-fast gate.
- **`read(fn)`** — every other access, without the queue. A read that finds the
  checkout no longer what was opened drops the facade, so the next call opens it
  again.
- **`status()` / `refresh()`** — the snapshot the card is derived from: engine
  status, conflict, draft revision, draft owner, a refused pull, a failed fetch.
- **`subscribe(listener)`** — events:
  - `status`;
  - `remote-pulled` — paths, plus the records they are; the engine knows the
    Collection layout, and `recordOf` maps others. It is emitted whenever a
    pull, publish or finish-send brought colleagues' work in, whatever the
    callback returned. A mutation made through another facade is detected from
    the moved HEAD;
  - `conflict`;
  - `error`.
- **Background check** every `intervalMs` (default 30 s), in the queue: fetch,
  then fast-forward whenever the engine allows it — also under a draft of other
  records.
- **Recovery** — a checkout that does not exist yet, or vanished, is opened again
  on every check. A failed open is never cached.

## Derived output

`generated_manifest` declares derived output: read models built from the data
by materializer commands of the data repo. It is an **ignored cache**.

- Every declared path is untracked and covered by `.gitignore`. A checkout that
  tracks one, or does not ignore it, is refused at open with
  `derived_output_tracked`. The error carries the exact migration commands.
- `ensureGenerated()` builds it in the live checkout (cwd = mount, the data
  repo's dependencies). It rebuilds only when the **content state** — the HEAD
  tree plus the bytes of every draft path — differs from the state recorded in
  `generated.stamp.json`. Pulls, sends, discards, record writes and changes to
  `repository-db.yaml` or `scripts/` all change the content state, so nobody
  marks anything stale. The stamp is dropped before a build and written only
  after a full success. Builds are single-flight per checkout within a process.
- A failing materializer throws `materialize_failed` to the reader and refuses
  publish. It stages nothing and creates no draft.
- Derived files never take part in a draft, overlap check, conflict, review or
  discard, so two people changing different records cannot collide on them.
- Derived output is never pushed. It is not a contract between modules: another
  module reads `data/` or the owner's API.

## Configuration rules

`repository-db.yaml` is data too: a colleague can publish a change to it.

- The facade re-reads it whenever the file changed. A pull or send therefore
  brings a stricter validator or a new derived artifact into effect at once.
- Publish validates with the configuration in the checkout. A send validates the
  integrated result with the configuration that result holds.
- The **boundary** of a checkout is `data_repo.remote`, `data_repo.branch` and
  `layout.data`. A change of any of them, or a configuration this engine cannot
  read (including an unknown `schema_version`), fails closed with
  `config_changed`:
  - a send returns to the confirmed commit and pushes nothing;
  - a pull, and a send that finds its commit already published, are refused
    before anything moves;
  - the sync host opens the checkout again.

## Identity

A commit needs an author and a committer. Before anything is built, staged or
replayed, publish and finish-send ask Git for both (`git var
GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT`). Without them the operation refuses
with `identity_missing`, and nothing changes. The engine never invents an
identity; the Environment provides it (the Launchpad sets it when signing in to
GitHub). When a publish names no `actor`, the Git author (`Name <email>`) is
recorded as the actor in the trailers. `db.identity()` returns the same
identity read-only (`{ name, email }`, or `null` when there is none), so an app
can attribute records without running Git.

## Boundary guard

Every operation first checks four things:

- the mount is the root of its Git repository;
- `origin` matches `data_repo.remote` (the ssh and https spellings compare
  equal);
- the checkout is on `data_repo.branch`;
- every Git call runs as `git -C <mount>`.

An operation started from a parent code repository is refused.
