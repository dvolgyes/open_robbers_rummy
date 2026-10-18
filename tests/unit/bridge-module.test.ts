import { describe, expect, it } from "vitest";
import type { RandomBelow } from "../../src/bridge/deal";
import { dealCards, randomBelowFrom } from "../../src/bridge/deal";
import {
	type Action,
	applyAction,
	type Board,
	boardStatus,
	createBoard,
	legalActions,
	parseAction,
	parseBoard,
	scoreBoard,
} from "../../src/bridge/engine";
import {
	type CallRecord,
	callRecordPayload,
	type StoredCallRecord,
} from "../../src/call/record";
import {
	actionPayload,
	claimRequestPayload,
	claimVotePayload,
	createBridgeModule,
	dealPayload,
	isChatCommand,
	isChatEvent,
	isTableCommand,
	parseBridgeState,
	totals,
} from "../../src/game/bridge";
import { chatModule, chatPayload } from "../../src/game/chat";
import type { ApplyResult } from "../../src/game/module";
import {
	APPLICATION_FEATURES,
	envelopeEvent,
	type JsonObject,
	PROTOCOL_VERSION,
	SEATS,
	type Seat,
} from "../../src/protocol";
import { call, DEAL, play } from "./bridge-fixtures";
import { CONFIG, OTHER_ROOM_ID, ROOM_ID } from "./fixtures";

/** A repeatable random source (xorshift32), so a test can predict the deal. */
function seeded(seed: number): RandomBelow {
	let x = seed;
	return randomBelowFrom(() => {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		return x >>> 0;
	});
}

function context(seat: Seat, seq = 1) {
	return {
		roomId: ROOM_ID,
		config: CONFIG,
		seat,
		holder: holderOf(seat),
		commandId: testCommandId(seq),
		seq,
		present: SEATS,
		features: new Map(
			SEATS.map((seat) => [seat, Object.values(APPLICATION_FEATURES)]),
		),
	};
}

function holderOf(seat: Seat): string {
	return `holder-${seat}`;
}

function testCommandId(seq: number): string {
	return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

/** Sends commands through the module as the host does, and keeps the event log. */
class Table {
	readonly module;
	state: JsonObject;
	readonly events: JsonObject[] = [];

	constructor(seed = 1, state?: JsonObject) {
		this.module = createBridgeModule(seeded(seed));
		this.state = state ?? this.module.initialState(ROOM_ID, CONFIG);
	}

	send(seat: Seat, payload: unknown): ApplyResult {
		const seq = this.events.length + 1;
		const result = this.module.apply(this.state, context(seat, seq), payload);
		if (result.ok) {
			this.state = result.state;
			this.events.push(
				envelopeEvent(
					{
						roomId: ROOM_ID,
						seq,
						commandId: testCommandId(seq),
						fromSeat: seat,
					},
					result.event,
				),
			);
		}
		return result;
	}

	board(): Board {
		const board = parseBridgeState(this.state, ROOM_ID)?.board;
		if (!board) throw new Error("no board on the table");
		return board;
	}

	/** The seat that must act sends `action` at the current position. */
	act(action: Action): ApplyResult {
		const board = this.board();
		const seat = boardStatus(board).actor;
		if (seat === undefined) throw new Error("nobody can act");
		const result = this.send(seat, actionPayload(ROOM_ID, board, action));
		expect(result, JSON.stringify(action)).toMatchObject({ ok: true });
		return result;
	}

	calls(text: string): void {
		for (const item of text.split(" ")) this.act(call(item));
	}

	/** Plays the first legal card `count` times, or until the board is over. */
	playFirstLegal(count = 52): void {
		for (let i = 0; i < count; i++) {
			const board = this.board();
			const seat = boardStatus(board).actor;
			if (seat === undefined) return;
			const [action] = legalActions(board, seat);
			if (!action) throw new Error("no legal action");
			this.act(action);
		}
	}
}

/** A table whose board 1 has the fixture deal, as if it had been dealt. */
function fixtureTable(): Table {
	const table = new Table();
	table.state = { ...table.state, board: createBoard(1, DEAL) };
	return table;
}

/**
 * Test oracle, independent of the module's state handling: rebuilds the board from the event log with
 * the engine alone. The deal comes from the deal event, and each action is applied for its sender.
 */
function replay(events: readonly JsonObject[]): Board | null {
	let board: Board | null = null;
	for (const event of events) {
		if (event.kind === "deal") {
			board = parseBoard(event.board) ?? null;
			if (!board) throw new Error("the deal event has no valid board");
		} else if (event.kind === "call" || event.kind === "play") {
			const action = parseAction({ ...event, type: event.kind });
			if (!board || !action) throw new Error("unreadable action event");
			const result = applyAction(board, event.fromSeat as Seat, action);
			if (!result.ok) throw new Error(result.reason);
			board = result.board;
		}
	}
	return board;
}

/** Postgres jsonb does not keep key order; reverse every object's keys to show that order does not matter. */
function reorderKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reorderKeys);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.reverse()
			.map(([key, item]) => [key, reorderKeys(item)]),
	);
}

function rejection(result: ApplyResult): string | undefined {
	return result.ok ? undefined : result.reason;
}

describe("bridge table state", () => {
	it("starts with no board, no results, no messages and no call status", () => {
		const state = createBridgeModule(seeded(1)).initialState(ROOM_ID, CONFIG);
		expect(parseBridgeState(state, ROOM_ID)).toEqual({
			v: PROTOCOL_VERSION,
			roomId: ROOM_ID,
			game: "bridge",
			messages: 0,
			board: null,
			results: [],
			undo: null,
			claim: null,
			claimResult: null,
			reset: null,
			media: {},
		});
	});

	it("refuses the state of another room or game, and a stored board with an illegal call", () => {
		const table = fixtureTable();
		expect(parseBridgeState(table.state, OTHER_ROOM_ID)).toBeUndefined();
		expect(
			parseBridgeState(chatModule.initialState(ROOM_ID, CONFIG), ROOM_ID),
		).toBeUndefined();
		const illegal = { ...createBoard(1, DEAL), calls: ["1C", "1C"] };
		expect(
			parseBridgeState({ ...table.state, board: illegal }, ROOM_ID),
		).toBeUndefined();
	});

	it("refuses results that do not match the boards", () => {
		const passedOut = {
			number: 1,
			contract: null,
			declarerTricks: 0,
			scoreNS: 0,
		};
		const table = fixtureTable();
		// Board 1 is still in the auction, so it cannot have a result yet.
		expect(
			parseBridgeState({ ...table.state, results: [passedOut] }, ROOM_ID),
		).toBeUndefined();
		table.calls("P P P P");
		const done = table.state;
		expect(parseBridgeState(done, ROOM_ID)?.results).toEqual([passedOut]);
		expect(parseBridgeState({ ...done, results: [] }, ROOM_ID)).toBeUndefined();
		expect(
			parseBridgeState(
				{ ...done, results: [{ ...passedOut, scoreNS: 50 }] },
				ROOM_ID,
			),
		).toBeUndefined();
	});

	it("reads a stored state the same whatever its key order", () => {
		const table = fixtureTable();
		table.calls("1S P P P");
		table.playFirstLegal(5);
		expect(
			parseBridgeState(reorderKeys(table.state) as JsonObject, ROOM_ID),
		).toEqual(parseBridgeState(table.state, ROOM_ID));
	});
});

describe("claim requests", () => {
	it("allows only declarer claims and waits for both defenders", () => {
		const table = fixtureTable();
		table.calls("1C P P P");
		let board = table.board();
		expect(boardStatus(board)).toMatchObject({ phase: "play", actor: "E" });
		const defenderRequest = table.send(
			"E",
			claimRequestPayload(ROOM_ID, board.number, 13),
		);
		expect(defenderRequest).toMatchObject({
			ok: false,
			reason: "the declarer can claim only on their turn or dummy's turn",
		});
		table.playFirstLegal(1);
		board = table.board();
		expect(boardStatus(board)).toMatchObject({
			phase: "play",
			turn: "S",
			actor: "N",
		});
		const request = table.send(
			"N",
			claimRequestPayload(ROOM_ID, board.number, 13),
		);
		expect(request.ok).toBe(true);
		const parsed = parseBridgeState(table.state, ROOM_ID);
		const pending = parsed?.claim;
		if (!pending) throw new Error("claim request was not stored");
		expect(pending.requester).toBe("N");
		expect(pending.required).toEqual(["E", "W"]);
		const rejectOnDummyTurn = table.send(
			"E",
			claimVotePayload(ROOM_ID, pending.id, false),
		);
		expect(rejectOnDummyTurn.ok).toBe(true);

		table.playFirstLegal(2);
		board = table.board();
		expect(boardStatus(board)).toMatchObject({
			phase: "play",
			turn: "N",
			actor: "N",
		});
		const ownTurnRequest = table.send(
			"N",
			claimRequestPayload(ROOM_ID, board.number, 13),
		);
		expect(ownTurnRequest.ok).toBe(true);
		const ownTurnPending = parseBridgeState(table.state, ROOM_ID)?.claim;
		if (!ownTurnPending) throw new Error("claim request was not stored");

		const requesterVote = table.send(
			"N",
			claimVotePayload(ROOM_ID, ownTurnPending.id, true),
		);
		expect(requesterVote).toMatchObject({
			ok: false,
			reason: "your seat is not asked to decide this claim",
		});

		const firstVote = table.send(
			"E",
			claimVotePayload(ROOM_ID, ownTurnPending.id, true),
		);
		expect(firstVote.ok).toBe(true);
		expect(parseBridgeState(table.state, ROOM_ID)).toMatchObject({
			claim: { id: ownTurnPending.id, approved: ["E"] },
			claimResult: null,
			results: [],
		});

		const secondVote = table.send(
			"W",
			claimVotePayload(ROOM_ID, ownTurnPending.id, true),
		);
		expect(secondVote.ok).toBe(true);
		expect(parseBridgeState(table.state, ROOM_ID)).toMatchObject({
			claim: null,
			claimResult: { id: ownTurnPending.id },
			results: [{ number: 1 }],
		});
	});
});

describe("dealing", () => {
	it("deals board 1 from the module's random source, into the event and the state", () => {
		const table = new Table(7);
		const result = table.send("E", dealPayload(ROOM_ID, 1));
		expect(result.ok).toBe(true);
		const expected = createBoard(1, dealCards(seeded(7)));
		expect(table.board()).toEqual(expected);
		expect(table.board()).toMatchObject({ dealer: "N", vulnerability: "none" });
		expect(result.ok && result.event).toEqual({
			kind: "deal",
			board: expected,
		});
	});

	it("deals only the next board, and only after the current board is over", () => {
		const table = new Table();
		expect(rejection(table.send("W", dealPayload(ROOM_ID, 2)))).toBe(
			"the next board is board 1",
		);
		expect(table.send("W", dealPayload(ROOM_ID, 1)).ok).toBe(true);
		expect(rejection(table.send("N", dealPayload(ROOM_ID, 1)))).toBe(
			"board 1 is already dealt",
		);
		expect(rejection(table.send("N", dealPayload(ROOM_ID, 2)))).toBe(
			"board 1 is not over",
		);
		table.calls("P P P P");
		expect(rejection(table.send("N", dealPayload(ROOM_ID, 3)))).toBe(
			"the next board is board 2",
		);
		expect(table.send("N", dealPayload(ROOM_ID, 2)).ok).toBe(true);
		expect(table.board()).toMatchObject({
			number: 2,
			dealer: "E",
			vulnerability: "NS",
		});
		expect(
			rejection(table.send("N", { ...dealPayload(ROOM_ID, 3), board: "3" })),
		).toBe("deal command has no board number");
	});
});

describe("calls and plays", () => {
	it("accepts the seat whose turn it is and records the call", () => {
		const table = fixtureTable();
		const result = table.send(
			"N",
			actionPayload(ROOM_ID, table.board(), call("1S")),
		);
		expect(result.ok && result.event).toEqual({
			kind: "call",
			board: 1,
			call: "1S",
		});
		expect(table.board().calls).toEqual(["1S"]);
	});

	it.each<[string, Seat, (board: Board) => unknown, string]>([
		[
			"a call out of turn",
			"E",
			(b) => actionPayload(ROOM_ID, b, call("P")),
			"it is not your turn",
		],
		[
			"an action chosen at an earlier position",
			"N",
			(b) => ({ ...actionPayload(ROOM_ID, b, call("P")), at: 1 }),
			"the table has moved on since this action was chosen",
		],
		[
			"an action for another board",
			"N",
			(b) => ({ ...actionPayload(ROOM_ID, b, call("P")), board: 2 }),
			"the table has moved on since this action was chosen",
		],
		[
			"an action without a position",
			"N",
			(b) => ({ ...actionPayload(ROOM_ID, b, call("P")), at: undefined }),
			"command has no table position",
		],
		[
			"an unknown call",
			"N",
			(b) => ({ ...actionPayload(ROOM_ID, b, call("P")), call: "8NT" }),
			"not a valid call",
		],
		[
			"an unknown card",
			"N",
			(b) => ({ ...actionPayload(ROOM_ID, b, play("SA")), card: "S1" }),
			"not a valid card",
		],
		[
			"a card in the auction",
			"N",
			(b) => actionPayload(ROOM_ID, b, play("SA")),
			"the auction is not over",
		],
		[
			"an unknown command",
			"N",
			() => ({ v: PROTOCOL_VERSION, roomId: ROOM_ID, type: "claim" }),
			"unknown command type",
		],
		[
			"another protocol version",
			"N",
			(b) => ({ ...actionPayload(ROOM_ID, b, call("P")), v: 2 }),
			"unsupported protocol version",
		],
		[
			"another room",
			"N",
			(b) => actionPayload(OTHER_ROOM_ID, b, call("P")),
			"command is for another room",
		],
		["a non-object", "N", () => "P", "command is not an object"],
	])("rejects %s", (_label, seat, payload, reason) => {
		const table = fixtureTable();
		const before = table.state;
		expect(table.send(seat, payload(table.board()))).toEqual({
			ok: false,
			reason,
		});
		expect(table.state).toBe(before);
	});

	it("rejects an action before the first deal", () => {
		const table = new Table();
		const board = createBoard(1, DEAL);
		expect(
			rejection(table.send("N", actionPayload(ROOM_ID, board, call("P")))),
		).toBe("no board has been dealt");
	});

	it("lets declarer, not dummy, play dummy's cards, and enforces following suit", () => {
		const table = fixtureTable();
		table.calls("1S P P P");
		table.act(play("S7")); // East leads; South is dummy.
		const board = table.board();
		expect(
			rejection(table.send("S", actionPayload(ROOM_ID, board, play("S2")))),
		).toBe("dummy's cards are played by declarer");
		const fromDummy = table.send(
			"N",
			actionPayload(ROOM_ID, board, play("S2")),
		);
		expect(fromDummy.ok && fromDummy.event).toEqual({
			kind: "play",
			board: 1,
			hand: "S",
			card: "S2",
		});
		table.act(play("H3")); // West is void in spades.
		expect(
			rejection(
				table.send("N", actionPayload(ROOM_ID, table.board(), play("HA"))),
			),
		).toBe("HA does not follow suit");
	});
});

describe("board results", () => {
	it("records the result when the last card is played", () => {
		const table = fixtureTable();
		table.calls("1S P P P");
		table.playFirstLegal();
		const state = parseBridgeState(table.state, ROOM_ID);
		expect(state?.board && boardStatus(state.board).phase).toBe("complete");
		expect(state?.results).toEqual([scoreBoard(table.board())]);
		expect(state?.results[0]).toMatchObject({
			number: 1,
			contract: { level: 1, strain: "S", declarer: "N", doubling: "" },
		});
	});

	it("scores a passed-out board 0 at once", () => {
		const table = fixtureTable();
		table.calls("P P P P");
		expect(parseBridgeState(table.state, ROOM_ID)?.results).toEqual([
			{ number: 1, contract: null, declarerTricks: 0, scoreNS: 0 },
		]);
	});

	it("totals the points each side scored", () => {
		const result = (scoreNS: number) => ({
			number: 1,
			contract: null,
			declarerTricks: 0,
			scoreNS,
		});
		expect(totals([result(420), result(-100), result(0), result(-50)])).toEqual(
			{
				ns: 420,
				ew: 150,
			},
		);
		expect(totals([])).toEqual({ ns: 0, ew: 0 });
	});
});

describe("replay", () => {
	it("rebuilds the stored board from the event log, in the auction and in the play", () => {
		const table = new Table(3);
		table.send("W", dealPayload(ROOM_ID, 1));
		table.calls("1NT P");
		expect(replay(table.events)).toEqual(table.board());
		table.calls("3NT P P P");
		table.playFirstLegal(6);
		expect(boardStatus(table.board()).phase).toBe("play");
		expect(replay(table.events)).toEqual(table.board());
	});

	it("gives the same next state from a state restored from storage", () => {
		const table = new Table(3);
		table.send("W", dealPayload(ROOM_ID, 1));
		table.calls("1NT P 3NT P P P");
		table.playFirstLegal(6);
		const board = table.board();
		const seat = boardStatus(board).actor as Seat;
		const [action] = legalActions(board, seat);
		const payload = actionPayload(ROOM_ID, board, action as Action);
		const restored = reorderKeys(
			JSON.parse(JSON.stringify(table.state)),
		) as JsonObject;
		const module = createBridgeModule(seeded(3));
		expect(module.apply(restored, context(seat), payload)).toEqual(
			module.apply(table.state, context(seat), payload),
		);
	});
});

describe("chat at the table", () => {
	it("counts a message and names its sender", () => {
		const table = new Table();
		const result = table.send("S", chatPayload(ROOM_ID, " good luck "));
		expect(result.ok && result.event).toEqual({
			fromName: "player2",
			text: "good luck",
		});
		expect(parseBridgeState(table.state, ROOM_ID)?.messages).toBe(1);
		expect(rejection(table.send("S", chatPayload(ROOM_ID, " ")))).toBe(
			"message is empty",
		);
	});

	it("tells table commands, call status and chat apart", () => {
		const board = createBoard(1, DEAL);
		const media = callRecordPayload(ROOM_ID, record(1));
		expect(isTableCommand(dealPayload(ROOM_ID, 1))).toBe(true);
		expect(isTableCommand(actionPayload(ROOM_ID, board, call("P")))).toBe(true);
		expect(isTableCommand(chatPayload(ROOM_ID, "hi"))).toBe(false);
		expect(isTableCommand(media)).toBe(false);
		expect(isChatCommand(chatPayload(ROOM_ID, "hi"))).toBe(true);
		expect(isChatCommand(dealPayload(ROOM_ID, 1))).toBe(false);
		expect(isChatCommand(media)).toBe(false);
		expect(isChatEvent({ fromName: "host", text: "hi" })).toBe(true);
		expect(isChatEvent({ kind: "play", card: "SA" })).toBe(false);
		expect(isChatEvent({ kind: "media", seat: "N", version: 1 })).toBe(false);
	});
});

function record(version: number, inCall = true): CallRecord {
	return {
		version,
		prefs: {
			inCall,
			send: { audio: true, video: false },
			receive: { audio: true, video: true },
		},
		form: "desktop",
	};
}

function stored(seat: Seat, version: number, inCall = true): StoredCallRecord {
	return { ...record(version, inCall), holder: holderOf(seat) };
}

describe("call status at the table", () => {
	it("keeps each seat's record and needs nobody present", () => {
		const table = new Table();
		const alone = { ...context("S"), present: [] };
		const result = table.module.apply(
			table.state,
			alone,
			callRecordPayload(ROOM_ID, record(1)),
		);
		expect(result.ok && result.event).toEqual({
			kind: "media",
			seat: "S",
			version: 1,
		});
		if (!result.ok) throw new Error(result.reason);
		table.state = result.state;
		table.send("E", callRecordPayload(ROOM_ID, record(4, false)));
		expect(parseBridgeState(table.state, ROOM_ID)?.media).toEqual({
			S: stored("S", 1),
			E: stored("E", 4, false),
		});
	});

	it("stores the holder of the sender's seat, never a holder from the payload", () => {
		const table = new Table();
		const payload = callRecordPayload(ROOM_ID, record(1));
		table.send("S", { ...payload, holder: holderOf("N") });
		expect(parseBridgeState(table.state, ROOM_ID)?.media.S?.holder).toBe(
			holderOf("S"),
		);
	});

	it("takes a higher version only, so a late resend never wins", () => {
		const table = new Table();
		table.send("S", callRecordPayload(ROOM_ID, record(2)));
		expect(
			rejection(table.send("S", callRecordPayload(ROOM_ID, record(2, false)))),
		).toBe("a newer call status is stored");
		expect(
			rejection(table.send("S", callRecordPayload(ROOM_ID, record(1, false)))),
		).toBe("a newer call status is stored");
		expect(parseBridgeState(table.state, ROOM_ID)?.media.S).toEqual(
			stored("S", 2),
		);
		expect(
			table.send("S", callRecordPayload(ROOM_ID, record(3, false))).ok,
		).toBe(true);
		expect(parseBridgeState(table.state, ROOM_ID)?.media.S).toEqual(
			stored("S", 3, false),
		);
	});

	it("refuses an invalid record and a stored state with an unknown seat", () => {
		const table = new Table();
		const payload = callRecordPayload(ROOM_ID, record(1));
		expect(rejection(table.send("S", { ...payload, version: 0 }))).toBe(
			"not a valid call status",
		);
		expect(rejection(table.send("S", { ...payload, form: "tv" }))).toBe(
			"not a valid call status",
		);
		expect(
			parseBridgeState(
				{ ...table.state, media: { X: stored("S", 1) } },
				ROOM_ID,
			),
		).toBeUndefined();
		// A stored record without its holder could restore another person's call.
		expect(
			parseBridgeState({ ...table.state, media: { S: record(1) } }, ROOM_ID),
		).toBeUndefined();
		const { media: _, ...withoutMedia } = table.state;
		expect(parseBridgeState(withoutMedia, ROOM_ID)).toBeUndefined();
	});
});
