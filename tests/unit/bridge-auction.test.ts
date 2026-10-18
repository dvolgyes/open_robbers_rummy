import { describe, expect, it } from "vitest";
import {
	applyAction,
	boardStatus,
	createBoard,
	legalActions,
	parseAction,
	scoreBoard,
} from "../../src/bridge/engine";
import { bidding, call, DEAL } from "./bridge-fixtures";

function legalCalls(text: string): string[] {
	const board = bidding(createBoard(1, DEAL), text);
	const seat = boardStatus(board).actor;
	if (seat === undefined) throw new Error("auction is over");
	return legalActions(board, seat).map((action) =>
		action.type === "call" ? action.call : action.card,
	);
}

describe("auction", () => {
	it("starts with the dealer and moves clockwise", () => {
		const board = createBoard(2, DEAL);
		expect(boardStatus(board)).toMatchObject({ phase: "auction", turn: "E" });
		expect(boardStatus(bidding(board, "P")).turn).toBe("S");
		expect(boardStatus(bidding(board, "P P P")).turn).toBe("N");
	});

	it("rejects a call out of turn and offers it to nobody else", () => {
		const board = createBoard(1, DEAL);
		expect(applyAction(board, "E", call("P"))).toEqual({
			ok: false,
			reason: "it is not your turn",
		});
		for (const seat of ["E", "S", "W"] as const)
			expect(legalActions(board, seat)).toEqual([]);
	});

	it("rejects an insufficient bid and does not offer it", () => {
		const board = bidding(createBoard(1, DEAL), "1S");
		expect(applyAction(board, "E", call("1H"))).toEqual({
			ok: false,
			reason: "1H is not a legal call now",
		});
		const legal = legalCalls("1S");
		expect(legal).not.toContain("1H");
		expect(legal).not.toContain("1S");
		expect(legal.slice(0, 4)).toEqual(["P", "X", "1NT", "2C"]);
		expect(legal.at(-1)).toBe("7NT");
		expect(legal).toHaveLength(2 + 31);
	});

	it("offers all 35 bids and a pass at the start, and no double or redouble", () => {
		const legal = legalCalls("");
		expect(legal).toHaveLength(36);
		expect(legal).not.toContain("X");
		expect(legal).not.toContain("XX");
	});

	it.each([
		["1S", "X", true, "an opponent's bid"],
		["1S P", "X", false, "partner's bid"],
		["1S P P", "X", true, "a balancing double"],
		["1S X", "X", false, "a bid that is already doubled"],
		["P", "X", false, "no bid yet"],
		["1S X 2C", "X", true, "a new opponent's bid after a double"],
		["1S", "XX", false, "an undoubled bid"],
		["1S X", "XX", true, "partner of the bidder after an opponent's double"],
		["1S X P", "XX", false, "partner of the doubler"],
		["1S X P P", "XX", true, "the bidder after X P P"],
		["1S X XX", "XX", false, "a bid that is already redoubled"],
		["1S X XX", "X", false, "a redoubled bid"],
	])("after %s, %s is legal: %s (%s)", (auction, next, legal) => {
		expect(legalCalls(auction).includes(next)).toBe(legal);
		const board = bidding(createBoard(1, DEAL), auction);
		const seat = boardStatus(board).actor;
		if (seat === undefined) throw new Error("auction is over");
		expect(applyAction(board, seat, call(next)).ok).toBe(legal);
	});

	it("four passes pass the board out with a score of 0", () => {
		const board = bidding(createBoard(1, DEAL), "P P P P");
		expect(boardStatus(board)).toMatchObject({
			phase: "complete",
			contract: null,
			turn: undefined,
			actor: undefined,
		});
		expect(scoreBoard(board)).toEqual({
			number: 1,
			contract: null,
			declarerTricks: 0,
			scoreNS: 0,
		});
		expect(applyAction(board, "N", call("1C"))).toEqual({
			ok: false,
			reason: "the board is over",
		});
	});

	it("three opening passes do not end the auction", () => {
		const board = bidding(createBoard(1, DEAL), "P P P");
		expect(boardStatus(board)).toMatchObject({ phase: "auction", turn: "W" });
		expect(scoreBoard(board)).toBeUndefined();
	});

	it("three passes after a double end the auction", () => {
		const board = bidding(createBoard(1, DEAL), "1S P P X P P P");
		expect(boardStatus(board)).toMatchObject({
			phase: "play",
			contract: { level: 1, strain: "S", declarer: "N", doubling: "X" },
			dummy: "S",
			turn: "E",
			actor: "E",
		});
		expect(applyAction(board, "S", call("P"))).toEqual({
			ok: false,
			reason: "the auction is over",
		});
	});

	it("records a redoubled contract", () => {
		const board = bidding(createBoard(1, DEAL), "1S X XX P P P");
		expect(boardStatus(board).contract).toEqual({
			level: 1,
			strain: "S",
			declarer: "N",
			doubling: "XX",
		});
	});

	it("makes the first player of the side who named the strain the declarer", () => {
		const board = bidding(createBoard(1, DEAL), "1C P 1S P 4S P P P");
		expect(boardStatus(board)).toMatchObject({
			contract: { level: 4, strain: "S", declarer: "S", doubling: "" },
			dummy: "N",
			turn: "W",
		});
	});

	it("ignores an opponent's earlier mention of the strain", () => {
		const board = bidding(createBoard(1, DEAL), "1D 1S P P 2S P P P");
		expect(boardStatus(board).contract).toMatchObject({ declarer: "N" });
	});

	it("does not end the auction while passes are fewer than three after a bid", () => {
		const board = bidding(createBoard(3, DEAL), "1NT P P");
		expect(boardStatus(board)).toMatchObject({ phase: "auction", turn: "E" });
	});
});

describe("parseAction", () => {
	it.each([
		[{ type: "call", call: "P" }],
		[{ type: "call", call: "XX" }],
		[{ type: "call", call: "7NT" }],
		[{ type: "play", card: "HT" }],
	])("accepts %j", (action) => {
		expect(parseAction(action)).toEqual(action);
	});

	it.each([
		[null],
		["P"],
		[{ type: "call" }],
		[{ type: "call", call: "8S" }],
		[{ type: "call", call: "1Z" }],
		[{ type: "call", call: "1N" }],
		[{ type: "call", call: "pass" }],
		[{ type: "play", card: "S10" }],
		[{ type: "play", card: "sa" }],
		[{ type: "claim", tricks: 13 }],
	])("rejects %j", (action) => {
		expect(parseAction(action)).toBeUndefined();
	});
});
