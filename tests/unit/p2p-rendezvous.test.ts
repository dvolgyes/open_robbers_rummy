import { describe, expect, it } from "vitest";
import {
	pairRetryMs,
	peerRendezvous,
	seatRendezvous,
} from "../../src/p2p/rendezvous";

const A = "0123456789AbCdEfGhIj";
const B = "ZZZZZZZZZZZZZZZZZZZZ";

describe("pair names", () => {
	it("are the same from both pages of a pair", () => {
		expect(peerRendezvous(A, B)).toBe(peerRendezvous(B, A));
		expect(seatRendezvous("S", "E")).toBe(seatRendezvous("E", "S"));
	});

	it("keep peer pairs and seat pairs apart", () => {
		expect(peerRendezvous(A, B)).toBe(`peer|${A}|${B}`);
		expect(seatRendezvous("W", "N")).toBe("seat|N|W");
	});

	it("differ for another pair", () => {
		expect(seatRendezvous("N", "E")).not.toBe(seatRendezvous("N", "S"));
	});
});

describe("pairRetryMs", () => {
	it.each([
		[1, 30_000],
		[2, 60_000],
		[3, 120_000],
		[4, 120_000],
		[50, 120_000],
	])("waits after %i failed rooms for %i ms", (failures, wait) => {
		expect(pairRetryMs(failures)).toBe(wait);
	});
});
