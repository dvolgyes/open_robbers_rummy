import { describe, expect, it } from "vitest";
import {
	applyAction,
	CLASSIC_RULES,
	isBlack3,
	isWild,
	type MatchState,
	scoreHand,
	startMatch,
	teamOf,
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
import { pairPickupMatch } from "./canasta-fixtures";

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

	it("a pickup that needs hand cards is offered before any card is selected, with the fewest and most natural cards", () => {
		const match = pairPickupMatch();
		const view = tableView(inputFor(stateOf(match), turnOf(match)));
		const wild = new Set(
			view.own
				.filter((card) => card.rank === "2" || card.rank === "JK")
				.map((card) => card.id),
		);
		const wilds = (option: ActionOption) =>
			option.cards.filter((id) => wild.has(id)).length;
		const pickups = view.options.filter(
			(option) => option.action.type === "takePile",
		);
		const fewest = Math.min(...pickups.map((option) => option.cards.length));
		const natural = Math.min(
			...pickups.filter((option) => option.cards.length === fewest).map(wilds),
		);
		const shown = optionsFor(view.options, []).filter(
			(option) => option.action.type === "takePile",
		);
		expect(shown.length).toBeGreaterThan(0);
		for (const option of shown) {
			expect(option.cards).toHaveLength(fewest);
			expect(wilds(option)).toBe(natural);
		}
		const texts = shown.map((option) => labelText(option.label));
		expect(new Set(texts).size).toBe(texts.length);
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

	/** The match after East went out, with the hand added to the scores, as the host settles it. */
	function wentOut(concealed: boolean): MatchState {
		const match = startMatch(7);
		const hand = {
			...match.hand,
			outcome: { kind: "out" as const, seat: engineSeat("E"), concealed },
		};
		const [first, second] = scoreHand(hand);
		return {
			...match,
			hand,
			settled: true,
			scores: [first.total + 300, second.total + 700],
		};
	}

	it("names the player who went out and scores the hand for each side", () => {
		const match = wentOut(false);
		const [first, second] = scoreHand(match.hand);
		const view = tableView(inputFor(stateOf(match), "S"));
		expect(view.scoring?.outcome).toBe("Ben (E-W) went out.");
		const rows = new Map(
			view.scoring?.rows.map((row) => [row.label, row.values]),
		);
		expect([...rows.keys()]).toEqual([
			"Melds",
			"Canasta bonuses",
			"Red 3s",
			"Going out",
			"Cards in hand",
			"Hand score",
			"Match score",
		]);
		expect(rows.get("Going out")).toEqual([0, CLASSIC_RULES.outBonus]);
		expect(rows.get("Cards in hand")).toEqual([
			first.handPenalty,
			second.handPenalty,
		]);
		expect(rows.get("Hand score")).toEqual([first.total, second.total]);
		expect(rows.get("Match score")).toEqual(match.scores);
	});

	it("says when the player went out concealed", () => {
		const view = tableView(inputFor(stateOf(wentOut(true)), "S"));
		expect(view.scoring?.outcome).toBe("Ben (E-W) went out concealed.");
	});

	it("keeps the last hand's score when the match is won, with no countdown", () => {
		const view = tableView(
			inputFor(stateOf({ ...wentOut(false), winner: 1 }), "S", {
				scoringCountdown: 4,
			}),
		);
		expect(view.phase).toBe("complete");
		expect(view.scoring?.outcome).toBe("Ben (E-W) went out.");
		expect(view.scoring?.countdown).toBeUndefined();
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

	it("an option offered without a selection shows until another selection is made", () => {
		const pickupAB: ActionOption = {
			key: "pickup-ab",
			label: [{ kind: "text", text: "Take the pile with A and B" }],
			action: { type: "takePile", cards: ["a", "b"] },
			cards: ["a", "b"],
			ready: true,
		};
		const all = [draw, pickupAB];
		expect(optionsFor(all, [])).toEqual([draw, pickupAB]);
		expect(optionsFor(all, ["a"])).toEqual([draw]);
		expect(optionsFor(all, ["a", "b"])).toEqual([draw, pickupAB]);
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

	it("offers the draw at an exhausted stock as the end of the hand", () => {
		const match = startMatch(7);
		const exhausted = { ...match, hand: { ...match.hand, stock: [] } };
		const view = tableView(inputFor(stateOf(exhausted), turnOf(exhausted)));
		const draw = view.options.find((option) => option.action.type === "draw");
		expect(draw && labelText(draw.label)).toBe(
			"End the hand: the stock is empty",
		);
		expect(view.prompt).toBe(
			"Your turn: the stock is empty. Take the pile, or end the hand.",
		);
	});

	it("says that the pile must be taken when the exhausted stock offers no draw", () => {
		const match = startMatch(7);
		const top = match.hand.pile.at(-1);
		if (top === undefined || isWild(top) || isBlack3(top))
			throw new Error("the pile top of seed 7 cannot be taken");
		// The viewer's side has a meld of the top card's rank, and the pile is not frozen for it.
		const team = teamOf(match.hand.turn);
		const side = {
			melds: [{ id: "m9", rank: top.rank, team, cards: [top, top, top] }],
			redThrees: [],
			initialMade: true,
		};
		const teams = match.hand.teams;
		const forced: MatchState = {
			...match,
			hand: {
				...match.hand,
				stock: [],
				pile: [top],
				teams: team === 0 ? [side, teams[1]] : [teams[0], side],
			},
		};
		const view = tableView(inputFor(stateOf(forced), turnOf(forced)));
		expect(new Set(view.options.map((option) => option.action.type))).toEqual(
			new Set(["takePile"]),
		);
		expect(view.prompt).toBe(
			"Your turn: the stock is empty, and the pile goes onto your meld: take it.",
		);
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
