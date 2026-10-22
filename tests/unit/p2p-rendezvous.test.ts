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
		expect(seatRendezvous("3", "2")).toBe(seatRendezvous("2", "3"));
	});

	it("keep peer pairs and seat pairs apart", () => {
		expect(peerRendezvous(A, B)).toBe(`peer|${A}|${B}`);
		expect(seatRendezvous("4", "1")).toBe("seat|1|4");
	});

	it("differ for another pair", () => {
		expect(seatRendezvous("1", "2")).not.toBe(seatRendezvous("1", "3"));
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
