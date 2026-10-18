import { describe, expect, it } from "vitest";
import type { Authority } from "../../src/p2p/authority";
import { replaceCommit, seatsAfter } from "../../src/p2p/log";
import type { Entry } from "../../src/p2p/wire";
import {
	AUTH_1,
	AUTH_2,
	CONFIG,
	commandId,
	entries,
	HOLDER_E,
	TABLE,
	tableRecord,
} from "./p2p-fixtures";

// LocalLog and the stored host are tested on Chrome's IndexedDB in tests/browser/p2p-log.test.ts.

const AUTH_3: Authority = { term: 3, tag: `${HOLDER_E}.E`, inc: 4 };

describe("commits", () => {
	it("a replacement keeps the better host and the incarnation, and takes the seats of the new log", () => {
		const current = tableRecord({ host: AUTH_3, inc: 4 });
		const claim: Entry = {
			seq: 1,
			auth: AUTH_2,
			prevAuth: null,
			id: commandId(1),
			seat: "E",
			gen: 1,
			kind: "seat",
			op: { type: "claim", holder: HOLDER_E },
			event: { kind: "seat" },
		};
		const commit = replaceCommit(current, {
			tableId: TABLE,
			replica: "N",
			config: CONFIG,
			entries: [claim, ...entries(2, 3, AUTH_2, AUTH_2)],
			state: { phase: "new" },
			auth: AUTH_2,
			lastActivityAt: 3_000,
		});
		expect(commit.replace).toBe(true);
		expect(commit.expect).toEqual({ rev: 3, host: AUTH_3 });
		expect(commit.table).toMatchObject({
			rev: 3,
			lastAuth: AUTH_2,
			host: AUTH_3,
			inc: 4,
			lastActivityAt: 3_000,
		});
		expect(commit.table.seats.filter((row) => row.holder !== null)).toEqual([
			{ seat: "E", holder: HOLDER_E, gen: 1 },
		]);
		expect(commit.sent).toEqual([commandId(2), commandId(3)]);
	});

	it("creates the partition from a replacement when none exists", () => {
		const commit = replaceCommit(null, {
			tableId: TABLE,
			replica: "S",
			config: CONFIG,
			entries: entries(1, 2, AUTH_1, null),
			state: {},
			auth: AUTH_2,
			lastActivityAt: 0,
		});
		expect(commit.expect).toBeNull();
		expect(commit.replace).toBeUndefined();
		expect(commit.table).toMatchObject({ host: AUTH_2, inc: 0, rev: 2 });
	});

	it("seat entries give a seat to its holder, and a release frees it with a new generation", () => {
		const base = tableRecord().seats;
		const claim: Entry = {
			...entries(4, 4, AUTH_1, AUTH_1)[0],
			kind: "seat",
			seat: "E",
			gen: 1,
			op: { type: "claim", holder: HOLDER_E },
		} as Entry;
		const release: Entry = {
			...claim,
			seq: 5,
			gen: 2,
			op: { type: "release", by: "N" },
		} as Entry;
		expect(seatsAfter(base, [claim]).find((row) => row.seat === "E")).toEqual({
			seat: "E",
			holder: HOLDER_E,
			gen: 1,
		});
		expect(
			seatsAfter(base, [claim, release]).find((row) => row.seat === "E"),
		).toEqual({ seat: "E", holder: null, gen: 2 });
	});
});
