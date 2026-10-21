import { describe, expect, it } from "vitest";
import type { Authority } from "../../src/p2p/authority";
import {
	frame,
	jsonBytes,
	parseCall,
	parseCtl,
	parseLog,
	parseMesh,
	withinDepth,
} from "../../src/p2p/wire";

const TABLE = "vKg29g0NeA3vntlnYBW0TP";
const HOLDER_N = "DFqES54ngHxkS3v5";
const HOLDER_E = "AAAAAAAAAAAAAAAA";
const CLIENT = "AgICAgICAgICAgICAgICAg";
const PEER = "0123456789AbCdEfGhIj";
const ID = "123e4567-e89b-42d3-a456-426614174000";
const ID2 = "123e4567-e89b-42d3-a456-426614174001";
const AUTH: Authority = { term: 2, tag: `${HOLDER_N}.N`, inc: 1 };
const OLD_AUTH: Authority = { term: 1, tag: `${HOLDER_E}.E`, inc: 1 };
const POS = { rev: 3, lastAuth: OLD_AUTH };
const EMPTY = { rev: 0, lastAuth: null };
const CONFIG = {
	names: { N: "player1", E: "player3", S: "player2", W: "player4" },
};
const PAYLOAD = { v: 1, roomId: TABLE, type: "chat", text: "hi" };
const EVENT = { v: 1, roomId: TABLE, type: "event", seq: 4 };

type Sample = Record<string, unknown> & { k: string };
/** A label, one valid message, and the fields whose removal or wrong type must reject it. */
type Case = [string, Sample, string[]];

function entry(seq: number, prevAuth: Authority | null, auth = AUTH): Sample {
	return {
		k: "-",
		seq,
		auth,
		prevAuth,
		id: ID,
		seat: "N",
		gen: 2,
		kind: "cmd",
		payload: PAYLOAD,
		event: { ...EVENT, seq },
	};
}

function strip({ k: _k, ...rest }: Sample): Record<string, unknown> {
	return rest;
}

const ENTRY_4 = strip(entry(4, OLD_AUTH));
const ENTRY_5 = {
	seq: 5,
	auth: AUTH,
	prevAuth: AUTH,
	id: ID2,
	seat: "E",
	gen: 3,
	kind: "seat",
	op: { type: "claim", holder: HOLDER_E },
	event: { type: "seat" },
};

/** One valid message per kind and variant. */
const CTL: Case[] = [
	[
		"hello",
		{ k: "hello", b: "p2p-v1", client: CLIENT, seat: "N", gen: 2, pos: POS },
		["b", "client"],
	],
	["hello (visitor)", { k: "hello", b: "p2p-v1", client: CLIENT }, ["b"]],
	[
		"welcome",
		{ k: "welcome", status: "bound", auth: AUTH, seat: "N", gen: 2 },
		["status", "auth", "seat", "gen"],
	],
	[
		"lobby",
		{
			k: "lobby",
			auth: AUTH,
			config: CONFIG,
			idleMs: 1000,
			seats: [
				{ seat: "N", available: false, online: true, mine: false },
				{ seat: "E", available: true, online: false, mine: true },
				{ seat: "S", available: true, online: false, mine: false },
				{ seat: "W", available: false, online: false, mine: false },
			],
		},
		["auth", "config", "idleMs", "seats"],
	],
	["claim-seat", { k: "claim-seat", req: 1, seat: "E" }, ["req", "seat"]],
	[
		"seat-result (ok)",
		{ k: "seat-result", req: 1, ok: true, seat: "E", gen: 3 },
		["req", "ok", "seat", "gen"],
	],
	[
		"seat-result (refused)",
		{ k: "seat-result", req: 1, ok: false, code: "taken" },
		["req", "ok", "code"],
	],
	["release", { k: "release", req: 2, seat: "S" }, ["req", "seat"]],
	[
		"release-result (ok)",
		{ k: "release-result", req: 2, ok: true },
		["req", "ok"],
	],
	[
		"release-result (refused)",
		{ k: "release-result", req: 2, ok: false, code: "online" },
		["req", "ok", "code"],
	],
	[
		"beat (host)",
		{
			k: "beat",
			role: "host",
			auth: AUTH,
			pos: POS,
			holder: HOLDER_N,
			seat: "N",
			elig: true,
		},
		["role", "auth", "pos", "holder", "seat", "elig"],
	],
	[
		"beat (follower)",
		{
			k: "beat",
			role: "follower",
			auth: AUTH,
			seenAgoMs: 1200,
			pos: POS,
			holder: HOLDER_E,
			seat: "E",
			elig: true,
		},
		["role", "auth", "seenAgoMs", "pos", "holder", "seat", "elig"],
	],
	[
		"beat (visitor)",
		{ k: "beat", role: "visitor", holder: HOLDER_E, elig: false },
		["role", "holder", "elig"],
	],
	["ping", { k: "ping", n: "abcdefgh12" }, ["n"]],
	["echo", { k: "echo", n: "abcdefgh12" }, ["n"]],
	[
		"cmd",
		{ k: "cmd", id: ID, gen: 2, payload: PAYLOAD },
		["id", "gen", "payload"],
	],
	[
		"result (accepted)",
		{ k: "result", id: ID, status: "accepted", seq: 4 },
		["id", "status", "seq"],
	],
	[
		"result (rejected)",
		{ k: "result", id: ID, status: "rejected", reason: "Not your turn" },
		["id", "status", "reason"],
	],
	[
		"result (waiting)",
		{
			k: "result",
			id: ID,
			status: "waiting",
			reason: "Waiting for West to come back",
		},
		["id", "status", "reason"],
	],
	["ack", { k: "ack", rev: 3 }, ["rev"]],
	[
		"roster",
		{
			k: "roster",
			auth: AUTH,
			seats: [
				{ seat: "N", holder: HOLDER_N, gen: 2, acked: 3 },
				{ seat: "E", holder: HOLDER_E, gen: 1, acked: 3 },
				{ seat: "S", holder: null, gen: 0, acked: 0 },
				{ seat: "W", holder: null, gen: 2, acked: 0 },
			],
			peers: [{ peer: PEER, seat: "N", gen: 2 }],
			bots: [],
		},
		["auth", "seats", "peers"],
	],
	["sync", { k: "sync", req: 1, pos: POS }, ["req", "pos"]],
	["behind", { k: "behind", req: 1, pos: EMPTY }, ["req", "pos"]],
	["gone", { k: "gone", reason: "expired" }, ["reason"]],
];

const LOG: Case[] = [
	[
		"entry",
		{ k: "entry", e: ENTRY_4, state: { phase: "bidding" } },
		["e", "state"],
	],
	[
		"page (last)",
		{
			k: "page",
			req: 1,
			auth: AUTH,
			base: POS,
			entries: [ENTRY_4, ENTRY_5],
			last: true,
			state: { phase: "bidding" },
		},
		["req", "auth", "base", "entries", "last", "state"],
	],
	[
		"page (first)",
		{ k: "page", req: 1, auth: null, base: POS, entries: [], last: false },
		["req", "auth", "base", "entries", "last"],
	],
	[
		"snap",
		{
			k: "snap",
			req: 1,
			auth: null,
			mode: "replace",
			config: CONFIG,
			seats: [
				{ seat: "N", holder: HOLDER_N, gen: 2 },
				{ seat: "E", holder: null, gen: 0 },
				{ seat: "S", holder: null, gen: 0 },
				{ seat: "W", holder: null, gen: 0 },
			],
			pos: POS,
			idleMs: 0,
		},
		["req", "auth", "mode", "config", "seats", "pos", "idleMs"],
	],
];

const CALL: Case[] = [
	[
		"call",
		{
			k: "call",
			to: "E",
			toGen: 1,
			fromGen: 2,
			msg: { type: "leave", session: ID },
		},
		["to", "toGen", "fromGen", "msg"],
	],
];

const MESH: Case[] = [
	["links", { k: "links", peers: [PEER, "ZZZZZZZZZZZZZZZZZZZZ"] }, ["peers"]],
	["no links", { k: "links", peers: [] }, ["peers"]],
];

type Parse =
	| typeof parseCtl
	| typeof parseLog
	| typeof parseCall
	| typeof parseMesh;

const CHANNELS: [string, Parse, Case[]][] = [
	["oc-ctl", parseCtl, CTL],
	["oc-log", parseLog, LOG],
	["oc-call", parseCall, CALL],
	["oc-mesh", parseMesh, MESH],
];

/** A value of another JSON type than `value`. */
function wrongType(value: unknown): unknown {
	if (typeof value === "string") return 7;
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return {};
	return "x";
}

/** As the receiver gets it: framed, then through JSON as Trystero sends it. */
function wire(message: Sample): unknown {
	return JSON.parse(JSON.stringify(frame(TABLE, message)));
}

function malformed(parse: Parse, message: Sample): void {
	expect(parse(wire(message), TABLE)).toEqual({
		ok: false,
		reason: "malformed",
	});
}

describe.each(CHANNELS)("%s messages", (_channel, parse, samples) => {
	describe.each(samples)("%s", (_label, sample, required) => {
		it("parses the framed message to the same value", () => {
			expect(parse(wire(sample), TABLE)).toEqual({ ok: true, message: sample });
		});

		it("drops unknown fields", () => {
			expect(parse(wire({ ...sample, extra: "<b>x</b>" }), TABLE)).toEqual({
				ok: true,
				message: sample,
			});
		});

		it.each(required)("rejects a missing %s", (field) => {
			const { [field]: _removed, ...rest } = sample;
			malformed(parse, rest as Sample);
		});

		it.each(required)("rejects a wrong type of %s", (field) => {
			malformed(parse, { ...sample, [field]: wrongType(sample[field]) });
		});

		it("rejects another table, another wire version and a damaged header", () => {
			expect(
				parse({ ...frame(TABLE, sample), t: "x".repeat(22) }, TABLE),
			).toEqual({ ok: false, reason: "foreign" });
			expect(parse({ ...frame(TABLE, sample), v: 2 }, TABLE)).toEqual({
				ok: false,
				reason: "incompatible",
			});
			const { v: _v, ...noVersion } = frame(TABLE, sample);
			expect(parse(noVersion, TABLE)).toEqual({
				ok: false,
				reason: "malformed",
			});
			const { t: _t, ...noTable } = frame(TABLE, sample);
			expect(parse(noTable, TABLE)).toEqual({ ok: false, reason: "malformed" });
		});
	});

	it.each([
		["an unknown kind", "teleport"],
		["a prototype key", "constructor"],
		["a prototype key", "__proto__"],
	])("reports %s as incompatible", (_label, kind) => {
		expect(parse({ v: 1, t: TABLE, k: kind }, TABLE)).toEqual({
			ok: false,
			reason: "incompatible",
		});
	});

	it.each([
		["null", null],
		["an array", [1, 2]],
		["a string", "hello"],
		["bytes", new Uint8Array([1, 2, 3])],
		["a missing kind", { v: 1, t: TABLE }],
	])("rejects %s", (_label, value) => {
		expect(parse(value, TABLE)).toEqual({ ok: false, reason: "malformed" });
	});
});

describe("channels", () => {
	it("accept only their own kinds", () => {
		const [, entryMessage] = LOG[0] ?? [];
		const [, beat] = CTL[10] ?? [];
		if (!entryMessage || !beat) throw new Error("missing sample");
		expect(parseCtl(wire(entryMessage), TABLE)).toEqual({
			ok: false,
			reason: "incompatible",
		});
		expect(parseLog(wire(beat), TABLE)).toEqual({
			ok: false,
			reason: "incompatible",
		});
		expect(parseCall(wire(beat), TABLE)).toEqual({
			ok: false,
			reason: "incompatible",
		});
	});
});

describe("size and depth caps", () => {
	function nested(depth: number): unknown {
		let value: unknown = 1;
		for (let level = 0; level < depth; level++) value = { a: value };
		return value;
	}

	it("measures depth and UTF-8 length", () => {
		expect(withinDepth(nested(3), 3)).toBe(true);
		expect(withinDepth(nested(4), 3)).toBe(false);
		expect(jsonBytes({ a: "é" })).toBe(10);
	});

	it("rejects a command payload above 4096 bytes", () => {
		const text = "x".repeat(4096 - jsonBytes({ ...PAYLOAD, text: "" }));
		const fits = { k: "cmd", id: ID, gen: 2, payload: { ...PAYLOAD, text } };
		expect(parseCtl(wire(fits), TABLE).ok).toBe(true);
		malformed(parseCtl, {
			...fits,
			payload: { ...PAYLOAD, text: `${text}x` },
		});
	});

	it("rejects a payload nested deeper than 32 levels", () => {
		malformed(parseCtl, {
			k: "cmd",
			id: ID,
			gen: 2,
			payload: nested(33) as Record<string, unknown>,
		});
	});

	it("rejects a very deep message without exhausting the stack", () => {
		let value: unknown = 1;
		for (let level = 0; level < 200_000; level++) value = [value];
		expect(
			parseCtl({ v: 1, t: TABLE, k: "cmd", payload: value }, TABLE),
		).toEqual({ ok: false, reason: "malformed" });
	});

	it("rejects an event above 16 KiB and a state above 128 KiB", () => {
		malformed(parseLog, {
			k: "entry",
			e: { ...ENTRY_4, event: { text: "x".repeat(16 * 1024) } },
			state: {},
		});
		malformed(parseLog, {
			k: "entry",
			e: ENTRY_4,
			state: { text: "x".repeat(128 * 1024) },
		});
	});

	it("rejects a reason above 200 characters and a name above 40", () => {
		malformed(parseCtl, {
			k: "result",
			id: ID,
			status: "rejected",
			reason: "x".repeat(201),
		});
		const [, lobby] = CTL[3] ?? [];
		if (!lobby) throw new Error("missing sample");
		malformed(parseCtl, {
			...lobby,
			config: { ...CONFIG, names: { ...CONFIG.names, N: "x".repeat(41) } },
		});
	});

	it("rejects a page with more than 200 entries", () => {
		const entries = [ENTRY_4];
		for (let seq = 5; seq <= 204; seq++) {
			entries.push(strip(entry(seq, AUTH)));
		}
		const page = {
			k: "page",
			req: 1,
			auth: AUTH,
			base: POS,
			last: false,
		};
		expect(
			parseLog(wire({ ...page, entries: entries.slice(0, 200) }), TABLE).ok,
		).toBe(true);
		malformed(parseLog, { ...page, entries });
	});

	it("rejects a page above 192 KiB although each field fits", () => {
		const big = (seq: number, prev: Authority) => ({
			...strip(entry(seq, prev)),
			event: { text: "x".repeat(15 * 1024) },
		});
		const entries = [OLD_AUTH, AUTH, AUTH, AUTH, AUTH].map((prev, index) =>
			big(4 + index, prev),
		);
		const page = {
			k: "page",
			req: 1,
			auth: AUTH,
			base: POS,
			entries,
			last: true,
		};
		const fits = { ...page, state: { text: "x".repeat(100 * 1024) } };
		expect(parseLog(wire(fits), TABLE).ok).toBe(true);
		malformed(parseLog, { ...page, state: { text: "x".repeat(127 * 1024) } });
	});
});

describe("message rules", () => {
	const hostBeat = CTL[10]?.[1];
	const followerBeat = CTL[11]?.[1];
	const visitorBeat = CTL[12]?.[1];
	const roster = CTL.find(([label]) => label === "roster")?.[1];
	const lastPage = LOG[1]?.[1];
	const snap = LOG[3]?.[1];
	if (
		!hostBeat ||
		!followerBeat ||
		!visitorBeat ||
		!roster ||
		!lastPage ||
		!snap
	)
		throw new Error("missing sample");

	it.each([
		["a host tag of another holder", { ...hostBeat, holder: HOLDER_E }],
		["a host tag of another seat", { ...hostBeat, seat: "E" }],
		["a host with a reported age", { ...hostBeat, seenAgoMs: 0 }],
		["an ineligible host", { ...hostBeat, elig: false }],
		[
			"a claimer without a position",
			{ ...hostBeat, role: "claiming", pos: undefined },
		],
		[
			"a follower authority without its age",
			{ ...followerBeat, seenAgoMs: undefined },
		],
		["an age without an authority", { ...followerBeat, auth: undefined }],
		["a follower without a seat", { ...followerBeat, seat: undefined }],
		["a visitor with a seat", { ...visitorBeat, seat: "S" }],
		["an eligible visitor", { ...visitorBeat, elig: true }],
		["a null optional field", { ...visitorBeat, seat: null }],
	])("beat rejects %s", (_label, message) => {
		malformed(parseCtl, message);
	});

	it.each([
		[
			"a seat without its generation",
			{ k: "hello", b: "p2p-v1", client: CLIENT, seat: "N" },
		],
		[
			"a bound welcome without a seat",
			{ k: "welcome", status: "bound", auth: AUTH },
		],
		[
			"an accepted result without a sequence",
			{ k: "result", id: ID, status: "accepted" },
		],
		[
			"a refused result with a sequence",
			{ k: "result", id: ID, status: "invalid", seq: 3 },
		],
		[
			"a rejected result without a reason",
			{ k: "result", id: ID, status: "rejected" },
		],
		[
			"a waiting result without a reason",
			{ k: "result", id: ID, status: "waiting" },
		],
		[
			"an unknown seat code",
			{ k: "seat-result", req: 1, ok: false, code: "nope" },
		],
		["request number 0", { k: "claim-seat", req: 0, seat: "E" }],
		["a short nonce", { k: "ping", n: "abc" }],
		[
			"an upper-case command id",
			{ k: "cmd", id: ID.toUpperCase(), gen: 1, payload: {} },
		],
		["generation 0", { k: "cmd", id: ID, gen: 0, payload: {} }],
		["an array payload", { k: "cmd", id: ID, gen: 1, payload: [] }],
	])("oc-ctl rejects %s", (_label, message) => {
		malformed(parseCtl, message as Sample);
	});

	it.each([
		["a binding of an empty seat", [{ peer: PEER, seat: "S", gen: 0 }]],
		["a binding of an old generation", [{ peer: PEER, seat: "N", gen: 1 }]],
		[
			"one peer bound twice",
			[
				{ peer: PEER, seat: "N", gen: 2 },
				{ peer: PEER, seat: "E", gen: 1 },
			],
		],
		["a bad peer id", [{ peer: "short", seat: "N", gen: 2 }]],
	])("roster rejects %s", (_label, peers) => {
		malformed(parseCtl, { ...roster, peers });
	});

	it("roster rejects seats out of order", () => {
		const seats = roster.seats as unknown[];
		malformed(parseCtl, {
			...roster,
			seats: [seats[1], seats[0], seats[2], seats[3]],
		});
	});

	it.each([
		["entry 1 with a previous authority", { ...strip(entry(1, AUTH)) }],
		["entry 2 without a previous authority", { ...strip(entry(2, null)) }],
		[
			"a previous authority above its own",
			{ ...strip(entry(4, AUTH, OLD_AUTH)) },
		],
		["an unknown entry kind", { ...ENTRY_4, kind: "magic" }],
		["a seat entry without an operation", { ...ENTRY_5, op: undefined }],
		["an unknown seat operation", { ...ENTRY_5, op: { type: "steal" } }],
	])("entry rejects %s", (_label, e) => {
		malformed(parseLog, { k: "entry", e, state: {} });
	});

	it.each([
		["a gap", { entries: [ENTRY_5] }],
		[
			"a broken authority chain",
			{ entries: [ENTRY_4, { ...ENTRY_5, prevAuth: OLD_AUTH }] },
		],
		[
			"a base that the entries do not continue",
			{ base: { rev: 3, lastAuth: AUTH } },
		],
		["a last page without the state", { state: undefined }],
		["a state on another page", { last: false }],
	])("page rejects %s", (_label, change) => {
		malformed(parseLog, { ...lastPage, ...change });
	});

	it("snap rejects an empty log", () => {
		malformed(parseLog, { ...snap, pos: EMPTY });
	});

	it("call rejects an invalid call message", () => {
		malformed(parseCall, {
			k: "call",
			to: "E",
			toGen: 1,
			fromGen: 2,
			msg: { type: "offer", session: ID },
		});
	});

	it.each([
		["more peers than a page serves", peersUpTo(13)],
		["a peer twice", [PEER, PEER]],
		["an invalid peer id", [PEER, "<b>x</b>"]],
	])("links rejects %s", (_label, peers) => {
		malformed(parseMesh, { k: "links", peers });
	});

	it("links accepts as many peers as a page serves", () => {
		const peers = peersUpTo(12);
		expect(parseMesh(wire({ k: "links", peers }), TABLE)).toEqual({
			ok: true,
			message: { k: "links", peers },
		});
	});
});

/** `count` distinct valid peer ids. */
function peersUpTo(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `${PEER.slice(0, 18)}${String(index).padStart(2, "0")}`,
	);
}
