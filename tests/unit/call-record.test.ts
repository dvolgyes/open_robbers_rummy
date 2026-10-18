import { describe, expect, it } from "vitest";
import {
	applyCallRecord,
	type CallRecord,
	callRecordFor,
	callRecordPayload,
	callRestore,
	nextCallVersion,
	ownCallRecord,
	parseCallRecords,
	pendingCallRecords,
	type StoredCallRecord,
} from "../../src/call/record";
import { chatPayload } from "../../src/game/chat";
import { TABLE } from "./p2p-fixtures";

const ME = "holder-me";
const OTHER = "holder-other";

function record(version: number, video = false): CallRecord {
	return {
		version,
		prefs: {
			inCall: true,
			send: { audio: true, video },
			receive: { audio: true, video: false },
		},
		form: "compact",
	};
}

function stored(version: number, holder = ME, video = false): StoredCallRecord {
	return { ...record(version, video), holder };
}

function outside(version: number): CallRecord {
	const base = record(version);
	return { ...base, prefs: { ...base.prefs, inCall: false } };
}

describe("call records", () => {
	it("round-trips a record through its command payload, with the holder the host gives", () => {
		const applied = applyCallRecord(
			{},
			"E",
			ME,
			callRecordPayload(TABLE, record(7, true)),
		);
		expect(applied).toEqual({
			ok: true,
			record: stored(7, ME, true),
			records: { E: stored(7, ME, true) },
		});
		expect(parseCallRecords(applied.ok && applied.records)).toEqual({
			E: stored(7, ME, true),
		});
	});

	it("keeps another seat's record when one seat changes", () => {
		const applied = applyCallRecord(
			{ N: stored(9, OTHER) },
			"E",
			ME,
			callRecordPayload(TABLE, record(1)),
		);
		expect(applied.ok && applied.records).toEqual({
			N: stored(9, OTHER),
			E: stored(1, ME),
		});
	});

	it("needs a higher version than the stored one, whoever stored it", () => {
		expect(
			applyCallRecord(
				{ E: stored(3, OTHER) },
				"E",
				ME,
				callRecordPayload(TABLE, record(3)),
			),
		).toEqual({ ok: false, reason: "a newer call status is stored" });
		const applied = applyCallRecord(
			{ E: stored(3, OTHER) },
			"E",
			ME,
			callRecordPayload(TABLE, record(4)),
		);
		expect(applied.ok && applied.records.E).toEqual(stored(4, ME));
	});

	it("refuses a payload with a missing switch, a fractional version or another form, and an empty holder", () => {
		const payload = callRecordPayload(TABLE, record(1));
		const prefs = { inCall: true, send: { audio: true }, receive: {} };
		for (const bad of [
			{ ...payload, prefs },
			{ ...payload, version: 1.5 },
			{ ...payload, form: "phone" },
		]) {
			expect(applyCallRecord({}, "S", ME, bad)).toEqual({
				ok: false,
				reason: "not a valid call status",
			});
		}
		expect(applyCallRecord({}, "S", "", payload)).toEqual({
			ok: false,
			reason: "not a valid call status",
		});
	});

	it("refuses stored records with a key that is not a seat, a record without a holder, and a value that is not an object", () => {
		expect(parseCallRecords({ N: stored(1), host: stored(1) })).toBeUndefined();
		expect(parseCallRecords({ N: record(1) })).toBeUndefined();
		expect(
			parseCallRecords({ N: { ...stored(1), holder: "x".repeat(65) } }),
		).toBeUndefined();
		expect(parseCallRecords([stored(1)])).toBeUndefined();
		expect(parseCallRecords(null)).toBeUndefined();
	});

	it("picks a version above the stored record and every own record still in the outbox", () => {
		expect(nextCallVersion(undefined, [])).toBe(1);
		expect(nextCallVersion(record(4), [])).toBe(5);
		expect(nextCallVersion(record(4), [6, 5])).toBe(7);
	});
});

describe("own call status", () => {
	it("reads only the media commands among the waiting commands", () => {
		expect(
			pendingCallRecords([
				chatPayload(TABLE, "hello"),
				callRecordPayload(TABLE, record(2)),
				{ ...callRecordPayload(TABLE, record(3)), version: 0 },
			]),
		).toEqual([record(2)]);
	});

	it("is the newest of the own stored record and the waiting ones", () => {
		expect(ownCallRecord(undefined, ME, [])).toBeUndefined();
		expect(ownCallRecord(stored(2), ME, [])).toEqual(stored(2));
		expect(ownCallRecord(stored(2), ME, [record(4), record(3)])).toEqual(
			record(4),
		);
		expect(ownCallRecord(stored(5), ME, [record(4)])).toEqual(stored(5));
	});

	it("is never the record of the seat's previous holder", () => {
		expect(ownCallRecord(stored(5, OTHER), ME, [])).toBeUndefined();
		expect(ownCallRecord(stored(5, OTHER), ME, [record(6)])).toEqual(record(6));
	});
});

describe("the record to store", () => {
	const inCall = record(1).prefs;

	it("is nothing for a person outside the call who has no record", () => {
		expect(
			callRecordFor(undefined, ME, [], outside(1).prefs, "compact"),
		).toBeUndefined();
		expect(
			callRecordFor(stored(4, OTHER), ME, [], outside(1).prefs, "compact"),
		).toBeUndefined();
	});

	it("is nothing when the newest own record says the same", () => {
		expect(callRecordFor(stored(2), ME, [], inCall, "compact")).toBeUndefined();
		expect(
			callRecordFor(stored(2, ME, true), ME, [record(3)], inCall, "compact"),
		).toBeUndefined();
	});

	it("has a version above the stored record when the status changed", () => {
		expect(callRecordFor(undefined, ME, [], inCall, "compact")).toEqual(
			record(1),
		);
		expect(callRecordFor(stored(2), ME, [], inCall, "desktop")).toEqual({
			...record(3),
			form: "desktop",
		});
		expect(
			callRecordFor(stored(2), ME, [], outside(9).prefs, "compact"),
		).toEqual(outside(3));
		expect(callRecordFor(stored(6, OTHER), ME, [], inCall, "compact")).toEqual(
			record(7),
		);
	});
});

describe("the restore", () => {
	it("is nothing outside the call or without a record", () => {
		expect(callRestore(undefined, "desktop")).toBeUndefined();
		expect(callRestore(outside(2), "desktop")).toBeUndefined();
	});

	it("joins with the stored switches and captures each device whose Send switch is on", () => {
		const both: CallRecord = {
			version: 1,
			prefs: {
				inCall: true,
				send: { audio: true, video: true },
				receive: { audio: true, video: true },
			},
			form: "desktop",
		};
		expect(callRestore(both, "desktop")).toEqual({
			selection: { send: both.prefs.send, receive: both.prefs.receive },
			devices: ["audio", "video"],
		});
	});

	it("drops video on a compact device, and a listener captures nothing", () => {
		const listen: CallRecord = {
			version: 1,
			prefs: {
				inCall: true,
				send: { audio: false, video: true },
				receive: { audio: true, video: true },
			},
			form: "desktop",
		};
		expect(callRestore(listen, "compact")).toEqual({
			selection: {
				send: { audio: false, video: false },
				receive: { audio: true, video: false },
			},
			devices: [],
		});
	});

	it("is nothing when no switch this device supports is on", () => {
		const watch: CallRecord = {
			version: 1,
			prefs: {
				inCall: true,
				send: { audio: false, video: false },
				receive: { audio: false, video: true },
			},
			form: "desktop",
		};
		expect(callRestore(watch, "compact")).toBeUndefined();
	});
});
