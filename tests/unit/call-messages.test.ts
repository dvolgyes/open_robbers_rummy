import { describe, expect, it } from "vitest";
import {
	type InboxIdentity,
	inboxTopic,
	isSession,
	MAX_CANDIDATE_LENGTH,
	MAX_CANDIDATES,
	MAX_GENERATION,
	MAX_SDP_LENGTH,
	MAX_SDP_MID_LENGTH,
	MAX_SDP_MLINE_INDEX,
	parseCallMessage,
	parseEnvelope,
} from "../../src/call/messages";

const ROOM = "abcdefghijklmnopqrstuv";
const SESSION_A = "0f8e2c1a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const SESSION_B = "11111111-2222-4333-8444-555555555555";
const PREFS = {
	inCall: true,
	send: { audio: true, video: false },
	receive: { audio: true, video: true },
};
const ANNOUNCEMENT = { prefs: PREFS, prefVersion: 3, form: "desktop" };
const CANDIDATE = {
	candidate: "candidate:1 1 udp 2122260223 peer.local 9 typ host",
	sdpMid: "0",
	sdpMLineIndex: 0,
};

function join(extra: Record<string, unknown> = {}) {
	return { type: "join", session: SESSION_A, ...ANNOUNCEMENT, ...extra };
}

function offer(extra: Record<string, unknown> = {}) {
	return {
		type: "offer",
		session: SESSION_A,
		toSession: SESSION_B,
		negotiation: 1,
		sdp: "v=0",
		...ANNOUNCEMENT,
		...extra,
	};
}

function ice(extra: Record<string, unknown> = {}) {
	return {
		type: "ice",
		session: SESSION_A,
		toSession: SESSION_B,
		negotiation: 2,
		candidates: [CANDIDATE],
		...extra,
	};
}

function iceWith(candidate: Record<string, unknown>) {
	return parseCallMessage(
		ice({ candidates: [{ ...CANDIDATE, ...candidate }] }),
	);
}

describe("isSession", () => {
	it("accepts a lowercase UUID and rejects other text", () => {
		expect(isSession(SESSION_A)).toBe(true);
		expect(isSession(SESSION_A.toUpperCase())).toBe(false);
		expect(isSession(SESSION_A.slice(1))).toBe(false);
		expect(isSession(42)).toBe(false);
	});
});

describe("inboxTopic", () => {
	it("builds the topic that the receive policy expects", () => {
		expect(inboxTopic({ roomId: ROOM, seat: "E", generation: 7 })).toBe(
			`call:${ROOM}:E:7`,
		);
		expect(
			inboxTopic({ roomId: ROOM, seat: "N", generation: MAX_GENERATION }),
		).toBe(`call:${ROOM}:N:999999999`);
	});

	it.each([
		{ roomId: "short", seat: "N", generation: 1 },
		{ roomId: ROOM, seat: "X", generation: 1 },
		{ roomId: ROOM, seat: "N", generation: 0 },
		{ roomId: ROOM, seat: "N", generation: MAX_GENERATION + 1 },
		{ roomId: ROOM, seat: "N", generation: 1.5 },
	])("throws on an invalid identity %o", (inbox) => {
		expect(() => inboxTopic(inbox as InboxIdentity)).toThrow(
			"invalid call inbox identity",
		);
	});
});

describe("parseCallMessage: announcements", () => {
	it.each(["join", "resync", "prefs"])("accepts %s", (type) => {
		expect(parseCallMessage(join({ type }))).toEqual({
			type,
			session: SESSION_A,
			...ANNOUNCEMENT,
		});
	});

	it("drops unknown keys at every level", () => {
		const parsed = parseCallMessage(
			join({
				extra: 1,
				prefs: { ...PREFS, extra: 2, send: { ...PREFS.send, extra: 3 } },
			}),
		);
		expect(parsed).toEqual({
			type: "join",
			session: SESSION_A,
			...ANNOUNCEMENT,
		});
	});

	it("accepts prefVersion 0 and rejects negative or fractional versions", () => {
		expect(parseCallMessage(join({ prefVersion: 0 }))).toBeDefined();
		expect(parseCallMessage(join({ prefVersion: -1 }))).toBeUndefined();
		expect(parseCallMessage(join({ prefVersion: 1.5 }))).toBeUndefined();
		expect(parseCallMessage(join({ prefVersion: "1" }))).toBeUndefined();
	});

	it("accepts only the two device classes", () => {
		expect(parseCallMessage(join({ form: "compact" }))).toBeDefined();
		expect(parseCallMessage(join({ form: "tablet" }))).toBeUndefined();
		expect(parseCallMessage(join({ form: undefined }))).toBeUndefined();
	});

	it("rejects incomplete preferences", () => {
		expect(
			parseCallMessage(join({ prefs: { ...PREFS, inCall: "yes" } })),
		).toBeUndefined();
		expect(
			parseCallMessage(join({ prefs: { ...PREFS, send: { audio: true } } })),
		).toBeUndefined();
		expect(
			parseCallMessage(join({ prefs: { ...PREFS, receive: null } })),
		).toBeUndefined();
	});

	it("rejects a missing or malformed session and an unknown type", () => {
		expect(parseCallMessage(join({ session: undefined }))).toBeUndefined();
		expect(parseCallMessage(join({ session: "me" }))).toBeUndefined();
		expect(parseCallMessage(join({ type: "hello" }))).toBeUndefined();
		expect(parseCallMessage([join()])).toBeUndefined();
		expect(parseCallMessage(null)).toBeUndefined();
	});

	it("accepts leave with only a session", () => {
		expect(
			parseCallMessage({ type: "leave", session: SESSION_A, prefs: PREFS }),
		).toEqual({ type: "leave", session: SESSION_A });
		expect(parseCallMessage({ type: "leave" })).toBeUndefined();
	});
});

describe("parseCallMessage: descriptions", () => {
	it.each(["offer", "answer"])("accepts %s", (type) => {
		expect(parseCallMessage(offer({ type, extra: true }))).toEqual({
			type,
			session: SESSION_A,
			toSession: SESSION_B,
			negotiation: 1,
			sdp: "v=0",
			...ANNOUNCEMENT,
		});
	});

	it("limits the SDP length to 1..MAX_SDP_LENGTH", () => {
		expect(
			parseCallMessage(offer({ sdp: "x".repeat(MAX_SDP_LENGTH) })),
		).toBeDefined();
		expect(
			parseCallMessage(offer({ sdp: "x".repeat(MAX_SDP_LENGTH + 1) })),
		).toBeUndefined();
		expect(parseCallMessage(offer({ sdp: "" }))).toBeUndefined();
		expect(parseCallMessage(offer({ sdp: 1 }))).toBeUndefined();
	});

	it("requires a positive negotiation, a target session and the announcement", () => {
		expect(parseCallMessage(offer({ negotiation: 0 }))).toBeUndefined();
		expect(parseCallMessage(offer({ negotiation: 2.5 }))).toBeUndefined();
		expect(parseCallMessage(offer({ toSession: "x" }))).toBeUndefined();
		expect(parseCallMessage(offer({ form: undefined }))).toBeUndefined();
	});
});

describe("parseCallMessage: ICE batches", () => {
	it("accepts a batch and drops unknown candidate keys", () => {
		expect(
			parseCallMessage(
				ice({ candidates: [{ ...CANDIDATE, usernameFragment: "u" }] }),
			),
		).toEqual({
			type: "ice",
			session: SESSION_A,
			toSession: SESSION_B,
			negotiation: 2,
			candidates: [CANDIDATE],
		});
	});

	it("limits a batch to 1..MAX_CANDIDATES candidates", () => {
		const many = (n: number) => Array.from({ length: n }, () => CANDIDATE);
		expect(
			parseCallMessage(ice({ candidates: many(MAX_CANDIDATES) })),
		).toBeDefined();
		expect(
			parseCallMessage(ice({ candidates: many(MAX_CANDIDATES + 1) })),
		).toBeUndefined();
		expect(parseCallMessage(ice({ candidates: [] }))).toBeUndefined();
		expect(parseCallMessage(ice({ candidates: CANDIDATE }))).toBeUndefined();
	});

	it("rejects the whole batch when one candidate is invalid", () => {
		expect(
			parseCallMessage(ice({ candidates: [CANDIDATE, { candidate: 1 }] })),
		).toBeUndefined();
	});

	it("limits the candidate text and accepts the empty end-of-candidates text", () => {
		expect(iceWith({ candidate: "" })).toBeDefined();
		expect(
			iceWith({ candidate: "c".repeat(MAX_CANDIDATE_LENGTH) }),
		).toBeDefined();
		expect(
			iceWith({ candidate: "c".repeat(MAX_CANDIDATE_LENGTH + 1) }),
		).toBeUndefined();
	});

	it("accepts a null or bounded sdpMid", () => {
		expect(iceWith({ sdpMid: null })).toBeDefined();
		expect(iceWith({ sdpMid: "m".repeat(MAX_SDP_MID_LENGTH) })).toBeDefined();
		expect(
			iceWith({ sdpMid: "m".repeat(MAX_SDP_MID_LENGTH + 1) }),
		).toBeUndefined();
		expect(iceWith({ sdpMid: 0 })).toBeUndefined();
		expect(iceWith({ sdpMid: undefined })).toBeUndefined();
	});

	it("accepts a null or bounded sdpMLineIndex", () => {
		expect(iceWith({ sdpMLineIndex: null })).toBeDefined();
		expect(iceWith({ sdpMLineIndex: MAX_SDP_MLINE_INDEX })).toBeDefined();
		expect(iceWith({ sdpMLineIndex: MAX_SDP_MLINE_INDEX + 1 })).toBeUndefined();
		expect(iceWith({ sdpMLineIndex: -1 })).toBeUndefined();
		expect(iceWith({ sdpMLineIndex: undefined })).toBeUndefined();
	});
});

describe("parseEnvelope", () => {
	const inbox: InboxIdentity = { roomId: ROOM, seat: "N", generation: 4 };
	const envelope = (extra: Record<string, unknown> = {}) => ({
		v: 1,
		roomId: ROOM,
		from: "E",
		fromGen: 2,
		toGen: 4,
		id: "3e0c5f7a-0000-4000-8000-000000000000",
		message: join(),
		...extra,
	});

	it("accepts the database envelope and ignores the added id", () => {
		expect(parseEnvelope(envelope(), inbox)).toEqual({
			from: "E",
			fromGen: 2,
			message: { type: "join", session: SESSION_A, ...ANNOUNCEMENT },
		});
	});

	it.each([
		["another version", { v: 2 }],
		["another room", { roomId: "vutsrqponmlkjihgfedcba" }],
		["an older generation of this seat", { toGen: 3 }],
		["a sender at this seat", { from: "N" }],
		["an invalid sender", { from: "X" }],
		["sender generation 0", { fromGen: 0 }],
		["a sender generation over the limit", { fromGen: MAX_GENERATION + 1 }],
		["an invalid message", { message: join({ form: "tablet" }) }],
	])("rejects %s", (_name, extra) => {
		expect(parseEnvelope(envelope(extra), inbox)).toBeUndefined();
	});

	it("rejects a value that is not an object", () => {
		expect(parseEnvelope("call", inbox)).toBeUndefined();
		expect(parseEnvelope(null, inbox)).toBeUndefined();
	});
});
