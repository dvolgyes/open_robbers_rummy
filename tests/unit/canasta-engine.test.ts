import { describe, expect, it } from "vitest";
import {
	type Action,
	actionsWithCards,
	applyAction,
	buildDecks,
	type Card,
	CLASSIC_RULES,
	cardPoints,
	type HandState,
	initialMeldMinimum,
	isBlack3,
	isRed3,
	isWild,
	legalActions,
	type MatchState,
	type Meld,
	newHand,
	type Seat,
	scoreHand,
	settleHand,
	startMatch,
	validateMeld,
	viewFor,
} from "../../src/canasta";

const byId = (id: string): Card => {
	const card = buildDecks().find((candidate) => candidate.id === id);
	if (card === undefined) throw new Error(`no card ${id}`);
	return card;
};
const cardsById = (ids: readonly string[]): Card[] => ids.map(byId);

/** Total cards: in hands, in the stock, in the pile, and on the table (melds and red threes). */
function cardTotal(hand: HandState): number {
	const inHands = hand.hands.reduce((sum, cards) => sum + cards.length, 0);
	const onTable = hand.teams.reduce(
		(sum, team) =>
			sum +
			team.redThrees.length +
			team.melds.reduce((m, meld) => m + meld.cards.length, 0),
		0,
	);
	return inHands + hand.stock.length + hand.pile.length + onTable;
}

/** Overrides parts of a dealt hand, so a scenario can use exact cards. */
function scenario(
	base: HandState,
	patch: Partial<
		Pick<
			HandState,
			| "hands"
			| "stock"
			| "pile"
			| "turn"
			| "phase"
			| "teams"
			| "nextMeldNo"
			| "meldedSeats"
		>
	>,
): HandState {
	const next = { ...base, ...patch };
	return { ...next, turnStart: next };
}

describe("cards", () => {
	it("builds two decks: 108 cards with unique ids", () => {
		const deck = buildDecks();
		expect(deck).toHaveLength(108);
		expect(new Set(deck.map((card) => card.id)).size).toBe(108);
	});

	it("has 12 wild cards, 4 red threes and 4 black threes", () => {
		const deck = buildDecks();
		expect(deck.filter(isWild)).toHaveLength(12);
		expect(deck.filter(isRed3)).toHaveLength(4);
		expect(deck.filter(isBlack3)).toHaveLength(4);
	});

	it.each([
		["0-JK0", 50],
		["0-2S", 20],
		["0-AH", 20],
		["0-KD", 10],
		["0-8C", 10],
		["0-7H", 5],
		["0-4S", 5],
		["0-3C", 5],
	])("counts %s as %i points", (id, points) => {
		expect(cardPoints(byId(id))).toBe(points);
	});
});

describe("meld validation", () => {
	it("accepts three naturals of one rank", () => {
		expect(
			validateMeld(cardsById(["0-5H", "0-5D", "0-5S"]), CLASSIC_RULES),
		).toEqual({ ok: true, rank: "5" });
	});

	it("accepts two naturals with one wild", () => {
		expect(
			validateMeld(cardsById(["0-5H", "0-5D", "0-2S"]), CLASSIC_RULES).ok,
		).toBe(true);
	});

	it("rejects a meld with only one natural", () => {
		expect(
			validateMeld(cardsById(["0-5H", "0-2S", "1-2S"]), CLASSIC_RULES).ok,
		).toBe(false);
	});

	it("accepts more wild cards than natural cards, up to three wild cards", () => {
		const cards = cardsById(["0-5H", "0-5D", "0-2S", "1-2S", "0-2C"]);
		expect(validateMeld(cards, CLASSIC_RULES)).toEqual({ ok: true, rank: "5" });
	});

	it("rejects a fourth wild card", () => {
		const cards = cardsById([
			"0-5H",
			"0-5D",
			"0-5S",
			"0-2S",
			"1-2S",
			"0-2C",
			"0-JK0",
		]);
		expect(validateMeld(cards, CLASSIC_RULES)).toEqual({
			ok: false,
			reason: "a meld may hold at most 3 wild cards",
		});
	});

	it("rejects mixed natural ranks", () => {
		expect(
			validateMeld(cardsById(["0-5H", "0-6D", "0-5S"]), CLASSIC_RULES).ok,
		).toBe(false);
	});

	it("accepts three or four black threes, with no wild card", () => {
		expect(
			validateMeld(cardsById(["0-3C", "0-3S", "1-3C"]), CLASSIC_RULES),
		).toEqual({ ok: true, rank: "3" });
		expect(
			validateMeld(cardsById(["0-3C", "0-3S", "1-3C", "1-3S"]), CLASSIC_RULES)
				.ok,
		).toBe(true);
		expect(
			validateMeld(cardsById(["0-3C", "0-3S", "0-2H"]), CLASSIC_RULES),
		).toEqual({
			ok: false,
			reason: "a meld of black threes cannot hold wild cards",
		});
	});

	it("never melds red threes", () => {
		expect(
			validateMeld(cardsById(["0-3H", "0-3D", "1-3H"]), CLASSIC_RULES),
		).toEqual({ ok: false, reason: "red threes cannot be melded" });
	});

	it("rejects a card that does not match the meld rank", () => {
		expect(
			validateMeld(
				cardsById(["0-5H", "0-5D", "0-5S", "0-9H"]),
				CLASSIC_RULES,
				"5",
			).ok,
		).toBe(false);
	});
});

describe("initial meld thresholds", () => {
	it.each([
		[-50, 15],
		[-5, 15],
		[0, 50],
		[1495, 50],
		[1500, 90],
		[2995, 90],
		[3000, 120],
		[4995, 120],
	])("a score of %i needs %i points", (score, minimum) => {
		expect(initialMeldMinimum(CLASSIC_RULES.initialMeld, score)).toBe(minimum);
	});
});

describe("hand flow", () => {
	it("deals a hand that accounts for all 108 cards", () => {
		const hand = newHand({ teamScores: [0, 0], dealer: 0, seed: 7 });
		expect(cardTotal(hand)).toBe(108);
		expect(hand.hands.map((cards) => cards.length)).toEqual([11, 11, 11, 11]);
	});

	it("turns more starter cards while the top one is wild or a red three, and freezes the pile for both sides", () => {
		const starters = Array.from({ length: 400 }, (_, seed) =>
			newHand({ teamScores: [0, 0], dealer: 0, seed }),
		).filter((hand) => hand.pile.length > 1);
		const under = starters.flatMap((hand) => hand.pile.slice(0, -1));
		expect(under.some(isWild)).toBe(true);
		expect(under.some(isRed3)).toBe(true);
		for (const hand of starters) {
			expect(cardTotal(hand)).toBe(108);
			const top = hand.pile.at(-1);
			expect(top !== undefined && !isWild(top) && !isRed3(top)).toBe(true);
			expect(
				hand.pile.slice(0, -1).every((card) => isWild(card) || isRed3(card)),
			).toBe(true);
			const melded = scenario(hand, {
				teams: [
					{ ...hand.teams[0], initialMade: true },
					{ ...hand.teams[1], initialMade: true },
				],
			});
			expect(viewFor(melded, 0).pileFrozen).toBe(true);
			expect(viewFor(melded, 1).pileFrozen).toBe(true);
		}
	});

	it("puts a red three from the pile with the taker's red threes, with no replacement card", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-7H", "1-7H", "0-2S", "0-KS", "0-9D"]), [], []],
			pile: cardsById(["0-3H", "0-7D"]),
			teams: [
				{ ...base.teams[0], redThrees: [] },
				{ melds: [], redThrees: [], initialMade: true },
			],
		});
		expect(
			applyAction(hand, 1, { type: "takePile", cards: ["0-7H", "0-2S"] }),
		).toEqual({
			ok: false,
			reason: "a frozen pile needs two natural cards from your hand",
		});
		const taken = applyAction(hand, 1, {
			type: "takePile",
			cards: ["0-7H", "1-7H"],
		});
		if (!taken.ok) throw new Error(taken.reason);
		expect(taken.hand.teams[1].redThrees.map((card) => card.id)).toEqual([
			"0-3H",
		]);
		expect(taken.hand.hands[1]?.map((card) => card.id).sort()).toEqual(
			["0-2S", "0-9D", "0-KS"].sort(),
		);
		expect(taken.hand.stock).toHaveLength(hand.stock.length);
		expect(taken.hand.turnTaken).toEqual([]);
	});

	it("deals the same hand for the same seed", () => {
		const first = newHand({ teamScores: [0, 0], dealer: 2, seed: 99 });
		const second = newHand({ teamScores: [0, 0], dealer: 2, seed: 99 });
		expect(second.hands).toEqual(first.hands);
		expect(second.stock).toEqual(first.stock);
	});

	it("starts with the seat after the dealer, which must draw first", () => {
		const hand = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		expect(hand.turn).toBe(1);
		expect(hand.phase).toBe("draw");
		const someCard = hand.hands[1]?.[0]?.id ?? "";
		expect(
			applyAction(hand, 1, { type: "discard", card: someCard }),
		).toMatchObject({ ok: false });
	});

	it("draws one card from the stock", () => {
		const hand = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const drawn = applyAction(hand, 1, { type: "draw" });
		if (!drawn.ok) throw new Error(drawn.reason);
		const before = hand.hands[1]?.length ?? 0;
		const redThrees =
			drawn.hand.teams[1].redThrees.length - hand.teams[1].redThrees.length;
		expect(drawn.hand.hands[1]?.length).toBe(before + 1 - redThrees);
		expect(hand.stock.length - drawn.hand.stock.length).toBe(1 + redThrees);
	});

	it("rejects an action from the wrong seat", () => {
		const hand = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		expect(applyAction(hand, 0, { type: "draw" })).toMatchObject({ ok: false });
	});

	it("moves the turn clockwise after a discard", () => {
		const dealt = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		// Team 1 has already made its initial meld, so a plain discard can end the turn.
		const base = scenario(dealt, {
			teams: [dealt.teams[0], { ...dealt.teams[1], initialMade: true }],
		});
		const drawn = applyAction(base, 1, { type: "draw" });
		if (!drawn.ok) throw new Error(drawn.reason);
		const card = drawn.hand.hands[1]?.[0];
		if (card === undefined) throw new Error("no card");
		const discarded = applyAction(drawn.hand, 1, {
			type: "discard",
			card: card.id,
		});
		if (!discarded.ok) throw new Error(discarded.reason);
		expect(discarded.hand.turn).toBe(2);
		expect(discarded.hand.pile.at(-1)?.id).toBe(card.id);
		expect(cardTotal(discarded.hand)).toBe(108);
	});

	it("lets a black three be discarded, and then blocks the next player from taking the pile", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "play",
			hands: [[], cardsById(["0-3C", "0-4H"]), [], []],
			teams: [base.teams[0], { ...base.teams[1], initialMade: true }],
		});
		const discarded = applyAction(hand, 1, { type: "discard", card: "0-3C" });
		if (!discarded.ok) throw new Error(discarded.reason);
		expect(discarded.hand.pile.at(-1)?.id).toBe("0-3C");
		const blocked = scenario(discarded.hand, {
			hands: [cardsById(["0-4S", "1-4S"]), [], [], []],
		});
		expect(
			applyAction(blocked, 2, { type: "takePile", cards: ["0-4S", "1-4S"] }),
		).toMatchObject({ ok: false });
	});

	it("freezes the pile against a side that has not made its initial meld, so a natural pair must take it", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-7H", "1-7H", "0-KS"]), [], []],
			pile: cardsById(["0-9C", "0-7D"]),
		});
		// Two natural sevens take the pile; the side is still below its 50-point minimum, so the turn must go on.
		const taken = applyAction(hand, 1, {
			type: "takePile",
			cards: ["0-7H", "1-7H"],
		});
		if (!taken.ok) throw new Error(taken.reason);
		expect(taken.hand.teams[1].initialMade).toBe(false);
	});

	it("does not let a frozen pile be taken with a wild card from the hand", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-7H", "0-2S", "0-KS"]), [], []],
			pile: cardsById(["0-9C", "0-2C", "0-7D"]),
			teams: [base.teams[0], { ...base.teams[1], initialMade: true }],
		});
		expect(
			applyAction(hand, 1, { type: "takePile", cards: ["0-7H", "0-2S"] }),
		).toMatchObject({ ok: false });
	});

	it("ends the hand when the last stock card is a red three", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			stock: cardsById(["0-3H"]),
			hands: [[], cardsById(["0-KS"]), [], []],
		});
		const drawn = applyAction(hand, 1, { type: "draw" });
		if (!drawn.ok) throw new Error(drawn.reason);
		expect(drawn.hand.outcome).toEqual({ kind: "stock" });
	});

	it("continues an exhausted stock with a pile pickup, ends it at the player's choice, and ends when none is possible", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const exhausted = scenario(base, {
			turn: 0,
			phase: "play",
			stock: [],
			hands: [
				cardsById(["0-KS", "0-4H"]),
				cardsById(["0-KH", "1-KH", "0-QD"]),
				[],
				[],
			],
			pile: cardsById(["0-9C"]),
			teams: [base.teams[0], { ...base.teams[1], initialMade: true }],
		});
		const discarded = applyAction(exhausted, 0, {
			type: "discard",
			card: "0-KS",
		});
		if (!discarded.ok) throw new Error(discarded.reason);
		expect(discarded.hand.outcome).toBeNull();
		expect(discarded.hand.turn).toBe(1);
		expect(discarded.hand.phase).toBe("draw");
		expect(
			applyAction(discarded.hand, 1, {
				type: "takePile",
				cards: ["0-KH", "1-KH"],
			}).ok,
		).toBe(true);
		// The 9 matches no meld of East-West, so East may decline the pile: a draw from the empty stock ends the hand.
		expect(legalActions(discarded.hand, 1)).toContainEqual({ type: "draw" });
		const declined = applyAction(discarded.hand, 1, { type: "draw" });
		if (!declined.ok) throw new Error(declined.reason);
		expect(declined.hand.outcome).toEqual({ kind: "stock" });
		expect(declined.hand.hands).toEqual(discarded.hand.hands);

		const stuck = scenario(base, {
			turn: 0,
			phase: "play",
			stock: [],
			hands: [cardsById(["0-KS", "0-4H"]), cardsById(["0-QD"]), [], []],
			pile: cardsById(["0-9C"]),
			teams: [base.teams[0], { ...base.teams[1], initialMade: true }],
		});
		const ended = applyAction(stuck, 0, { type: "discard", card: "0-KS" });
		if (!ended.ok) throw new Error(ended.reason);
		expect(ended.hand.outcome).toEqual({ kind: "stock" });
	});

	it("refuses a pickup that leaves one card without a canasta, so an exhausted stock ends the hand", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const queens = {
			id: "m1",
			rank: "Q" as const,
			team: 1 as const,
			cards: cardsById(["0-QS", "1-QS", "0-QC"]),
		};
		// The pile is only the discarded QH, which extends East-West's queens with no card from East's hand.
		// East would keep one card, which it can neither meld nor discard without a canasta.
		const exhausted = scenario(base, {
			turn: 0,
			phase: "play",
			stock: [],
			hands: [cardsById(["0-QH", "0-4H"]), cardsById(["0-JS"]), [], []],
			pile: [],
			teams: [
				base.teams[0],
				{ ...base.teams[1], melds: [queens], initialMade: true },
			],
		});
		const discarded = applyAction(exhausted, 0, {
			type: "discard",
			card: "0-QH",
		});
		if (!discarded.ok) throw new Error(discarded.reason);
		expect(discarded.hand.outcome).toEqual({ kind: "stock" });

		const atDraw = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-JS"]), [], []],
			pile: cardsById(["0-QH"]),
			teams: [
				base.teams[0],
				{ ...base.teams[1], melds: [queens], initialMade: true },
			],
		});
		expect(
			applyAction(atDraw, 1, { type: "takePile", cards: [], extend: "m1" }),
		).toMatchObject({ ok: false });
	});

	it("forces the pickup at an exhausted stock when the unfrozen pile goes onto a meld of the side", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const nines: Meld = {
			id: "m1",
			rank: "9",
			team: 1,
			cards: cardsById(["0-9H", "0-9D", "0-9S"]),
		};
		const atDraw = (pile: readonly string[]) =>
			scenario(base, {
				turn: 1,
				phase: "draw",
				stock: [],
				hands: [[], cardsById(["0-QD", "0-4S"]), [], []],
				pile: cardsById(pile),
				teams: [
					base.teams[0],
					{ melds: [nines], redThrees: [], initialMade: true },
				],
				nextMeldNo: 2,
			});
		const forced = atDraw(["0-6C", "0-9C"]);
		expect(applyAction(forced, 1, { type: "draw" })).toEqual({
			ok: false,
			reason: "the stock is empty, and the pile goes onto your meld: take it",
		});
		expect(legalActions(forced, 1)).toEqual([
			{ type: "takePile", cards: [], extend: "m1" },
		]);
		// A wild card freezes the pile, and the side holds no natural pair of 9s, so the hand ends at the draw.
		const frozen = applyAction(atDraw(["0-2C", "0-9C"]), 1, { type: "draw" });
		expect(frozen.ok && frozen.hand.outcome).toEqual({ kind: "stock" });
	});

	it("takes back a pickup at an exhausted stock to the start of the turn, where the player may end the hand", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		// Three fives are 15 points, below the 50 that East-West need, and East cannot meld more: only resetTurn is left.
		const forced = scenario(base, {
			turn: 1,
			phase: "draw",
			stock: [],
			hands: [[], cardsById(["0-5H", "1-5H", "0-9C", "0-8D"]), [], []],
			pile: cardsById(["0-7C", "0-5D"]),
		});
		const taken = applyAction(forced, 1, {
			type: "takePile",
			cards: ["0-5H", "1-5H"],
		});
		if (!taken.ok) throw new Error(taken.reason);
		expect(legalActions(taken.hand, 1)).toEqual([{ type: "resetTurn" }]);
		const reset = applyAction(taken.hand, 1, { type: "resetTurn" });
		if (!reset.ok) throw new Error(reset.reason);
		expect(reset.hand.outcome).toBeNull();
		expect(reset.hand.phase).toBe("draw");
		expect(reset.hand.pile).toEqual(forced.pile);
		expect(reset.hand.hands).toEqual(forced.hands);
		const ended = applyAction(reset.hand, 1, { type: "draw" });
		expect(ended.ok && ended.hand.outcome).toEqual({ kind: "stock" });
	});

	it("lets a side below its minimum discard, but not end the turn with a partial meld", () => {
		const base = newHand({ teamScores: [1500, 1500], dealer: 0, seed: 1 });
		// Three fives are 15 points, below the 90 needed at a score of 1500. The hand keeps 9H, so the discard does not go out.
		const hand = scenario(base, {
			turn: 1,
			phase: "play",
			hands: [[], cardsById(["0-5H", "0-5D", "0-5S", "0-KH", "0-9H"]), [], []],
		});
		const discarded = applyAction(hand, 1, { type: "discard", card: "0-KH" });
		if (!discarded.ok) throw new Error(discarded.reason);
		expect(discarded.hand.turn).toBe(2);
		expect(discarded.hand.teams[1].initialMade).toBe(false);

		const partial = applyAction(hand, 1, {
			type: "meld",
			cards: ["0-5H", "0-5D", "0-5S"],
		});
		if (!partial.ok) throw new Error(partial.reason);
		expect(
			applyAction(partial.hand, 1, { type: "discard", card: "0-KH" }),
		).toMatchObject({ ok: false });
		const reset = applyAction(partial.hand, 1, { type: "resetTurn" });
		if (!reset.ok) throw new Error(reset.reason);
		expect(reset.hand.teams[1].melds).toHaveLength(0);
		expect(reset.hand.hands[1]).toHaveLength(5);
	});

	it("does not count the rest of the pile toward the initial meld", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-7H", "1-7H", "0-KS", "0-9D"]), [], []],
			pile: cardsById(["0-AC", "1-AC", "0-AD", "0-7D"]),
		});
		const taken = applyAction(hand, 1, {
			type: "takePile",
			cards: ["0-7H", "1-7H"],
		});
		if (!taken.ok) throw new Error(taken.reason);
		const aces = applyAction(taken.hand, 1, {
			type: "meld",
			cards: ["0-AC", "1-AC", "0-AD"],
		});
		if (!aces.ok) throw new Error(aces.reason);
		// The aces came from the pile, so the side still has 15 of the 50 it needs and cannot end the turn.
		expect(aces.hand.turnMeldPoints).toBe(15);
		expect(
			applyAction(aces.hand, 1, { type: "discard", card: "0-KS" }),
		).toMatchObject({ ok: false });
	});

	it("takes the pile with a natural pair and melds the top card", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-7H", "1-7H", "0-KS"]), [], []],
			pile: cardsById(["0-9C", "0-7D"]),
		});
		const taken = applyAction(hand, 1, {
			type: "takePile",
			cards: ["0-7H", "1-7H"],
		});
		if (!taken.ok) throw new Error(taken.reason);
		expect(taken.hand.pile).toHaveLength(0);
		expect(taken.hand.teams[1].melds).toHaveLength(1);
		expect(taken.hand.teams[1].melds[0]?.cards).toHaveLength(3);
		// The top card counts toward the initial meld with the two cards from the hand.
		expect(taken.hand.turnMeldPoints).toBe(15);
		expect(cardTotal(taken.hand)).toBe(cardTotal(hand));
	});

	it("lets a frozen pile join an existing meld only with a natural pair from the hand", () => {
		const base = newHand({ teamScores: [1500, 0], dealer: 0, seed: 1 });
		const existing = {
			id: "m1",
			rank: "7" as const,
			team: 1 as const,
			cards: cardsById(["0-7S", "1-7S", "0-7C"]),
		};
		// The 2 in the pile makes the pile frozen; the top card is a natural 7.
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-7H", "1-7H", "0-KS", "0-9H"]), [], []],
			pile: cardsById(["0-2C", "0-7D"]),
			teams: [
				base.teams[0],
				{ ...base.teams[1], melds: [existing], initialMade: true },
			],
		});
		const frozenRefusal = {
			ok: false,
			reason: "a frozen pile needs two natural cards from your hand",
		};
		expect(
			applyAction(hand, 1, { type: "takePile", cards: [], extend: "m1" }),
		).toMatchObject(frozenRefusal);
		expect(
			applyAction(hand, 1, { type: "takePile", cards: ["0-7H"], extend: "m1" }),
		).toMatchObject(frozenRefusal);
		// Pagat: the pair and the top card "could be the same rank as an existing meld ... the melds are then merged".
		const taken = applyAction(hand, 1, {
			type: "takePile",
			cards: ["0-7H", "1-7H"],
			extend: "m1",
		});
		if (!taken.ok) throw new Error(taken.reason);
		expect(taken.hand.teams[1].melds).toHaveLength(1);
		expect(taken.hand.teams[1].melds[0]?.cards).toHaveLength(6);
	});

	describe("one meld of each rank for a side", () => {
		const sevens = {
			id: "m1",
			rank: "7" as const,
			team: 1 as const,
			cards: cardsById(["0-7S", "1-7S", "0-7C"]),
		};
		const withSevens = (
			patch: Partial<Pick<HandState, "hands" | "pile" | "phase">>,
		): HandState => {
			const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
			return scenario(base, {
				turn: 1,
				teams: [
					base.teams[0],
					{ ...base.teams[1], melds: [sevens], initialMade: true },
				],
				...patch,
			});
		};
		const refusal = {
			ok: false,
			reason: "the side already has a meld of this rank; add the cards to it",
		};

		it("refuses a second meld of a rank that the side has melded, and adds the cards to the meld", () => {
			const hand = withSevens({
				phase: "play",
				hands: [
					[],
					cardsById(["0-7H", "1-7H", "0-7D", "0-KS", "0-9H"]),
					[],
					[],
				],
			});
			const cards = ["0-7H", "1-7H", "0-7D"];
			expect(applyAction(hand, 1, { type: "meld", cards })).toMatchObject(
				refusal,
			);
			const legal = legalActions(hand, 1);
			expect(legal).not.toContainEqual({ type: "meld", cards });
			expect(legal).toContainEqual({ type: "extend", meldId: "m1", cards });
			const extended = applyAction(hand, 1, {
				type: "extend",
				meldId: "m1",
				cards,
			});
			if (!extended.ok) throw new Error(extended.reason);
			expect(extended.hand.teams[1].melds).toHaveLength(1);
			expect(extended.hand.teams[1].melds[0]?.cards).toHaveLength(6);
		});

		it("refuses a second meld of that rank in the same turn as the first", () => {
			const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
			const hand = scenario(base, {
				turn: 1,
				phase: "play",
				hands: [
					[],
					cardsById(["0-KH", "1-KH", "0-KS", "1-KS", "0-KD", "1-KD", "0-9H"]),
					[],
					[],
				],
			});
			const first = applyAction(hand, 1, {
				type: "meld",
				cards: ["0-KH", "1-KH", "0-KS"],
			});
			if (!first.ok) throw new Error(first.reason);
			expect(
				applyAction(first.hand, 1, {
					type: "meld",
					cards: ["1-KS", "0-KD", "1-KD"],
				}),
			).toMatchObject(refusal);
		});

		it("takes the pile with a pair onto the side's meld of that rank, not into a second meld", () => {
			const hand = withSevens({
				phase: "draw",
				hands: [[], cardsById(["0-7H", "1-7H", "0-KS", "0-9H"]), [], []],
				pile: cardsById(["0-9C", "0-7D"]),
			});
			const cards = ["0-7H", "1-7H"];
			expect(applyAction(hand, 1, { type: "takePile", cards })).toMatchObject(
				refusal,
			);
			const legal = legalActions(hand, 1);
			expect(legal).not.toContainEqual({ type: "takePile", cards });
			expect(legal).toContainEqual({ type: "takePile", cards, extend: "m1" });
			const taken = applyAction(hand, 1, {
				type: "takePile",
				cards,
				extend: "m1",
			});
			if (!taken.ok) throw new Error(taken.reason);
			expect(taken.hand.teams[1].melds).toHaveLength(1);
			expect(taken.hand.teams[1].melds[0]?.cards).toHaveLength(6);
		});
	});

	it("refuses a meld or an extension that leaves one card while the side has no canasta", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "play",
			hands: [[], cardsById(["0-KH", "0-KD", "0-KS", "0-9H", "0-9D"]), [], []],
		});
		const kings = applyAction(hand, 1, {
			type: "meld",
			cards: ["0-KH", "0-KD", "0-KS"],
		});
		if (!kings.ok) throw new Error(kings.reason);
		const reason =
			"the move would leave one card, which needs a canasta to go out";
		expect(
			applyAction(
				scenario(base, {
					turn: 1,
					phase: "play",
					hands: [[], cardsById(["0-KH", "0-KD", "0-KS", "0-9H"]), [], []],
				}),
				1,
				{ type: "meld", cards: ["0-KH", "0-KD", "0-KS"] },
			),
		).toEqual({ ok: false, reason });
		const joined = applyAction(
			{ ...kings.hand, hands: [[], cardsById(["0-9H", "1-KH"]), [], []] },
			1,
			{
				type: "extend",
				meldId: kings.hand.teams[1].melds[0]?.id ?? "",
				cards: ["1-KH"],
			},
		);
		expect(joined).toEqual({ ok: false, reason });
	});

	it("refuses to go out without a canasta", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "play",
			hands: [[], cardsById(["0-5H", "0-5D", "0-5S"]), [], []],
		});
		const result = applyAction(hand, 1, {
			type: "meld",
			cards: ["0-5H", "0-5D", "0-5S"],
		});
		expect(result).toMatchObject({
			ok: false,
			reason: "the side needs a canasta to go out",
		});
	});

	describe("black threes", () => {
		const threes = ["0-3C", "0-3S", "1-3C"];
		const canasta: Meld = {
			id: "m1",
			rank: "K",
			team: 1,
			cards: cardsById([
				"0-KH",
				"0-KD",
				"0-KS",
				"0-KC",
				"1-KH",
				"1-KD",
				"1-KS",
			]),
		};
		/** Seat 1 has drawn; its side has made its initial meld, with or without a canasta. */
		const holding = (own: readonly string[], melds: Meld[] = [canasta]) =>
			scenario(newHand({ teamScores: [0, 0], dealer: 0, seed: 1 }), {
				turn: 1,
				phase: "play",
				hands: [[], cardsById(own), [], []],
				teams: [
					{ melds: [], redThrees: [], initialMade: false },
					{ melds, redThrees: [], initialMade: true },
				],
				nextMeldNo: 2,
				meldedSeats: [1, 3],
			});

		it("may be melded by a player who goes out in this turn", () => {
			const melded = applyAction(holding([...threes, "0-9H"]), 1, {
				type: "meld",
				cards: threes,
			});
			if (!melded.ok) throw new Error(melded.reason);
			expect(melded.hand.teams[1].melds.at(-1)?.rank).toBe("3");
			const out = applyAction(melded.hand, 1, {
				type: "discard",
				card: "0-9H",
			});
			if (!out.ok) throw new Error(out.reason);
			expect(out.hand.outcome).toEqual({
				kind: "out",
				seat: 1,
				concealed: false,
			});
			const lastMeld = applyAction(holding(threes), 1, {
				type: "meld",
				cards: threes,
			});
			expect(lastMeld.ok && lastMeld.hand.outcome?.kind).toBe("out");
		});

		it("cannot be melded by a player who keeps more cards than the discard", () => {
			const hand = holding([...threes, "0-9H", "0-9D"]);
			expect(applyAction(hand, 1, { type: "meld", cards: threes })).toEqual({
				ok: false,
				reason: "black threes can be melded only when going out",
			});
			expect(legalActions(hand, 1)).not.toContainEqual({
				type: "meld",
				cards: threes,
			});
		});

		it("cannot be melded while the side has no canasta", () => {
			const kings: Meld = { ...canasta, cards: canasta.cards.slice(0, 3) };
			expect(
				applyAction(holding([...threes, "0-9H"], [kings]), 1, {
					type: "meld",
					cards: threes,
				}).ok,
			).toBe(false);
		});

		it("are offered as a meld when they let the player go out", () => {
			expect(legalActions(holding([...threes, "0-9H"]), 1)).toContainEqual({
				type: "meld",
				cards: threes,
			});
		});
	});

	describe("going out concealed", () => {
		/** Applies the actions in order and returns the last step; an earlier refusal throws. */
		function play(hand: HandState, seat: Seat, actions: readonly Action[]) {
			let current = hand;
			let step: ReturnType<typeof applyAction> = { ok: true, hand };
			for (const action of actions) {
				step = applyAction(current, seat, action);
				if (!step.ok && action !== actions.at(-1)) throw new Error(step.reason);
				if (step.ok) current = step.hand;
			}
			return step;
		}
		const fives = ["0-5H", "0-5D", "0-5S", "0-5C", "1-5H", "1-5D", "1-5S"];
		const layFives = (meldId: string): Action[] => [
			{ type: "meld", cards: fives.slice(0, 3) },
			{ type: "extend", meldId, cards: fives.slice(3) },
		];
		const kings: Meld = {
			id: "m1",
			rank: "K",
			team: 1,
			cards: cardsById(["0-KH", "0-KD", "0-KS"]),
		};
		/** Seat 1 has drawn from the stock; its partner, seat 3, melded kings in an earlier turn. */
		const afterPartnerMeld = (own: readonly string[], melded: Seat[] = [3]) =>
			scenario(newHand({ teamScores: [0, 0], dealer: 0, seed: 1 }), {
				turn: 1,
				phase: "play",
				hands: [[], cardsById(own), [], []],
				teams: [
					{ melds: [], redThrees: [], initialMade: false },
					{ melds: [kings], redThrees: [], initialMade: true },
				],
				nextMeldNo: 2,
				meldedSeats: melded,
			});
		const outcome = (step: ReturnType<typeof applyAction>) =>
			step.ok ? step.hand.outcome : step.reason;

		it("scores concealed for a player who melds for the first time and lays a canasta, after the partner melded", () => {
			const hand = afterPartnerMeld([...fives, "0-9C"]);
			expect(
				outcome(
					play(hand, 1, [...layFives("m2"), { type: "discard", card: "0-9C" }]),
				),
			).toEqual({ kind: "out", seat: 1, concealed: true });
		});

		it("is not concealed when the player adds cards to the partner's meld", () => {
			const hand = afterPartnerMeld([...fives, "1-KH", "0-9C"]);
			expect(
				outcome(
					play(hand, 1, [
						...layFives("m2"),
						{ type: "extend", meldId: "m1", cards: ["1-KH"] },
						{ type: "discard", card: "0-9C" },
					]),
				),
			).toEqual({ kind: "out", seat: 1, concealed: false });
		});

		it("is not concealed when the player melded in an earlier turn of the hand", () => {
			const first = play(
				scenario(newHand({ teamScores: [-10, -10], dealer: 0, seed: 1 }), {
					turn: 1,
					phase: "play",
					hands: [
						[],
						cardsById(["0-KH", "0-KD", "0-KS", "0-9C", "0-8C"]),
						[],
						[],
					],
				}),
				1,
				[
					{ type: "meld", cards: ["0-KH", "0-KD", "0-KS"] },
					{ type: "discard", card: "0-9C" },
				],
			);
			if (!first.ok) throw new Error(first.reason);
			const later = scenario(first.hand, {
				turn: 1,
				phase: "play",
				hands: [[], cardsById([...fives, "1-9C"]), [], []],
			});
			expect(
				outcome(
					play(later, 1, [
						...layFives("m2"),
						{ type: "discard", card: "1-9C" },
					]),
				),
			).toEqual({ kind: "out", seat: 1, concealed: false });
		});

		it("is not concealed when the player lays no canasta of their own", () => {
			const hand = afterPartnerMeld(["0-5H", "0-5D", "0-5S", "0-9C"]);
			const partnerCanasta = scenario(hand, {
				teams: [
					hand.teams[0],
					{
						...hand.teams[1],
						melds: [
							{
								...kings,
								cards: cardsById([
									"0-KH",
									"0-KD",
									"0-KS",
									"0-KC",
									"1-KH",
									"1-KD",
									"1-KS",
								]),
							},
						],
					},
				],
			});
			expect(
				outcome(
					play(partnerCanasta, 1, [
						{ type: "meld", cards: ["0-5H", "0-5D", "0-5S"] },
						{ type: "discard", card: "0-9C" },
					]),
				),
			).toEqual({ kind: "out", seat: 1, concealed: false });
		});

		const unmelded = (phase: "draw" | "play", pile: readonly string[]) =>
			scenario(newHand({ teamScores: [0, 0], dealer: 0, seed: 1 }), {
				turn: 1,
				phase,
				pile: cardsById(pile),
				hands: [[], cardsById([...fives, "0-9C"]), [], []],
				teams: [
					{ melds: [], redThrees: [], initialMade: false },
					{ melds: [], redThrees: [], initialMade: false },
				],
				meldedSeats: [],
			});

		it("needs no initial minimum to go out concealed after a draw from the stock", () => {
			// Seven fives are 35 points, below the 50 that a score of 0 needs.
			expect(
				outcome(
					play(unmelded("play", ["0-KC"]), 1, [
						...layFives("m1"),
						{ type: "discard", card: "0-9C" },
					]),
				),
			).toEqual({ kind: "out", seat: 1, concealed: true });
		});

		it("still needs the initial minimum to go out after taking the pile", () => {
			const hand = unmelded("draw", ["1-5C"]);
			expect(
				outcome(
					play(hand, 1, [
						{ type: "takePile", cards: ["0-5H", "0-5D"] },
						{ type: "extend", meldId: "m1", cards: fives.slice(2) },
						{ type: "discard", card: "0-9C" },
					]),
				),
			).toBe("the side has not made its initial meld");
		});
	});

	it("reports resetTurn only after a meld or a pickup in the turn", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			hands: [[], cardsById(["0-KH", "1-KH", "0-KS", "0-9H"]), [], []],
			stock: cardsById(["0-4C", "0-6C"]),
		});
		const canReset = (state: HandState): boolean =>
			legalActions(state, 1).some((action) => action.type === "resetTurn");
		expect(canReset(hand)).toBe(false);
		const drawn = applyAction(hand, 1, { type: "draw" });
		if (!drawn.ok) throw new Error(drawn.reason);
		// The drawn card stays drawn, so there is nothing to take back yet.
		expect(canReset(drawn.hand)).toBe(false);
		const melded = applyAction(drawn.hand, 1, {
			type: "meld",
			cards: ["0-KH", "1-KH", "0-KS"],
		});
		if (!melded.ok) throw new Error(melded.reason);
		expect(canReset(melded.hand)).toBe(true);
	});

	it("keeps the card drawn from the stock when the turn's melds are taken back", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			hands: [[], cardsById(["0-KH", "1-KH", "0-KS", "0-9H"]), [], []],
			stock: cardsById(["0-4C", "0-6C"]),
		});
		const drawn = applyAction(hand, 1, { type: "draw" });
		if (!drawn.ok) throw new Error(drawn.reason);
		const melded = applyAction(drawn.hand, 1, {
			type: "meld",
			cards: ["0-KH", "1-KH", "0-KS"],
		});
		if (!melded.ok) throw new Error(melded.reason);
		const reset = applyAction(melded.hand, 1, { type: "resetTurn" });
		if (!reset.ok) throw new Error(reset.reason);
		// The player may not put the card back and take the pile instead.
		expect(reset.hand.phase).toBe("play");
		expect(reset.hand.stock.map((card) => card.id)).toEqual(["0-6C"]);
		expect(reset.hand.hands[1]?.map((card) => card.id)).toContain("0-4C");
		expect(reset.hand.teams[1].melds).toHaveLength(0);
		expect(
			legalActions(reset.hand, 1).some((action) => action.type === "takePile"),
		).toBe(false);
	});

	it("takes a pile pickup back to the start of the turn, because the pile hides no card", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-7H", "1-7H", "0-KS"]), [], []],
			pile: cardsById(["0-9C", "0-7D"]),
		});
		const taken = applyAction(hand, 1, {
			type: "takePile",
			cards: ["0-7H", "1-7H"],
		});
		if (!taken.ok) throw new Error(taken.reason);
		const reset = applyAction(taken.hand, 1, { type: "resetTurn" });
		if (!reset.ok) throw new Error(reset.reason);
		expect(reset.hand.phase).toBe("draw");
		expect(reset.hand.pile).toHaveLength(2);
		expect(reset.hand.hands[1]).toHaveLength(3);
	});
});

describe("actions for a selection of cards", () => {
	const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
	const sevens = ["0-7H", "1-7H", "0-7S", "1-7S", "0-2S"];
	/** Seat 1 holds four 7s, a deuce and two more cards; its side has melded, with the given melds. */
	const holding = (phase: "draw" | "play", melds: Meld[]): HandState =>
		scenario(base, {
			turn: 1,
			phase,
			hands: [[], cardsById([...sevens, "0-KS", "0-9D"]), [], []],
			pile: cardsById(["0-4C", "0-7D"]),
			teams: [
				{ ...base.teams[0], redThrees: [] },
				{ melds, redThrees: [], initialMade: true },
			],
		});
	const nines: Meld = {
		id: "m1",
		rank: "9",
		team: 1,
		cards: cardsById(["0-9C", "1-9C", "0-9H"]),
	};
	const sevenMeld: Meld = {
		id: "m2",
		rank: "7",
		team: 1,
		cards: cardsById(["0-7C", "1-7C", "0-7D"]),
	};

	it("melds five selected cards at once, which the bounded legal actions do not list", () => {
		const hand = holding("play", [nines]);
		expect(actionsWithCards(hand, 1, sevens)).toEqual([
			{ type: "meld", cards: sevens },
		]);
		expect(
			legalActions(hand, 1).some(
				(action) => action.type === "meld" && action.cards.length === 5,
			),
		).toBe(false);
	});

	it("adds five selected cards to the side's meld of their rank", () => {
		expect(
			actionsWithCards(holding("play", [nines, sevenMeld]), 1, sevens),
		).toEqual([{ type: "extend", meldId: "m2", cards: sevens }]);
	});

	it("takes the pile with four selected cards, as a new meld or onto the side's meld", () => {
		const four = sevens.slice(0, 4);
		expect(actionsWithCards(holding("draw", [nines]), 1, four)).toEqual([
			{ type: "takePile", cards: four },
		]);
		expect(actionsWithCards(holding("draw", [sevenMeld]), 1, four)).toEqual([
			{ type: "takePile", cards: four, extend: "m2" },
		]);
	});

	it("offers nothing for a selection that no action accepts", () => {
		expect(actionsWithCards(holding("play", []), 1, ["0-7H", "0-KS"])).toEqual(
			[],
		);
		expect(actionsWithCards(holding("play", []), 1, [])).toEqual([]);
	});
});

describe("cards taken this turn", () => {
	it("shows the drawn card to the seat on turn only, until its turn ends", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-KH", "1-KH", "0-KS", "0-9H"]), [], []],
			stock: cardsById(["0-3H", "0-4C", "0-6C"]),
		});
		expect(viewFor(hand, 1).taken).toEqual([]);
		const drawn = applyAction(hand, 1, { type: "draw" });
		if (!drawn.ok) throw new Error(drawn.reason);
		// The red three goes to the table, so only its replacement is new in the hand.
		expect(viewFor(drawn.hand, 1).taken).toEqual(["0-4C"]);
		expect(viewFor(drawn.hand, 0).taken).toEqual([]);
		expect(viewFor(drawn.hand, 3).taken).toEqual([]);
		const melded = applyAction(drawn.hand, 1, {
			type: "meld",
			cards: ["0-KH", "1-KH", "0-KS"],
		});
		if (!melded.ok) throw new Error(melded.reason);
		const reset = applyAction(melded.hand, 1, { type: "resetTurn" });
		if (!reset.ok) throw new Error(reset.reason);
		expect(viewFor(reset.hand, 1).taken).toEqual(["0-4C"]);
		const discarded = applyAction(reset.hand, 1, {
			type: "discard",
			card: "0-9H",
		});
		if (!discarded.ok) throw new Error(discarded.reason);
		expect(viewFor(discarded.hand, 1).taken).toEqual([]);
		expect(viewFor(discarded.hand, 2).taken).toEqual([]);
	});

	it("shows the pile cards that a pickup put into the hand, and forgets them when the pickup is taken back", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "draw",
			hands: [[], cardsById(["0-7H", "1-7H", "0-KS"]), [], []],
			pile: cardsById(["0-9C", "0-QD", "0-7D"]),
		});
		const taken = applyAction(hand, 1, {
			type: "takePile",
			cards: ["0-7H", "1-7H"],
		});
		if (!taken.ok) throw new Error(taken.reason);
		// The top card went into the meld; the rest of the pile is in the hand.
		expect(viewFor(taken.hand, 1).taken).toEqual(["0-9C", "0-QD"]);
		expect(viewFor(taken.hand, 2).taken).toEqual([]);
		const reset = applyAction(taken.hand, 1, { type: "resetTurn" });
		if (!reset.ok) throw new Error(reset.reason);
		expect(viewFor(reset.hand, 1).taken).toEqual([]);
	});
});

describe("scoring", () => {
	it("subtracts the points of the cards left in each side's hands", () => {
		const hand = newHand({ teamScores: [0, 0], dealer: 0, seed: 3 });
		const [first, second] = scoreHand(hand);
		const sideSum = (seats: readonly Seat[]) =>
			seats
				.flatMap((seat) => hand.hands[seat] ?? [])
				.reduce((sum, card) => sum + cardPoints(card), 0);
		expect(first.handPenalty).toBe(-sideSum([0, 2]));
		expect(second.handPenalty).toBe(-sideSum([1, 3]));
	});

	it("adds the out bonus, plus the concealed bonus when the side made no meld before going out", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand: HandState = {
			...base,
			hands: [[], [], [], []],
			outcome: { kind: "out", seat: 0, concealed: true },
		};
		const [first] = scoreHand(hand);
		expect(first.outBonus).toBe(
			CLASSIC_RULES.outBonus + CLASSIC_RULES.concealedOutBonus,
		);
	});

	it("doubles the red three score when one side holds all four: 800 with a meld, -800 without", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const reds = cardsById(["0-3H", "0-3D", "1-3H", "1-3D"]);
		const withReds = (initialMade: boolean): HandState => ({
			...base,
			hands: [[], [], [], []],
			teams: [
				{ ...base.teams[0], melds: [], redThrees: reds, initialMade },
				{ ...base.teams[1], melds: [], redThrees: [] },
			],
		});
		expect(scoreHand(withReds(true))[0].redThrees).toBe(800);
		expect(scoreHand(withReds(false))[0].redThrees).toBe(-800);
		const three = {
			...withReds(true),
			teams: [
				{ ...withReds(true).teams[0], redThrees: reds.slice(0, 3) },
				base.teams[1],
			] as const,
		};
		expect(scoreHand(three)[0].redThrees).toBe(300);
	});
});

describe("match end", () => {
	/** The match after a hand that ends at the exhausted stock, with the final scores given. */
	function settledAt(finals: readonly [number, number]): MatchState {
		const match = startMatch(5);
		const hand: HandState = { ...match.hand, outcome: { kind: "stock" } };
		const [first, second] = scoreHand(hand);
		const step = settleHand({
			...match,
			hand,
			scores: [finals[0] - first.total, finals[1] - second.total],
		});
		if (!step.ok) throw new Error(step.reason);
		expect(step.match.scores).toEqual(finals);
		return step.match;
	}

	it("goes on while both sides are below the target", () => {
		expect(settledAt([4990, 4000]).winner).toBeNull();
	});

	it("is won by the higher total when one or both sides reach the target", () => {
		expect(settledAt([5000, 4000]).winner).toBe(0);
		expect(settledAt([5100, 5200]).winner).toBe(1);
	});

	it("goes on with another hand when both sides reach the target with equal totals", () => {
		expect(settledAt([5100, 5100]).winner).toBeNull();
	});
});

describe("random play", () => {
	it("keeps all cards accounted for and reaches the end of every hand", () => {
		for (let seed = 1; seed <= 100; seed++) {
			let hand = newHand({
				teamScores: [0, 0],
				dealer: (seed % 4) as Seat,
				seed,
			});
			let steps = 0;
			let pick = seed * 7919;
			while (hand.outcome === null && steps < 5000) {
				const seat = hand.turn;
				const options = legalActions(hand, seat);
				expect(
					options.length,
					`seed ${seed} step ${steps}: no legal action`,
				).toBeGreaterThan(0);
				pick = (pick * 1103515245 + 12345) >>> 0;
				const choice = options[(pick >>> 16) % options.length];
				if (choice === undefined) throw new Error("empty option list");
				const step = applyAction(hand, seat, choice);
				expect(
					step.ok,
					`seed ${seed}: ${JSON.stringify(choice)} was listed but refused`,
				).toBe(true);
				if (!step.ok) return;
				hand = step.hand;
				expect(cardTotal(hand)).toBe(108);
				steps++;
			}
			expect(
				hand.outcome,
				`seed ${seed} did not finish in ${steps} steps`,
			).not.toBeNull();
		}
	}, 60_000);
});
