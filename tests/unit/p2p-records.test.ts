import { describe, expect, it } from "vitest";
import { MAX_STATE_BYTES } from "../../src/p2p/limits";
import {
	parseOutboxRecord,
	parseReplica,
	parseTableRecord,
	parseTombstone,
} from "../../src/p2p/records";
import {
	AUTH_1,
	AUTH_2,
	CONFIG,
	entries,
	outboxRecord,
	TABLE,
	tableRecord,
} from "./p2p-fixtures";

function nested(depth: number): Record<string, unknown> {
	let value: Record<string, unknown> = {};
	for (let level = 0; level < depth; level++) value = { child: value };
	return value;
}

describe("parseTableRecord", () => {
	it("accepts a valid record and drops unknown fields", () => {
		const record = tableRecord();
		expect(parseTableRecord(record)).toEqual(record);
		expect(parseTableRecord({ ...record, extra: 1 })).toEqual(record);
	});

	it("accepts a host that beats the last entry's authority", () => {
		const record = tableRecord({ host: AUTH_2 });
		expect(parseTableRecord(record)).toEqual(record);
	});

	it.each<[string, Record<string, unknown>]>([
		["a bad table id", { tableId: "short" }],
		["a bad replica seat", { replica: "X" }],
		["revision 0", { rev: 0 }],
		["more than 20000 entries", { rev: 20_001 }],
		["a negative incarnation", { inc: -1 }],
		["an incarnation above 2^31 - 1", { inc: 2 ** 31 }],
		["a fractional activity time", { lastActivityAt: 1.5 }],
		["a negative activity time", { lastActivityAt: -1 }],
		["a state that is not an object", { state: [] }],
		[
			"a state that is too large",
			{ state: { text: "x".repeat(MAX_STATE_BYTES) } },
		],
		["a state that is too deep", { state: nested(40) }],
		[
			"a name with outer spaces",
			{ config: { ...CONFIG, names: { ...CONFIG.names, N: " a" } } },
		],
		[
			"a bad last authority",
			{ lastAuth: { term: 0, tag: AUTH_1.tag, inc: 1 } },
		],
		["a missing host", { host: null }],
		["three seats", { seats: tableRecord().seats.slice(1) }],
		["a host weaker than the last entry", { host: AUTH_1, lastAuth: AUTH_2 }],
	])("rejects %s", (_label, overrides) => {
		expect(
			parseTableRecord({ ...tableRecord(), ...overrides }),
		).toBeUndefined();
	});

	it.each([
		"tableId",
		"config",
		"state",
		"rev",
		"lastAuth",
		"host",
		"inc",
		"lastActivityAt",
		"seats",
	])("rejects a record without %s", (field) => {
		const record: Record<string, unknown> = { ...tableRecord() };
		delete record[field];
		expect(parseTableRecord(record)).toBeUndefined();
	});
});

describe("parseOutboxRecord and parseTombstone", () => {
	it("accept valid records", () => {
		expect(parseOutboxRecord(outboxRecord(0))).toEqual(outboxRecord(0));
		expect(parseTombstone({ tableId: TABLE, expiredAt: 0 })).toEqual({
			tableId: TABLE,
			expiredAt: 0,
		});
	});

	it.each<[string, Record<string, unknown>]>([
		["a bad command id", { id: "x" }],
		["a negative order", { order: -1 }],
		["a payload that is not an object", { payload: "text" }],
		["a payload above 4096 bytes", { payload: { text: "x".repeat(4_096) } }],
		["a bad seat", { replica: "X" }],
	])("parseOutboxRecord rejects %s", (_label, overrides) => {
		expect(
			parseOutboxRecord({ ...outboxRecord(1), ...overrides }),
		).toBeUndefined();
	});

	it.each<[string, unknown]>([
		["a bad table id", { tableId: "x", expiredAt: 1 }],
		["a negative time", { tableId: TABLE, expiredAt: -1 }],
		["a missing time", { tableId: TABLE }],
		["null", null],
	])("parseTombstone rejects %s", (_label, value) => {
		expect(parseTombstone(value)).toBeUndefined();
	});
});

describe("parseReplica", () => {
	const log = entries(1, 3, AUTH_1, null);

	it("accepts a consistent replica and sorts the outbox by send order", () => {
		const replica = parseReplica(tableRecord(), log, [
			outboxRecord(2),
			outboxRecord(1),
		]);
		expect(replica).toEqual({
			table: tableRecord(),
			entries: log,
			outbox: [outboxRecord(1), outboxRecord(2)],
		});
	});

	it("accepts a log that changes authority along the way", () => {
		const mixed = [
			...entries(1, 2, AUTH_1, null),
			...entries(3, 3, AUTH_2, AUTH_1),
		];
		const record = tableRecord({ lastAuth: AUTH_2, host: AUTH_2 });
		expect(parseReplica(record, mixed, [])?.entries).toEqual(mixed);
	});

	it.each<[string, unknown[], unknown[]]>([
		["a missing entry", log.slice(0, 2), []],
		["an extra entry", [...log, ...entries(4, 4, AUTH_1, AUTH_1)], []],
		["entries out of order", [log[1], log[0], log[2]], []],
		["a broken link", [log[0], log[1], ...entries(3, 3, AUTH_2, AUTH_2)], []],
		[
			"a last authority that differs from the record",
			[log[0], log[1], ...entries(3, 3, AUTH_2, AUTH_1)],
			[],
		],
		["an invalid entry", [log[0], { seq: 2 }, log[2]], []],
		[
			"an outbox record of another seat",
			log,
			[outboxRecord(1, { replica: "E" })],
		],
		[
			"an outbox record of another table",
			log,
			[outboxRecord(1, { tableId: "Other-ID-0123456789abc" })],
		],
		["an invalid outbox record", log, [{ ...outboxRecord(1), order: "first" }]],
	])("rejects %s", (_label, rows, outbox) => {
		expect(parseReplica(tableRecord(), rows, outbox)).toBeUndefined();
	});

	it("rejects an invalid table record", () => {
		expect(
			parseReplica({ ...tableRecord(), rev: "3" }, log, []),
		).toBeUndefined();
	});
});
