import { describe, expect, it } from "vitest";
import { solve } from "../../src/bot/solver";
import {
	type Action,
	applyAction,
	buildDeck,
	type HandState,
	legalActions,
	newHand,
	penaltyOf,
	playAllowed,
	type RulePreset,
	type RummyRules,
	rulesFor,
	settle,
	viewFor,
} from "../../src/rummy";

const GAMERULES = rulesFor("gamerules", 4, false);
const WIKIPEDIA = rulesFor("wikipedia", 4, false);
const MACHIAVELLI = rulesFor("machiavelli", 4, false);

/** A hand in a chosen position: seat 0 is on turn in the start phase unless the fields say otherwise. */
function position(
	rules: RummyRules,
	fields: Partial<HandState> & Pick<HandState, "hands">,
): HandState {
	const base = newHand({
		rules,
		players: fields.hands.length,
		dealer: fields.hands.length - 1,
		seed: 1,
	});
	return {
		...base,
		stock: ["1-9C", "1-9D", "1-9H"],
		table: [],
		opened: fields.hands.map(() => true),
		...fields,
	};
}

function step(hand: HandState, seat: number, action: Action): HandState {
	const result = applyAction(hand, seat, action);
	if (!result.ok) throw new Error(result.reason);
	return result.hand;
}

function reason(hand: HandState, seat: number, action: Action): string {
	const result = applyAction(hand, seat, action);
	if (result.ok) throw new Error(`accepted ${JSON.stringify(action)}`);
	return result.reason;
}

const play = (...melds: string[]): Action => ({
	type: "play",
	melds: melds.map((meld) => meld.split(" ")),
});

describe("newHand", () => {
	it.each([2, 3, 6])(
		"deals the preset's hand size to %i players",
		(players) => {
			for (const rules of [GAMERULES, WIKIPEDIA]) {
				const hand = newHand({ rules, players, dealer: 0, seed: 7 });
				expect(hand.hands).toHaveLength(players);
				for (const cards of hand.hands)
					expect(cards).toHaveLength(rules.handSize);
				const all = [...hand.hands.flat(), ...hand.stock];
				expect(new Set(all).size).toBe(all.length);
				expect([...all].sort()).toEqual(
					buildDeck(rules.jokers)
						.map((card) => card.id)
						.sort(),
				);
				expect(hand.turn).toBe(1 % players);
				expect(hand.phase).toBe("start");
				expect(hand.table).toEqual([]);
				expect(
					hand.opened.every((open) => open === (rules.openingPoints === 0)),
				).toBe(true);
			}
		},
	);

	it("refuses a player count outside 2 to 6", () => {
		expect(() =>
			newHand({ rules: GAMERULES, players: 1, dealer: 0, seed: 1 }),
		).toThrow();
		expect(() =>
			newHand({ rules: GAMERULES, players: 7, dealer: 0, seed: 1 }),
		).toThrow();
		expect(() =>
			newHand({ rules: GAMERULES, players: 3, dealer: 3, seed: 1 }),
		).toThrow();
	});
});

describe("turn phases", () => {
	const hands = [
		["0-4H", "0-5H", "0-6H", "0-KS"],
		["0-2C", "0-3C"],
	];

	it.each<RulePreset>(["gamerules", "wikipedia"])(
		"%s: a play may be followed by a draw or the end of the turn",
		(preset) => {
			const rules = rulesFor(preset, 4, false);
			const hand = position(rules, { hands });
			expect(reason(hand, 0, { type: "end" })).toMatch(/draw/);
			const played = step(hand, 0, play("0-4H 0-5H 0-6H"));
			expect(played.phase).toBe("played");
			expect(played.turn).toBe(0);
			expect(reason(played, 0, play("0-4H 0-5H 0-6H"))).toMatch(/already/);
			const ended = step(played, 0, { type: "end" });
			expect([ended.turn, ended.phase]).toEqual([1, "start"]);
			const drew = step(played, 0, { type: "draw" });
			expect([drew.turn, drew.phase]).toEqual([1, "start"]);
			expect(drew.hands[0]).toEqual(["0-KS", "1-9C"]);
		},
	);

	it.each<RulePreset>(["gamerules", "wikipedia"])(
		"%s: a draw may be followed by a play, which ends the turn, or by the end",
		(preset) => {
			const rules = rulesFor(preset, 4, false);
			const hand = position(rules, { hands });
			const drew = step(hand, 0, { type: "draw" });
			expect([drew.turn, drew.phase]).toEqual([0, "drew"]);
			expect(drew.stock).toEqual(["1-9D", "1-9H"]);
			expect(reason(drew, 0, { type: "draw" })).toMatch(/already/);
			const played = step(drew, 0, play("0-4H 0-5H 0-6H"));
			expect([played.turn, played.phase]).toEqual([1, "start"]);
			const ended = step(drew, 0, { type: "end" });
			expect([ended.turn, ended.phase]).toEqual([1, "start"]);
		},
	);

	it("machiavelli: a play or a draw ends the turn", () => {
		const hand = position(MACHIAVELLI, { hands });
		const played = step(hand, 0, play("0-4H 0-5H 0-6H"));
		expect([played.turn, played.phase]).toEqual([1, "start"]);
		const drew = step(hand, 0, { type: "draw" });
		expect([drew.turn, drew.phase]).toEqual([1, "start"]);
		expect(reason(hand, 0, { type: "end" })).toMatch(/draw/);
	});

	it("lists the legal actions other than a play", () => {
		const hand = position(GAMERULES, { hands });
		expect(legalActions(hand, 0)).toEqual([{ type: "draw" }]);
		expect(legalActions(hand, 1)).toEqual([]);
		expect(playAllowed(hand, 0)).toBe(true);
		expect(playAllowed(hand, 1)).toBe(false);
		const played = step(hand, 0, play("0-4H 0-5H 0-6H"));
		expect(legalActions(played, 0)).toEqual([
			{ type: "draw" },
			{ type: "end" },
		]);
		expect(playAllowed(played, 0)).toBe(false);
		const drew = step(hand, 0, { type: "draw" });
		expect(legalActions(drew, 0)).toEqual([{ type: "end" }]);
		expect(playAllowed(drew, 0)).toBe(true);
	});

	it("refuses an action from a seat that is not on turn", () => {
		const hand = position(GAMERULES, { hands });
		expect(reason(hand, 1, { type: "draw" })).toMatch(/turn/);
		expect(reason(hand, 5, { type: "draw" })).toMatch(/turn/);
	});
});

describe("play", () => {
	it("keeps the id of an unchanged meld and gives new ids to changed and new melds", () => {
		const hand = position(WIKIPEDIA, {
			hands: [["0-7H", "0-9C", "0-9D", "0-9S"], ["0-2C"]],
			table: [
				{ id: "m1", cards: ["0-4H", "0-5H", "0-6H"] },
				{ id: "m2", cards: ["0-KC", "0-KD", "0-KS"] },
			],
			nextMeldNo: 3,
		});
		const after = step(
			hand,
			0,
			play("0-KS 0-KC 0-KD", "0-6H 0-5H 0-4H 0-7H", "0-9S 0-9C 0-9D"),
		);
		expect(after.table).toEqual([
			{ id: "m2", cards: ["0-KC", "0-KD", "0-KS"] },
			{ id: "m3", cards: ["0-4H", "0-5H", "0-6H", "0-7H"] },
			{ id: "m4", cards: ["0-9C", "0-9D", "0-9S"] },
		]);
		expect(after.nextMeldNo).toBe(5);
		expect(after.hands[0]).toEqual([]);
		expect(after.lastPlay).toEqual({
			seat: 0,
			cards: ["0-7H", "0-9C", "0-9D", "0-9S"],
			meldIds: ["m3", "m4"],
		});
	});

	it("lets a play rearrange the table and move a joker", () => {
		const hand = position(GAMERULES, {
			hands: [["0-5H", "0-9C", "0-9D", "0-2S"], ["0-2C"]],
			table: [{ id: "m1", cards: ["0-4H", "JK0", "0-6H"] }],
			nextMeldNo: 2,
		});
		const after = step(hand, 0, play("0-4H 0-5H 0-6H", "0-9C 0-9D JK0"));
		expect(after.table.map((meld) => meld.cards)).toEqual([
			["0-4H", "0-5H", "0-6H"],
			["0-9C", "0-9D", "JK0"],
		]);
		expect(after.hands[0]).toEqual(["0-2S"]);
	});

	it.each([
		["a table card left out", play("0-4H 0-5H 0-6H"), /table card 0-7H/],
		["an invalid meld", play("0-4H 0-5H 0-6H 0-7H", "0-9C 0-9D 0-2S"), /9C/],
		[
			"no hand card",
			play("0-4H 0-5H", "0-6H 0-7H"),
			/at least three|hand card/,
		],
		["only table cards", play("0-4H 0-5H 0-6H 0-7H"), /hand card/],
		["a card twice", play("0-4H 0-5H 0-6H 0-7H", "0-9C 0-9D 0-9C"), /twice/],
		[
			"a card from another hand",
			play("0-4H 0-5H 0-6H 0-7H 0-8H"),
			/not in your hand/,
		],
		["an unknown card", play("0-4H 0-5H 0-6H 0-7H", "0-9C 0-9D JK5"), /JK5/],
		[
			"a string that is not a card",
			play("0-4H 0-5H 0-6H 0-7H", "0-9C 0-9D xx"),
			/xx/,
		],
	])("refuses %s", (_, action, expected) => {
		const hand = position(GAMERULES, {
			hands: [["0-9C", "0-9D", "0-2S"], ["0-8H"]],
			table: [{ id: "m1", cards: ["0-4H", "0-5H", "0-6H", "0-7H"] }],
			nextMeldNo: 2,
		});
		expect(reason(hand, 0, action)).toMatch(expected);
	});

	it("applies the joker limit of the preset", () => {
		const hands = [["0-4H", "JK0", "JK1", "0-2S"], ["0-2C"]];
		expect(
			reason(position(GAMERULES, { hands }), 0, play("0-4H JK0 JK1")),
		).toMatch(/one joker/);
		expect(
			step(position(WIKIPEDIA, { hands }), 0, play("0-4H JK0 JK1")).table,
		).toHaveLength(1);
	});

	it("allows a run around the corner only in the wikipedia preset", () => {
		const hands = [["0-KH", "0-AH", "0-2H", "0-2S"], ["0-2C"]];
		expect(
			reason(position(GAMERULES, { hands }), 0, play("0-KH 0-AH 0-2H")),
		).toMatch(/run/);
		expect(
			step(position(WIKIPEDIA, { hands }), 0, play("0-KH 0-AH 0-2H")).table,
		).toHaveLength(1);
	});
});

describe("opening", () => {
	const table = [{ id: "m1", cards: ["0-4H", "0-5H", "0-6H"] }];

	it("needs new melds from the hand worth the opening points", () => {
		const hand = position(GAMERULES, {
			hands: [
				["0-QS", "0-KS", "0-AS", "0-9C", "0-9D", "0-9H", "0-7H", "0-2C"],
				["0-2D"],
			],
			table,
			nextMeldNo: 2,
			opened: [false, true],
		});
		expect(reason(hand, 0, play("0-4H 0-5H 0-6H", "0-9C 0-9D 0-9H"))).toMatch(
			/40/,
		);
		expect(
			reason(hand, 0, play("0-4H 0-5H 0-6H 0-7H", "0-QS 0-KS 0-AS")),
		).toMatch(/table/);
		const opened = step(
			hand,
			0,
			play("0-4H 0-5H 0-6H", "0-QS 0-KS 0-AS", "0-9C 0-9D 0-9H"),
		);
		expect(opened.opened).toEqual([true, true]);
		expect(opened.hands[0]).toEqual(["0-7H", "0-2C"]);
	});

	it("counts a joker as the card it stands for", () => {
		const hand = position(GAMERULES, {
			hands: [
				["0-QS", "JK0", "0-AS", "0-10C", "0-10D", "0-10H", "0-2C"],
				["0-2D"],
			],
			table,
			nextMeldNo: 2,
			opened: [false, true],
		});
		// Q K A is 10 + 10 + 11 = 31; with a set of tens it is 51.
		expect(reason(hand, 0, play("0-4H 0-5H 0-6H", "0-QS JK0 0-AS"))).toMatch(
			/40/,
		);
		const opened = step(
			hand,
			0,
			play("0-4H 0-5H 0-6H", "0-QS JK0 0-AS", "0-10C 0-10D 0-10H"),
		);
		expect(opened.hands[0]).toEqual(["0-2C"]);
	});

	it("does not apply in a preset without an opening rule", () => {
		const hand = position(WIKIPEDIA, {
			hands: [["0-7H", "0-2C"], ["0-2D"]],
			table,
			nextMeldNo: 2,
			opened: [false, false],
		});
		expect(step(hand, 0, play("0-4H 0-5H 0-6H 0-7H")).hands[0]).toEqual([
			"0-2C",
		]);
	});
});

describe("end of the hand", () => {
	it("ends when a player places the last card", () => {
		const hand = position(GAMERULES, {
			hands: [["0-7H"], ["0-2D", "JK0", "0-AS"], ["0-3C"]],
			table: [{ id: "m1", cards: ["0-4H", "0-5H", "0-6H"] }],
			nextMeldNo: 2,
		});
		const after = step(hand, 0, play("0-4H 0-5H 0-6H 0-7H"));
		expect(after.outcome).toEqual({ kind: "out", seat: 0 });
		expect(legalActions(after, 0)).toEqual([]);
		expect(reason(after, 0, { type: "draw" })).toMatch(/over/);
		expect(settle(after)).toEqual({ penalties: [0, 45, 5], winners: [0] });
	});

	it("passes at an empty stock and ends blocked when every player passed in a row", () => {
		let hand = position(GAMERULES, {
			hands: [["0-AS"], ["0-2D", "0-3C"], ["0-KC"]],
			stock: [],
		});
		expect(legalActions(hand, 0)).toEqual([{ type: "pass" }]);
		expect(reason(hand, 0, { type: "draw" })).toMatch(/stock/);
		hand = step(hand, 0, { type: "pass" });
		hand = step(hand, 1, { type: "pass" });
		expect(hand.outcome).toBeNull();
		hand = step(hand, 2, { type: "pass" });
		expect(hand.outcome).toEqual({ kind: "blocked" });
		expect(settle(hand)).toEqual({ penalties: [15, 10, 10], winners: [1, 2] });
	});

	it("starts the pass count again after a play", () => {
		let hand = position(GAMERULES, {
			hands: [["0-AS"], ["0-7H", "0-3C"], ["0-KC"]],
			table: [{ id: "m1", cards: ["0-4H", "0-5H", "0-6H"] }],
			nextMeldNo: 2,
			stock: [],
		});
		hand = step(hand, 0, { type: "pass" });
		hand = step(hand, 1, play("0-4H 0-5H 0-6H 0-7H"));
		expect(legalActions(hand, 1)).toEqual([{ type: "end" }]);
		hand = step(hand, 1, { type: "end" });
		hand = step(hand, 2, { type: "pass" });
		hand = step(hand, 0, { type: "pass" });
		expect(hand.outcome).toBeNull();
		hand = step(hand, 1, { type: "pass" });
		expect(hand.outcome).toEqual({ kind: "blocked" });
	});

	it("adds the penalty values of the cards left in hand", () => {
		expect(penaltyOf(["JK0", "0-AS", "0-10H", "0-2C"])).toBe(55);
		expect(penaltyOf([])).toBe(0);
	});
});

describe("viewFor", () => {
	it("shows the own hand and only counts of the other hands until the end", () => {
		const hand = position(GAMERULES, {
			hands: [["0-7H"], ["0-2D", "JK0"], ["0-3C"]],
			table: [{ id: "m1", cards: ["0-4H", "0-5H", "0-6H"] }],
			nextMeldNo: 2,
		});
		const view = viewFor(hand, 1);
		expect(view.own).toEqual(["0-2D", "JK0"]);
		expect(view.handCounts).toEqual([1, 2, 1]);
		expect(view.revealed).toBeNull();
		expect(view.stockCount).toBe(3);
		expect(JSON.stringify(view)).not.toContain("0-3C");
		const over = viewFor(step(hand, 0, play("0-4H 0-5H 0-6H 0-7H")), 1);
		expect(over.revealed).toEqual([[], ["0-2D", "JK0"], ["0-3C"]]);
	});
});

describe("self-play", () => {
	it.each([
		["gamerules", 2],
		["wikipedia", 6],
		["machiavelli", 4],
		["gamerules", 6],
	] as const)(
		"%s with %i players ends, and keeps every card",
		(preset, players) => {
			const rules = rulesFor(preset, 6, false);
			const deck = buildDeck(rules.jokers)
				.map((card) => card.id)
				.sort();
			let hand = newHand({ rules, players, dealer: 0, seed: players * 31 });
			for (let turn = 0; hand.outcome === null; turn++) {
				expect(turn).toBeLessThan(2000);
				const seat = hand.turn;
				if (playAllowed(hand, seat)) {
					const result = solve({
						rules,
						table: hand.table.map((meld) => meld.cards),
						hand: hand.hands[seat] ?? [],
						useHandJokers: true,
						...(hand.opened[seat]
							? {}
							: { openingPoints: rules.openingPoints }),
						budget: { maxNodes: 3000 },
					});
					if (result.melds !== null) {
						hand = step(hand, seat, { type: "play", melds: result.melds });
						continue;
					}
				}
				const [first] = legalActions(hand, seat);
				if (first === undefined) throw new Error("no legal action");
				hand = step(hand, seat, first);
				const all = [
					...hand.hands.flat(),
					...hand.stock,
					...hand.table.flatMap((meld) => meld.cards),
				];
				expect([...all].sort()).toEqual(deck);
			}
			const result = settle(hand);
			expect(result.winners.length).toBeGreaterThan(0);
			for (const winner of result.winners)
				expect(result.penalties[winner]).toBe(Math.min(...result.penalties));
		},
	);
});
