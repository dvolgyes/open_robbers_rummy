import { describe, expect, it } from "vitest";
import {
	DEFAULT_STUN_URLS,
	parseStunUrls,
	rtcConfiguration,
} from "../../src/call/ice";

describe("parseStunUrls", () => {
	it.each([
		["absent", undefined],
		["empty", ""],
		["blank", "  ,  "],
	])("gives the Cloudflare default when %s", (_name, value) => {
		expect(parseStunUrls(value)).toEqual({ ok: true, urls: DEFAULT_STUN_URLS });
		expect(DEFAULT_STUN_URLS).toEqual(["stun:stun.cloudflare.com:3478"]);
	});

	it("accepts stun: and stuns: URLs separated by commas or spaces", () => {
		expect(
			parseStunUrls(
				"stun:stun.example.org:3478, stuns:stun.example.org:5349 stun:[2001:db8::1]:3478 stun:192.0.2.1",
			),
		).toEqual({
			ok: true,
			urls: [
				"stun:stun.example.org:3478",
				"stuns:stun.example.org:5349",
				"stun:[2001:db8::1]:3478",
				"stun:192.0.2.1",
			],
		});
	});

	it.each(["turn:relay.example.org:3478", "TURNS:relay.example.org:5349"])(
		"refuses the TURN URL %s",
		(url) => {
			const result = parseStunUrls(`stun:stun.example.org ${url}`);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error).toContain("TURN URLs are not supported");
		},
	);

	it.each([
		["no scheme", "stun.example.org:3478"],
		["http scheme", "https://stun.example.org"],
		["a path", "stun:stun.example.org/x"],
		["a query", "stun:stun.example.org?transport=udp"],
		["port 0", "stun:stun.example.org:0"],
		["port 65536", "stun:stun.example.org:65536"],
		["user info", "stun:user@stun.example.org"],
	])("refuses a malformed URL: %s", (_name, url) => {
		expect(parseStunUrls(url).ok).toBe(false);
	});

	it("accepts 8 URLs and refuses 9", () => {
		const urls = (n: number) =>
			Array.from({ length: n }, (_, i) => `stun:s${i}.example.org`).join(",");
		expect(parseStunUrls(urls(8)).ok).toBe(true);
		expect(parseStunUrls(urls(9)).ok).toBe(false);
	});
});

describe("rtcConfiguration", () => {
	it("puts the STUN URLs into one ICE server entry without credentials", () => {
		expect(rtcConfiguration(DEFAULT_STUN_URLS)).toEqual({
			iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
		});
	});
});
