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

const PEER_N = "peerNorth0123456789a";
const PEER_E = "peerEast00123456789a";
const PEER_S = "peerSouth0123456789a";
const PEER_W = "peerWest00123456789a";
const VISITOR = "visitor0123456789abc";

const BINDINGS: readonly Binding[] = [
	{ peer: PEER_N, seat: "N", gen: 3 },
	{ peer: PEER_E, seat: "E", gen: 1 },
	{ peer: PEER_S, seat: "S", gen: 2 },
	{ peer: PEER_W, seat: "W", gen: 5 },
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
			[PEER_N, PEER_E, PEER_S, VISITOR],
			"N",
			null,
		);
		expect(targets).toEqual([
			{ peer: PEER_E, seat: "E", gen: 1 },
			{ peer: PEER_S, seat: "S", gen: 2 },
		]);
	});

	it("sends an addressed message only to the peer of that seat", () => {
		const all = [PEER_N, PEER_E, PEER_S, PEER_W];
		expect(callTargets(BINDINGS, all, "N", "W")).toEqual([
			{ peer: PEER_W, seat: "W", gen: 5 },
		]);
		expect(callTargets(BINDINGS, [PEER_N, PEER_E], "N", "W")).toEqual([]);
		expect(callTargets(BINDINGS, all, "N", "N")).toEqual([]);
	});
});

describe("inbound call frames", () => {
	it("takes the sender seat from the roster and builds an envelope for the addressed inbox", () => {
		const inbound = inboundCall(TABLE, BINDINGS, PEER_E, frame("N", 3, 1));
		const inbox = { roomId: TABLE, seat: "N" as const, generation: 3 };
		expect(inbound?.topic).toBe(inboxTopic(inbox));
		expect(parseEnvelope(inbound?.envelope, inbox)).toEqual({
			from: "E",
			fromGen: 1,
			message: JOIN,
		});
	});

	it("drops a frame from an unbound peer or with another sender generation", () => {
		expect(
			inboundCall(TABLE, BINDINGS, VISITOR, frame("N", 3, 1)),
		).toBeUndefined();
		expect(
			inboundCall(TABLE, BINDINGS, PEER_E, frame("N", 3, 2)),
		).toBeUndefined();
	});

	it("addresses a frame with an old receiver generation to that old inbox, not to the current one", () => {
		const inbound = inboundCall(TABLE, BINDINGS, PEER_E, frame("N", 2, 1));
		const current = { roomId: TABLE, seat: "N" as const, generation: 3 };
		expect(inbound?.topic).not.toBe(inboxTopic(current));
		expect(parseEnvelope(inbound?.envelope, current)).toBeUndefined();
	});

	it("never lets a frame name its own seat as the sender", () => {
		const fromNorth = inboundCall(TABLE, BINDINGS, PEER_N, frame("N", 3, 3));
		const inbox = { roomId: TABLE, seat: "N" as const, generation: 3 };
		expect(parseEnvelope(fromNorth?.envelope, inbox)).toBeUndefined();
	});
});

function snapshot(online: readonly Seat[]): CallRoomSnapshot {
	return {
		roomId: TABLE,
		self: { seat: "N", generation: 3 },
		holders: { N: 3, E: 1, S: 2 },
		online: new Set(online),
	};
}

describe("seats that come back online", () => {
	it("names held seats that are online now and were not before, except this seat", () => {
		expect(
			returnedSeats(snapshot(["E"]), snapshot(["N", "E", "S"]), "N"),
		).toEqual(["S"]);
		expect(returnedSeats(snapshot([]), snapshot(["N"]), "N")).toEqual([]);
	});

	it("names nothing before the first snapshot, nor a seat without a holder", () => {
		expect(returnedSeats(undefined, snapshot(["E", "S"]), "N")).toEqual([]);
		expect(returnedSeats(snapshot([]), snapshot(["W"]), "N")).toEqual([]);
	});
});
