import { describe, expect, it } from "vitest";
import { randomBelowFrom } from "../../src/bridge/deal";
import {
	type Board,
	boardStatus,
	createBoard,
	legalActions,
} from "../../src/bridge/engine";
import {
	actionPayload,
	createBridgeModule,
	dealPayload,
} from "../../src/game/bridge";
import { chatPayload } from "../../src/game/chat";
import type { ApplyResult } from "../../src/game/module";
import { type JsonObject, SEATS, type Seat } from "../../src/protocol";
import { bidding, call, DEAL } from "./bridge-fixtures";
import { CONFIG, ROOM_ID } from "./fixtures";

// Plan §12 R4: a game action needs every player at the table; dummy may be away while the cards are played.
// A command that waits for a player is marked `waiting`, so the host keeps it for a resend (R3).

const module = createBridgeModule(randomBelowFrom(() => 7));

function stateWith(board: Board | null): JsonObject {
	return { ...module.initialState(ROOM_ID, CONFIG), board };
}

function send(
	state: JsonObject,
	seat: Seat,
	payload: JsonObject,
	present: readonly Seat[],
): ApplyResult {
	return module.apply(
		state,
		{
			roomId: ROOM_ID,
			config: CONFIG,
			seat,
			holder: `holder-${seat}`,
			commandId: "cmd-1",
			seq: 1,
			present,
		},
		payload,
	);
}

function without(...absent: Seat[]): Seat[] {
	return SEATS.filter((seat) => !absent.includes(seat));
}

/** Board 1 after a one-heart contract by North (North deals board 1), so South is dummy and East leads. */
function contract(): Board {
	const board = bidding(createBoard(1, DEAL), "1H P P P");
	const status = boardStatus(board);
	expect([status.phase, status.dummy, status.actor]).toEqual([
		"play",
		"S",
		"E",
	]);
	return board;
}

/** The table state after the actor played the first legal card until the board was over. */
function finished(board: Board): JsonObject {
	let state = stateWith(board);
	let current = board;
	for (let i = 0; i < 52; i++) {
		const seat = boardStatus(current).actor;
		if (seat === undefined) break;
		const [action] = legalActions(current, seat);
		if (!action) throw new Error("no legal action");
		const result = send(
			state,
			seat,
			actionPayload(ROOM_ID, current, action),
			SEATS,
		);
		if (!result.ok) throw new Error(result.reason);
		state = result.state;
		current = state.board as unknown as Board;
	}
	expect(boardStatus(current).phase).toBe("complete");
	return state;
}

describe("the presence rule for game actions", () => {
	it("deals only when all four players are present", () => {
		expect(
			send(stateWith(null), "N", dealPayload(ROOM_ID, 1), without("W")),
		).toEqual({
			ok: false,
			reason: "Waiting for West to come back",
			waiting: true,
		});
		expect(send(stateWith(null), "N", dealPayload(ROOM_ID, 1), SEATS).ok).toBe(
			true,
		);
	});

	it("does not deal the next board while the last board's dummy is away", () => {
		const done = finished(contract());
		expect(send(done, "N", dealPayload(ROOM_ID, 2), without("S"))).toEqual({
			ok: false,
			reason: "Waiting for South to come back",
			waiting: true,
		});
		expect(send(done, "N", dealPayload(ROOM_ID, 2), SEATS).ok).toBe(true);
	});

	it("accepts a call only when all four players are present", () => {
		const board = createBoard(1, DEAL);
		const payload = actionPayload(ROOM_ID, board, call("1H"));
		expect(send(stateWith(board), "N", payload, without("E"))).toEqual({
			ok: false,
			reason: "Waiting for East to come back",
			waiting: true,
		});
		expect(send(stateWith(board), "N", payload, SEATS).ok).toBe(true);
	});

	it("plays a card while dummy is away", () => {
		const board = contract();
		const [lead] = legalActions(board, "E");
		if (!lead) throw new Error("no lead");
		const result = send(
			stateWith(board),
			"E",
			actionPayload(ROOM_ID, board, lead),
			without("S"),
		);
		expect(result.ok).toBe(true);
	});

	it("names every absent player who is not dummy, in seat order", () => {
		const board = contract();
		const [lead] = legalActions(board, "E");
		if (!lead) throw new Error("no lead");
		const payload = actionPayload(ROOM_ID, board, lead);
		expect(send(stateWith(board), "E", payload, ["E", "S"])).toEqual({
			ok: false,
			reason: "Waiting for North and West to come back",
			waiting: true,
		});
		expect(send(stateWith(null), "N", dealPayload(ROOM_ID, 1), ["N"])).toEqual({
			ok: false,
			reason: "Waiting for East, South and West to come back",
			waiting: true,
		});
	});

	it("checks the rules before presence, so a stale action keeps its own reason", () => {
		const board = contract();
		const stale = actionPayload(ROOM_ID, createBoard(1, DEAL), call("1H"));
		expect(send(stateWith(board), "N", stale, ["N"])).toEqual({
			ok: false,
			reason: "the table has moved on since this action was chosen",
		});
		expect(send(stateWith(board), "N", dealPayload(ROOM_ID, 2), ["N"])).toEqual(
			{
				ok: false,
				reason: "board 1 is not over",
			},
		);
	});

	it("needs nobody else for a chat message", () => {
		expect(
			send(stateWith(null), "N", chatPayload(ROOM_ID, "back soon"), []).ok,
		).toBe(true);
	});
});
