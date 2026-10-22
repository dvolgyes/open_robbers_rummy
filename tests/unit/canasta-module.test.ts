import { describe, expect, it } from "vitest";
import { type Action, legalActions } from "../../src/canasta";
import {
	actionPayload,
	type CanastaState,
	canastaModule,
	createCanastaModule,
	engineSeat,
	nextHandPayload,
	parseAction,
	parseCanastaState,
	resetCancelPayload,
	resetRequestPayload,
	resetVotePayload,
	startPayload,
	tableSeat,
} from "../../src/game/canasta";
import { chatPayload } from "../../src/game/chat";
import type { ApplyContext } from "../../src/game/module";
import { type JsonObject, SEATS, type Seat } from "../../src/protocol";
import { type RandomBelow, randomBelowFrom } from "../../src/random";

const ROOM = "room-1";
const names = { N: "Ann", E: "Ben", S: "Cy", W: "Dee" } as const;

/** Deterministic randomness: a small LCG, so each test reproduces the same deal. */
function seededRandom(seed: number): RandomBelow {
	let state = seed >>> 0;
	return randomBelowFrom(() => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	});
}

const module = createCanastaModule(seededRandom(42));

function context(seat: Seat, present: readonly Seat[] = SEATS): ApplyContext {
	return {
		roomId: ROOM,
		config: { names },
		seat,
		holder: `holder-${seat}`,
		commandId: "cmd",
		seq: 1,
		present,
	};
}

function started(): JsonObject {
	const initial = module.initialState(ROOM, { names });
	const result = module.apply(initial, context("N"), startPayload(ROOM));
	if (!result.ok) throw new Error(result.reason);
	return result.state;
}

function table(state: JsonObject): CanastaState {
	const parsed = parseCanastaState(state, ROOM);
	if (parsed === undefined) throw new Error("state does not parse");
	return parsed;
}

function currentSeat(state: JsonObject): Seat {
	const { match } = table(state);
	if (match === null) throw new Error("no match");
	return tableSeat(match.hand.turn);
}

describe("canasta module: starting and presence", () => {
	it("creates a valid empty table", () => {
		const initial = module.initialState(ROOM, { names });
		expect(module.isState(initial, ROOM)).toBe(true);
		expect(table(initial).match).toBeNull();
	});

	it("refuses to start while a seat is away, and names the seat", () => {
		const initial = module.initialState(ROOM, { names });
		const result = module.apply(
			initial,
			context("N", ["N", "E", "S"]),
			startPayload(ROOM),
		);
		expect(result).toEqual({
			ok: false,
			reason: "Waiting for West to come back",
			waiting: true,
		});
	});

	it("deals the same hand for the same seed", () => {
		const first = createCanastaModule(seededRandom(7)).apply(
			module.initialState(ROOM, { names }),
			context("N"),
			startPayload(ROOM),
		);
		const second = createCanastaModule(seededRandom(7)).apply(
			module.initialState(ROOM, { names }),
			context("N"),
			startPayload(ROOM),
		);
		if (!first.ok || !second.ok) throw new Error("start was refused");
		expect(table(first.state).match?.hand.hands).toEqual(
			table(second.state).match?.hand.hands,
		);
	});

	it("starts only once", () => {
		const result = module.apply(started(), context("N"), startPayload(ROOM));
		expect(result).toMatchObject({ ok: false });
	});
});

describe("canasta module: actions", () => {
	it("accepts the action of the player whose turn it is and counts it", () => {
		const state = started();
		const seat = currentSeat(state);
		const { match } = table(state);
		if (match === null) throw new Error("no match");
		const draw: Action = { type: "draw" };
		const result = module.apply(
			state,
			context(seat),
			actionPayload(ROOM, match, table(state).actions, draw),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(table(result.state).actions).toBe(1);
	});

	it("rejects an action chosen before the last accepted action", () => {
		const state = started();
		const seat = currentSeat(state);
		const { match } = table(state);
		if (match === null) throw new Error("no match");
		const stale = module.apply(state, context(seat), {
			...actionPayload(ROOM, match, 5, { type: "draw" }),
		});
		expect(stale).toMatchObject({
			ok: false,
			reason: "the table has moved on since this action was chosen",
		});
	});

	it("rejects an action from a player who is not on turn", () => {
		const state = started();
		const other = SEATS.find((seat) => seat !== currentSeat(state)) as Seat;
		const { match } = table(state);
		if (match === null) throw new Error("no match");
		const result = module.apply(
			state,
			context(other),
			actionPayload(ROOM, match, 0, { type: "draw" }),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects a malformed action", () => {
		expect(parseAction({ type: "meld" })).toBeUndefined();
		expect(parseAction({ type: "fly" })).toBeUndefined();
		expect(parseAction({ type: "discard", card: 7 })).toBeUndefined();
		expect(
			parseAction({ type: "takePile", cards: ["0-7H"], extend: "m1" }),
		).toEqual({
			type: "takePile",
			cards: ["0-7H"],
			extend: "m1",
		});
	});

	it("maps protocol seats to engine seats, with partners sharing a team", () => {
		expect(engineSeat("N")).toBe(0);
		expect(engineSeat("S")).toBe(2);
		expect(tableSeat(3)).toBe("W");
	});
});

describe("canasta module: replicated state", () => {
	it("rejects a state with a duplicated card", () => {
		const state = started();
		const copy = JSON.parse(JSON.stringify(state)) as {
			match: { hand: { hands: { id: string }[][] } };
		};
		const first = copy.match.hand.hands[0]?.[0];
		const second = copy.match.hand.hands[1]?.[0];
		if (first === undefined || second === undefined)
			throw new Error("no cards");
		second.id = first.id;
		expect(module.isState(copy as JsonObject, ROOM)).toBe(false);
	});

	it("rejects a state for another room", () => {
		expect(module.isState(started(), "other-room")).toBe(false);
	});
});

describe("canasta module: a full hand through the module", () => {
	it("plays one hand to settlement with legal actions only, then deals the next", () => {
		const state = playToSettlement(started());
		const finished = table(state);
		expect(finished.match?.settled).toBe(true);
		expect(finished.actions).toBeGreaterThan(0);
		const next = module.apply(state, context("N"), nextHandPayload(ROOM));
		expect(next.ok).toBe(true);
		if (next.ok) expect(table(next.state).match?.handNo).toBe(2);
	});
});

describe("canasta module: shared constants", () => {
	it("is the module for canasta tables", () => {
		expect(canastaModule.isState(started(), ROOM)).toBe(true);
	});
});

/** Plays the current hand with legal actions until the host settles it. */
function playToSettlement(start: JsonObject): JsonObject {
	let state = start;
	for (let step = 0; step < 5000; step++) {
		const parsed = table(state);
		const match = parsed.match;
		if (match === null) throw new Error("no match");
		if (match.settled) return state;
		const seat = tableSeat(match.hand.turn);
		const options = legalActions(match.hand, match.hand.turn);
		const pick = options[(step * 7919) % options.length];
		if (pick === undefined) throw new Error(`no legal action at step ${step}`);
		const result = module.apply(
			state,
			context(seat),
			actionPayload(ROOM, match, parsed.actions, pick),
		);
		if (!result.ok) throw new Error(`step ${step}: ${result.reason}`);
		state = result.state;
	}
	throw new Error("the hand did not end");
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

function requestId(state: JsonObject): string {
	const id = table(state).reset?.id;
	if (id === undefined) throw new Error("no reset request");
	return id;
}

describe("canasta module: reset", () => {
	it("waits for the three other players, then clears the scores, keeps the messages, and lets the host deal a new match", () => {
		let state = playToSettlement(started());
		state = applied(state, "E", chatPayload(ROOM, "hi"));
		const before = table(state);
		expect(before.match?.settled).toBe(true);
		expect(before.matches).toBe(1);

		state = applied(state, "N", resetRequestPayload(ROOM));
		expect(table(state).reset).toEqual({
			id: commandIdOf("N"),
			requester: "N",
			required: ["E", "S", "W"],
			approved: [],
		});
		state = applied(state, "E", resetVotePayload(ROOM, requestId(state), true));
		state = applied(state, "S", resetVotePayload(ROOM, requestId(state), true));
		expect(table(state).match).not.toBeNull();
		const result = module.apply(
			state,
			context("W"),
			resetVotePayload(ROOM, requestId(state), true),
		);
		expect(result).toMatchObject({
			ok: true,
			event: { kind: "reset-applied", requester: "N" },
		});
		if (!result.ok) return;
		const after = table(result.state);
		expect(after).toMatchObject({
			match: null,
			actions: 0,
			reset: null,
			matches: 1,
			messages: before.messages,
		});

		const again = applied(result.state, "N", startPayload(ROOM));
		expect(table(again).match).toMatchObject({
			handNo: 1,
			scores: [0, 0],
			settled: false,
		});
		expect(table(again).matches).toBe(2);
	});

	it("ends the request when one player rejects it, and keeps the match", () => {
		let state = applied(started(), "S", resetRequestPayload(ROOM));
		const match = table(state).match;
		state = applied(state, "W", resetVotePayload(ROOM, requestId(state), true));
		const result = module.apply(
			state,
			context("N"),
			resetVotePayload(ROOM, requestId(state), false),
		);
		expect(result).toMatchObject({
			ok: true,
			event: { kind: "reset-rejected", by: "N" },
		});
		if (result.ok)
			expect(table(result.state)).toMatchObject({ reset: null, match });
	});

	it("lets only the requester cancel the request", () => {
		const state = applied(started(), "S", resetRequestPayload(ROOM));
		const id = requestId(state);
		expect(
			module.apply(state, context("E"), resetCancelPayload(ROOM, id)),
		).toEqual({
			ok: false,
			reason: "only the requester can cancel this reset",
		});
		expect(
			table(applied(state, "S", resetCancelPayload(ROOM, id))).reset,
		).toBeNull();
	});

	it("blocks the game, the next hand and a second request while a reset waits for answers", () => {
		const state = applied(started(), "N", resetRequestPayload(ROOM));
		const { match, actions } = table(state);
		if (match === null) throw new Error("no match");
		const seat = currentSeat(state);
		const blocked = {
			ok: false,
			reason: "a reset request is waiting for answers",
		};
		expect(
			module.apply(
				state,
				context(seat),
				actionPayload(ROOM, match, actions, { type: "draw" }),
			),
		).toEqual(blocked);
		expect(
			module.apply(state, context("E"), resetRequestPayload(ROOM)),
		).toEqual(blocked);
		const settled = applied(
			playToSettlement(started()),
			"N",
			resetRequestPayload(ROOM),
		);
		expect(module.apply(settled, context("N"), nextHandPayload(ROOM))).toEqual(
			blocked,
		);
	});

	it("asks only the players who are present, and resets at once when the requester is alone", () => {
		const partial = applied(started(), "N", resetRequestPayload(ROOM), [
			"N",
			"S",
		]);
		expect(table(partial).reset?.required).toEqual(["S"]);
		const alone = module.apply(
			started(),
			context("N", ["N"]),
			resetRequestPayload(ROOM),
		);
		expect(alone).toMatchObject({ ok: true, event: { kind: "reset-applied" } });
		if (alone.ok) expect(table(alone.state).match).toBeNull();
	});

	it("refuses a vote from a seat that was not asked, a repeated approval, and a vote for another request", () => {
		let state = applied(started(), "N", resetRequestPayload(ROOM), [
			"N",
			"E",
			"S",
		]);
		const id = requestId(state);
		expect(
			module.apply(state, context("W"), resetVotePayload(ROOM, id, true)),
		).toMatchObject({
			ok: false,
			reason: "your seat is not asked to approve this reset",
		});
		expect(
			module.apply(state, context("E"), resetVotePayload(ROOM, "other", true)),
		).toMatchObject({
			ok: false,
			reason: "there is no matching reset request",
		});
		state = applied(state, "E", resetVotePayload(ROOM, id, true));
		expect(
			module.apply(state, context("E"), resetVotePayload(ROOM, id, true)),
		).toMatchObject({
			ok: false,
			reason: "your seat has already approved this reset",
		});
	});

	it("keeps a waiting request in the replicated state, and refuses a malformed one", () => {
		const state = applied(started(), "N", resetRequestPayload(ROOM));
		expect(module.isState(JSON.parse(JSON.stringify(state)), ROOM)).toBe(true);
		const reset = table(state).reset;
		expect(
			module.isState(
				{ ...state, reset: { ...reset, required: ["N", "E"] } },
				ROOM,
			),
		).toBe(false);
		expect(
			module.isState(
				{ ...state, reset: { ...reset, approved: ["W", "W"] } },
				ROOM,
			),
		).toBe(false);
	});

	it("is not a host-only command, because it deals no cards", () => {
		expect(module.isRandomCommand?.(resetRequestPayload(ROOM))).toBe(false);
		expect(module.isRandomCommand?.(resetVotePayload(ROOM, "x", true))).toBe(
			false,
		);
	});
});
