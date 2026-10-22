import { describe, expect, it } from "vitest";
import {
	type Action,
	applyAction,
	buildDecks,
	type Card,
	CLASSIC_RULES,
	isBlack3,
	isWild,
	legalActions,
	type MatchState,
	type Meld,
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
	selectionOptions,
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

	it("before any card is selected, one pickup is offered: the one with the fewest wild cards, then the fewest cards", () => {
		// Three jacks, a 2 and a joker in the hand, and a jack on top of the pile: many pickups are legal.
		const match = startMatch(7);
		const turn = match.hand.turn;
		const side = { melds: [], redThrees: [], initialMade: true };
		const teams = match.hand.teams;
		const hand = {
			...match.hand,
			teams: teamOf(turn) === 0 ? [side, teams[1]] : [teams[0], side],
			hands: match.hand.hands.map((cards, index) =>
				index === turn
					? cardsOf(["0-JS", "0-JH", "0-JD", "0-2C", "0-JK0", "0-9D", "0-4S"])
					: cards,
			),
			pile: cardsOf(["0-5C", "0-JC"]),
		} as MatchState["hand"];
		const view = tableView(
			inputFor(
				stateOf({ ...match, hand: { ...hand, turnStart: hand } }),
				turnOf(match),
			),
		);
		const pickups = view.options.filter(
			(option) => option.action.type === "takePile",
		);
		expect(pickups.length).toBeGreaterThan(3);
		const shown = optionsFor(view.options, []).filter(
			(option) => option.action.type === "takePile",
		);
		expect(shown).toHaveLength(1);
		expect(shown[0]?.cards).toHaveLength(2);
		expect(
			shown[0]?.cards.every((id) => id.startsWith("0-J") && id !== "0-JK0"),
		).toBe(true);
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

describe("options for the selected cards", () => {
	const sevens = ["0-7H", "1-7H", "0-7S", "1-7S", "0-2S"];
	const eightSevens = [
		"0-7H",
		"1-7H",
		"0-7S",
		"1-7S",
		"0-7D",
		"1-7D",
		"0-7C",
		"1-7C",
	];
	const deuces = ["0-2S", "1-2S", "0-2H", "1-2H"];
	/** After the draw, the seat on turn holds the given cards, a king and a nine, and its side has melded. */
	function holdingSevens(ids: readonly string[] = sevens): MatchState {
		const match = afterDraw(7);
		const own = cardsOf([...ids, "0-KS", "0-9D"]);
		const turn = match.hand.turn;
		const side = { melds: [], redThrees: [], initialMade: true };
		const teams = match.hand.teams;
		return {
			...match,
			hand: {
				...match.hand,
				hands: match.hand.hands.map((cards, index) =>
					index === turn ? own : cards,
				),
				teams: teamOf(turn) === 0 ? [side, teams[1]] : [teams[0], side],
			},
		};
	}
	const melds = (options: readonly ActionOption[]) =>
		options.filter((option) => option.action.type === "meld");
	/** The meld options of the selection, for the seat on turn or for the given seat. */
	function meldsFor(
		match: MatchState,
		selected: readonly string[],
		seat: Seat = turnOf(match),
	): ActionOption[] {
		const input = inputFor(stateOf(match, 1), seat);
		return melds(selectionOptions(input, tableView(input), selected));
	}

	it("offers a meld of five selected cards, which the listed options leave out", () => {
		const match = holdingSevens();
		const view = tableView(inputFor(stateOf(match, 1), turnOf(match)));
		expect(
			melds(view.options).some((option) => option.cards.length === 5),
		).toBe(false);
		const offered = meldsFor(match, sevens);
		expect(offered.map((option) => option.action)).toEqual([
			{ type: "meld", cards: sevens },
		]);
		expect(cardIdsOf(offered[0]?.label ?? [])).toEqual(sevens);
	});

	it("offers a canasta of eleven cards from the hand: eight naturals and three wild cards", () => {
		const canasta = [...eightSevens, ...deuces.slice(0, 3)];
		const match = holdingSevens([...eightSevens, ...deuces]);
		expect(meldsFor(match, canasta).map((option) => option.action)).toEqual([
			{ type: "meld", cards: canasta },
		]);
	});

	it("offers no meld with four wild cards, because a meld holds at most three", () => {
		const twelve = [...eightSevens, ...deuces];
		expect(meldsFor(holdingSevens(twelve), twelve)).toEqual([]);
	});

	it("offers a listed meld once, whatever the order of the selection", () => {
		const four = ["1-7S", "0-7H", "0-7S", "1-7H"];
		expect(meldsFor(holdingSevens(), four)).toHaveLength(1);
	});

	it("offers nothing for the selection when it is not the viewer's turn", () => {
		const match = holdingSevens();
		const other = turnOf(match) === "N" ? "E" : "N";
		const input = inputFor(stateOf(match, 1), other);
		expect(selectionOptions(input, tableView(input), sevens)).toEqual([]);
	});
});

describe("why the pile cannot be taken", () => {
	/** The hand of the screenshot that asked why: no 4, and one deuce. */
	const noFours = [
		"0-7H",
		"0-8D",
		"0-8S",
		"0-9D",
		"0-9S",
		"0-10S",
		"0-JH",
		"0-QC",
		"0-QS",
		"0-KS",
		"0-2C",
	];
	const jacks: Meld = {
		id: "m1",
		rank: "J",
		team: 0,
		cards: cardsOf(["1-JH", "0-JD", "1-JD"]),
	};
	/** The seat on turn has not drawn yet; it holds the given cards, and its side has the given melds. */
	function drawTurn(
		own: readonly string[],
		pile: readonly string[],
		melds: readonly Meld[],
		initialMade = true,
	): MatchState {
		const match = startMatch(7);
		const turn = match.hand.turn;
		const team = teamOf(turn);
		const side = {
			melds: melds.map((meld) => ({ ...meld, team })),
			redThrees: [],
			initialMade,
		};
		const teams = match.hand.teams;
		return {
			...match,
			hand: {
				...match.hand,
				hands: match.hand.hands.map((cards, index) =>
					index === turn ? cardsOf(own) : cards,
				),
				pile: cardsOf(pile),
				teams: team === 0 ? [side, teams[1]] : [teams[0], side],
			},
		};
	}
	const promptOf = (match: MatchState, t?: Translate): string =>
		tableView(inputFor(stateOf(match), turnOf(match), { t })).prompt;

	it("names the cards that an unfrozen pile needs, when the hand lacks them", () => {
		const match = drawTurn(noFours, ["0-9H", "0-4C"], [jacks]);
		expect(promptOf(match)).toBe(
			"Your turn: draw from the stock. To take the pile, you need two 4s, or a 4 and a wild card.",
		);
		expect(promptOf(match, translator("hu"))).toBe(
			"Te jössz: húzz a pakliból. A dobópakli felvételéhez két 4 lap kell, vagy egy 4 lap és egy joker vagy kettes.",
		);
	});

	it("asks for a natural pair when a wild card in the pile freezes it", () => {
		const own = [...noFours.slice(0, -1), "0-4H", "0-2C"];
		const match = drawTurn(own, ["0-2D", "0-9H", "0-4C"], [jacks]);
		expect(promptOf(match)).toBe(
			"Your turn: draw from the stock. The pile is frozen: to take it, you need two natural 4s.",
		);
	});

	it("asks for a natural pair while the side has not melded", () => {
		const own = [...noFours.slice(0, -1), "0-4H", "0-2C"];
		const match = drawTurn(own, ["0-9H", "0-4C"], [], false);
		expect(promptOf(match)).toBe(
			"Your turn: draw from the stock. Until your side melds, you need two natural 4s to take the pile.",
		);
	});

	it("says that a black 3 or a wild card on top blocks the pile", () => {
		expect(promptOf(drawTurn(noFours, ["0-9H", "0-3S"], [jacks]))).toBe(
			"Your turn: draw from the stock. A black 3 on top blocks the pile for this turn.",
		);
		expect(promptOf(drawTurn(noFours, ["0-9H", "0-JK0"], [jacks]))).toBe(
			"Your turn: draw from the stock. A wild card on top blocks the pile for this turn.",
		);
	});

	it("offers the pile without a hint when the hand can take it", () => {
		const own = [...noFours.slice(0, -1), "0-4H", "0-2C"];
		expect(promptOf(drawTurn(own, ["0-9H", "0-4C"], [jacks]))).toBe(
			"Your turn: draw from the stock, or take the pile.",
		);
	});

	it("gives no reason that would be false when the hand has the cards", () => {
		// Two natural 4s, but taking with them leaves one card without a canasta, so no pickup is legal.
		const match = drawTurn(["0-4H", "1-4H", "0-KS"], ["0-4C"], [jacks]);
		expect(
			tableView(inputFor(stateOf(match), turnOf(match))).options.some(
				(option) => option.action.type === "takePile",
			),
		).toBe(false);
		expect(promptOf(match)).toBe("Your turn: draw from the stock.");
	});

	it("does not offer the pile when it is empty", () => {
		expect(promptOf(drawTurn(noFours, [], [jacks]))).toBe(
			"Your turn: draw from the stock.",
		);
	});

	it("ends the hand at an empty stock when the pile cannot be taken, and says why", () => {
		const match = drawTurn(noFours, ["0-9H", "0-4C"], [jacks]);
		const exhausted = { ...match, hand: { ...match.hand, stock: [] } };
		expect(promptOf(exhausted)).toBe(
			"Your turn: the stock is empty. End the hand. To take the pile, you need two 4s, or a 4 and a wild card.",
		);
	});
});

describe("melds on the table", () => {
	it("shows a side's melds by rank, lowest on the left, not in the order they were made", () => {
		const match = afterDraw(7);
		const meld = (id: string, rank: Meld["rank"], ids: string[]): Meld => ({
			id,
			rank,
			team: 0,
			cards: cardsOf(ids),
		});
		const melds = [
			meld("m1", "K", ["0-KS", "1-KS", "0-KH"]),
			meld("m2", "4", ["0-4S", "1-4S", "0-4H"]),
			meld("m3", "A", ["0-AS", "1-AS", "0-2C"]),
			meld("m4", "10", ["0-10S", "1-10S", "0-10H"]),
		];
		const side = { melds, redThrees: [], initialMade: true };
		const sorted: MatchState = {
			...match,
			hand: { ...match.hand, teams: [side, match.hand.teams[1]] },
		};
		const view = tableView(inputFor(stateOf(sorted, 1), turnOf(sorted)));
		expect(view.sides[0].melds.map((shown) => shown.rank)).toEqual([
			"4",
			"10",
			"K",
			"A",
		]);
	});
});

describe("frames on the cards of the hand", () => {
	/** After the draw of the 9 of diamonds, the seat on turn holds 7s, a K, a 2 and a joker; its side has a meld of 7s. */
	function drewNine(): MatchState {
		const match = afterDraw(7);
		const turn = match.hand.turn;
		const side = {
			melds: [
				{
					id: "m1",
					rank: "7" as const,
					team: teamOf(turn),
					cards: cardsOf(["1-7C", "1-7D", "0-7D"]),
				},
			],
			redThrees: [],
			initialMade: true,
		};
		const teams = match.hand.teams;
		const own = cardsOf(["0-7H", "1-7H", "0-KS", "0-2C", "0-JK0", "0-9D"]);
		const hand = {
			...match.hand,
			teams: teamOf(turn) === 0 ? [side, teams[1]] : [teams[0], side],
			hands: match.hand.hands.map((cards, index) =>
				index === turn ? own : cards,
			),
			turnTaken: ["0-9D"],
		} as MatchState["hand"];
		return { ...match, hand: { ...hand, turnStart: hand } };
	}
	const viewOf = (match: MatchState) =>
		tableView(inputFor(stateOf(match, 1), turnOf(match)));
	function acted(match: MatchState, action: Action): MatchState {
		const step = applyAction(match.hand, match.hand.turn, action);
		if (!step.ok) throw new Error(step.reason);
		return { ...match, hand: step.hand };
	}

	it("frames the drawn cards in gold until the first action after the draw, and nothing green before it", () => {
		const view = viewOf(drewNine());
		expect(view.taken).toEqual(["0-9D"]);
		expect(view.fits).toEqual([]);
	});

	it("after the first action, frames in green the natural cards that fit a meld of the side, not the wild cards", () => {
		const match = acted(drewNine(), {
			type: "extend",
			meldId: "m1",
			cards: ["0-7H"],
		});
		const view = viewOf(match);
		expect(view.taken).toEqual([]);
		expect(view.fits).toEqual(["1-7H"]);
	});

	it("takes back the green frames and shows the gold again when the turn is reset", () => {
		const match = acted(
			acted(drewNine(), { type: "extend", meldId: "m1", cards: ["0-7H"] }),
			{ type: "resetTurn" },
		);
		const view = viewOf(match);
		expect(view.taken).toEqual(["0-9D"]);
		expect(view.fits).toEqual([]);
	});

	it("keeps the gold on the cards from the pile until the first action after the pickup", () => {
		const match = pairPickupMatch();
		const pickup = legalActions(match.hand, match.hand.turn).find(
			(action) => action.type === "takePile",
		);
		if (pickup === undefined) throw new Error("no pickup");
		const taken = acted(match, pickup);
		expect(viewOf(taken).taken.length).toBeGreaterThan(0);
		expect(viewOf(taken).fits).toEqual([]);
		const meld = legalActions(taken.hand, taken.hand.turn).find(
			(action) => action.type === "meld" || action.type === "extend",
		);
		if (meld === undefined) throw new Error("no meld after the pickup");
		expect(viewOf(acted(taken, meld)).taken).toEqual([]);
	});

	it("shows no frames to a player who is not on turn", () => {
		const match = drewNine();
		const other = SEATS.find((seat) => seat !== turnOf(match)) ?? "N";
		const view = tableView(inputFor(stateOf(match, 1), other));
		expect(view.taken).toEqual([]);
		expect(view.fits).toEqual([]);
	});
});

describe("the first meld minimum", () => {
	const sevens = ["0-7H", "1-7H", "0-7S"];
	const aces = ["0-AS", "1-AS", "0-AH"];
	/** After the draw, the seat on turn holds three 7s (15 points), three aces (60) and two more cards. */
	function unmelded(
		teamScores: readonly [number, number] = [0, 0],
	): MatchState {
		const match = afterDraw(7);
		const turn = match.hand.turn;
		const own = cardsOf([...sevens, ...aces, "0-9D", "0-4C"]);
		return {
			...match,
			scores: teamScores,
			hand: {
				...match.hand,
				teamScores,
				hands: match.hand.hands.map((cards, index) =>
					index === turn ? own : cards,
				),
			},
		};
	}
	function melded(match: MatchState, cards: readonly string[]): MatchState {
		const step = applyAction(match.hand, match.hand.turn, {
			type: "meld",
			cards,
		});
		if (!step.ok) throw new Error(step.reason);
		return { ...match, hand: step.hand };
	}
	const viewOf = (match: MatchState) =>
		tableView(inputFor(stateOf(match, 1), turnOf(match)));
	const ownSide = (match: MatchState) => teamOf(match.hand.turn);

	it("shows each side's minimum until it melds, from its score at the deal", () => {
		const match = unmelded([1500, -20]);
		const view = viewOf(match);
		expect(view.sides.map((side) => side.initialMeld)).toEqual([
			"First meld: at least 90 points",
			"First meld: at least 15 points",
		]);
		const minimum = ownSide(match) === 0 ? 90 : 15;
		expect(view.prompt).toBe(
			`Your turn: your side's first meld needs at least ${minimum} points. Meld, or discard.`,
		);
		expect(
			viewOf(unmelded([3000, 0])).sides.map((side) => side.initialMeld),
		).toEqual([
			"First meld: at least 120 points",
			"First meld: at least 50 points",
		]);
	});

	it("counts the points melded this turn and says how many are missing", () => {
		const match = melded(unmelded(), sevens);
		const view = viewOf(match);
		expect(view.sides[ownSide(match)]?.initialMeld).toBe(
			"First meld: 15 of 50 points",
		);
		expect(view.prompt).toBe(
			"Your turn: your side's first meld has 15 of the 50 points. Meld 35 more, or take back this turn's melds.",
		);
	});

	it("says when the melds of the turn reach the minimum", () => {
		const match = melded(melded(unmelded(), sevens), aces);
		const view = viewOf(match);
		expect(view.sides[ownSide(match)]?.initialMeld).toBe(
			"First meld: 75 of 50 points",
		);
		expect(view.prompt).toBe(
			"Your turn: your side's first meld has 75 points, enough for the 50. Meld more, or discard.",
		);
	});

	it("shows no minimum for a side that has melded", () => {
		const match = melded(melded(unmelded(), sevens), aces);
		const step = applyAction(match.hand, match.hand.turn, {
			type: "discard",
			card: "0-4C",
		});
		if (!step.ok) throw new Error(step.reason);
		const after = { ...match, hand: step.hand };
		expect(viewOf(after).sides[ownSide(match)]?.initialMeld).toBe("");
	});

	it("tells a side that has melded only to meld, extend and discard", () => {
		const match = afterDraw(7);
		const turn = match.hand.turn;
		const side = { melds: [], redThrees: [], initialMade: true };
		const teams = match.hand.teams;
		const made: MatchState = {
			...match,
			hand: {
				...match.hand,
				teams: teamOf(turn) === 0 ? [side, teams[1]] : [teams[0], side],
			},
		};
		expect(viewOf(made).prompt).toBe("Your turn: meld, extend, then discard.");
	});
});

/** The match after the seat on turn drew from the stock, so it can meld and discard. */
function afterDraw(seed: number): MatchState {
	const match = startMatch(seed);
	const step = applyAction(match.hand, match.hand.turn, { type: "draw" });
	if (!step.ok) throw new Error(step.reason);
	return { ...match, hand: step.hand };
}

/** The cards with the given ids, in that order. */
function cardsOf(ids: readonly string[]): Card[] {
	const deck = buildDecks();
	return ids.flatMap((id) => deck.filter((card) => card.id === id));
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
