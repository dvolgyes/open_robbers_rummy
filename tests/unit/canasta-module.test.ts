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
	startPayload,
	tableSeat,
} from "../../src/game/canasta";
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
		config: { names, scoring: "duplicate" },
		seat,
		holder: `holder-${seat}`,
		commandId: "cmd",
		seq: 1,
		present,
	};
}

function started(): JsonObject {
	const initial = module.initialState(ROOM, { names, scoring: "duplicate" });
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
		const initial = module.initialState(ROOM, { names, scoring: "duplicate" });
		expect(module.isState(initial, ROOM)).toBe(true);
		expect(table(initial).match).toBeNull();
	});

	it("refuses to start while a seat is away, and names the seat", () => {
		const initial = module.initialState(ROOM, { names, scoring: "duplicate" });
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
			module.initialState(ROOM, { names, scoring: "duplicate" }),
			context("N"),
			startPayload(ROOM),
		);
		const second = createCanastaModule(seededRandom(7)).apply(
			module.initialState(ROOM, { names, scoring: "duplicate" }),
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
		let state = started();
		let accepted = 0;
		for (let step = 0; step < 5000; step++) {
			const parsed = table(state);
			const match = parsed.match;
			if (match === null) throw new Error("no match");
			if (match.settled) break;
			const seat = tableSeat(match.hand.turn);
			const options = legalActions(match.hand, match.hand.turn);
			const pick = options[(step * 7919) % options.length];
			if (pick === undefined)
				throw new Error(`no legal action at step ${step}`);
			const result = module.apply(
				state,
				context(seat),
				actionPayload(ROOM, match, parsed.actions, pick),
			);
			if (!result.ok) throw new Error(`step ${step}: ${result.reason}`);
			state = result.state;
			accepted++;
		}
		const finished = table(state).match;
		expect(finished?.settled).toBe(true);
		expect(accepted).toBeGreaterThan(0);
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
