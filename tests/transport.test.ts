import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkCredentials, clearCredentialCache } from "../src/credentials.ts";
import { gitFetchAsync } from "../src/git.ts";
import { initDataRepo } from "../src/init.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { type SyncHostEvent, createSyncHost } from "../src/syncHost.ts";
import { TRANSPORT_SCHEMA_VERSION, readTransportAnswer, transportArgs } from "../src/transport.ts";
import { type FixtureRepo, cloneFixture, createFixtureRepo, git, writeFixtureDocument } from "./fixtures.ts";

const ACTOR = "Anna <anna@example.com>";
const REAL_GIT = Bun.which("git") ?? "";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type Operation = "check" | "fetch" | "push";

interface TransportCall {
	op: string;
	cwd: string;
	mount: string;
	remote: string;
	branch: string;
	deadline: string;
	commit: string;
	expect: string;
	stdin: string;
	prompt: string;
}

interface FakeTransport {
	path: string;
	ctl: string;
	calls(): TransportCall[];
	ops(): string[];
	/** normal, refuse, unavailable, garbage, mismatch, two-lines, exit5, signal, hang; push also noref. */
	mode(operation: Operation, mode: string): void;
	/** A script the double runs before every push (a colleague publishing in between); null removes it. */
	beforePush(script: string | null): void;
}

/**
 * A test double of a host transport (repository-db.transport.v1). It reaches
 * the fixture's bare origin — the `--remote` path — with the real Git, by
 * absolute path, and records every call with its working directory, whether
 * its stdin was closed and the prompt setting it got.
 */
function createFakeTransport(root: string): FakeTransport {
	const dir = path.join(root, "transport");
	const ctl = path.join(dir, "ctl");
	mkdirSync(ctl, { recursive: true });
	const bin = path.join(dir, "host-transport");
	writeFileSync(
		bin,
		`#!/bin/sh
GIT=${quote(REAL_GIT)}
CTL=${quote(ctl)}
op="$1"
[ $# -gt 0 ] && shift
mount= remote= branch= deadline= commit= expect=
while [ $# -gt 0 ]; do
  case "$1" in
    --mount) mount="$2" ;;
    --remote) remote="$2" ;;
    --branch) branch="$2" ;;
    --deadline-ms) deadline="$2" ;;
    --commit) commit="$2" ;;
    --expect) expect="$2" ;;
    *) echo "unexpected argument $1" >&2; exit 2 ;;
  esac
  shift 2
done
stdin_bytes=$(wc -c | tr -d ' ')
printf '%s\\tcwd=%s\\tmount=%s\\tremote=%s\\tbranch=%s\\tdeadline=%s\\tcommit=%s\\texpect=%s\\tstdin=%s\\tprompt=%s\\n' \\
  "$op" "$(pwd -P)" "$mount" "$remote" "$branch" "$deadline" "$commit" "$expect" "$stdin_bytes" "\${GIT_TERMINAL_PROMPT-unset}" >> "$CTL/calls.log"
line() {
  if [ -n "$2" ]; then head="\\"$2\\""; else head=null; fi
  printf '{"schema_version":"${TRANSPORT_SCHEMA_VERSION}","operation":"%s","outcome":"%s","remote_head":%s,"detail":"%s"}\\n' "$op" "$1" "$head" "$3"
}
answer() { line "$2" "$3" "$4"; exit "$1"; }
mode=normal
[ -f "$CTL/$op.mode" ] && mode=$(cat "$CTL/$op.mode")
case "$mode" in
  refuse) answer 2 refused "" "not a data repository of a writer application on this host" ;;
  unavailable) echo "service socket missing" >&2; answer 3 unavailable "" "the host service is not reachable" ;;
  garbage) echo "this is not json"; exit 0 ;;
  mismatch) line refused "" "exit 0 with a refusal"; exit 0 ;;
  two-lines) line unavailable "" "one"; line unavailable "" "two"; exit 3 ;;
  exit5) line unavailable "" "an exit code outside the contract"; exit 5 ;;
  signal) kill -KILL $$ ;;
  hang) echo $$ > "$CTL/$op.pid"; exec sleep 30 ;;
esac
case "$op" in
  check)
    tip=$("$GIT" ls-remote "$remote" "refs/heads/$branch" | cut -f1)
    [ -n "$tip" ] || answer 2 refused "" "the branch does not exist"
    answer 0 ok "$tip" "" ;;
  fetch)
    "$GIT" -C "$mount" fetch --quiet --no-tags "$remote" "+refs/heads/$branch:refs/remotes/origin/$branch" 2>"$CTL/fetch.err" \\
      || answer 3 unavailable "" "the fetch failed"
    answer 0 fetched "$("$GIT" -C "$mount" rev-parse "refs/remotes/origin/$branch")" "" ;;
  push)
    [ "$("$GIT" -C "$mount" rev-parse HEAD)" = "$commit" ] || answer 2 refused "" "HEAD is not --commit"
    [ -f "$CTL/push.before" ] && sh "$CTL/push.before" >"$CTL/push.before.out" 2>&1
    tip=$("$GIT" ls-remote "$remote" "refs/heads/$branch" | cut -f1)
    [ -n "$tip" ] || answer 2 refused "" "the remote branch does not exist"
    if [ "$tip" = "$commit" ]; then
      "$GIT" -C "$mount" update-ref "refs/remotes/origin/$branch" "$commit"
      answer 0 up-to-date "$commit" ""
    fi
    [ "$expect" = "$tip" ] || answer 1 rejected-non-fast-forward "$tip" "the remote branch moved"
    "$GIT" -C "$mount" push --quiet "$remote" "$commit:refs/heads/$branch" 2>"$CTL/push.err" \\
      || answer 1 rejected-non-fast-forward "$tip" "not a fast-forward"
    [ "$mode" = noref ] || "$GIT" -C "$mount" update-ref "refs/remotes/origin/$branch" "$commit"
    answer 0 pushed "$commit" "" ;;
esac
answer 2 refused "" "unknown operation"
`,
		{ encoding: "utf8", mode: 0o755 },
	);
	const log = path.join(ctl, "calls.log");
	const calls = (): TransportCall[] =>
		(existsSync(log) ? readFileSync(log, "utf8") : "")
			.split("\n")
			.filter(Boolean)
			.map((entry) => {
				const [op = "", ...fields] = entry.split("\t");
				const call: Record<string, string> = { op };
				for (const field of fields) {
					const at = field.indexOf("=");
					call[field.slice(0, at)] = field.slice(at + 1);
				}
				return call as unknown as TransportCall;
			});
	return {
		path: bin,
		ctl,
		calls,
		ops: () => calls().map((call) => call.op),
		mode(operation, mode) {
			writeFileSync(path.join(ctl, `${operation}.mode`), mode, "utf8");
		},
		beforePush(script) {
			const hook = path.join(ctl, "push.before");
			if (script === null) rmSync(hook, { force: true });
			else writeFileSync(hook, script, "utf8");
		},
	};
}

/** A colleague's clone that publishes one new record each time the script runs. */
function colleagueScript(fixture: FixtureRepo, clone: string, counter: string): string {
	return [
		"set -e",
		`n=$(cat ${quote(counter)} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${quote(counter)}`,
		`cd ${quote(clone)}`,
		`${quote(REAL_GIT)} pull --quiet --ff-only origin ${fixture.branch}`,
		'printf "id: colleague-%s\\nrecord:\\n  name: Colleague %s\\nschemaVersion: thing.v3\\n" $n $n > data/things/colleague-$n.yaml',
		`${quote(REAL_GIT)} add --all`,
		`${quote(REAL_GIT)} commit --quiet --message "colleague $n"`,
		`${quote(REAL_GIT)} push --quiet origin ${fixture.branch}`,
		"",
	].join("\n");
}

/** A colleague publishes one record directly, with the real Git and the test's own environment. */
function colleaguePublishes(fixture: FixtureRepo, clone: string, id: string, env: NodeJS.ProcessEnv): string {
	const run = (args: string[]) => {
		const result = spawnSync(REAL_GIT, ["-C", clone, ...args], { encoding: "utf8", env });
		if (result.status !== 0) throw new Error(`colleague git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout;
	};
	run(["pull", "--quiet", "--ff-only", "origin", fixture.branch]);
	writeFixtureDocument(clone, id, { name: id });
	run(["add", "--all"]);
	run(["commit", "--quiet", "--message", `colleague: ${id}`]);
	run(["push", "--quiet", "origin", fixture.branch]);
	return run(["rev-parse", "HEAD"]).trim();
}

const rev = (cwd: string, ref: string) => git(cwd, ["rev-parse", ref]).trim();

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["REPOSITORY_DB_TRANSPORT", "PATH", "REPOSITORY_DB_GH_BIN"] as const;
let cleanup: string[] = [];

beforeEach(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	clearCredentialCache();
	cleanup = [];
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	clearCredentialCache();
	for (const entry of cleanup) rmSync(entry, { recursive: true, force: true });
});

/** A fixture data repository whose engine reaches it only through the fake transport. */
function setup(): { fixture: FixtureRepo; transport: FakeTransport; db: RepositoryDb; base: string } {
	const fixture = createFixtureRepo();
	cleanup.push(fixture.root);
	const transport = createFakeTransport(fixture.root);
	process.env.REPOSITORY_DB_TRANSPORT = transport.path;
	return { fixture, transport, db: RepositoryDb.open(fixture.mountPath), base: rev(fixture.mountPath, "HEAD") };
}

const publishDraft = (db: RepositoryDb) =>
	db.publish({ actor: ACTOR, source: "test", expectedRevision: db.draftRevision() });

describe("REPOSITORY_DB_TRANSPORT: fetch and push through the host's command", () => {
	test("a publish runs check, fetch and push through the transport with the contract's arguments", async () => {
		const { fixture, transport, db, base } = setup();
		writeFixtureDocument(fixture.mountPath, "first", { name: "First" });

		const result = await publishDraft(db);

		const head = rev(fixture.mountPath, "HEAD");
		expect(result.state).toBe("published");
		expect(result.commit).toBe(head);
		expect(rev(fixture.originPath, fixture.branch)).toBe(head);
		expect(db.status().state).toBe("published");
		expect(transport.ops()).toEqual(["check", "fetch", "push"]);
		const mount = realpathSync(fixture.mountPath);
		for (const call of transport.calls()) {
			// No shell, cwd = the checkout, stdin closed, never a prompt.
			expect(call).toMatchObject({
				cwd: mount,
				mount,
				remote: fixture.originPath,
				branch: fixture.branch,
				deadline: "58000",
				stdin: "0",
				prompt: "0",
			});
		}
		const [check, fetch, push] = transport.calls();
		expect([check?.commit, check?.expect, fetch?.commit, fetch?.expect]).toEqual(["", "", "", ""]);
		expect(push).toMatchObject({ commit: head, expect: base });
	});

	test("a push refused as not a fast-forward fetches through the transport and the next attempt sends on top of the colleague's work", async () => {
		const { fixture, transport, db, base } = setup();
		const clone = cloneFixture(fixture, "colleague");
		const hook = path.join(transport.ctl, "push.before");
		transport.beforePush(`${colleagueScript(fixture, clone, path.join(fixture.root, "count"))}rm -f -- ${quote(hook)}\n`);
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });

		const result = await publishDraft(db);

		expect(result.state).toBe("published");
		expect(result.remoteChanges).toEqual(["data/things/colleague-1.yaml"]);
		expect(transport.ops()).toEqual(["check", "fetch", "push", "fetch", "push"]);
		const colleague = rev(fixture.originPath, `${fixture.branch}^`);
		const pushes = transport.calls().filter((call) => call.op === "push");
		expect(pushes.map((call) => call.expect)).toEqual([base, colleague]);
		expect(rev(fixture.originPath, fixture.branch)).toBe(rev(fixture.mountPath, "HEAD"));
		expect(git(fixture.originPath, ["log", "--format=%s", "-2", fixture.branch]).split("\n")[1]).toBe("colleague 1");
		expect(db.status().state).toBe("published");
	});

	test("a remote that moves before every push stops the send after three attempts: publish_push_failed, the confirmed commit waits", async () => {
		const { fixture, transport, db, base } = setup();
		const clone = cloneFixture(fixture, "colleague");
		transport.beforePush(colleagueScript(fixture, clone, path.join(fixture.root, "count")));
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });

		const failure = await publishDraft(db).catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "publish_push_failed" });
		expect((failure as Error).message).toMatch(/committed_not_pushed/);
		expect(transport.ops()).toEqual(["check", "fetch", "push", "fetch", "push", "fetch", "push"]);
		// Back on the commit publish made, not on an integration attempt.
		expect(rev(fixture.mountPath, "HEAD^")).toBe(base);
		expect(db.status().state).toBe("committed_not_pushed");
		expect(db.conflict()).toBeUndefined();

		// The colleague stops; finishing the send integrates all three and sends.
		transport.beforePush(null);
		const finished = await db.finishSend({ expectedHead: rev(fixture.mountPath, "HEAD") });
		expect(finished.state).toBe("published");
		expect(finished.remoteChanges?.sort()).toEqual([
			"data/things/colleague-1.yaml",
			"data/things/colleague-2.yaml",
			"data/things/colleague-3.yaml",
		]);
		expect(rev(fixture.originPath, fixture.branch)).toBe(rev(fixture.mountPath, "HEAD"));
	});

	test("a refused push is transport_refused at once: no new attempt, the checkout back on the confirmed commit, the commit waits", async () => {
		const { fixture, transport, db, base } = setup();
		const clone = cloneFixture(fixture, "colleague");
		const colleague = colleaguePublishes(fixture, clone, "theirs", process.env);
		transport.mode("push", "refuse");
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });

		const failure = await publishDraft(db).catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "transport_refused" });
		expect((failure as Error).message).toMatch(/committed_not_pushed/);
		expect((failure as Error).message).toMatch(/not a data repository of a writer application on this host/);
		// One push, no fetch after it.
		expect(transport.ops()).toEqual(["check", "fetch", "push"]);
		// The send had integrated onto the colleague's commit; the checkout is back on the confirmed one.
		expect(rev(fixture.mountPath, "HEAD^")).toBe(base);
		expect(rev(fixture.originPath, fixture.branch)).toBe(colleague);
		expect(db.status().state).toBe("committed_not_pushed");
		expect(db.conflict()).toBeUndefined();

		transport.mode("push", "normal");
		const finished = await db.finishSend({ expectedHead: rev(fixture.mountPath, "HEAD") });
		expect(finished.state).toBe("published");
		expect(rev(fixture.mountPath, "HEAD^")).toBe(colleague);
		expect(rev(fixture.originPath, fixture.branch)).toBe(rev(fixture.mountPath, "HEAD"));
	});

	test("an unavailable push is publish_push_failed with committed_not_pushed and no new attempt; finishing the send later sends it", async () => {
		const { fixture, transport, db } = setup();
		transport.mode("push", "unavailable");
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });

		const failure = await publishDraft(db).catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "publish_push_failed" });
		const message = (failure as Error).message;
		expect(message).toMatch(/committed_not_pushed/);
		expect(message).toMatch(/the host service is not reachable/);
		expect(message).toMatch(/service socket missing/); // the transport's stderr
		expect(transport.ops()).toEqual(["check", "fetch", "push"]);
		expect(db.status().state).toBe("committed_not_pushed");

		transport.mode("push", "normal");
		const pending = rev(fixture.mountPath, "HEAD");
		const finished = await db.finishSend({ expectedHead: pending });
		expect(finished).toMatchObject({ state: "published", commit: pending });
		expect(rev(fixture.originPath, fixture.branch)).toBe(pending);
	});

	test("an unavailable fetch stops a publish with publish_push_failed after one retry; a refused fetch is transport_refused at once", async () => {
		const { fixture, transport, db } = setup();
		transport.mode("fetch", "unavailable");
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });

		const failure = await publishDraft(db).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "publish_push_failed" });
		expect((failure as Error).message).toMatch(/committed_not_pushed/);
		expect(transport.ops()).toEqual(["check", "fetch", "fetch"]);
		expect(db.status().state).toBe("committed_not_pushed");

		transport.mode("fetch", "refuse");
		const pending = rev(fixture.mountPath, "HEAD");
		const refused = await db.finishSend({ expectedHead: pending }).catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "transport_refused" });
		expect((refused as Error).message).toMatch(/committed_not_pushed/);
		// The successful check is still cached; the refused fetch is not retried.
		expect(transport.ops()).toEqual(["check", "fetch", "fetch", "fetch"]);
		expect(rev(fixture.mountPath, "HEAD")).toBe(pending);
	});

	test("the sync host reports an unavailable or refused fetch as fetchError and pulls once the transport works", async () => {
		const { fixture, transport } = setup();
		const clone = cloneFixture(fixture, "colleague");
		const host = createSyncHost({ mountRoot: fixture.mountPath, intervalMs: 0 });
		const events: SyncHostEvent[] = [];
		host.subscribe((event) => events.push(event));

		transport.mode("fetch", "unavailable");
		expect((await host.refresh()).fetchError?.code).toBe("transport_unavailable");
		expect(transport.calls().at(-1)).toMatchObject({ op: "fetch", deadline: "18000" });

		transport.mode("fetch", "refuse");
		expect((await host.refresh()).fetchError?.code).toBe("transport_refused");

		transport.mode("fetch", "normal");
		colleaguePublishes(fixture, clone, "theirs", process.env);
		const status = await host.refresh();
		expect(status.fetchError).toBeNull();
		expect(status.sync?.state).toBe("published");
		expect(existsSync(path.join(fixture.mountPath, "data/things/theirs.yaml"))).toBe(true);
		const pulled = events.find((event) => event.type === "remote-pulled");
		expect(pulled?.type === "remote-pulled" ? pulled.paths : []).toEqual(["data/things/theirs.yaml"]);
		// The background check never asks for credentials.
		expect(transport.ops()).not.toContain("check");
	});
});

describe("REPOSITORY_DB_TRANSPORT: answers the engine does not trust count as unavailable", () => {
	for (const mode of ["garbage", "mismatch", "two-lines", "exit5", "signal"]) {
		test(`fetch: ${mode}`, async () => {
			const { fixture, transport } = setup();
			transport.mode("fetch", mode);
			const failure = await gitFetchAsync(fixture.mountPath, { remote: fixture.originPath, branch: fixture.branch }).catch(
				(error: unknown) => error,
			);
			expect(failure).toMatchObject({ code: "transport_unavailable" });
		});
	}

	test("a push the transport calls done without moving refs/remotes/origin is not taken as published; finishing the send catches up", async () => {
		const { fixture, transport, db } = setup();
		transport.mode("push", "noref");
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });

		const failure = await publishDraft(db).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "publish_push_failed" });
		expect((failure as Error).message).toMatch(/refs\/remotes\/origin\/v3/);
		const pending = rev(fixture.mountPath, "HEAD");
		// The push did arrive.
		expect(rev(fixture.originPath, fixture.branch)).toBe(pending);

		transport.mode("push", "normal");
		expect((await db.finishSend({ expectedHead: pending })).state).toBe("nothing_to_publish");
		expect(db.status().state).toBe("published");
	});

	test("the deadline stops a hung transport and counts as unavailable", async () => {
		const { fixture, transport } = setup();
		transport.mode("fetch", "hang");
		const started = performance.now();
		const failure = await gitFetchAsync(
			fixture.mountPath,
			{ remote: fixture.originPath, branch: fixture.branch },
			400,
		).catch((error: unknown) => error);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(failure).toMatchObject({ code: "transport_unavailable" });
		expect((failure as Error).message).toMatch(/no answer within 400 ms/);
		// It was told the engine's limit minus the margin (at least 1 ms) and is terminated.
		expect(transport.calls().at(-1)?.deadline).toBe("1");
		const pid = Number(readFileSync(path.join(transport.ctl, "fetch.pid"), "utf8").trim());
		const alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (let wait = 0; alive() && wait < 40; wait += 1) await Bun.sleep(50);
		expect(alive()).toBe(false);
	});
});

describe("REPOSITORY_DB_TRANSPORT: the credential check", () => {
	test("is the transport's check (mechanism transport), cached like the Git check; a failure is credentials and is asked again", async () => {
		const { fixture, transport, db, base } = setup();
		const target = { mount: fixture.mountPath, branch: fixture.branch };

		expect(await checkCredentials(fixture.originPath, target)).toMatchObject({ ok: true, mechanism: "transport" });
		expect(await checkCredentials(fixture.originPath, target)).toMatchObject({ ok: true, mechanism: "transport" });
		expect(transport.ops()).toEqual(["check"]);

		clearCredentialCache();
		transport.mode("check", "refuse");
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });
		const failure = await publishDraft(db).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "credentials" });
		expect((failure as Error).message).toMatch(/transport check: refused/);
		expect((failure as Error).message).toMatch(/not a data repository of a writer application on this host/);
		// Nothing committed, fetched or pushed; the draft stays.
		expect(rev(fixture.mountPath, "HEAD")).toBe(base);
		expect(db.status().state).toBe("draft");
		await expect(publishDraft(db)).rejects.toMatchObject({ code: "credentials" });
		expect(transport.ops()).toEqual(["check", "check", "check"]);

		transport.mode("check", "normal");
		expect((await publishDraft(db)).state).toBe("published");
		expect(transport.ops()).toEqual(["check", "check", "check", "check", "fetch", "push"]);
	});

	test("a transport that is not an absolute path to an executable is transport_unavailable before anything, and Git is not used instead", async () => {
		const { fixture, transport, db, base } = setup();
		// A relative path is never resolved against the checkout.
		const planted = path.join(fixture.mountPath, "bin", "transport");
		const marker = path.join(fixture.root, "planted-ran");
		mkdirSync(path.dirname(planted), { recursive: true });
		writeFileSync(planted, `#!/bin/sh\ntouch ${quote(marker)}\nexit 0\n`, { mode: 0o755 });
		const notExecutable = path.join(fixture.root, "not-executable");
		writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });

		for (const value of ["bin/transport", "/nonexistent/host-transport", fixture.root, notExecutable]) {
			process.env.REPOSITORY_DB_TRANSPORT = value;
			clearCredentialCache();
			await expect(publishDraft(db)).rejects.toMatchObject({ code: "transport_unavailable" });
			await expect(
				gitFetchAsync(fixture.mountPath, { remote: fixture.originPath, branch: fixture.branch }),
			).rejects.toMatchObject({ code: "transport_unavailable" });
		}
		expect(existsSync(marker)).toBe(false);
		expect(rev(fixture.mountPath, "HEAD")).toBe(base);
		expect(rev(fixture.originPath, fixture.branch)).toBe(base);
		expect(transport.ops()).toEqual([]);
	});
});

describe("REPOSITORY_DB_TRANSPORT: init and the CLI", () => {
	test("init refuses with transport_unsupported and creates nothing", async () => {
		const { fixture, transport } = setup();
		const mountPath = path.join(fixture.root, "new-mount");
		await expect(
			initDataRepo({
				app: "fixture",
				remote: fixture.originPath,
				branch: fixture.branch,
				mountPath,
				schemaName: "fixture-data",
				schemaVersion: "1.0.0",
			}),
		).rejects.toMatchObject({ code: "transport_unsupported" });
		expect(existsSync(mountPath)).toBe(false);
		expect(transport.ops()).toEqual([]);
	});

	test("the CLI goes through the transport too, and its init refuses", () => {
		const { fixture, transport } = setup();
		const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
		const env = { ...process.env, REPOSITORY_DB_TRANSPORT: transport.path };

		const sync = spawnSync("bun", [cli, "sync", "--mount", fixture.mountPath, "--json"], { encoding: "utf8", env });
		expect(sync.status).toBe(0);
		expect(JSON.parse(sync.stdout)).toMatchObject({ state: "published", fetched: true });
		expect(transport.ops()).toEqual(["fetch"]);

		const init = spawnSync(
			"bun",
			[
				cli,
				"init",
				"--app",
				"fixture",
				"--remote",
				fixture.originPath,
				"--branch",
				fixture.branch,
				"--mount",
				path.join(fixture.root, "cli-mount"),
				"--schema-name",
				"fixture-data",
				"--schema-version",
				"1.0.0",
			],
			{ encoding: "utf8", env },
		);
		expect(init.status).toBe(2);
		expect(init.stderr).toMatch(/\[transport_unsupported\]/);
		expect(existsSync(path.join(fixture.root, "cli-mount"))).toBe(false);
	});
});

describe("REPOSITORY_DB_TRANSPORT: no network Git, no credential probe", () => {
	/**
	 * A `git` first in PATH that refuses and records every network operation
	 * (and `gh` / `ssh-add` that record any credential probe); everything else
	 * is the real Git.
	 */
	function installNetworkGuard(root: string): { network: () => string[]; probes: () => string[] } {
		const bin = path.join(root, "guard-bin");
		mkdirSync(bin, { recursive: true });
		const networkLog = path.join(root, "guard-network.log");
		const probeLog = path.join(root, "guard-probes.log");
		writeFileSync(
			path.join(bin, "git"),
			`#!/bin/sh
sub=
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace) skip=1 ;;
    -*) ;;
    *) sub="$arg"; break ;;
  esac
done
case "$sub" in
  fetch|pull|push|clone|ls-remote|fetch-pack|send-pack|archive|submodule|credential)
    printf '%s\\n' "$sub" >> ${quote(networkLog)}
    echo "network git refused by the test: $sub" >&2
    exit 97 ;;
  remote)
    case " $* " in
      *" get-url "*) ;;
      *) printf 'remote\\n' >> ${quote(networkLog)}; exit 97 ;;
    esac ;;
esac
exec ${quote(REAL_GIT)} "$@"
`,
			{ mode: 0o755 },
		);
		for (const probe of ["gh", "ssh-add"]) {
			writeFileSync(path.join(bin, probe), `#!/bin/sh\necho "${probe} $*" >> ${quote(probeLog)}\nexit 1\n`, {
				mode: 0o755,
			});
		}
		process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
		process.env.REPOSITORY_DB_GH_BIN = path.join(bin, "gh");
		const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
		return {
			network: () => lines(networkLog),
			probes: () => lines(probeLog),
		};
	}

	test("publish, finish-send, status --fetch, pull and the sync host's check never reach Git's network", async () => {
		const { fixture, transport } = setup();
		const clone = cloneFixture(fixture, "colleague");
		const outside = { ...process.env, PATH: saved.PATH };
		const guard = installNetworkGuard(fixture.root);

		// The guard works: without the transport, Git's own fetch is stopped.
		delete process.env.REPOSITORY_DB_TRANSPORT;
		await expect(RepositoryDb.open(fixture.mountPath).statusAsync({ fetch: true })).rejects.toMatchObject({
			code: "git_failed",
		});
		expect(guard.network()).toEqual(["fetch"]);
		rmSync(path.join(fixture.root, "guard-network.log"));

		process.env.REPOSITORY_DB_TRANSPORT = transport.path;
		const db = RepositoryDb.open(fixture.mountPath);
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });
		expect((await publishDraft(db)).state).toBe("published");

		colleaguePublishes(fixture, clone, "theirs", outside);
		expect((await db.statusAsync({ fetch: true })).behind).toBe(1);
		expect((await db.pull()).state).toBe("pulled");

		transport.mode("push", "unavailable");
		writeFixtureDocument(fixture.mountPath, "later", { name: "Later" });
		await expect(publishDraft(db)).rejects.toMatchObject({ code: "publish_push_failed" });
		transport.mode("push", "normal");
		expect((await db.finishSend({ expectedHead: rev(fixture.mountPath, "HEAD") })).state).toBe("published");

		colleaguePublishes(fixture, clone, "theirs-again", outside);
		const host = createSyncHost({ mountRoot: fixture.mountPath, intervalMs: 0 });
		const status = await host.refresh();
		expect(status.fetchError).toBeNull();
		expect(existsSync(path.join(fixture.mountPath, "data/things/theirs-again.yaml"))).toBe(true);

		expect(guard.network()).toEqual([]);
		expect(guard.probes()).toEqual([]);
		expect(new Set(transport.ops())).toEqual(new Set(["check", "fetch", "push"]));
		expect(rev(fixture.mountPath, "HEAD")).toBe(rev(fixture.originPath, fixture.branch));
	});

	test("an empty REPOSITORY_DB_TRANSPORT is the same as unset: Git and its own preflight", async () => {
		const fixture = createFixtureRepo();
		cleanup.push(fixture.root);
		process.env.REPOSITORY_DB_TRANSPORT = "";
		const db = RepositoryDb.open(fixture.mountPath);
		expect(
			await checkCredentials(fixture.originPath, { mount: fixture.mountPath, branch: fixture.branch }),
		).toMatchObject({ ok: true, mechanism: "local-remote" });
		writeFixtureDocument(fixture.mountPath, "mine", { name: "Mine" });
		expect((await publishDraft(db)).state).toBe("published");
		expect(rev(fixture.originPath, fixture.branch)).toBe(rev(fixture.mountPath, "HEAD"));
	});
});

describe("the transport answer", () => {
	const sha = "a".repeat(40);
	const answer = (operation: Operation, outcome: string, extra: Record<string, unknown> = {}) =>
		`${JSON.stringify({
			schema_version: TRANSPORT_SCHEMA_VERSION,
			operation,
			outcome,
			remote_head: sha,
			detail: "",
			...extra,
		})}\n`;
	const read = (operation: Operation, status: number, stdout: string, stderr = "") =>
		readTransportAnswer(operation, { kind: "exited", status, stdout, stderr });

	test("the exit code decides, with an outcome that goes with it", () => {
		expect(read("check", 0, answer("check", "ok"))).toMatchObject({ code: 0, outcome: "ok", remoteHead: sha });
		expect(read("fetch", 0, answer("fetch", "fetched")).code).toBe(0);
		expect(read("fetch", 0, answer("fetch", "up-to-date")).code).toBe(0);
		expect(read("push", 0, answer("push", "pushed")).code).toBe(0);
		expect(read("push", 0, answer("push", "up-to-date")).code).toBe(0);
		expect(read("push", 1, answer("push", "rejected-non-fast-forward")).code).toBe(1);
		expect(read("push", 2, answer("push", "refused", { remote_head: null })).code).toBe(2);
		expect(read("fetch", 3, answer("fetch", "unavailable")).code).toBe(3);
		// 1 is push only; a refusal never comes with 0; other codes are 3.
		expect(read("fetch", 1, answer("fetch", "rejected-non-fast-forward")).code).toBe(3);
		expect(read("push", 0, answer("push", "refused")).code).toBe(3);
		expect(read("check", 7, answer("check", "ok")).code).toBe(3);
	});

	test("anything but one valid JSON line of at most 4 KiB counts as 3", () => {
		expect(read("check", 0, answer("check", "ok").trimEnd()).code).toBe(0);
		for (const stdout of [
			"",
			"ok\n",
			"[]\n",
			`${answer("check", "ok")}${answer("check", "ok")}`,
			answer("check", "ok", { schema_version: "repository-db.transport.v0" }),
			answer("check", "ok", { operation: "fetch" }),
			answer("check", "ok", { remote_head: "abc" }),
			answer("check", "ok", { detail: undefined }),
			answer("check", "ok", { outcome: 0 }),
			answer("check", "ok", { detail: "x".repeat(4100) }),
		]) {
			expect(read("check", 0, stdout)).toMatchObject({ code: 3, outcome: "unavailable" });
		}
		expect(readTransportAnswer("push", { kind: "timed-out", timeoutMs: 5 })).toMatchObject({ code: 3 });
		expect(readTransportAnswer("push", { kind: "failed", reason: "spawn failed", stderr: "" })).toMatchObject({
			code: 3,
			detail: "spawn failed",
		});
	});

	test("detail and stderr are bounded", () => {
		const bounded = read("push", 2, answer("push", "refused", { detail: "d".repeat(3000) }), "e".repeat(10_000));
		expect(bounded.code).toBe(2);
		expect(bounded.detail.startsWith(`${"d".repeat(2000)}; stderr: `)).toBe(true);
		expect(Buffer.byteLength(bounded.detail)).toBeLessThan(2000 + 4096 + 32);
	});

	test("push arguments carry --commit and --expect, none when the remote branch is not known", () => {
		const request = { mount: "/m", remote: "git@github.com:example-org/deals-data.git", branch: "v3", deadlineMs: 58_000 };
		expect(transportArgs("fetch", request)).toEqual([
			"fetch",
			"--mount",
			"/m",
			"--remote",
			"git@github.com:example-org/deals-data.git",
			"--branch",
			"v3",
			"--deadline-ms",
			"58000",
		]);
		expect(transportArgs("push", { ...request, commit: "c".repeat(40), expect: undefined }).slice(-4)).toEqual([
			"--commit",
			"c".repeat(40),
			"--expect",
			"none",
		]);
	});
});
