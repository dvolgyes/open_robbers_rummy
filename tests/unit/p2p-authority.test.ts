import { describe, expect, it } from "vitest";
import {
	type Authority,
	compareAuthority,
	comparePosition,
	EMPTY_POSITION,
	parseAuthority,
	parsePosition,
	sameAuthority,
} from "../../src/p2p/authority";

const LOW_TAG = "AAAAAAAAAAAAAAAA.N";
const HIGH_TAG = "BBBBBBBBBBBBBBBB.E";

function auth(term: number, tag: string, inc = 1): Authority {
	return { term, tag, inc };
}

describe("compareAuthority", () => {
	it("prefers the higher term over any tag", () => {
		expect(
			compareAuthority(auth(3, HIGH_TAG), auth(2, LOW_TAG)),
		).toBeGreaterThan(0);
	});

	it("prefers the lower tag for equal terms", () => {
		expect(
			compareAuthority(auth(2, LOW_TAG), auth(2, HIGH_TAG)),
		).toBeGreaterThan(0);
		expect(compareAuthority(auth(2, HIGH_TAG), auth(2, LOW_TAG))).toBeLessThan(
			0,
		);
	});

	it("prefers the higher incarnation for equal term and tag", () => {
		expect(
			compareAuthority(auth(2, LOW_TAG, 5), auth(2, LOW_TAG, 4)),
		).toBeGreaterThan(0);
	});

	it("ranks any authority above none", () => {
		expect(compareAuthority(auth(1, HIGH_TAG), null)).toBeGreaterThan(0);
		expect(compareAuthority(null, auth(1, HIGH_TAG))).toBeLessThan(0);
		expect(sameAuthority(null, null)).toBe(true);
		expect(sameAuthority(auth(1, LOW_TAG), auth(1, LOW_TAG))).toBe(true);
	});
});

describe("comparePosition", () => {
	it("prefers a better last authority over a longer log", () => {
		const longer = { rev: 9, lastAuth: auth(1, LOW_TAG) };
		const better = { rev: 4, lastAuth: auth(2, HIGH_TAG) };
		expect(comparePosition(better, longer)).toBeGreaterThan(0);
	});

	it("prefers the longer log for the same last authority", () => {
		const a = { rev: 5, lastAuth: auth(2, LOW_TAG) };
		const b = { rev: 4, lastAuth: auth(2, LOW_TAG) };
		expect(comparePosition(a, b)).toBeGreaterThan(0);
		expect(comparePosition(EMPTY_POSITION, b)).toBeLessThan(0);
	});
});

describe("parseAuthority and parsePosition", () => {
	it("accept valid values", () => {
		expect(parseAuthority(auth(1, LOW_TAG))).toEqual(auth(1, LOW_TAG));
		expect(parsePosition({ rev: 0, lastAuth: null })).toEqual(EMPTY_POSITION);
		expect(parsePosition({ rev: 2, lastAuth: auth(1, LOW_TAG) })).toEqual({
			rev: 2,
			lastAuth: auth(1, LOW_TAG),
		});
	});

	it.each([
		["term 0", { term: 0, tag: LOW_TAG, inc: 1 }],
		["term above 2^31 - 1", { term: 2 ** 31, tag: LOW_TAG, inc: 1 }],
		["a fractional term", { term: 1.5, tag: LOW_TAG, inc: 1 }],
		["incarnation 0", { term: 1, tag: LOW_TAG, inc: 0 }],
		["a bad tag", { term: 1, tag: "x.N", inc: 1 }],
		["a missing tag", { term: 1, inc: 1 }],
		["null", null],
	])("parseAuthority rejects %s", (_label, value) => {
		expect(parseAuthority(value)).toBeUndefined();
	});

	it.each([
		["an empty log with an authority", { rev: 0, lastAuth: auth(1, LOW_TAG) }],
		["entries without an authority", { rev: 3, lastAuth: null }],
		["a negative revision", { rev: -1, lastAuth: null }],
		["more than 20000 entries", { rev: 20_001, lastAuth: auth(1, LOW_TAG) }],
		["a string revision", { rev: "3", lastAuth: auth(1, LOW_TAG) }],
	])("parsePosition rejects %s", (_label, value) => {
		expect(parsePosition(value)).toBeUndefined();
	});
});
