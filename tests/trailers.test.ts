import { describe, expect, test } from "bun:test";
import {
	buildCommitMessage,
	newChangeId,
	parseCommitMessage,
} from "../src/trailers.ts";
import type { CommitTrailers } from "../src/types.ts";

function sampleTrailers(overrides: Partial<CommitTrailers> = {}): CommitTrailers {
	return {
		app: "deals",
		dataRepo: "git@github.com:example-org/deals-data.git",
		branch: "v3",
		schemaVersion: "deals-data@3.0.0-alpha.0",
		actor: "Jana Novak <jana@example.com>",
		machine: "test-machine",
		source: "deals-app-v3",
		changeId: newChangeId(),
		...overrides,
	};
}

describe("commit message contract", () => {
	test("build + parse roundtrip preserves all trailers", () => {
		const trailers = sampleTrailers({ entities: ["deal-1", "quote-2"] });
		const message = buildCommitMessage("deals: publish 2 data file(s)", trailers);
		const parsed = parseCommitMessage(message);
		expect(parsed.subject).toBe("deals: publish 2 data file(s)");
		expect(parsed.trailers).toEqual(trailers);
	});

	test("change id generator matches the validated format", () => {
		for (let i = 0; i < 5; i += 1) {
			const message = buildCommitMessage("subject", sampleTrailers());
			expect(() => parseCommitMessage(message)).not.toThrow();
		}
	});

	test("parser rejects a missing required trailer", () => {
		const message = buildCommitMessage("subject", sampleTrailers()).replace(
			/Repository-Db-Machine:.*\n/,
			"",
		);
		expect(() => parseCommitMessage(message)).toThrow(
			/missing required commit trailer: Repository-Db-Machine/,
		);
	});

	test("parser rejects duplicated trailers", () => {
		const base = buildCommitMessage("subject", sampleTrailers());
		const message = `${base}Repository-Db-App: second\n`;
		expect(() => parseCommitMessage(message)).toThrow(/duplicate commit trailer/);
	});

	test("parser rejects malformed change ids", () => {
		const message = buildCommitMessage("subject", sampleTrailers()).replace(
			/Repository-Db-Change-Id: .*/,
			"Repository-Db-Change-Id: not-a-change-id",
		);
		expect(() => parseCommitMessage(message)).toThrow(/unexpected format/);
	});

	test("builder refuses newline injection in trailer values", () => {
		const message = buildCommitMessage(
			"subject",
			sampleTrailers({ actor: "Jana\nInjected: value" }),
		);
		const parsed = parseCommitMessage(message);
		expect(parsed.trailers.actor).toBe("Jana Injected: value");
	});

	test("deterministic without AI: same inputs produce the same message", () => {
		const trailers = sampleTrailers({ changeId: "00abcdef-0123456789ab" });
		const a = buildCommitMessage("subject", trailers, "body");
		const b = buildCommitMessage("subject", trailers, "body");
		expect(a).toBe(b);
	});
});
