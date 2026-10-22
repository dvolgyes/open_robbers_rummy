import { describe, expect, it } from "vitest";
import {
	applyAction,
	CLASSIC_RULES,
	type MatchState,
	startMatch,
} from "../../src/canasta";
import {
	type CanastaState,
	engineSeat,
	tableSeat,
} from "../../src/game/canasta";
import {
	catalogKeys,
	type Locale,
	type Translate,
	translator,
} from "../../src/i18n";
import {
	PROTOCOL_VERSION,
	type RoomConfig,
	SEATS,
	type Seat,
} from "../../src/protocol";
import type { RosterRow } from "../../src/ui/model";
import {
	type ActionOption,
	type Label,
	labelText,
	optionsFor,
	positionOf,
	type TableViewInput,
	tableView,
} from "../../src/ui/table-model";

const ROOM = "room-1";
const CONFIG: RoomConfig = {
	names: { N: "Ann", E: "Ben", S: "Cy", W: "Dee" },
};
const ROSTER: RosterRow[] = SEATS.map((seat) => ({
	seat,
	label: seat,
	host: seat === "N",
	you: seat === "S",
	state: "online",
	releasable: false,
}));

function stateOf(match: MatchState | null, actions = 0): CanastaState {
	return {
		v: PROTOCOL_VERSION,
		roomId: ROOM,
		game: "canasta",
		messages: 0,
		matches: match === null ? 0 : 1,
		match,
		actions,
		reset: null,
		media: {},
	};
}

function inputFor(
	state: CanastaState | null | undefined,
	seat: Seat = "S",
	overrides: Partial<TableViewInput> = {},
): TableViewInput {
	return {
		config: CONFIG,
		seat,
		state,
		terminal: false,
		present: new Set(SEATS),
		roster: ROSTER,
		hostSeat: "N",
		outbox: [],
		failures: [],
		undone: [],
		...overrides,
	};
}

/** The seat that the engine says acts now, as a table seat. */
function turnOf(match: MatchState): Seat {
	return tableSeat(match.hand.turn);
}

describe("table phases", () => {
	it("a room that is still loading shows no seats and no options", () => {
		const view = tableView(inputFor(undefined));
		expect(view.phase).toBe("loading");
		expect(view.seats).toEqual([]);
		expect(view.options).toEqual([]);
	});

	it("a room whose state is not canasta is unreadable", () => {
		const view = tableView(inputFor(null));
		expect(view.phase).toBe("unreadable");
		expect(view.seats).toEqual([]);
	});

	it("the lobby lists four seats and waits for absent players", () => {
		const view = tableView(
			inputFor(stateOf(null), "S", { present: new Set(["N", "S"]) }),
		);
		expect(view.phase).toBe("waiting");
		expect(view.seats).toHaveLength(4);
		expect(view.prompt).toMatch(/^Waiting for/);
		expect(view.options).toEqual([]);
	});

	it("a finished match names the winning side", () => {
		const match = startMatch(7);
		const view = tableView(inputFor(stateOf({ ...match, winner: 0 })));
		expect(view.phase).toBe("complete");
		expect(view.winner).toBe("N-S won the match.");
		expect(view.options).toEqual([]);
	});
});

describe("seats and turn", () => {
	it("marks the seat to act, and only that viewer is offered actions", () => {
		const match = startMatch(7);
		const turn = turnOf(match);
		const onTurn = tableView(inputFor(stateOf(match), turn));
		expect(onTurn.yourTurn).toBe(true);
		expect(onTurn.seats.find((seat) => seat.turn)?.seat).toBe(turn);

		const other = SEATS.find((seat) => seat !== turn) as Seat;
		const waiting = tableView(inputFor(stateOf(match), other));
		expect(waiting.yourTurn).toBe(false);
		expect(waiting.options).toEqual([]);
		expect(waiting.prompt).toContain(CONFIG.names[turn]);
	});

	it("the viewer sits at the bottom and the others around the table", () => {
		expect(positionOf("S", "S")).toBe("bottom");
		expect(positionOf("S", "N")).toBe("top");
		expect(positionOf("S", "W")).toBe("left");
		expect(positionOf("S", "E")).toBe("right");
	});
});

describe("offered actions", () => {
	it("a draw is offered at the start of the turn", () => {
		const match = startMatch(7);
		const view = tableView(inputFor(stateOf(match), turnOf(match)));
		expect(view.options.some((option) => option.action.type === "draw")).toBe(
			true,
		);
	});

	it("no action is offered while a command of the viewer is in flight", () => {
		const match = startMatch(7);
		const view = tableView(
			inputFor(stateOf(match), turnOf(match), {
				outbox: [
					{
						id: "c1",
						order: 1,
						state: "queued",
						payload: {
							type: "action",
							hand: match.handNo,
							action: { type: "draw" },
						},
					},
				],
			}),
		);
		expect(view.options).toEqual([]);
		expect(view.lines.map((line) => line.state)).toEqual(["pending"]);
	});
});

describe("score strip and piles", () => {
	it("shows both sides' scores, the viewer's side, and the target", () => {
		const match = { ...startMatch(7), scores: [120, 45] as const };
		const view = tableView(inputFor(stateOf(match), "S"));
		expect(view.target).toBe(CLASSIC_RULES.targetScore);
		expect(view.sides[0]).toMatchObject({
			label: "N-S",
			owner: "ours",
			score: 120,
			mine: true,
		});
		expect(view.sides[1]).toMatchObject({
			label: "E-W",
			owner: "theirs",
			score: 45,
			mine: false,
		});
	});

	it("names the sides with the viewer's seat letters, and marks them from the viewer's side", () => {
		const match = { ...startMatch(7), winner: 1 as const };
		const view = tableView({
			...inputFor(stateOf(match), "W"),
			t: translator("hu"),
		});
		expect(view.sides[0]).toMatchObject({ label: "É-D", owner: "övék" });
		expect(view.sides[1]).toMatchObject({ label: "K-Ny", owner: "miénk" });
		expect(view.winner).toContain("K-Ny");
	});

	it("reports the frozen pile until the viewer's side has its initial meld", () => {
		const match = startMatch(7);
		const view = tableView(inputFor(stateOf(match), "S"));
		expect(view.pile.frozen).toBe(true);
	});

	it("counts the viewer's hand and each opponent's hand from the engine view", () => {
		const match = startMatch(7);
		const view = tableView(inputFor(stateOf(match), "S"));
		expect(view.own).toHaveLength(
			match.hand.hands[engineSeat("S")]?.length ?? -1,
		);
		const west = view.seats.find((seat) => seat.seat === "W");
		expect(west?.handCount).toBe(match.hand.hands[engineSeat("W")]?.length);
		expect(view.stockCount).toBe(match.hand.stock.length);
		expect(view.pile.count).toBe(match.hand.pile.length);
	});
});

describe("hand over", () => {
	it("a settled-out hand offers no action and shows its outcome", () => {
		const match = startMatch(7);
		const ended = {
			...match,
			hand: { ...match.hand, outcome: { kind: "stock" as const } },
		};
		const view = tableView(inputFor(stateOf(ended), turnOf(match)));
		expect(view.phase).toBe("hand-over");
		expect(view.options).toEqual([]);
		expect(view.scoring?.outcome).toBe("The stock ran out. No side went out.");
		expect(view.scoring?.countdown).toBe(10);
	});

	it("a finished hand marks no seat as the one to play", () => {
		const match = startMatch(7);
		const ended = {
			...match,
			hand: { ...match.hand, outcome: { kind: "stock" as const } },
		};
		const view = tableView(inputFor(stateOf(ended), "N"));
		expect(view.seats.filter((seat) => seat.turn)).toEqual([]);
	});

	it("the countdown to the next hand comes from the room", () => {
		const match = startMatch(7);
		const ended = {
			...match,
			hand: { ...match.hand, outcome: { kind: "stock" as const } },
		};
		const view = tableView(
			inputFor(stateOf(ended), turnOf(match), { scoringCountdown: 4 }),
		);
		expect(view.scoring?.countdown).toBe(4);
	});
});

describe("optionsFor", () => {
	const draw: ActionOption = {
		key: "draw",
		label: [{ kind: "text", text: "Draw" }],
		action: { type: "draw" },
		cards: [],
	};
	const discardA: ActionOption = {
		key: "discard-a",
		label: [{ kind: "text", text: "Discard A" }],
		action: { type: "discard", card: "a" },
		cards: ["a"],
	};
	const meldAB: ActionOption = {
		key: "meld-ab",
		label: [{ kind: "text", text: "Meld A and B" }],
		action: { type: "meld", cards: ["a", "b"] },
		cards: ["a", "b"],
	};
	const options = [draw, discardA, meldAB];

	it("with no selection only the cards-free action is offered", () => {
		expect(optionsFor(options, [])).toEqual([draw]);
	});

	it("a single selected card offers the discard of that card", () => {
		expect(optionsFor(options, ["a"])).toEqual([draw, discardA]);
	});

	it("the selection matches the cards of an option in any order", () => {
		expect(optionsFor(options, ["b", "a"])).toEqual([draw, meldAB]);
	});
});

/** The match after the seat on turn drew from the stock, so it can meld and discard. */
function afterDraw(seed: number): MatchState {
	const match = startMatch(seed);
	const step = applyAction(match.hand, match.hand.turn, { type: "draw" });
	if (!step.ok) throw new Error(step.reason);
	return { ...match, hand: step.hand };
}

const cardIdsOf = (label: Label): string[] =>
	label.flatMap((part) => (part.kind === "card" ? [part.card.id] : []));
/** The text of a label with each card as "|". */
const textOf = (label: Label): string =>
	label.map((part) => (part.kind === "text" ? part.text : "|")).join("");

describe("action labels", () => {
	const hu = translator("hu");

	it("names a draw in the viewer's language", () => {
		const match = startMatch(7);
		const view = tableView(inputFor(stateOf(match), turnOf(match), { t: hu }));
		const draw = view.options.find((option) => option.action.type === "draw");
		expect(draw && labelText(draw.label)).toBe("Húzz egy lapot a pakliból");
	});

	it("shows a discarded card as a card, not as text", () => {
		const match = afterDraw(7);
		const view = tableView(
			inputFor(stateOf(match, 1), turnOf(match), { t: hu }),
		);
		const discard = view.options.find(
			(option) => option.action.type === "discard",
		);
		expect(discard).toBeDefined();
		if (discard === undefined) return;
		expect(textOf(discard.label)).toBe("Eldobás: |");
		expect(cardIdsOf(discard.label)).toEqual(discard.cards);
	});

	it("shows each card of a new meld as a card, in the order of the action", () => {
		const meld = Array.from({ length: 200 }, (_, seed) => afterDraw(seed + 1))
			.flatMap(
				(match) =>
					tableView(inputFor(stateOf(match, 1), turnOf(match), { t: hu }))
						.options,
			)
			.find((option) => option.action.type === "meld");
		expect(meld).toBeDefined();
		if (meld === undefined) return;
		expect(textOf(meld.label)).toMatch(/^Kirakás: \|( \|)+$/);
		expect(cardIdsOf(meld.label)).toEqual(meld.cards);
	});
});

describe("translated table texts", () => {
	/** A translator that records each message that the table asks for. */
	function recording(): { t: Translate; asked: Set<string> } {
		const asked = new Set<string>();
		const english = translator("en");
		return {
			asked,
			t: (message, values) => {
				asked.add(message);
				return english(message, values);
			},
		};
	}

	it("asks only for messages that every language translates", () => {
		const { t, asked } = recording();
		const match = startMatch(7);
		const turn = turnOf(match);
		const drawn = afterDraw(7);
		const ended = (outcome: MatchState["hand"]["outcome"]): MatchState => ({
			...match,
			hand: { ...match.hand, outcome },
		});
		const refused = (id: string, reason: string) => ({
			id,
			payload: { type: "action", hand: match.handNo, action: { type: "draw" } },
			status: "rejected" as const,
			reason,
		});
		const inputs: TableViewInput[] = [
			inputFor(undefined, "S", { t }),
			inputFor(null, "S", { t }),
			inputFor(stateOf(null), "S", { t, present: new Set(["N", "S"]) }),
			inputFor(stateOf(null), "S", { t }),
			inputFor(stateOf(match), turn, {
				t,
				failures: [
					refused("c1", "draw before melding"),
					refused("c2", "card 7H-1 is not in your hand"),
					refused("c3", "a meld may hold at most 3 wild cards"),
					refused("c4", "the cards do not match the meld rank 7"),
					refused("c5", "the table has moved on since this action was chosen"),
				],
			}),
			inputFor(stateOf(match), turn, {
				t,
				outbox: [
					{
						id: "c6",
						order: 1,
						state: "queued",
						waiting: "Waiting for North and East to come back",
						payload: { type: "next-hand" },
					},
				],
			}),
			inputFor(stateOf(drawn, 1), turnOf(drawn), { t }),
			inputFor(stateOf(ended({ kind: "stock" })), turn, { t }),
			inputFor(
				stateOf(ended({ kind: "out", seat: 0, concealed: true })),
				turn,
				{ t },
			),
			inputFor(stateOf({ ...match, winner: 1 }), turn, { t }),
		];
		for (const input of inputs) tableView(input);
		expect(asked.size).toBeGreaterThan(20);
		const locales = [
			"de",
			"hu",
			"no",
			"es",
			"pt",
			"fr",
			"it",
			"nl",
		] as const satisfies readonly Exclude<Locale, "en">[];
		for (const locale of locales) {
			const known = new Set(catalogKeys(locale));
			expect(
				[...asked].filter((message) => !known.has(message)),
				locale,
			).toEqual([]);
		}
	});
});
