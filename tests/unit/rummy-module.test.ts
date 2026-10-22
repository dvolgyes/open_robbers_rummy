import { describe, expect, it } from "vitest";
import { chatPayload } from "../../src/game/chat";
import type { ApplyContext } from "../../src/game/module";
import {
	actionPayload,
	createRummyModule,
	engineSeat,
	parseAction,
	parseRummyState,
	type RummyState,
	resetCancelPayload,
	resetRequestPayload,
	resetVotePayload,
	rummyModule,
	startPayload,
	tableSeat,
} from "../../src/game/rummy";
import {
	DEFAULT_TABLE_SETUP,
	type JsonObject,
	MAX_JOKERS as MAX_TABLE_JOKERS,
	MIN_JOKERS as MIN_TABLE_JOKERS,
	SEATS,
	type Seat,
	seatsOf,
	TABLE_PRESETS,
} from "../../src/protocol";
import { type RandomBelow, randomBelowFrom } from "../../src/random";
import {
	legalActions,
	MAX_JOKERS,
	MIN_JOKERS,
	RULE_PRESETS,
} from "../../src/rummy";

const ROOM = "room-1";
const names = { "1": "Ann", "2": "Ben", "3": "Cy", "4": "Dee" } as const;
const config = { names, table: DEFAULT_TABLE_SETUP };

/** Deterministic randomness: a small LCG, so each test reproduces the same deal. */
function seededRandom(seed: number): RandomBelow {
	let state = seed >>> 0;
	return randomBelowFrom(() => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	});
}

const module = createRummyModule(seededRandom(42));

function context(seat: Seat, present: readonly Seat[] = SEATS): ApplyContext {
	return {
		roomId: ROOM,
		config,
		seat,
		holder: `holder-${seat}`,
		commandId: "cmd",
		seq: 1,
		present,
	};
}

/** A command id in the format that `newCommandId` gives, one for each seat. */
function commandIdOf(seat: Seat): string {
	return `00000000-0000-4000-8000-00000000000${SEATS.indexOf(seat)}`;
}

function applied(
	state: JsonObject,
	seat: Seat,
	payload: JsonObject,
	present: readonly Seat[] = SEATS,
): JsonObject {
	const result = module.apply(
		state,
		{ ...context(seat, present), commandId: commandIdOf(seat) },
		payload,
	);
	if (!result.ok) throw new Error(result.reason);
	return result.state;
}

function started(): JsonObject {
	return applied(module.initialState(ROOM, config), "1", startPayload(ROOM));
}

function table(state: JsonObject): RummyState {
	const parsed = parseRummyState(state, ROOM);
	if (parsed === undefined) throw new Error("state does not parse");
	return parsed;
}

function currentSeat(state: JsonObject): Seat {
	const { match } = table(state);
	if (match === null) throw new Error("no game");
	return tableSeat(match.hand.turn);
}

/** Plays the hand with draws, ends and passes only, until every player passes at the empty stock. */
function playToBlockedEnd(start: JsonObject): JsonObject {
	let state = start;
	for (let step = 0; step < 1000; step++) {
		const parsed = table(state);
		const match = parsed.match;
		if (match === null) throw new Error("no game");
		if (match.hand.outcome !== null) return state;
		const pick = legalActions(match.hand, match.hand.turn)[0];
		if (pick === undefined) throw new Error(`no legal action at step ${step}`);
		state = applied(
			state,
			tableSeat(match.hand.turn),
			actionPayload(ROOM, match, parsed.actions, pick),
		);
	}
	throw new Error("the hand did not end");
}

function requestId(state: JsonObject): string {
	const id = table(state).reset?.id;
	if (id === undefined) throw new Error("no reset request");
	return id;
}

/** Ends the game through a reset that every other player approves. */
function resetByAll(state: JsonObject): JsonObject {
	let next = applied(state, "1", resetRequestPayload(ROOM));
	for (const seat of ["2", "3", "4"] as const)
		next = applied(next, seat, resetVotePayload(ROOM, requestId(next), true));
	return next;
}

describe("rummy module: table setup", () => {
	it("offers at table creation the presets and joker counts that the engine accepts", () => {
		expect([...TABLE_PRESETS]).toEqual([...RULE_PRESETS]);
		expect([MIN_TABLE_JOKERS, MAX_TABLE_JOKERS]).toEqual([
			MIN_JOKERS,
			MAX_JOKERS,
		]);
	});
});

describe("rummy module: starting and presence", () => {
	it("creates a valid empty table", () => {
		const initial = module.initialState(ROOM, config);
		expect(module.isState(initial, ROOM)).toBe(true);
		expect(table(initial)).toMatchObject({ match: null, lastDealer: null });
	});

	it("refuses to start while a seat is away, and names the seat", () => {
		const result = module.apply(
			module.initialState(ROOM, config),
			context("1", ["1", "2", "3"]),
			startPayload(ROOM),
		);
		expect(result).toEqual({
			ok: false,
			reason: "Waiting for Player 4 to come back",
			waiting: true,
		});
	});

	it("deals one hand per playing seat with the table's rules", () => {
		const { match, matches } = table(started());
		expect(matches).toBe(1);
		expect(match?.handNo).toBe(1);
		expect(match?.hand.players).toBe(4);
		expect(match?.hand.rules).toMatchObject({
			preset: "gamerules",
			jokers: 4,
		});
		expect(match?.hand.hands.map((cards) => cards.length)).toEqual([
			11, 11, 11, 11,
		]);
	});

	it("chooses the first dealer at random", () => {
		const dealers = new Set(
			Array.from({ length: 40 }, (_, seed) => {
				const result = createRummyModule(seededRandom(seed)).apply(
					module.initialState(ROOM, config),
					context("1"),
					startPayload(ROOM),
				);
				if (!result.ok) throw new Error(result.reason);
				return table(result.state).match?.hand.dealer;
			}),
		);
		expect([...dealers].sort()).toEqual([0, 1, 2, 3]);
	});

	it("deals the same hand for the same randomness", () => {
		const deal = (seed: number) => {
			const result = createRummyModule(seededRandom(seed)).apply(
				module.initialState(ROOM, config),
				context("1"),
				startPayload(ROOM),
			);
			if (!result.ok) throw new Error(result.reason);
			return table(result.state).match?.hand.hands;
		};
		expect(deal(7)).toEqual(deal(7));
	});

	it("starts only once while the game runs", () => {
		expect(
			module.apply(started(), context("1"), startPayload(ROOM)),
		).toMatchObject({ ok: false, reason: "the game has already started" });
	});

	it("is a host-only command, because it deals cards", () => {
		expect(module.isRandomCommand?.(startPayload(ROOM))).toBe(true);
		expect(module.isRandomCommand?.(resetRequestPayload(ROOM))).toBe(false);
	});

	it("refuses a command from a seat that does not play at the table", () => {
		const twoPlayers = { names: { "1": "Ann", "2": "Ben" } } as never;
		const result = module.apply(
			module.initialState(ROOM, twoPlayers),
			{ ...context("3"), config: twoPlayers },
			startPayload(ROOM),
		);
		expect(result).toEqual({
			ok: false,
			reason: "your seat does not play at this table",
		});
	});
});

describe("rummy module: actions", () => {
	it("accepts the action of the player whose turn it is and counts it", () => {
		const state = started();
		const { match } = table(state);
		if (match === null) throw new Error("no game");
		const result = module.apply(
			state,
			context(currentSeat(state)),
			actionPayload(ROOM, match, 0, { type: "draw" }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(table(result.state).actions).toBe(1);
	});

	it("rejects an action chosen at another position", () => {
		const state = started();
		const { match } = table(state);
		if (match === null) throw new Error("no game");
		expect(
			module.apply(
				state,
				context(currentSeat(state)),
				actionPayload(ROOM, match, 5, { type: "draw" }),
			),
		).toMatchObject({
			ok: false,
			reason: "the table has moved on since this action was chosen",
		});
	});

	it("rejects an action from a player who is not on turn", () => {
		const state = started();
		const other = SEATS.find((seat) => seat !== currentSeat(state)) as Seat;
		const { match } = table(state);
		if (match === null) throw new Error("no game");
		expect(
			module.apply(
				state,
				context(other),
				actionPayload(ROOM, match, 0, { type: "draw" }),
			),
		).toMatchObject({ ok: false, reason: "it is not your turn" });
	});

	it("waits for an absent player before it applies a legal action", () => {
		const state = started();
		const seat = currentSeat(state);
		const { match } = table(state);
		if (match === null) throw new Error("no game");
		const result = module.apply(
			state,
			context(seat, [seat]),
			actionPayload(ROOM, match, 0, { type: "draw" }),
		);
		expect(result).toMatchObject({ ok: false, waiting: true });
	});

	it("reads each action type and rejects a malformed one", () => {
		expect(parseAction({ type: "draw" })).toEqual({ type: "draw" });
		expect(parseAction({ type: "pass", extra: 1 })).toEqual({ type: "pass" });
		expect(parseAction({ type: "play", melds: [["0-2C"]] })).toEqual({
			type: "play",
			melds: [["0-2C"]],
		});
		expect(parseAction({ type: "play", melds: [[7]] })).toBeUndefined();
		expect(parseAction({ type: "play" })).toBeUndefined();
		expect(
			parseAction({
				type: "play",
				melds: Array.from({ length: 41 }, () => []),
			}),
		).toBeUndefined();
		expect(parseAction({ type: "discard", card: "0-2C" })).toBeUndefined();
	});

	it("maps protocol seats to engine seats in turn order", () => {
		expect(engineSeat("1")).toBe(0);
		expect(engineSeat("4")).toBe(3);
		expect(tableSeat(2)).toBe("3");
		expect(seatsOf(config)).toEqual(["1", "2", "3", "4"]);
	});

	it("plays a hand to its end and then refuses further actions", () => {
		const state = playToBlockedEnd(started());
		const { match, actions } = table(state);
		expect(match?.hand.outcome).toEqual({ kind: "blocked" });
		if (match === null) throw new Error("no game");
		expect(
			module.apply(
				state,
				context("1"),
				actionPayload(ROOM, match, actions, { type: "pass" }),
			),
		).toMatchObject({ ok: false, reason: "this game is over" });
		expect(module.apply(state, context("1"), startPayload(ROOM))).toMatchObject(
			{ ok: false, reason: "the game is over; ask for a new game" },
		);
	});
});

describe("rummy module: replicated state", () => {
	type Raw = {
		match: {
			hand: {
				hands: string[][];
				stock: string[];
				rules: Record<string, unknown>;
				players: number;
			};
		};
	};
	const copy = (): Raw => JSON.parse(JSON.stringify(started())) as Raw;
	const valid = (raw: Raw) =>
		module.isState(raw as unknown as JsonObject, ROOM);

	it("reads its own state back after a JSON round trip", () => {
		expect(valid(copy())).toBe(true);
	});

	it("rejects a duplicated card", () => {
		const raw = copy();
		const [first] = raw.match.hand.hands[0] ?? [];
		const second = raw.match.hand.hands[1];
		if (first === undefined || second === undefined)
			throw new Error("no cards");
		second[0] = first;
		expect(valid(raw)).toBe(false);
	});

	it("rejects a missing card", () => {
		const raw = copy();
		raw.match.hand.stock.pop();
		expect(valid(raw)).toBe(false);
	});

	it("rejects a joker that the rules do not deal", () => {
		const raw = copy();
		raw.match.hand.stock[0] = "JK5";
		expect(valid(raw)).toBe(false);
	});

	it("rejects rules that no preset gives", () => {
		const raw = copy();
		raw.match.hand.rules.handSize = 7;
		expect(valid(raw)).toBe(false);
	});

	it("rejects a hand list that does not match the player count", () => {
		const raw = copy();
		raw.match.hand.players = 3;
		expect(valid(raw)).toBe(false);
	});

	it("rejects a state for another room", () => {
		expect(module.isState(started(), "other-room")).toBe(false);
	});

	it("is the module for rummy tables", () => {
		expect(rummyModule.isState(started(), ROOM)).toBe(true);
	});
});

describe("rummy module: reset and new game", () => {
	it("waits for the other players, then ends the game and keeps the messages", () => {
		let state = applied(started(), "2", chatPayload(ROOM, "hi"));
		state = applied(state, "1", resetRequestPayload(ROOM));
		expect(table(state).reset).toEqual({
			id: commandIdOf("1"),
			requester: "1",
			required: ["2", "3", "4"],
			approved: [],
		});
		state = applied(state, "2", resetVotePayload(ROOM, requestId(state), true));
		state = applied(state, "3", resetVotePayload(ROOM, requestId(state), true));
		expect(table(state).match).not.toBeNull();
		const result = module.apply(
			state,
			context("4"),
			resetVotePayload(ROOM, requestId(state), true),
		);
		expect(result).toMatchObject({
			ok: true,
			event: { kind: "reset-applied", requester: "1" },
		});
		if (!result.ok) return;
		expect(table(result.state)).toMatchObject({
			match: null,
			actions: 0,
			reset: null,
			matches: 1,
			messages: 1,
		});
	});

	it("deals the next game from the next seat after a finished hand", () => {
		const finished = playToBlockedEnd(started());
		const dealer = table(finished).match?.hand.dealer;
		if (dealer === undefined) throw new Error("no game");
		const next = applied(resetByAll(finished), "1", startPayload(ROOM));
		expect(table(next).matches).toBe(2);
		expect(table(next).match?.handNo).toBe(2);
		expect(table(next).match?.hand.dealer).toBe((dealer + 1) % 4);
		expect(table(next).match?.hand.outcome).toBeNull();
	});

	it("ends the request when one player rejects it, and keeps the game", () => {
		let state = applied(started(), "3", resetRequestPayload(ROOM));
		const match = table(state).match;
		state = applied(state, "4", resetVotePayload(ROOM, requestId(state), true));
		const result = module.apply(
			state,
			context("1"),
			resetVotePayload(ROOM, requestId(state), false),
		);
		expect(result).toMatchObject({
			ok: true,
			event: { kind: "reset-rejected", by: "1" },
		});
		if (result.ok)
			expect(table(result.state)).toMatchObject({ reset: null, match });
	});

	it("lets only the requester cancel the request", () => {
		const state = applied(started(), "3", resetRequestPayload(ROOM));
		const id = requestId(state);
		expect(
			module.apply(state, context("2"), resetCancelPayload(ROOM, id)),
		).toEqual({
			ok: false,
			reason: "only the requester can cancel this reset",
		});
		expect(
			table(applied(state, "3", resetCancelPayload(ROOM, id))).reset,
		).toBeNull();
	});

	it("blocks the game and a second request while a reset waits for answers", () => {
		const state = applied(started(), "1", resetRequestPayload(ROOM));
		const { match, actions } = table(state);
		if (match === null) throw new Error("no game");
		const blocked = {
			ok: false,
			reason: "a reset request is waiting for answers",
		};
		expect(
			module.apply(
				state,
				context(currentSeat(state)),
				actionPayload(ROOM, match, actions, { type: "draw" }),
			),
		).toEqual(blocked);
		expect(
			module.apply(state, context("2"), resetRequestPayload(ROOM)),
		).toEqual(blocked);
	});

	it("asks only the players who are present, and resets at once when the requester is alone", () => {
		const partial = applied(started(), "1", resetRequestPayload(ROOM), [
			"1",
			"3",
		]);
		expect(table(partial).reset?.required).toEqual(["3"]);
		const alone = module.apply(
			started(),
			context("1", ["1"]),
			resetRequestPayload(ROOM),
		);
		expect(alone).toMatchObject({ ok: true, event: { kind: "reset-applied" } });
	});

	it("refuses a vote from a seat that was not asked, a repeated approval, and a vote for another request", () => {
		let state = applied(started(), "1", resetRequestPayload(ROOM), [
			"1",
			"2",
			"3",
		]);
		const id = requestId(state);
		expect(
			module.apply(state, context("4"), resetVotePayload(ROOM, id, true)),
		).toMatchObject({
			ok: false,
			reason: "your seat is not asked to approve this reset",
		});
		expect(
			module.apply(state, context("2"), resetVotePayload(ROOM, "other", true)),
		).toMatchObject({
			ok: false,
			reason: "there is no matching reset request",
		});
		state = applied(state, "2", resetVotePayload(ROOM, id, true));
		expect(
			module.apply(state, context("2"), resetVotePayload(ROOM, id, true)),
		).toMatchObject({
			ok: false,
			reason: "your seat has already approved this reset",
		});
	});

	it("keeps a waiting request in the replicated state, and refuses a malformed one", () => {
		const state = applied(started(), "1", resetRequestPayload(ROOM));
		expect(module.isState(JSON.parse(JSON.stringify(state)), ROOM)).toBe(true);
		const reset = table(state).reset;
		expect(
			module.isState(
				{ ...state, reset: { ...reset, required: ["1", "2"] } },
				ROOM,
			),
		).toBe(false);
	});
});
