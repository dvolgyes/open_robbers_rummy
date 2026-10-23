import { describe, expect, it } from "vitest";
import { type CallRoomSnapshot, returnedSeats } from "../../src/call/mesh";
import {
	type CallMessage,
	inboxTopic,
	parseEnvelope,
} from "../../src/call/messages";
import { callTargets, inboundCall } from "../../src/p2p/call-transport";
import type { Binding, CallFrame } from "../../src/p2p/wire";
import type { Seat } from "../../src/protocol";
import { TABLE } from "./p2p-fixtures";

const PEER_1 = "player1x0123456789ab";
const PEER_2 = "player2x0123456789ab";
const PEER_3 = "player3x0123456789ab";
const PEER_4 = "player4x0123456789ab";
const VISITOR = "visitor0123456789abc";

const BINDINGS: readonly Binding[] = [
	{ peer: PEER_1, seat: "1", gen: 3 },
	{ peer: PEER_2, seat: "2", gen: 1 },
	{ peer: PEER_3, seat: "3", gen: 2 },
	{ peer: PEER_4, seat: "4", gen: 5 },
];

const JOIN: CallMessage = {
	type: "join",
	session: "123e4567-e89b-42d3-a456-426614174000",
	prefs: {
		inCall: true,
		send: { audio: true, video: false },
		receive: { audio: true, video: true },
	},
	prefVersion: 1,
	form: "desktop",
};

function frame(to: Seat, toGen: number, fromGen: number): CallFrame {
	return { k: "call", to, toGen, fromGen, msg: JOIN };
}

describe("call targets", () => {
	it("sends a broadcast to every connected peer bound to another seat", () => {
		const targets = callTargets(
			BINDINGS,
			[PEER_1, PEER_2, PEER_3, VISITOR],
			"1",
			null,
		);
		expect(targets).toEqual([
			{ peer: PEER_2, seat: "2", gen: 1 },
			{ peer: PEER_3, seat: "3", gen: 2 },
		]);
	});

	it("sends an addressed message only to the peer of that seat", () => {
		const all = [PEER_1, PEER_2, PEER_3, PEER_4];
		expect(callTargets(BINDINGS, all, "1", "4")).toEqual([
			{ peer: PEER_4, seat: "4", gen: 5 },
		]);
		expect(callTargets(BINDINGS, [PEER_1, PEER_2], "1", "4")).toEqual([]);
		expect(callTargets(BINDINGS, all, "1", "1")).toEqual([]);
	});
});

describe("inbound call frames", () => {
	it("takes the sender seat from the roster and builds an envelope for the addressed inbox", () => {
		const inbound = inboundCall(TABLE, BINDINGS, PEER_2, frame("1", 3, 1));
		const inbox = { roomId: TABLE, seat: "1" as const, generation: 3 };
		expect(inbound?.topic).toBe(inboxTopic(inbox));
		expect(parseEnvelope(inbound?.envelope, inbox)).toEqual({
			from: "2",
			fromGen: 1,
			message: JOIN,
		});
	});

	it("drops a frame from an unbound peer or with another sender generation", () => {
		expect(
			inboundCall(TABLE, BINDINGS, VISITOR, frame("1", 3, 1)),
		).toBeUndefined();
		expect(
			inboundCall(TABLE, BINDINGS, PEER_2, frame("1", 3, 2)),
		).toBeUndefined();
	});

	it("addresses a frame with an old receiver generation to that old inbox, not to the current one", () => {
		const inbound = inboundCall(TABLE, BINDINGS, PEER_2, frame("1", 2, 1));
		const current = { roomId: TABLE, seat: "1" as const, generation: 3 };
		expect(inbound?.topic).not.toBe(inboxTopic(current));
		expect(parseEnvelope(inbound?.envelope, current)).toBeUndefined();
	});

	it("never lets a frame name its own seat as the sender", () => {
		const fromPlayer1 = inboundCall(TABLE, BINDINGS, PEER_1, frame("1", 3, 3));
		const inbox = { roomId: TABLE, seat: "1" as const, generation: 3 };
		expect(parseEnvelope(fromPlayer1?.envelope, inbox)).toBeUndefined();
	});
});

function snapshot(online: readonly Seat[]): CallRoomSnapshot {
	return {
		roomId: TABLE,
		self: { seat: "1", generation: 3 },
		seats: ["1", "2", "3"],
		holders: { "1": 3, "2": 1, "3": 2 },
		online: new Set(online),
	};
}

describe("seats that come back online", () => {
	it("names held seats that are online now and were not before, except this seat", () => {
		expect(
			returnedSeats(snapshot(["2"]), snapshot(["1", "2", "3"]), "1"),
		).toEqual(["3"]);
		expect(returnedSeats(snapshot([]), snapshot(["1"]), "1")).toEqual([]);
	});

	it("names nothing before the first snapshot, nor a seat without a holder", () => {
		expect(returnedSeats(undefined, snapshot(["2", "3"]), "1")).toEqual([]);
		expect(returnedSeats(snapshot([]), snapshot(["4"]), "1")).toEqual([]);
	});
});
