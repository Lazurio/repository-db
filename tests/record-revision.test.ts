import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordRevision, writeRecordDraft } from "../src/collections.ts";
import { acquirePublishLock } from "../src/lock.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { RecordChangedError } from "../src/types.ts";
import { createFixtureRepo, git } from "./fixtures.ts";

type Thing = { name: string };

function things(mountPath: string) {
	return RepositoryDb.open(mountPath).collection<Thing>("things", { schemaVersion: "thing.v3" });
}

describe("a save holds to the record version it started from", () => {
	test("two people on different records never block each other", () => {
		const fixture = createFixtureRepo();
		try {
			const collection = things(fixture.mountPath);
			const a0 = collection.put("a", { name: "A" }, {}, { baseRevision: null });
			const b0 = collection.put("b", { name: "B" }, {}, { baseRevision: null });

			// Each keeps saving from their own last version; the other record's
			// changes are irrelevant to them.
			const a1 = collection.put("a", { name: "A edit" }, {}, { baseRevision: a0 });
			const b1 = collection.put("b", { name: "B edit" }, {}, { baseRevision: b0 });
			collection.put("a", { name: "A edit 2" }, {}, { baseRevision: a1 });
			collection.put("b", { name: "B edit 2" }, {}, { baseRevision: b1 });
			expect(collection.get("a")?.record.name).toBe("A edit 2");
			expect(collection.get("b")?.record.name).toBe("B edit 2");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a stale save of the same record is refused, reports the current version and changes nothing", () => {
		const fixture = createFixtureRepo();
		try {
			const collection = things(fixture.mountPath);
			const base = collection.put("a", { name: "Original" }, {}, { baseRevision: null });
			const theirs = collection.put("a", { name: "Colleague" }, {}, { baseRevision: base });

			let refusal: unknown;
			try {
				collection.put("a", { name: "Mine, from the old version" }, {}, { baseRevision: base });
			} catch (error) {
				refusal = error;
			}
			expect(refusal).toBeInstanceOf(RecordChangedError);
			expect((refusal as RecordChangedError).code).toBe("record_changed");
			expect((refusal as RecordChangedError).currentRevision).toBe(theirs);
			expect(collection.get("a")?.record.name).toBe("Colleague");

			// Overwriting is possible, but only as an explicit decision on the
			// version that is there now.
			collection.put("a", { name: "Mine, on purpose" }, {}, { baseRevision: theirs });
			expect(collection.get("a")?.record.name).toBe("Mine, on purpose");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("a save after the record was reverted or deleted is refused; a create over an existing record too", () => {
		const fixture = createFixtureRepo();
		try {
			const collection = things(fixture.mountPath);
			const base = collection.put("a", { name: "Draft" }, {}, { baseRevision: null });
			// The draft record is reverted (here: it never existed in the baseline).
			rmSync(path.join(collection.directoryPath, "a.yaml"));
			expect(() => collection.put("a", { name: "Stale autosave" }, {}, { baseRevision: base })).toThrow(
				/no longer exists/,
			);
			expect(collection.has("a")).toBe(false);

			collection.put("b", { name: "B" }, {}, { baseRevision: null });
			expect(() => collection.put("b", { name: "Second create" }, {}, { baseRevision: null })).toThrow(
				/already exists/,
			);
			expect(() => collection.remove("b", { baseRevision: base })).toThrow(RecordChangedError);
			expect(collection.has("b")).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("the revision is the stored file, so any writer's change counts", () => {
		const fixture = createFixtureRepo();
		try {
			const collection = things(fixture.mountPath);
			const base = collection.put("a", { name: "A" }, {}, { baseRevision: null });
			const filePath = path.join(collection.directoryPath, "a.yaml");
			expect(recordRevision(filePath)).toBe(base);
			expect(collection.revision("a")).toBe(base);
			expect(collection.revision("missing")).toBeNull();

			// An agent edits the file with its own tools.
			writeFileSync(filePath, readFileSync(filePath, "utf8").replace("A", "Agent"), "utf8");
			expect(() => collection.put("a", { name: "Stale" }, {}, { baseRevision: base })).toThrow(
				RecordChangedError,
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("check and write happen inside the shared gate", () => {
		const fixture = createFixtureRepo();
		try {
			const collection = things(fixture.mountPath);
			const base = collection.put("a", { name: "A" }, {}, { baseRevision: null });
			const release = acquirePublishLock(fixture.mountPath);
			try {
				expect(() => collection.put("a", { name: "During publish" }, {}, { baseRevision: base })).toThrow(
					/publish or discard is in progress/,
				);
				// A host's own layout goes through the same gate.
				let wrote = false;
				expect(() =>
					writeRecordDraft(fixture.mountPath, path.join(fixture.mountPath, "data/notes.yaml"), {}, () => {
						wrote = true;
					}),
				).toThrow(/publish or discard is in progress/);
				expect(wrote).toBe(false);
			} finally {
				release();
			}
			expect(collection.get("a")?.record.name).toBe("A");
			expect(git(fixture.mountPath, ["status", "--porcelain"])).toContain("data/things/a.yaml");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
