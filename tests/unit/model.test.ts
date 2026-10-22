import { describe, expect, it } from "vitest";
import { chatPayload, checkMessageText } from "../../src/game/chat";
import { translator } from "../../src/i18n";
import type { ElectionView } from "../../src/p2p/election";
import type { MeshDiagnostics } from "../../src/p2p/mesh";
import type { OutboxItem } from "../../src/p2p/outbox";
import type {
	CommandFailure,
	PeerView,
	TableStatus,
} from "../../src/p2p/table";
import type { Entry, Lobby, Roster } from "../../src/p2p/wire";
import type { JsonObject, RoomConfig, Seat } from "../../src/protocol";
import {
	type BannerInput,
	bannerFor,
	bannerText,
	chatRefusalText,
	checkCreateFields,
	DEFAULT_CREATE_FIELDS,
	draftFor,
	heldSeats,
	type LobbyInput,
	lobbyScreen,
	networkLines,
	presentSeats,
	type RoomViewInput,
	roomView,
	TEXT,
} from "../../src/ui/model";

const TABLE_ID = "Table_ID-0123456789abc";
const CONFIG: RoomConfig = {
	names: { N: "player1", E: "player3", S: "player2", W: "player4" },
};
const AUTH = { term: 1, tag: "holder-W", inc: 1 };
const ALL = new Set<Seat>(["N", "E", "S", "W"]);

function chatEntry(
	seq: number,
	seat: Seat,
	text: string,
): Extract<Entry, { kind: "cmd" }> {
	const id = `00000000-0000-4000-8000-0000000000${String(seq).padStart(2, "0")}`;
	return {
		seq,
		auth: AUTH,
		prevAuth: seq === 1 ? null : AUTH,
		id,
		seat,
		gen: 1,
		kind: "cmd",
		payload: chatPayload(TABLE_ID, text),
		event: {
			v: 1,
			roomId: TABLE_ID,
			type: "event",
			seq,
			commandId: id,
			fromSeat: seat,
			fromName: CONFIG.names[seat],
			text,
		},
	};
}

function input(overrides: Partial<RoomViewInput> = {}): RoomViewInput {
	return {
		config: CONFIG,
		seat: "N",
		terminal: false,
		ready: true,
		held: ALL,
		online: ALL,
		hostSeat: "W",
		acked: {},
		entries: [],
		outbox: [],
		failures: [],
		undone: [],
		...overrides,
	};
}

describe("checkCreateFields", () => {
	it("accepts the default fields with West as the creator's seat and trims names", () => {
		const result = checkCreateFields({
			...DEFAULT_CREATE_FIELDS,
			names: { ...DEFAULT_CREATE_FIELDS.names, N: "  player1  " },
		});
		expect(result).toEqual({ ok: true, config: CONFIG, seat: "W" });
	});

	it("counts characters, not UTF-16 units, against the 40-character limit", () => {
		const forty = "🂡".repeat(40);
		const names = { ...DEFAULT_CREATE_FIELDS.names, E: forty, S: `${forty}x` };
		const result = checkCreateFields({ ...DEFAULT_CREATE_FIELDS, names });
		expect(result).toEqual({
			ok: false,
			errors: ["South: use at most 40 characters."],
		});
	});

	it("lists every problem: blank names and no seat for the creator", () => {
		const names = { ...DEFAULT_CREATE_FIELDS.names, N: " ", W: "" };
		expect(
			checkCreateFields({ ...DEFAULT_CREATE_FIELDS, names, seat: "X" }),
		).toEqual({
			ok: false,
			errors: [
				"North: enter a name.",
				"West: enter a name.",
				"Choose your seat.",
			],
		});
	});
});

describe("banner", () => {
	const banner = (
		status: TableStatus,
		election: ElectionView | null,
		supersededBy: BannerInput["supersededBy"] = null,
	) => bannerFor({ status, supersededBy, election });
	const waiting = (
		button: Extract<ElectionView, { phase: "waiting-for-host" }>["button"],
	) => banner("open", { phase: "waiting-for-host", absentMs: 12_400, button });

	it("shows one banner in the order of plan §4.9", () => {
		const unreachable: ElectionView = { phase: "host-unreachable" };
		expect(banner("expired", { phase: "superseded" })?.kind).toBe("expired");
		expect(banner("open", { phase: "superseded" })?.kind).toBe("superseded");
		expect(banner("superseded", unreachable)?.kind).toBe("superseded");
		expect(banner("incompatible", unreachable)?.kind).toBe("incompatible");
		expect(banner("full", unreachable)?.kind).toBe("full");
		expect(banner("connection-failed", unreachable)?.kind).toBe(
			"connection-failed",
		);
		expect(banner("open", unreachable)?.kind).toBe("host-unreachable");
		expect(banner("open", { phase: "becoming-host", self: true })).toEqual({
			kind: "becoming-host",
			self: true,
		});
		expect(banner("open", { phase: "nobody-here" })?.kind).toBe("nobody-here");
		expect(banner("starting", unreachable)?.kind).toBe("connecting");
		expect(banner("open", null)?.kind).toBe("connecting");
	});

	it("shows no banner while a host serves the table", () => {
		for (const phase of ["live", "host", "lobby"] as const)
			expect(banner("open", { phase })).toBeUndefined();
	});

	it("counts the waiting time in whole seconds and explains a disabled host button", () => {
		expect(waiting(null)).toEqual({
			kind: "waiting-for-host",
			seconds: 12,
			button: undefined,
		});
		expect(waiting({ enabled: true })).toMatchObject({
			button: { label: TEXT.becomeHost, enabled: true },
		});
		expect(waiting({ enabled: false, reason: "witness" })).toMatchObject({
			button: {
				enabled: false,
				hint: "Another player must be online to confirm",
			},
		});
		const shown = waiting(null);
		expect(shown && bannerText(shown)).toBe("Waiting for the host (12 s)");
	});

	it("says who holds a superseded tab's seat now", () => {
		const text = (by: BannerInput["supersededBy"]) => {
			const shown = banner("superseded", null, by);
			return shown && bannerText(shown);
		};
		expect(text(null)).toBe(TEXT.superseded);
		expect(text("tab")).toBe(
			`${TEXT.superseded}: another tab of this browser holds this seat now`,
		);
		expect(text("seat")).toBe(
			`${TEXT.superseded}: another device holds this seat now`,
		);
	});

	it("tells this page apart from another page that becomes the host", () => {
		expect(bannerText({ kind: "becoming-host", self: true })).toBe(
			"Becoming host…",
		);
		expect(bannerText({ kind: "becoming-host", self: false })).toBe(
			"A new host is taking over…",
		);
	});
});

describe("lobbyScreen", () => {
	const LOBBY: Lobby = {
		k: "lobby",
		auth: AUTH,
		config: CONFIG,
		idleMs: 0,
		seats: [
			{ seat: "N", available: true, online: false, mine: false },
			{ seat: "E", available: false, online: true, mine: false },
			{ seat: "S", available: true, online: false, mine: true },
			{ seat: "W", available: false, online: true, mine: false },
		],
	};
	const lobby = (overrides: Partial<LobbyInput> = {}) =>
		lobbyScreen({
			status: "open",
			supersededBy: null,
			election: { phase: "lobby" },
			lobby: LOBBY,
			heldElsewhere: [],
			...overrides,
		});

	it("offers only available seats that no active same-browser tab holds", () => {
		expect(lobby({ heldElsewhere: ["S"] })).toEqual({
			kind: "lobby",
			status: undefined,
			choices: [{ seat: "N", label: "North — player1" }],
		});
	});

	it("waits for the host's lobby before it lists seats, and names a seat by its compass point until the config is known", () => {
		expect(
			lobby({
				lobby: null,
				heldElsewhere: ["E"],
				election: { phase: "waiting-for-host", absentMs: 3000, button: null },
			}),
		).toEqual({
			kind: "lobby",
			status: "Waiting for the host (3 s)",
			choices: undefined,
		});
	});

	it("replaces the lobby when the page cannot take a seat", () => {
		expect(lobby({ status: "expired" })).toEqual({ kind: "expired" });
		expect(lobby({ status: "incompatible" })).toEqual({
			kind: "problem",
			text: "The other players use another version of the app. Reload the page.",
		});
		expect(lobby({ status: "connection-failed" }).kind).toBe("problem");
		expect(lobby({ status: "full" }).kind).toBe("problem");
	});
});

describe("networkLines", () => {
	const NETWORK: MeshDiagnostics = {
		trackersOpen: 2,
		trackers: 3,
		peers: 2,
		wrongKey: 1,
		unreachable: 1,
		refused: 0,
		incompatible: 0,
		dropped: {
			malformed: 0,
			incompatible: 0,
			foreign: 0,
			oversize: 0,
			rate: 0,
			stranger: 0,
		},
		sendFailures: 0,
		pairRooms: 1,
		repaired: 2,
		pairTimeouts: 3,
		unattached: 1,
		rejoins: 4,
	};
	const PEERS: PeerView[] = [
		{
			peer: "peer-e",
			seat: "E",
			check: { state: "ready", rttMs: 41.6 },
			path: { local: "srflx", remote: "srflx" },
		},
		{ peer: "peer-s", seat: "S", check: { state: "checking" }, path: null },
		{
			peer: "visitor",
			seat: null,
			check: { state: "ready", rttMs: 9 },
			path: null,
		},
	];

	it("shows counts and checked players only", () => {
		expect(
			networkLines({
				network: NETWORK,
				peers: PEERS,
				publicAddress: true,
				persistent: true,
				persisted: true,
			}),
		).toEqual([
			{ label: "Trackers reachable", value: "2 of 3" },
			{ label: "Direct connections", value: "3" },
			{ label: "Players checked", value: "East (42 ms)" },
			{ label: "Pages not reachable directly", value: "1" },
			{
				label: "Link repair rooms",
				value: "1 open, 2 repaired, 3 timed out (1 after connecting)",
			},
			{ label: "Rejoins with no links", value: "4" },
			{ label: "Public address found", value: "yes" },
			{ label: "Ignored wrong-key attempts", value: "1" },
			{ label: "Storage", value: "kept by the browser" },
		]);
	});

	it("reports the storage in the words of plan §4.3", () => {
		const storage = (persistent: boolean, persisted: boolean | undefined) =>
			networkLines({
				network: null,
				peers: [],
				publicAddress: false,
				persistent,
				persisted,
			}).find((line) => line.label === "Storage")?.value;
		expect(storage(false, undefined)).toBe(
			"memory only: a reload loses this copy",
		);
		expect(storage(true, undefined)).toBe("stored in this browser");
		expect(storage(true, false)).toBe("stored; the browser may clear it");
	});
});

describe("seats", () => {
	it("counts a seat as present when the roster binds its peer at the seat's current generation", () => {
		const roster: Roster = {
			k: "roster",
			auth: AUTH,
			seats: [
				{ seat: "N", holder: "h-n", gen: 2, acked: 0 },
				{ seat: "E", holder: "h-e", gen: 1, acked: 0 },
				{ seat: "S", holder: null, gen: 1, acked: 0 },
				{ seat: "W", holder: "h-w", gen: 1, acked: 0 },
			],
			peers: [
				{ peer: "peer-n", seat: "N", gen: 1 },
				{ peer: "peer-e", seat: "E", gen: 1 },
			],
			bots: [],
		};
		expect([...presentSeats("W", roster)].sort()).toEqual(["E", "W"]);
		expect([...presentSeats(null, null)]).toEqual([]);
		expect([...heldSeats(roster.seats)].sort()).toEqual(["E", "N", "W"]);
	});
});

describe("roomView", () => {
	it("counts receipts from the seats other than the sender", () => {
		const view = roomView(
			input({
				entries: [chatEntry(1, "W", "hello all")],
				acked: { N: 1, E: 0, S: 1, W: 1 },
			}),
		);
		expect(view.transcript).toEqual([
			{
				seq: 1,
				from: "West — player4",
				text: "hello all",
				receivedBy: 2,
				of: 3,
			},
		]);
	});

	it("leaves seat changes and table events out of the messages", () => {
		const { payload: _, ...base } = chatEntry(1, "N", "");
		const claim: Entry = {
			...base,
			kind: "seat",
			op: { type: "claim", holder: "h-n" },
			event: {},
		};
		const call = chatEntry(2, "N", "");
		const tableEvent: Entry = {
			...call,
			payload: {
				v: 1,
				roomId: TABLE_ID,
				type: "call",
				board: 1,
				at: 0,
				call: "1S",
			},
			event: { ...call.event, kind: "call" },
		};
		const view = roomView(
			input({ entries: [claim, tableEvent, chatEntry(3, "E", "good luck")] }),
		);
		expect(view.transcript.map((line) => [line.seq, line.text])).toEqual([
			[3, "good luck"],
		]);
	});

	it("lists this seat's unconfirmed messages: undone, refused with the reason, and waiting in the outbox", () => {
		const item = (
			n: number,
			state: OutboxItem["state"],
			waiting?: string,
		): OutboxItem => ({
			id: `local-${n}`,
			payload: chatPayload(TABLE_ID, `m${n}`),
			order: n,
			state,
			...(waiting === undefined ? {} : { waiting }),
		});
		const failure = (
			n: number,
			status: CommandFailure["status"],
			reason?: string,
		): CommandFailure => ({
			id: `failed-${n}`,
			payload: chatPayload(TABLE_ID, `f${n}`),
			status,
			...(reason === undefined ? {} : { reason }),
		});
		const play: JsonObject = {
			v: 1,
			roomId: TABLE_ID,
			type: "play",
			board: 1,
			at: 4,
			card: "S7",
		};
		const view = roomView(
			input({
				undone: [chatEntry(5, "N", "lost")],
				failures: [
					failure(1, "rejected", "message is empty"),
					failure(2, "full"),
				],
				outbox: [
					item(1, "queued"),
					item(2, "sent"),
					item(3, "accepted"),
					item(4, "queued", "Waiting for East to come back"),
					{ id: "local-5", payload: play, order: 5, state: "queued" },
				],
			}),
		);
		expect(
			view.pending.map((line) => [line.text, line.state, line.reason]),
		).toEqual([
			["lost", "undone", undefined],
			["f1", "not-sent", "message is empty"],
			["f2", "not-sent", "the table is full"],
			["m1", "pending", undefined],
			["m2", "sending", undefined],
			["m3", "sending", undefined],
			["m4", "pending", "Waiting for East to come back"],
		]);
	});

	it("lets a seated tab always send, with a hint while no host is connected, but not a terminal tab", () => {
		expect(roomView(input()).send).toEqual({ label: TEXT.send, enabled: true });
		expect(roomView(input({ ready: false })).send).toEqual({
			label: TEXT.send,
			enabled: true,
			hint: TEXT.sendHint,
		});
		expect(roomView(input({ terminal: true })).send.enabled).toBe(false);
	});

	it("marks seats online, offline or free; any seated player may release another player's offline seat", () => {
		const held = new Set<Seat>(["N", "S", "W"]);
		const online = new Set<Seat>(["N", "W"]);
		const view = roomView(input({ held, online, hostSeat: "W" }));
		expect(
			view.roster.map((row) => [row.seat, row.state, row.host, row.releasable]),
		).toEqual([
			["N", "online", false, false],
			["E", "free", false, false],
			["S", "offline", false, true],
			["W", "online", true, false],
		]);
		const terminal = roomView(input({ held, online, terminal: true }));
		expect(terminal.roster.some((row) => row.releasable)).toBe(false);
	});

	it("fills the send field with a test message from the own seat", () => {
		expect(draftFor("E")).toBe("Connection test from East");
	});

	it("says why a chat message was not sent in the viewer's language", () => {
		const reasons = ["", "😀".repeat(501), "a\u0007b", 7].map((text) => {
			const check = checkMessageText(text);
			if (check.ok) throw new Error("the message passed the check");
			return check.reason;
		});
		const hu = translator("hu");
		expect(chatRefusalText(reasons[1] ?? "", hu)).toBe(
			"az üzenet hosszabb 500 karakternél",
		);
		for (const reason of reasons)
			expect(chatRefusalText(reason, hu)).not.toBe(reason);
	});
});
