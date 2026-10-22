import { describe, expect, it } from "vitest";
import {
	isTableKey,
	newTableKey,
	parseRoute,
	tableFragment,
	tableLink,
} from "../../src/p2p/link";

/** 32 bytes of 0xfb, encoded by Node's own base64url encoder. */
const KEY = "-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_s";

describe("newTableKey", () => {
	it("encodes 32 random bytes as 43 base64url characters", () => {
		expect(newTableKey((length) => new Uint8Array(length).fill(0xfb))).toBe(
			KEY,
		);
	});

	it("gives distinct valid keys from the platform generator", () => {
		const keys = new Set(Array.from({ length: 50 }, () => newTableKey()));
		expect(keys.size).toBe(50);
		for (const key of keys) expect(isTableKey(key)).toBe(true);
	});

	it("refuses a generator that returns the wrong number of bytes", () => {
		expect(() => newTableKey(() => new Uint8Array(31))).toThrow(
			"expected 32 random bytes",
		);
	});
});

describe("isTableKey", () => {
	it.each([
		["42 characters", KEY.slice(0, 42)],
		["44 characters", `${KEY}A`],
		["standard base64", `${KEY.slice(0, 42)}+`],
		["padding", `${KEY.slice(0, 42)}=`],
		// The last character carries 2 unused bits; "t" sets one, so the text is not the canonical encoding.
		["a non-canonical final character", `${KEY.slice(0, 42)}t`],
		["a number", 42],
	])("rejects %s", (_label, value) => {
		expect(isTableKey(value)).toBe(false);
	});
});

describe("parseRoute", () => {
	it("routes an empty fragment to the create page", () => {
		expect(parseRoute("")).toEqual({ kind: "create" });
		expect(parseRoute("#")).toEqual({ kind: "create" });
	});

	it("reads the table link that it writes", () => {
		expect(parseRoute(tableFragment(KEY))).toEqual({ kind: "table", key: KEY });
		const link = tableLink("https://example.org/canasta/?x=1#old", KEY);
		expect(link).toBe(`https://example.org/canasta/?x=1#v=p2p-v1&k=${KEY}`);
		expect(parseRoute(new URL(link).hash)).toEqual({ kind: "table", key: KEY });
	});

	it("names the links of the Supabase version", () => {
		expect(parseRoute("#room=abcdefghijklmnopqrstuv")).toEqual({
			kind: "legacy",
		});
		expect(parseRoute("#room=abcdefghijklmnopqrstuv&host")).toEqual({
			kind: "legacy",
		});
	});

	it("reports another link version", () => {
		expect(parseRoute(`#v=p2p-v9&k=${KEY}`)).toEqual({
			kind: "incompatible",
			version: "p2p-v9",
		});
	});

	it.each([
		["no key", "#v=p2p-v1"],
		["a short key", "#v=p2p-v1&k=abc"],
		["a non-canonical key", `#v=p2p-v1&k=${KEY.slice(0, 42)}t`],
		["two keys", `#v=p2p-v1&k=${KEY}&k=${KEY}`],
		["two versions", `#v=p2p-v1&v=p2p-v1&k=${KEY}`],
		["a version with markup", `#v=%3Cb%3E&k=${KEY}`],
		["an unknown fragment", "#hello"],
	])("rejects %s", (_label, hash) => {
		expect(parseRoute(hash)).toEqual({ kind: "invalid" });
	});
});

describe("tableFragment", () => {
	it("refuses an invalid key", () => {
		expect(() => tableFragment("abc")).toThrow("invalid table key");
	});
});
