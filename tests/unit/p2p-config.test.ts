import { describe, expect, it } from "vitest";
import {
	DEFAULT_TRACKER_URLS,
	parseTrackerUrls,
	readMeshConfig,
} from "../../src/p2p/config";
import { classifyJoinError } from "../../src/p2p/mesh";

describe("parseTrackerUrls", () => {
	it.each([
		["absent", undefined],
		["empty", ""],
		["blank", "  ,  "],
	])("gives the three spike trackers when %s", (_name, value) => {
		expect(parseTrackerUrls(value)).toEqual({
			ok: true,
			urls: DEFAULT_TRACKER_URLS,
		});
		expect(DEFAULT_TRACKER_URLS).toHaveLength(3);
	});

	it("accepts wss: URLs separated by commas or spaces and removes duplicates", () => {
		expect(
			parseTrackerUrls(
				"wss://a.example, wss://b.example:8443/announce wss://a.example",
			),
		).toEqual({
			ok: true,
			urls: ["wss://a.example", "wss://b.example:8443/announce"],
		});
	});

	it.each([
		["plain ws", "ws://tracker.example"],
		["https", "https://tracker.example"],
		["credentials", "wss://user:secret@tracker.example"],
		["a query", "wss://tracker.example/?token=1"],
		["a fragment", "wss://tracker.example/#k"],
		["not a URL", "tracker.example"],
	])("refuses %s", (_name, url) => {
		const result = parseTrackerUrls(`wss://good.example ${url}`);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain("VITE_TRACKER_URLS");
	});

	it("refuses more than eight URLs", () => {
		const urls = Array.from(
			{ length: 9 },
			(_, index) => `wss://t${index}.example`,
		);
		expect(parseTrackerUrls(urls.join(","))).toEqual({
			ok: false,
			error: "At most 8 tracker URLs are allowed (VITE_TRACKER_URLS).",
		});
	});
});

describe("readMeshConfig", () => {
	it("combines the tracker list with the STUN list", () => {
		expect(
			readMeshConfig({
				VITE_TRACKER_URLS: "wss://tracker.example",
				VITE_STUN_URLS: "stun:stun.example:3478",
			}),
		).toEqual({
			ok: true,
			config: {
				trackers: ["wss://tracker.example"],
				rtc: { iceServers: [{ urls: ["stun:stun.example:3478"] }] },
			},
		});
	});

	it("gives the tracker error before the STUN error", () => {
		const result = readMeshConfig({
			VITE_TRACKER_URLS: "ws://tracker.example",
			VITE_STUN_URLS: "turn:relay.example",
		});
		expect(!result.ok && result.error).toContain("VITE_TRACKER_URLS");
	});

	it("refuses a TURN server, so no relay service is used", () => {
		const result = readMeshConfig({ VITE_STUN_URLS: "turn:relay.example" });
		expect(!result.ok && result.error).toContain("TURN URLs are not supported");
	});
});

describe("classifyJoinError", () => {
	// The texts of @trystero-p2p/core 0.26.0 (dist/signal-handler.mjs).
	it.each([
		["incorrect room password when decrypting offer", "wrong-key"],
		["incorrect room password when decrypting answer", "wrong-key"],
		["incorrect password", "wrong-key"],
		[
			"could not connect to peer abc after exchanging SDP; configure TURN servers with turnConfig or rtcConfig.iceServers",
			"unreachable",
		],
		["peer connection closed", "other"],
		["", "other"],
	])("classifies %j as %s", (error, expected) => {
		expect(classifyJoinError(error)).toBe(expected);
	});
});
