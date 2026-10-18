import { describe, expect, it } from "vitest";
import { DECK } from "../../src/bridge/cards";
import {
	cryptoRandomBelow,
	dealCards,
	randomBelowFrom,
	shuffle,
} from "../../src/bridge/deal";
import {
	applyAction,
	type Board,
	boardStatus,
	createBoard,
	parseBoard,
} from "../../src/bridge/engine";
import { bidding, cards, DEAL, playing } from "./bridge-fixtures";

describe("randomBelowFrom", () => {
	it("maps a 32-bit value into the range", () => {
		expect(randomBelowFrom(() => 7)(5)).toBe(2);
	});

	it("rejects values in the incomplete top block, so every result is equally likely", () => {
		// 2^32 = 3 * 1431655765 + 1, so only 0xFFFFFFFF falls outside the complete blocks.
		const values = [0xffffffff, 4];
		const randomBelow = randomBelowFrom(() => values.shift() ?? 0);
		expect(randomBelow(3)).toBe(1);
		expect(values).toEqual([]);
	});

	it.each([0, -1, 2.5, 2 ** 32 + 1])("rejects the bound %s", (bound) => {
		expect(() => randomBelowFrom(() => 0)(bound)).toThrow("bound");
	});
});

describe("shuffle", () => {
	it("draws each position from the cards not yet placed (Fisher–Yates)", () => {
		const bounds: number[] = [];
		const result = shuffle(DECK, (bound) => {
			bounds.push(bound);
			return 0;
		});
		expect(bounds).toEqual(Array.from({ length: 51 }, (_, i) => 52 - i));
		expect([...result].sort()).toEqual([...DECK].sort());
		// The input stays as it was.
		expect([DECK[0], DECK[51]]).toEqual(["SA", "C2"]);
	});

	it("gives all six orders of three items about equally often", () => {
		const counts = new Map<string, number>();
		for (let trial = 0; trial < 6000; trial++) {
			const order = shuffle(["a", "b", "c"], cryptoRandomBelow).join("");
			counts.set(order, (counts.get(order) ?? 0) + 1);
		}
		expect(counts.size).toBe(6);
		// The expected count is 1000 with a standard deviation of about 29; 200 is about 7 deviations.
		for (const count of counts.values()) {
			expect(count).toBeGreaterThan(800);
			expect(count).toBeLessThan(1200);
		}
	});
});

describe("dealCards", () => {
	it("deals four hands of 13 that together hold the whole deck", () => {
		const deal = dealCards(cryptoRandomBelow);
		for (const seat of ["N", "E", "S", "W"] as const)
			expect(deal[seat]).toHaveLength(13);
		expect(Object.values(deal).flat().sort()).toEqual([...DECK].sort());
	});
});

describe("createBoard", () => {
	it.each([
		["a hand of 12 cards", { ...DEAL, N: DEAL.N.slice(1) }],
		["a repeated card", { ...DEAL, N: [...DEAL.N.slice(1), "S7"] }],
		["a card that is not a card", { ...DEAL, N: [...DEAL.N.slice(1), "S1"] }],
	])("rejects a deal with %s", (_label, deal) => {
		expect(() => createBoard(1, deal as typeof DEAL)).toThrow("deal");
	});
});

/** The board after the auction and two tricks of 4♥ by East. */
function midPlay(): Board {
	return playing(
		bidding(createBoard(1, DEAL), "P 1H P 4H P P P"),
		"S4 H2 SA S5 D2 DA DT D9",
	);
}

describe("parseBoard", () => {
	it("restores a board from its JSON text, at every stage", () => {
		for (const board of [
			createBoard(7, DEAL),
			bidding(createBoard(7, DEAL), "1C X"),
			midPlay(),
			bidding(createBoard(1, DEAL), "P P P P"),
		]) {
			const restored = parseBoard(JSON.parse(JSON.stringify(board)));
			expect(restored).toEqual(board);
			if (restored === undefined) throw new Error("not restored");
			expect(boardStatus(restored)).toEqual(boardStatus(board));
		}
	});

	it("gives the same next state after a restore", () => {
		const board = midPlay();
		const restored = parseBoard(JSON.parse(JSON.stringify(board)));
		if (restored === undefined) throw new Error("not restored");
		const actor = boardStatus(board).actor;
		if (actor === undefined) throw new Error("nobody can act");
		const action = { type: "play", card: "DK" } as const;
		expect(applyAction(restored, actor, action)).toEqual(
			applyAction(board, actor, action),
		);
	});

	const valid = midPlay();
	it.each([
		["not an object", "board"],
		["a board number of 0", { ...valid, number: 0 }],
		[
			"a dealer that does not match the board number",
			{ ...valid, dealer: "E" },
		],
		[
			"a vulnerability that does not match",
			{ ...valid, vulnerability: "both" },
		],
		[
			"a deal with a repeated card",
			{ ...valid, deal: { ...DEAL, W: [...DEAL.W.slice(1), "SA"] } },
		],
		[
			"an illegal call",
			{ ...valid, calls: ["P", "1H", "P", "1C", "P", "P", "P"] },
		],
		[
			"a call that is not a call",
			{ ...valid, calls: ["P", "1H", "P", "4H", "P", "P", "pass"] },
		],
		[
			"a card that does not follow suit",
			{ ...valid, cards: cards("S4 H2 HA S5") },
		],
		["a card played twice", { ...valid, cards: cards("S4 H2 SA S5 H2") }],
		["cards before the auction is over", { ...valid, calls: ["P", "1H"] }],
		["a missing field", { ...valid, cards: undefined }],
	])("rejects %s", (_label, value) => {
		expect(parseBoard(value)).toBeUndefined();
	});
});
