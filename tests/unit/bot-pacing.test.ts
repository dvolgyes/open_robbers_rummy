import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BotTable, HostBotRunner } from "../../src/bot/host-runner";
import {
	BotPacer,
	type BotTime,
	COMMAND_GAP_MS,
	SHOW_PLAY_MS,
	sendAt,
} from "../../src/bot/pacing";
import type { Thinker } from "../../src/bot/think";
import type { ApplyContext } from "../../src/game/module";
import {
	createRummyModule,
	parseRummyState,
	type RummyMatch,
	startPayload,
	tableSeat,
} from "../../src/game/rummy";
import {
	DEFAULT_TABLE_SETUP,
	type JsonObject,
	SEATS,
	type Seat,
} from "../../src/protocol";
import { type RandomBelow, randomBelowFrom } from "../../src/random";
import type { Action } from "../../src/rummy";

const TABLE = "table-1";
const config = {
	names: { "1": "Ann", "2": "Bot", "3": "Bot", "4": "Bot" },
	table: DEFAULT_TABLE_SETUP,
};

/** Deterministic randomness: a small LCG, so each test deals the same cards. */
function seededRandom(seed: number): RandomBelow {
	let state = seed >>> 0;
	return randomBelowFrom(() => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	});
}

const module = createRummyModule(seededRandom(7));

function context(seat: Seat): ApplyContext {
	return {
		tableId: TABLE,
		config,
		seat,
		holder: `holder-${seat}`,
		commandId: `00000000-0000-4000-8000-00000000000${SEATS.indexOf(seat)}`,
		seq: 1,
		present: SEATS,
	};
}

function matchOf(state: JsonObject): RummyMatch {
	const match = parseRummyState(state, TABLE)?.match;
	if (!match) throw new Error("no game");
	return match;
}

function started(): JsonObject {
	const result = module.apply(
		module.initialState(TABLE, config),
		context("1"),
		startPayload(TABLE),
	);
	if (!result.ok) throw new Error(result.reason);
	return result.state;
}

/** Game time as the vitest fake timers move it. */
const fakeTime: BotTime = {
	now: () => Date.now(),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A host page that applies each bot command at once and tells its listeners. */
function hostTable(state: JsonObject, bots: readonly Seat[], hostSeat: Seat) {
	let current = state;
	const listeners = new Set<() => void>();
	const sent: { readonly at: number; readonly type: string }[] = [];
	const table: BotTable = {
		tableId: TABLE,
		view: () => ({
			hosting: true,
			ready: true,
			seat: hostSeat,
			table: { config, state: current },
			roster: { bots },
		}),
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		activateBots: async () => true,
		send: async () => ({ ok: false, code: "storage" }),
		async sendBot(seat, payload) {
			const result = module.apply(current, context(seat), payload);
			if (!result.ok) return { ok: false, reason: result.reason };
			current = result.state;
			sent.push({
				at: Date.now(),
				type: String((payload.action as { type?: unknown }).type),
			});
			for (const listener of listeners) listener();
			return { ok: true };
		},
	};
	return { table, sent, state: () => current };
}

/** A bot that draws and then ends the turn, and answers at once. */
const drawThenEnd: Thinker = {
	async choose(view): Promise<Action> {
		return view.phase === "start" ? { type: "draw" } : { type: "end" };
	},
	close() {},
};

describe("sendAt", () => {
	it("waits until the last play was shown for five seconds", () => {
		expect(SHOW_PLAY_MS).toBe(5000);
		expect(sendAt(10_000, undefined)).toBe(15_000);
		expect(sendAt(10_000, 9_000)).toBe(15_000);
	});

	it("keeps one second between two commands of the bots", () => {
		expect(COMMAND_GAP_MS).toBe(1000);
		expect(sendAt(10_000, 14_500)).toBe(15_500);
		expect(sendAt(0, 20_000)).toBe(21_000);
	});
});

describe("BotPacer", () => {
	const match = matchOf(started());

	function withPlay(cards: readonly string[], handNo = 1): RummyMatch {
		return {
			handNo,
			hand: { ...match.hand, lastPlay: { seat: 0, cards, meldIds: ["m1"] } },
		};
	}

	function pacerAt(clock: { now: number }): BotPacer {
		return new BotPacer({ now: () => clock.now, wait: async () => {} });
	}

	it("counts the first hand that it sees as a play now", () => {
		const clock = { now: 100 };
		const pacer = pacerAt(clock);
		pacer.observe(match);
		expect(pacer.delay()).toBe(SHOW_PLAY_MS);
	});

	it("starts the five seconds again only when a new play arrives", () => {
		const clock = { now: 0 };
		const pacer = pacerAt(clock);
		pacer.observe(withPlay(["0-5H", "0-6H", "0-7H"]));
		clock.now = 3000;
		pacer.observe(withPlay(["0-5H", "0-6H", "0-7H"]));
		expect(pacer.delay()).toBe(2000);
		pacer.observe(withPlay(["1-9C"]));
		expect(pacer.delay()).toBe(SHOW_PLAY_MS);
	});

	it("starts the five seconds again at a new hand", () => {
		const clock = { now: 0 };
		const pacer = pacerAt(clock);
		pacer.observe(withPlay(["1-9C"]));
		clock.now = 6000;
		pacer.observe(withPlay(["1-9C"]));
		expect(pacer.delay()).toBe(0);
		pacer.observe(withPlay(["1-9C"], 2));
		expect(pacer.delay()).toBe(SHOW_PLAY_MS);
	});

	it("keeps one second after its own last command", () => {
		const clock = { now: 0 };
		const pacer = pacerAt(clock);
		pacer.observe(match);
		clock.now = 8000;
		pacer.sent();
		clock.now = 8400;
		expect(pacer.delay()).toBe(600);
	});
});

describe("HostBotRunner pacing", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("moves at the deadline although no further change event comes", async () => {
		const state = started();
		const turnSeat = tableSeat(matchOf(state).hand.turn);
		const host = SEATS.find((seat) => seat !== turnSeat) ?? "1";
		const page = hostTable(state, [turnSeat], host);
		const runner = new HostBotRunner(
			page.table,
			drawThenEnd,
			undefined,
			fakeTime,
		);
		expect(await runner.start()).toBe(true);

		await vi.advanceTimersByTimeAsync(SHOW_PLAY_MS - 1);
		expect(page.sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(page.sent).toEqual([{ at: SHOW_PLAY_MS, type: "draw" }]);

		await vi.advanceTimersByTimeAsync(COMMAND_GAP_MS);
		expect(page.sent).toEqual([
			{ at: SHOW_PLAY_MS, type: "draw" },
			{ at: SHOW_PLAY_MS + COMMAND_GAP_MS, type: "end" },
		]);
		runner.stop();
	});
});
