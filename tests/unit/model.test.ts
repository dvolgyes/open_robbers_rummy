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
import {
	DEFAULT_TABLE_SETUP,
	type JsonObject,
	type Seat,
	type TableConfig,
} from "../../src/protocol";
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
	type TablePageViewInput,
	TEXT,
	tablePageView,
} from "../../src/ui/model";

const TABLE_ID = "Table_ID-0123456789abc";
const CONFIG: TableConfig = {
	names: { "1": "player1", "2": "player3", "3": "player2", "4": "player4" },
	table: DEFAULT_TABLE_SETUP,
};
const AUTH = { term: 1, tag: "holder-4", inc: 1 };
const ALL = new Set<Seat>(["1", "2", "3", "4"]);

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
			tableId: TABLE_ID,
			type: "event",
			seq,
			commandId: id,
			fromSeat: seat,
			fromName: CONFIG.names[seat],
			text,
		},
	};
}

function input(
	overrides: Partial<TablePageViewInput> = {},
): TablePageViewInput {
	return {
		config: CONFIG,
		seat: "1",
		terminal: false,
		ready: true,
		held: ALL,
		online: ALL,
		hostSeat: "4",
		acked: {},
		entries: [],
		outbox: [],
		failures: [],
		undone: [],
		...overrides,
	};
}

describe("checkCreateFields", () => {
	it("accepts the default fields with player 1 as the creator's seat and trims names", () => {
		const result = checkCreateFields({
			...DEFAULT_CREATE_FIELDS,
			names: { ...DEFAULT_CREATE_FIELDS.names, "1": "  player1  " },
		});
		expect(result).toEqual({
			ok: true,
			config: {
				names: {
					"1": "player1",
					"2": "player2",
					"3": "player3",
					"4": "player4",
				},
				table: DEFAULT_TABLE_SETUP,
			},
			seat: "1",
		});
	});

	it("keeps only the names of the seats in play, from two to six players", () => {
		const fields = {
			...DEFAULT_CREATE_FIELDS,
			names: { ...DEFAULT_CREATE_FIELDS.names, "6": "" },
		};
		const two = checkCreateFields({ ...fields, count: 2 });
		expect(two.ok && two.config.names).toEqual({
			"1": "player1",
			"2": "player2",
		});
		const table = { preset: "machiavelli", jokers: 6, assist: false } as const;
		const six = checkCreateFields({
			...DEFAULT_CREATE_FIELDS,
			count: 6,
			seat: "6",
			table,
		});
		expect(six.ok && Object.keys(six.config.names)).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
		]);
		expect(six.ok && six.config.table).toEqual(table);
		expect(checkCreateFields({ ...DEFAULT_CREATE_FIELDS, count: 1 }).ok).toBe(
			false,
		);
		expect(checkCreateFields({ ...DEFAULT_CREATE_FIELDS, count: 7 }).ok).toBe(
			false,
		);
	});

	it("refuses a creator's seat outside the players in play", () => {
		expect(
			checkCreateFields({ ...DEFAULT_CREATE_FIELDS, count: 3, seat: "4" }),
		).toEqual({ ok: false, errors: ["Choose your seat."] });
	});

	it("counts characters, not UTF-16 units, against the 40-character limit", () => {
		const forty = "🂡".repeat(40);
		const names = {
			...DEFAULT_CREATE_FIELDS.names,
			"2": forty,
			"3": `${forty}x`,
		};
		const result = checkCreateFields({ ...DEFAULT_CREATE_FIELDS, names });
		expect(result).toEqual({
			ok: false,
			errors: ["Player 3: use at most 40 characters."],
		});
	});

	it("lists every problem: blank names and no seat for the creator", () => {
		const names = { ...DEFAULT_CREATE_FIELDS.names, "1": " ", "4": "" };
		expect(
			checkCreateFields({ ...DEFAULT_CREATE_FIELDS, names, seat: "X" }),
		).toEqual({
			ok: false,
			errors: [
				"Player 1: enter a name.",
				"Player 4: enter a name.",
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

	it("shows one banner, in the order of precedence", () => {
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
			{ seat: "1", available: true, online: false, mine: false },
			{ seat: "2", available: false, online: true, mine: false },
			{ seat: "3", available: true, online: false, mine: true },
			{ seat: "4", available: false, online: true, mine: false },
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
		expect(lobby({ heldElsewhere: ["3"] })).toEqual({
			kind: "lobby",
			status: undefined,
			choices: [{ seat: "1", label: "Player 1 — player1" }],
		});
	});

	it("waits for the host's lobby before it lists seats, and names a seat by its compass point until the config is known", () => {
		expect(
			lobby({
				lobby: null,
				heldElsewhere: ["2"],
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
			seat: "2",
			check: { state: "ready", rttMs: 41.6 },
			path: { local: "srflx", remote: "srflx" },
		},
		{ peer: "peer-s", seat: "3", check: { state: "checking" }, path: null },
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
			{ label: "Players checked", value: "Player 2 (42 ms)" },
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

	it("reports the storage in plain words", () => {
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
				{ seat: "1", holder: "h-n", gen: 2, acked: 0 },
				{ seat: "2", holder: "h-e", gen: 1, acked: 0 },
				{ seat: "3", holder: null, gen: 1, acked: 0 },
				{ seat: "4", holder: "h-w", gen: 1, acked: 0 },
			],
			peers: [
				{ peer: "peer-n", seat: "1", gen: 1 },
				{ peer: "peer-e", seat: "2", gen: 1 },
			],
			bots: [],
		};
		expect([...presentSeats("4", roster)].sort()).toEqual(["2", "4"]);
		expect([...presentSeats(null, null)]).toEqual([]);
		expect([...heldSeats(roster.seats)].sort()).toEqual(["1", "2", "4"]);
	});
});

describe("tablePageView", () => {
	it("counts receipts from the seats other than the sender", () => {
		const view = tablePageView(
			input({
				entries: [chatEntry(1, "4", "hello all")],
				acked: { "1": 1, "2": 0, "3": 1, "4": 1 },
			}),
		);
		expect(view.transcript).toEqual([
			{
				seq: 1,
				from: "Player 4 — player4",
				text: "hello all",
				receivedBy: 2,
				of: 3,
			},
		]);
	});

	it("leaves seat changes and table events out of the messages", () => {
		const { payload: _, ...base } = chatEntry(1, "1", "");
		const claim: Entry = {
			...base,
			kind: "seat",
			op: { type: "claim", holder: "h-n" },
			event: {},
		};
		const call = chatEntry(2, "1", "");
		const tableEvent: Entry = {
			...call,
			payload: {
				v: 1,
				tableId: TABLE_ID,
				type: "action",
				hand: 1,
				at: 0,
				action: { type: "draw" },
			},
			event: { ...call.event, kind: "action" },
		};
		const view = tablePageView(
			input({ entries: [claim, tableEvent, chatEntry(3, "2", "good luck")] }),
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
			tableId: TABLE_ID,
			type: "action",
			hand: 1,
			at: 4,
			action: { type: "draw" },
		};
		const view = tablePageView(
			input({
				undone: [chatEntry(5, "1", "lost")],
				failures: [
					failure(1, "rejected", "message is empty"),
					failure(2, "full"),
				],
				outbox: [
					item(1, "queued"),
					item(2, "sent"),
					item(3, "accepted"),
					item(4, "queued", "Waiting for Player 2 to come back"),
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
			["m4", "pending", "Waiting for Player 2 to come back"],
		]);
	});

	it("lets a seated tab always send, with a hint while no host is connected, but not a terminal tab", () => {
		expect(tablePageView(input()).send).toEqual({
			label: TEXT.send,
			enabled: true,
		});
		expect(tablePageView(input({ ready: false })).send).toEqual({
			label: TEXT.send,
			enabled: true,
			hint: TEXT.sendHint,
		});
		expect(tablePageView(input({ terminal: true })).send.enabled).toBe(false);
	});

	it("marks seats online, offline or free; any seated player may release another player's offline seat", () => {
		const held = new Set<Seat>(["1", "3", "4"]);
		const online = new Set<Seat>(["1", "4"]);
		const view = tablePageView(input({ held, online, hostSeat: "4" }));
		expect(
			view.roster.map((row) => [row.seat, row.state, row.host, row.releasable]),
		).toEqual([
			["1", "online", false, false],
			["2", "free", false, false],
			["3", "offline", false, true],
			["4", "online", true, false],
		]);
		const terminal = tablePageView(input({ held, online, terminal: true }));
		expect(terminal.roster.some((row) => row.releasable)).toBe(false);
	});

	it("fills the send field with a test message from the own seat", () => {
		expect(draftFor("2")).toBe("Connection test from Player 2");
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
