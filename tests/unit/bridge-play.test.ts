import { describe, expect, it } from "vitest";
import {
	applyAction,
	type Board,
	boardStatus,
	createBoard,
	legalActions,
	scoreBoard,
	viewForPlayer,
} from "../../src/bridge/engine";
import { type Contract, scoreContract } from "../../src/bridge/rules";
import { bidding, DEAL, play, playing } from "./bridge-fixtures";

/** Board 1, dealer North: East declares 4♥, West is dummy, South leads. */
function fourHeartsByEast(): Board {
	return bidding(createBoard(1, DEAL), "P 1H P 4H P P P");
}

/** Board 1, dealer North: North declares 1NT, South is dummy, East leads. */
function oneNoTrumpByNorth(): Board {
	return bidding(createBoard(1, DEAL), "1NT P P P");
}

function legalCards(board: Board, seat: "N" | "E" | "S" | "W"): string[] {
	return legalActions(board, seat).map((action) =>
		action.type === "play" ? action.card : action.call,
	);
}

describe("play", () => {
	it("starts with the opening lead from declarer's left", () => {
		const board = fourHeartsByEast();
		expect(boardStatus(board)).toMatchObject({
			phase: "play",
			contract: { level: 4, strain: "H", declarer: "E", doubling: "" },
			dummy: "W",
			turn: "S",
			actor: "S",
		});
		for (const seat of ["N", "E", "W"] as const) {
			expect(applyAction(board, seat, play("S4"))).toEqual({
				ok: false,
				reason: "it is not your turn",
			});
		}
		expect(legalCards(board, "S")).toEqual(DEAL.S);
	});

	it("lets declarer play dummy's cards and never the dummy seat", () => {
		const board = playing(fourHeartsByEast(), "S4");
		expect(boardStatus(board)).toMatchObject({ turn: "W", actor: "E" });
		expect(applyAction(board, "W", play("H2"))).toEqual({
			ok: false,
			reason: "dummy's cards are played by declarer",
		});
		expect(legalActions(board, "W")).toEqual([]);
		expect(applyAction(board, "E", play("S7"))).toEqual({
			ok: false,
			reason: "S7 is not in West's hand",
		});
		expect(applyAction(board, "E", play("H2")).ok).toBe(true);
	});

	it("lets a player who is void in the led suit ruff or discard", () => {
		const board = playing(fourHeartsByEast(), "S4");
		expect(legalCards(board, "E")).toEqual(DEAL.W);
		expect(applyAction(board, "E", play("D2")).ok).toBe(true);
	});

	it("makes a player follow suit when able", () => {
		const board = playing(fourHeartsByEast(), "S4 H2");
		expect(applyAction(board, "N", play("HA"))).toEqual({
			ok: false,
			reason: "HA does not follow suit",
		});
		expect(legalCards(board, "N")).toEqual(
			DEAL.N.filter((card) => card.startsWith("S")),
		);
	});

	it("gives the trick to a trump over a higher card of the led suit; the winner leads next", () => {
		const board = playing(fourHeartsByEast(), "S4 H2 SA S5");
		expect(boardStatus(board)).toMatchObject({
			turn: "W",
			actor: "E",
			tricksNS: 0,
			tricksEW: 1,
			current: { leader: "W", cards: [] },
			tricks: [{ leader: "S", cards: ["S4", "H2", "SA", "S5"], winner: "W" }],
		});
	});

	it("without trumps, gives the trick to the highest card of the led suit", () => {
		const board = playing(oneNoTrumpByNorth(), "HJ H6 H3 HA");
		expect(boardStatus(board)).toMatchObject({
			turn: "N",
			tricksNS: 1,
			tricksEW: 0,
		});
		// A discard never wins: West, void in spades, throws a club.
		const next = playing(board, "S8 S7 S2 C8");
		expect(boardStatus(next).tricks.at(-1)).toEqual({
			leader: "N",
			cards: ["S8", "S7", "S2", "C8"],
			winner: "N",
		});
	});

	it("rejects a card that was already played", () => {
		const board = playing(fourHeartsByEast(), "S4 H2 SA S5");
		expect(applyAction(board, "E", play("H2"))).toEqual({
			ok: false,
			reason: "H2 is not in West's hand",
		});
	});

	it("rejects a call during the play", () => {
		const board = playing(fourHeartsByEast(), "S4");
		expect(applyAction(board, "E", { type: "call", call: "P" })).toEqual({
			ok: false,
			reason: "the auction is over",
		});
	});

	it("ends the board after 13 tricks and scores the tricks taken", () => {
		let board = fourHeartsByEast();
		for (let step = 0; step < 52; step++) {
			const actor = boardStatus(board).actor;
			if (actor === undefined) throw new Error(`nobody can act at ${step}`);
			const [first] = legalActions(board, actor);
			if (first === undefined) throw new Error(`no legal card at ${step}`);
			const result = applyAction(board, actor, first);
			if (!result.ok) throw new Error(result.reason);
			board = result.board;
		}
		const status = boardStatus(board);
		expect(status).toMatchObject({
			phase: "complete",
			turn: undefined,
			actor: undefined,
			current: { cards: [] },
		});
		expect(status.tricks).toHaveLength(13);
		expect(status.tricksNS + status.tricksEW).toBe(13);
		expect(new Set(board.cards).size).toBe(52);
		for (const seat of ["N", "E", "S", "W"] as const)
			expect(status.remaining[seat]).toEqual([]);
		const contract: Contract = {
			level: 4,
			strain: "H",
			declarer: "E",
			doubling: "",
		};
		expect(scoreBoard(board)).toEqual({
			number: 1,
			contract,
			declarerTricks: status.tricksEW,
			scoreNS: scoreContract(contract, "none", status.tricksEW),
		});
		expect(applyAction(board, "S", play("S4"))).toEqual({
			ok: false,
			reason: "the board is over",
		});
	});
});

describe("viewForPlayer", () => {
	it("shows only the player's own hand during the auction", () => {
		const view = viewForPlayer(bidding(createBoard(1, DEAL), "1S"), "E");
		expect(view.hands.E).toEqual({ visible: true, cards: DEAL.E });
		for (const seat of ["N", "S", "W"] as const)
			expect(view.hands[seat]).toEqual({ visible: false, count: 13 });
		expect(view).toMatchObject({
			seat: "E",
			number: 1,
			dealer: "N",
			vulnerability: "none",
			phase: "auction",
			calls: ["1S"],
			turn: "E",
		});
		expect(view.legal.length).toBeGreaterThan(0);
	});

	it("exposes dummy to everyone after the opening lead, and nothing else", () => {
		const beforeLead = fourHeartsByEast();
		expect(viewForPlayer(beforeLead, "N").hands.W).toEqual({
			visible: false,
			count: 13,
		});
		const board = playing(beforeLead, "S4");
		const north = viewForPlayer(board, "N");
		expect(north.hands.W).toEqual({ visible: true, cards: DEAL.W });
		expect(north.hands.E).toEqual({ visible: false, count: 13 });
		expect(north.hands.S).toEqual({ visible: false, count: 12 });
		expect(north.current).toEqual({ leader: "S", cards: ["S4"] });
		expect(north.legal).toEqual([]);
	});

	it("gives declarer the legal cards of dummy on dummy's turn", () => {
		const board = playing(fourHeartsByEast(), "S4");
		expect(viewForPlayer(board, "E").legal).toHaveLength(13);
		expect(viewForPlayer(board, "W").legal).toEqual([]);
	});

	it("sorts visible cards by suit (spades first) and rank", () => {
		const shuffled = {
			...DEAL,
			N: [...DEAL.N].reverse(),
		};
		expect(viewForPlayer(createBoard(1, shuffled), "N").hands.N).toEqual({
			visible: true,
			cards: DEAL.N,
		});
	});

	it("reveals every hand when the board is over", () => {
		const view = viewForPlayer(bidding(createBoard(1, DEAL), "P P P P"), "E");
		for (const seat of ["N", "E", "S", "W"] as const)
			expect(view.hands[seat]).toEqual({ visible: true, cards: DEAL[seat] });
		expect(view.result).toEqual({
			number: 1,
			contract: null,
			declarerTricks: 0,
			scoreNS: 0,
		});
	});
});
