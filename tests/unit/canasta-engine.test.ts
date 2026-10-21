import { describe, expect, it } from "vitest";
import {
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
	newHand,
	type Seat,
	scoreHand,
	validateMeld,
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
		Pick<HandState, "hands" | "stock" | "pile" | "turn" | "phase" | "teams">
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

	it("rejects more wild cards than natural cards", () => {
		const cards = cardsById(["0-5H", "0-5D", "0-2S", "1-2S", "0-2C"]);
		expect(validateMeld(cards, CLASSIC_RULES)).toEqual({
			ok: false,
			reason: "wild cards cannot outnumber natural cards",
		});
	});

	it("rejects mixed natural ranks", () => {
		expect(
			validateMeld(cardsById(["0-5H", "0-6D", "0-5S"]), CLASSIC_RULES).ok,
		).toBe(false);
	});

	it("never melds threes", () => {
		expect(
			validateMeld(cardsById(["0-3C", "0-3S", "1-3C"]), CLASSIC_RULES).ok,
		).toBe(false);
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
		[0, 15],
		[1499, 15],
		[1500, 50],
		[2999, 50],
		[3000, 90],
		[4999, 90],
		[5000, 120],
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

	it("blocks discarding a black three unless it is the last card", () => {
		const base = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		const hand = scenario(base, {
			turn: 1,
			phase: "play",
			hands: [[], cardsById(["0-3C", "0-4H"]), [], []],
			teams: [base.teams[0], { ...base.teams[1], initialMade: true }],
		});
		expect(
			applyAction(hand, 1, { type: "discard", card: "0-3C" }),
		).toMatchObject({ ok: false });
	});

	it("lets a side below its minimum discard, but not end the turn with a partial meld", () => {
		const base = newHand({ teamScores: [1500, 1500], dealer: 0, seed: 1 });
		// Three fives are 15 points, below the 50 needed at a score of 1500. The hand keeps 9H, so the discard does not go out.
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
		// The three sevens are worth 15, but only the two cards from the hand count toward the initial meld.
		expect(taken.hand.turnMeldPoints).toBe(10);
		expect(cardTotal(taken.hand)).toBe(cardTotal(hand));
	});

	it("does not let a frozen pile extend an existing meld", () => {
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
			hands: [[], cardsById(["0-7H", "0-KS"]), [], []],
			pile: cardsById(["0-2C", "0-7D"]),
			teams: [
				base.teams[0],
				{ ...base.teams[1], melds: [existing], initialMade: true },
			],
		});
		expect(
			applyAction(hand, 1, { type: "takePile", cards: ["0-7H"], extend: "m1" }),
		).toMatchObject({
			ok: false,
			reason: "a frozen pile cannot extend an existing meld",
		});
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

	it("reports resetTurn only after an action in the turn", () => {
		const hand = newHand({ teamScores: [0, 0], dealer: 0, seed: 1 });
		expect(
			legalActions(hand, 1).some((action) => action.type === "resetTurn"),
		).toBe(false);
		const drawn = applyAction(hand, 1, { type: "draw" });
		if (!drawn.ok) throw new Error(drawn.reason);
		expect(
			legalActions(drawn.hand, 1).some((action) => action.type === "resetTurn"),
		).toBe(true);
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
});

describe("random play", () => {
	it("keeps all cards accounted for and reaches the end of every hand", () => {
		for (let seed = 1; seed <= 2000; seed++) {
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
