import { describe, expect, it } from "vitest";
import { bestPlay, chooseAction, ENDGAME_CARDS } from "../../src/bot/policy";
import type { SolveBudget } from "../../src/bot/solver";
import {
	type Action,
	applyAction,
	type HandState,
	type Phase,
	type RulePreset,
	rulesFor,
	viewFor,
} from "../../src/rummy";

const BUDGET: SolveBudget = { maxNodes: 200_000 };

interface Position {
	readonly preset?: RulePreset;
	readonly own: string;
	readonly table?: readonly string[];
	readonly phase?: Phase;
	readonly stock?: number;
	readonly opened?: boolean;
	/** The opponent's card count. */
	readonly opponent?: number;
}

const ids = (text: string): string[] => text.split(" ").filter(Boolean);

/** Seat 0 on turn against one opponent, whose hand holds only filler cards. */
function position(input: Position): HandState {
	const rules = rulesFor(input.preset ?? "wikipedia", 4, true);
	const filler = ["1-2C", "1-4D", "1-6S", "1-8H", "1-10C", "1-QD", "1-2H"];
	return {
		rules,
		players: 2,
		dealer: 1,
		turn: 0,
		phase: input.phase ?? "start",
		hands: [ids(input.own), filler.slice(0, input.opponent ?? 7)],
		stock: Array.from({ length: input.stock ?? 5 }, (_, at) => `1-${3 + at}S`),
		table: (input.table ?? []).map((cards, at) => ({
			id: `m${at + 1}`,
			cards: ids(cards),
		})),
		opened: [input.opened ?? rules.openingPoints === 0, true],
		lastPlay: null,
		passes: 0,
		nextMeldNo: (input.table?.length ?? 0) + 1,
		outcome: null,
	};
}

function choose(hand: HandState): Action | undefined {
	return chooseAction(viewFor(hand, 0), 0, BUDGET);
}

/** The bot's action, after the engine accepted it. */
function accepted(hand: HandState): Action {
	const action = choose(hand);
	if (action === undefined) throw new Error("no action");
	const step = applyAction(hand, 0, action);
	if (!step.ok) throw new Error(step.reason);
	return action;
}

const placed = (action: Action): string[] =>
	action.type === "play" ? action.melds.flat() : [];

describe("bot policy", () => {
	it("plays a meld from its hand", () => {
		const action = accepted(position({ own: "0-5H 0-6H 0-7H 0-KC" }));
		expect(action.type).toBe("play");
		expect(placed(action).sort()).toEqual(["0-5H", "0-6H", "0-7H"]);
	});

	it("adds a hand card to a table meld", () => {
		const action = accepted(
			position({ own: "0-8H 0-KC", table: ["0-5H 0-6H 0-7H"] }),
		);
		expect(action.type === "play" && action.melds).toEqual([
			["0-5H", "0-6H", "0-7H", "0-8H"],
		]);
	});

	it("draws when it has no play", () => {
		expect(accepted(position({ own: "0-5H 0-9C 0-KC" }))).toEqual({
			type: "draw",
		});
	});

	it("passes when it has no play and the stock is empty", () => {
		expect(accepted(position({ own: "0-5H 0-9C 0-KC", stock: 0 }))).toEqual({
			type: "pass",
		});
	});

	it("ends the turn after a play, and after a draw that gives no play", () => {
		expect(accepted(position({ own: "0-5H 0-9C", phase: "played" }))).toEqual({
			type: "end",
		});
		expect(accepted(position({ own: "0-5H 0-9C", phase: "drew" }))).toEqual({
			type: "end",
		});
	});

	it("plays with the drawn card", () => {
		const action = accepted(
			position({ own: "0-5H 0-6H 0-KC 0-7H", phase: "drew" }),
		);
		expect(placed(action).sort()).toEqual(["0-5H", "0-6H", "0-7H"]);
	});

	it("keeps a joker in the hand when the joker does not empty the hand", () => {
		expect(accepted(position({ own: "JK0 0-5H 0-6H 0-KC" }))).toEqual({
			type: "draw",
		});
	});

	it("keeps a joker but plays the natural cards that it can", () => {
		const action = accepted(position({ own: "JK0 0-5H 0-6H 0-7H 0-KC" }));
		expect(placed(action).sort()).toEqual(["0-5H", "0-6H", "0-7H"]);
	});

	it("uses a joker when that empties the hand", () => {
		const action = accepted(position({ own: "JK0 0-5H 0-6H" }));
		expect(placed(action).sort()).toEqual(["0-5H", "0-6H", "JK0"]);
	});

	it("uses a joker when an opponent can go out soon", () => {
		const action = accepted(
			position({ own: "JK0 0-5H 0-6H 0-KC", opponent: ENDGAME_CARDS }),
		);
		expect(placed(action).sort()).toEqual(["0-5H", "0-6H", "JK0"]);
	});

	it("opens with a joker when the opening needs it", () => {
		// The run 10-J-Q-K of hearts, with a joker as the queen, is worth the 40 points of the opening.
		const action = accepted(
			position({
				preset: "gamerules",
				own: "0-10H 0-JH JK0 0-KH 0-2C",
				opened: false,
			}),
		);
		expect(placed(action).sort()).toEqual(["0-10H", "0-JH", "0-KH", "JK0"]);
	});

	it("draws when the opening points are too few", () => {
		expect(
			accepted(
				position({
					preset: "gamerules",
					own: "0-2H 0-3H 0-4H 0-KC",
					opened: false,
				}),
			),
		).toEqual({ type: "draw" });
	});

	it("does not touch the table before its opening", () => {
		const hand = position({
			preset: "gamerules",
			own: "0-8H 0-KC",
			table: ["0-5H 0-6H 0-7H"],
			opened: false,
		});
		expect(bestPlay(viewFor(hand, 0), 0, BUDGET)).toBeNull();
	});

	it("waits when the seat is not on turn or the hand is over", () => {
		const hand = position({ own: "0-5H 0-6H 0-7H" });
		expect(chooseAction(viewFor(hand, 1), 1, BUDGET)).toBeUndefined();
		expect(choose({ ...hand, outcome: { kind: "blocked" } })).toBeUndefined();
	});

	it("shares one deadline between the two searches of a joker hand", () => {
		const deadlines: (number | undefined)[] = [];
		const hand = position({ own: "JK0 0-5H 0-6H 0-KC" });
		chooseAction(
			viewFor(hand, 0),
			0,
			{ maxNodes: 1000, deadline: 1000, now: () => 0 },
			(input) => {
				deadlines.push(input.budget?.deadline);
				return { melds: null, placed: [], aborted: false, nodes: 0 };
			},
		);
		expect(deadlines).toEqual([500, 1000]);
	});
});
