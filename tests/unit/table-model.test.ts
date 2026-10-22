import { describe, expect, it } from "vitest";
import type { RummyState } from "../../src/game/rummy";
import { translator } from "../../src/i18n";
import {
	DEFAULT_TABLE_SETUP,
	PROTOCOL_VERSION,
	type RoomConfig,
	SEATS,
	type Seat,
} from "../../src/protocol";
import { type HandState, type Phase, rulesFor } from "../../src/rummy";
import { moveCards, newDraft } from "../../src/ui/draft";
import type { RosterRow } from "../../src/ui/model";
import {
	commandLabel,
	draftView,
	seatsAfter,
	type TableViewInput,
	tableView,
	translateReason,
} from "../../src/ui/table-model";

const ROOM = "room-1";
const CONFIG: RoomConfig = {
	names: { "1": "Ann", "2": "Ben", "3": "Cy", "4": "Dee" },
	table: DEFAULT_TABLE_SETUP,
};
const ROSTER: RosterRow[] = SEATS.map((seat) => ({
	seat,
	label: seat,
	host: seat === "1",
	you: seat === "3",
	state: "online",
	releasable: false,
}));

interface HandInput {
	readonly turn?: number;
	readonly phase?: Phase;
	readonly opened?: boolean;
	readonly preset?: "gamerules" | "wikipedia";
	readonly outcome?: HandState["outcome"];
}

/** Player 3 (engine seat 2) holds a run in hearts; the table has one run. */
function hand(input: HandInput = {}): HandState {
	const rules = rulesFor(input.preset ?? "wikipedia", 4, true);
	return {
		rules,
		players: 4,
		dealer: 1,
		turn: input.turn ?? 2,
		phase: input.phase ?? "start",
		hands: [
			["1-2C", "1-4D"],
			["1-6S"],
			["0-8H", "0-9H", "0-10H", "0-KC"],
			["1-QD", "1-KD", "JK1"],
		],
		stock: ["1-3S", "1-4S"],
		table: [{ id: "m1", cards: ["0-5H", "0-6H", "0-7H"] }],
		opened: [true, true, input.opened ?? true, true],
		lastPlay: { seat: 1, cards: ["0-7H"], meldIds: ["m1"] },
		passes: 0,
		nextMeldNo: 2,
		outcome: input.outcome ?? null,
	};
}

function stateOf(match: HandState | null, actions = 3): RummyState {
	return {
		v: PROTOCOL_VERSION,
		roomId: ROOM,
		game: "rummy",
		messages: 0,
		matches: match === null ? 0 : 1,
		lastDealer: match === null ? null : 1,
		match: match === null ? null : { handNo: 1, hand: match },
		actions,
		reset: null,
		media: {},
	};
}

function inputFor(
	state: RummyState | null | undefined,
	seat: Seat = "3",
	overrides: Partial<TableViewInput> = {},
): TableViewInput {
	return {
		config: CONFIG,
		seat,
		state,
		terminal: false,
		present: new Set(SEATS),
		roster: ROSTER,
		hostSeat: "1",
		outbox: [],
		failures: [],
		undone: [],
		...overrides,
	};
}

describe("table phases", () => {
	it("shows no seats while loading, and names an unreadable room", () => {
		expect(tableView(inputFor(undefined)).phase).toBe("loading");
		const unreadable = tableView(inputFor(null));
		expect(unreadable.phase).toBe("unreadable");
		expect(unreadable.seats).toEqual([]);
	});

	it("lists the seats in turn order after the viewer and waits for absent players", () => {
		const view = tableView(
			inputFor(stateOf(null), "3", { present: new Set(["1", "3"]) }),
		);
		expect(view.phase).toBe("waiting");
		expect(view.seats.map((seat) => seat.seat)).toEqual(["4", "1", "2", "3"]);
		expect(view.prompt).toBe("Waiting for Player 2 and Player 4 to come back");
	});

	it("puts the viewer last in the seat order", () => {
		expect(seatsAfter(["1", "2", "3", "4"], "1")).toEqual(["2", "3", "4", "1"]);
	});
});

describe("a game in play", () => {
	it("shows the hand counts, the table and the gold frame of the latest play", () => {
		const view = tableView(inputFor(stateOf(hand())));
		expect(view.phase).toBe("play");
		expect(view.seats.map((seat) => [seat.seat, seat.handCount])).toEqual([
			["4", 3],
			["1", 2],
			["2", 1],
			["3", 4],
		]);
		expect(view.seats.find((seat) => seat.turn)?.seat).toBe("3");
		expect(view.table[0]?.cards.map((card) => [card.text, card.gold])).toEqual([
			["5♥", false],
			["6♥", false],
			["7♥", true],
		]);
		expect(view.own.map((card) => card.text)).toEqual([
			"8♥",
			"9♥",
			"10♥",
			"K♣",
		]);
	});

	it("offers the draft editor and a draw at the start of the viewer's turn", () => {
		const view = tableView(inputFor(stateOf(hand())));
		expect(view.yourTurn).toBe(true);
		expect(view.canPlay).toBe(true);
		expect(view.assist).toBe(true);
		expect(view.actions.map((action) => action.key)).toEqual(["draw"]);
		expect(view.prompt).toBe(
			"Your turn: lay cards on the table, or draw a card.",
		);
	});

	it("waits for the player on turn, and offers nothing to the others", () => {
		const view = tableView(inputFor(stateOf(hand({ turn: 0 }))));
		expect(view.yourTurn).toBe(false);
		expect(view.canPlay).toBe(false);
		expect(view.actions).toEqual([]);
		expect(view.prompt).toBe("Waiting for Ann.");
	});

	it("offers a draw or the end of the turn after a play", () => {
		const view = tableView(inputFor(stateOf(hand({ phase: "played" }))));
		expect(view.canPlay).toBe(false);
		expect(view.actions.map((action) => action.key)).toEqual(["draw", "end"]);
	});

	it("blocks the viewer while a table command is in flight", () => {
		const view = tableView(
			inputFor(stateOf(hand()), "3", {
				outbox: [
					{
						id: "c1",
						payload: {
							type: "action",
							hand: 1,
							at: 3,
							action: { type: "draw" },
						},
						state: "sending",
					} as unknown as TableViewInput["outbox"][number],
				],
			}),
		);
		expect(view.yourTurn).toBe(false);
		expect(view.lines.map((line) => line.label)).toEqual(["Draw a card"]);
	});

	it("names the opening minimum before the viewer's opening", () => {
		const view = tableView(
			inputFor(stateOf(hand({ preset: "gamerules", opened: false }))),
		);
		expect(view.locked).toBe(true);
		expect(view.prompt).toBe(
			"Your turn: open with 40 points of new melds from your hand, or draw a card.",
		);
	});
});

describe("the draft", () => {
	it("accepts a draft that the engine accepts, and marks the placed cards", () => {
		const view = tableView(inputFor(stateOf(hand())));
		const start = newDraft(
			view.table.map((meld) => meld.cards.map((card) => card.id)),
			view.own.map((card) => card.id),
			view.locked,
		);
		const moved = moveCards(start, ["0-8H", "0-9H"], 0);
		if (!moved.ok) throw new Error(moved.reason);
		const draft = draftView(view, "3", moved.draft);
		expect(draft.changed).toBe(true);
		expect(draft.problem).toBeNull();
		expect(draft.play).toEqual({
			type: "play",
			melds: [["0-5H", "0-6H", "0-7H", "0-8H", "0-9H"]],
		});
		expect(draft.melds[0]?.cards.filter((card) => card.placed)).toHaveLength(2);
		expect(draft.hand.map((card) => card.id)).toEqual(["0-10H", "0-KC"]);
	});

	it("names the problem of an invalid meld and of the play", () => {
		const view = tableView(inputFor(stateOf(hand())));
		const moved = moveCards(
			newDraft(
				[["0-5H", "0-6H", "0-7H"]],
				view.own.map((card) => card.id),
				false,
			),
			["0-KC"],
			0,
		);
		if (!moved.ok) throw new Error(moved.reason);
		const draft = draftView(view, "3", moved.draft);
		expect(draft.play).toBeUndefined();
		expect(draft.melds[0]?.problem).toBe(
			"the cards of a run must share one suit",
		);
		expect(draft.problem).toBe("the cards of a run must share one suit");
	});

	it("shows the card that a joker stands for", () => {
		const view = tableView(
			inputFor(
				stateOf({
					...hand(),
					table: [{ id: "m1", cards: ["0-5H", "JK0", "0-7H"] }],
				}),
			),
		);
		expect(view.table[0]?.cards[1]).toMatchObject({ rank: "JK", as: "6♥" });
	});
});

describe("the end of the game", () => {
	it("lists the penalties, lowest first, and names the winner", () => {
		const over = hand({ outcome: { kind: "out", seat: 1 } });
		const view = tableView(
			inputFor(stateOf({ ...over, hands: [["1-2C"], [], ["0-KC"], ["JK1"]] })),
		);
		expect(view.phase).toBe("over");
		expect(view.result?.outcome).toBe("Ben went out.");
		expect(view.result?.winner).toBe("Ben won.");
		expect(view.result?.rows.map((row) => [row.name, row.penalty])).toEqual([
			["Ben", 0],
			["Ann", 5],
			["Cy", 10],
			["Dee", 25],
		]);
	});

	it("shares the win at a blocked end", () => {
		const over = hand({ outcome: { kind: "blocked" } });
		const view = tableView(
			inputFor(
				stateOf({ ...over, hands: [["1-2C"], ["1-3C"], ["0-2C"], ["JK1"]] }),
			),
		);
		expect(view.result?.winner).toBe("You share the win with Ann, Ben.");
	});
});

describe("texts", () => {
	it("labels commands and translates engine reasons with their values", () => {
		expect(commandLabel({ type: "start" })).toBe("Deal the cards");
		expect(commandLabel({ type: "action", action: { type: "pass" } })).toBe(
			"Pass",
		);
		expect(
			translateReason("0-5H 0-KC 0-6H: the cards of a run must share one suit"),
		).toBe("the cards of a run must share one suit");
		expect(
			translateReason(
				"your opening needs 40 points in new melds, not 24",
				translator("de"),
			),
		).not.toBe("your opening needs 40 points in new melds, not 24");
	});
});
