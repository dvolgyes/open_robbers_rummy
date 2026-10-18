import { describe, expect, it } from "vitest";
import type { Contract } from "../../src/bridge/rules";
import {
	miltonPoints,
	playSuitOrder,
	sideOf,
	trickNeed,
} from "../../src/ui/hand-layout";

const contract = (
	level: Contract["level"],
	strain: Contract["strain"],
	declarer: Contract["declarer"],
): Contract => ({ level, strain, declarer, doubling: "" });

describe("playSuitOrder", () => {
	it("puts the trump suit first, then the other suits clubs, diamonds, hearts, spades", () => {
		expect(playSuitOrder("C")).toEqual(["C", "D", "H", "S"]);
		expect(playSuitOrder("S")).toEqual(["S", "C", "D", "H"]);
	});

	it("keeps trump first in a hand on the top or left", () => {
		expect(playSuitOrder("C", "top")).toEqual(["C", "D", "H", "S"]);
		expect(playSuitOrder("D", "left")).toEqual(["D", "C", "H", "S"]);
		expect(playSuitOrder("D", "bottom")).toEqual(["D", "C", "H", "S"]);
	});

	it("puts the trump suit last in a hand on the right", () => {
		expect(playSuitOrder("H", "right")).toEqual(["C", "D", "S", "H"]);
	});

	it("uses the base order with no trump suit", () => {
		expect(playSuitOrder("NT")).toEqual(["C", "D", "H", "S"]);
		expect(playSuitOrder(undefined)).toEqual(["C", "D", "H", "S"]);
	});
});

describe("miltonPoints", () => {
	it("counts A 4, K 3, Q 2, J 1 and nothing else (the auction example: K♠ J♠ = 4)", () => {
		expect(miltonPoints(["SK", "SJ", "S8", "S4", "S2"])).toBe(4);
		expect(miltonPoints(["SA", "HQ", "DJ", "CT", "C2"])).toBe(7);
	});
});

describe("trickNeed", () => {
	it("gives the declaring side seven tricks to make a 1♣ contract", () => {
		const need = trickNeed("N", contract(1, "C", "N"), 0, 1);
		expect(need).toEqual({
			ours: 0,
			target: 7,
			opponents: 1,
			needed: 7,
			remaining: 12,
			status: "open",
		});
	});

	it("gives the defenders seven tricks to defeat the same contract, from their own count", () => {
		const need = trickNeed("E", contract(1, "C", "N"), 0, 1);
		expect(need.target).toBe(7);
		expect(need.ours).toBe(1);
		expect(need.needed).toBe(6);
	});

	it("uses four and ten for a 4♥ contract", () => {
		expect(trickNeed("S", contract(4, "H", "N"), 2, 0).target).toBe(10);
		expect(trickNeed("E", contract(4, "H", "N"), 2, 0).target).toBe(4);
	});

	it("reports secured and defeated from the counts, whichever seat is the viewer", () => {
		// The contract is secured once the declaring side has seven tricks, whoever is the viewer.
		expect(trickNeed("N", contract(1, "C", "N"), 7, 0).status).toBe("secured");
		expect(trickNeed("E", contract(1, "C", "N"), 7, 0).status).toBe("secured");
		// The defenders defeat it with seven tricks of their own.
		expect(trickNeed("N", contract(1, "C", "N"), 0, 7).status).toBe("defeated");
		expect(trickNeed("E", contract(1, "C", "N"), 0, 7).status).toBe("defeated");
	});

	it("counts completed tricks only, so the trick in play is still remaining", () => {
		expect(trickNeed("N", contract(1, "C", "N"), 3, 2).remaining).toBe(8);
	});
});

describe("sideOf", () => {
	it("pairs North with South and East with West", () => {
		expect(sideOf("N")).toBe("NS");
		expect(sideOf("S")).toBe("NS");
		expect(sideOf("E")).toBe("EW");
		expect(sideOf("W")).toBe("EW");
	});
});
