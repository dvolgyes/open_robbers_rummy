import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatModule, chatPayload } from "../../src/game/chat";
import type { GameModule } from "../../src/game/module";
import type { Authority } from "../../src/p2p/authority";
import { HostEngine, type HostStop } from "../../src/p2p/host-engine";
import { deriveHolder, makeTag } from "../../src/p2p/keys";
import {
	HOST_LOST_MS,
	LOBBY_REFRESH_MS,
	MAX_PENDING_PER_SEAT,
	ROSTER_COALESCE_MS,
	SEAT_GRACE_MS,
	SEAT_HOLD_MS,
	TABLE_IDLE_MS,
} from "../../src/p2p/limits";
import { LINK_VERSION } from "../../src/p2p/link";
import { creationCommit, LocalLog, storeClaim } from "../../src/p2p/log";
import type {
	AutoplayStatus,
	CtlMessage,
	Entry,
	EntryMessage,
} from "../../src/p2p/wire";
import type { RoomConfig, Seat } from "../../src/protocol";
import {
	overTheWire,
	peerId,
	Recorder,
	settle,
	syncDigest,
	TestStorage,
	VirtualClock,
} from "./fake-mesh";
import { CONFIG, commandId, TABLE } from "./p2p-fixtures";

/** The chat module, plus one random command, so the host-only rule can be tested without a game. */
const RANDOM_CHAT_MODULE: GameModule = {
	...chatModule,
	isRandomCommand: (payload) =>
		typeof payload === "object" &&
		payload !== null &&
		"type" in payload &&
		payload.type === "deal",
};

const HOST = peerId("host");
const EAST = peerId("east");
const EAST2 = peerId("east2");
const SOUTH = peerId("south");
const CLIENT_N = "clientN-0123456789abcd";
const CLIENT_E = "clientE-0123456789abcd";
const CLIENT_S = "clientS-0123456789abcd";

let restoreDigest: () => void;
beforeEach(() => {
	restoreDigest = syncDigest();
});
afterEach(() => restoreDigest());

class Rig {
	readonly clock = new VirtualClock();
	readonly storage = new TestStorage();
	readonly sent = new Recorder(TABLE);
	readonly stops: HostStop[] = [];
	readonly log = new LocalLog(this.storage, TABLE, "N");
	auth: Authority = { term: 1, tag: "", inc: 1 };
	engine: HostEngine | null = null;
	autoplay: (seat: Seat, enabled: boolean) => Promise<AutoplayStatus> =
		async () => "unavailable";
	autoplayRequests: { seat: Seat; enabled: boolean }[] = [];
	#next = 100;

	async create(config: RoomConfig = CONFIG): Promise<this> {
		const holder = await deriveHolder(TABLE, CLIENT_N);
		this.auth = { term: 1, tag: makeTag(holder, "N"), inc: 1 };
		const written = await this.log.write(() =>
			creationCommit({
				tableId: TABLE,
				seat: "N",
				holder,
				config,
				state: chatModule.initialState(TABLE, CONFIG),
				auth: this.auth,
				id: commandId(1),
				now: this.clock.wall(),
			}),
		);
		if (!written.ok) throw new Error(written.detail);
		this.start();
		return this;
	}

	/** A new engine on the same log, as after a host reload. */
	start(): HostEngine {
		this.engine = new HostEngine({
			log: this.log,
			auth: this.auth,
			self: HOST,
			module: RANDOM_CHAT_MODULE,
			send: this.sent,
			clock: this.clock,
			newId: () => commandId(this.#next++),
			autoplay: async (seat, enabled) => {
				this.autoplayRequests.push({ seat, enabled });
				return this.autoplay(seat, enabled);
			},
			onStop: (reason) => this.stops.push(reason),
		});
		return this.engine;
	}

	get host(): HostEngine {
		if (!this.engine) throw new Error("no engine");
		return this.engine;
	}

	/** Delivers a message from `peer` as it arrives over the wire, and lets the engine finish. */
	async from(peer: string, message: CtlMessage): Promise<void> {
		this.host.receive(peer, overTheWire(TABLE, "ctl", message));
		await settle();
	}

	async hello(
		peer: string,
		client: string,
		bound: { seat: Seat; gen: number } | null = null,
	): Promise<void> {
		this.host.join(peer);
		await this.from(peer, {
			k: "hello",
			b: LINK_VERSION,
			client,
			...(bound ?? {}),
		});
	}

	/** A visitor says hello and claims `seat`; returns its generation. */
	async seat(peer: string, client: string, seat: Seat): Promise<number> {
		await this.hello(peer, client);
		await this.from(peer, { k: "claim-seat", req: 1, seat });
		const result = this.to(peer).find((message) => message.k === "seat-result");
		if (result?.k !== "seat-result" || !result.ok)
			throw new Error(`no seat: ${JSON.stringify(result)}`);
		return result.gen;
	}

	async command(
		peer: string,
		n: number,
		gen: number,
		text = `message ${n}`,
	): Promise<void> {
		await this.from(peer, {
			k: "cmd",
			id: commandId(n),
			gen,
			payload: chatPayload(TABLE, text),
		});
	}

	/** Messages sent to `peer` (null: to everyone) since the last call, in order. */
	to(peer: string | null): CtlMessage[] {
		const all = this.sent.take();
		this.sent.sent = all.filter((item) => item.to !== peer);
		return all
			.filter((item) => item.to === peer && item.channel === "ctl")
			.map((item) => item.message as CtlMessage);
	}

	/** Entries broadcast since the last call. */
	entries(): EntryMessage[] {
		const all = this.sent.take();
		this.sent.sent = all.filter((item) => item.message.k !== "entry");
		return all
			.filter((item) => item.to === null && item.message.k === "entry")
			.map((item) => item.message as EntryMessage);
	}

	row(seat: Seat) {
		return this.log.table?.seats.find((row) => row.seat === seat);
	}
}

describe("test kit", () => {
	it("the synchronous digest gives the same holder as Web Crypto", async () => {
		const spied = await deriveHolder(TABLE, CLIENT_E);
		restoreDigest();
		const real = await deriveHolder(TABLE, CLIENT_E);
		restoreDigest = syncDigest();
		expect(spied).toBe(real);
	});
});

describe("host-local bots", () => {
	it("rejects autoplay without an authenticated current seat and ignores duplicate requests", async () => {
		const rig = await new Rig().create();
		await rig.hello(EAST, CLIENT_E);
		await rig.from(EAST, { k: "autoplay-request", req: 1, enabled: true });
		expect(rig.to(EAST)).toContainEqual({
			k: "autoplay-result",
			req: 1,
			status: "failed",
		});
		expect(rig.autoplayRequests).toEqual([]);

		const gen = await rig.seat(EAST2, "clientE2-0123456789abc", "E");
		const holder = rig.row("E")?.holder;
		let resolve: ((status: AutoplayStatus) => void) | undefined;
		rig.autoplay = () =>
			new Promise((done) => {
				resolve = done;
			});
		const request = { k: "autoplay-request", req: 2, enabled: true } as const;
		await rig.from(EAST2, request);
		await rig.from(EAST2, request);
		expect(rig.autoplayRequests).toEqual([{ seat: "E", enabled: true }]);
		expect(rig.row("E")).toEqual({ seat: "E", holder, gen });
		resolve?.("enabled");
		await settle();
		expect(rig.to(EAST2)).toContainEqual({
			k: "autoplay-result",
			req: 2,
			status: "enabled",
		});
	});

	it("rejects unavailable autoplay without changing the player's seat", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		const holder = rig.row("E")?.holder;
		rig.to(EAST);
		await rig.from(EAST, { k: "autoplay-request", req: 1, enabled: true });
		expect(rig.to(EAST)).toContainEqual({
			k: "autoplay-result",
			req: 1,
			status: "unavailable",
		});
		expect(rig.row("E")).toEqual({ seat: "E", holder, gen });
		expect(rig.host.roster()?.bots).not.toContain("E");
	});

	it("lets a player return control after host autoplay and keeps their seat", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		const holder = rig.row("E")?.holder;
		rig.to(EAST);
		rig.autoplay = async (seat, enabled) =>
			(await rig.host.setBotSeat(seat, enabled))
				? enabled
					? "enabled"
					: "disabled"
				: "failed";

		await rig.from(EAST, { k: "autoplay-request", req: 1, enabled: true });
		expect(rig.to(EAST)).toContainEqual({
			k: "autoplay-result",
			req: 1,
			status: "enabled",
		});
		expect(rig.row("E")).toEqual({ seat: "E", holder, gen });
		expect(rig.host.roster()?.bots).toContain("E");
		await rig.command(EAST, 61, gen, "blocked while autoplay is on");
		expect(rig.to(EAST)).toContainEqual(
			expect.objectContaining({ id: commandId(61), status: "rejected" }),
		);

		await rig.from(EAST, { k: "autoplay-request", req: 2, enabled: false });
		expect(rig.to(EAST)).toContainEqual({
			k: "autoplay-result",
			req: 2,
			status: "disabled",
		});
		expect(rig.row("E")).toEqual({ seat: "E", holder, gen });
		expect(rig.host.roster()?.bots).not.toContain("E");
		await rig.command(EAST, 62, gen, "human control restored");
		expect(rig.to(EAST)).toContainEqual(
			expect.objectContaining({ id: commandId(62), status: "accepted" }),
		);
	});

	it("claims bot seats privately and orders their actions through normal validation", async () => {
		const config = { ...CONFIG, names: { ...CONFIG.names, E: "Robot East" } };
		const rig = await new Rig().create(config);
		const activated = await rig.host.activateBots(["E"]);
		expect(activated).toBe(true);
		expect(rig.row("E")?.holder).not.toBeNull();
		expect(rig.host.roster()?.bots).toEqual(["E"]);
		expect(
			rig.host.roster()?.peers.some((binding) => binding.seat === "E"),
		).toBe(false);
		const result = await rig.host.localCommand(
			"E",
			commandId(55),
			chatPayload(TABLE, "hello"),
		);
		expect(result).toEqual({ ok: true });
		expect(rig.log.entries.at(-1)).toMatchObject({ seat: "E", kind: "cmd" });
	});

	it("lets the host automate an active player's seat without ending that player's seat", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		rig.to(EAST);
		const holder = await deriveHolder(TABLE, CLIENT_E);

		expect(await rig.host.setBotSeat("E", true)).toBe(true);
		expect(rig.row("E")).toEqual({ seat: "E", holder, gen });
		expect(rig.host.roster()?.bots).toContain("E");
		expect(rig.host.roster()?.peers).toContainEqual({
			peer: EAST,
			seat: "E",
			gen,
		});
		expect(await rig.host.activateBots(["E"])).toBe(true);
		expect(
			await rig.host.localCommand(
				"E",
				commandId(56),
				chatPayload(TABLE, "bot action"),
			),
		).toEqual({ ok: true });

		await rig.command(EAST, 57, gen, "human action while automated");
		expect(rig.to(EAST)).toContainEqual(
			expect.objectContaining({
				k: "result",
				id: commandId(57),
				status: "rejected",
			}),
		);

		expect(await rig.host.setBotSeat("E", false)).toBe(true);
		expect(rig.row("E")).toEqual({ seat: "E", holder, gen });
		expect(rig.host.roster()?.bots).not.toContain("E");
		expect(rig.host.roster()?.peers).toContainEqual({
			peer: EAST,
			seat: "E",
			gen,
		});
		await rig.command(EAST, 58, gen, "human action after automation");
		expect(rig.to(EAST)).toContainEqual(
			expect.objectContaining({
				k: "result",
				id: commandId(58),
				status: "accepted",
			}),
		);
	});

	it("claims a free seat for a bot and frees it when the bot is disabled", async () => {
		const rig = await new Rig().create();
		expect(await rig.host.setBotSeat("E", true)).toBe(true);
		const holder = await deriveHolder(TABLE, "open-canasta|host-bot|E");
		expect(rig.row("E")).toEqual({ seat: "E", holder, gen: 1 });
		expect(await rig.host.setBotSeat("E", false)).toBe(true);
		expect(rig.row("E")).toEqual({ seat: "E", holder: null, gen: 2 });
	});
});

describe("hello", () => {
	it("tells a visitor it is unseated and sends the lobby with the free seats", async () => {
		const rig = await new Rig().create();
		await rig.hello(EAST, CLIENT_E);
		const [welcome, lobby] = rig.to(EAST);
		expect(welcome).toEqual({
			k: "welcome",
			status: "unseated",
			auth: rig.auth,
		});
		expect(lobby).toMatchObject({ k: "lobby", auth: rig.auth, config: CONFIG });
		if (lobby?.k !== "lobby") return;
		expect(lobby.seats).toEqual([
			{ seat: "N", available: false, online: true, mine: false },
			{ seat: "E", available: true, online: false, mine: false },
			{ seat: "S", available: true, online: false, mine: false },
			{ seat: "W", available: true, online: false, mine: false },
		]);
	});

	it("refuses another link version", async () => {
		const rig = await new Rig().create();
		rig.host.join(EAST);
		await rig.from(EAST, { k: "hello", b: "p2p-v9", client: CLIENT_E });
		expect(rig.to(EAST)).toEqual([
			{ k: "welcome", status: "incompatible", auth: rig.auth },
		]);
	});

	it("does not let a second active peer take over a named seat", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		rig.to(EAST);
		await rig.hello(EAST2, CLIENT_E, { seat: "E", gen });
		const [welcome, roster] = rig.to(EAST2);
		expect(welcome).toEqual({
			k: "welcome",
			status: "superseded",
			auth: rig.auth,
		});
		expect(roster).toBeUndefined();
		expect(rig.to(EAST)).toEqual([]);
		await rig.command(EAST, 8, gen);
		expect(rig.to(EAST)).toContainEqual({
			k: "result",
			id: commandId(8),
			status: "accepted",
			seq: 3,
		});
	});

	it("supersedes a peer whose generation or holder does not match the seat", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		await rig.hello(EAST2, CLIENT_E, { seat: "E", gen: gen + 1 });
		await rig.hello(SOUTH, CLIENT_S, { seat: "E", gen });
		const superseded = { k: "welcome", status: "superseded", auth: rig.auth };
		expect(rig.to(EAST2)).toEqual([superseded]);
		expect(rig.to(SOUTH)).toEqual([superseded]);
		expect(rig.row("E")?.gen).toBe(gen);
	});

	it("deletes an expired table, tells every peer and stops", async () => {
		const rig = await new Rig().create();
		rig.clock.now += TABLE_IDLE_MS + 1;
		await rig.hello(EAST, CLIENT_E);
		expect(rig.to(EAST)).toEqual([
			{ k: "welcome", status: "expired", auth: rig.auth },
		]);
		expect(rig.to(null)).toEqual([{ k: "gone", reason: "expired" }]);
		expect(rig.log.expired).toBe(true);
		expect(rig.stops).toEqual(["expired"]);
	});
});

describe("seats", () => {
	it("a claim of a free seat commits a seat entry with the next generation and broadcasts it", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		expect(gen).toBe(1);
		const holder = await deriveHolder(TABLE, CLIENT_E);
		expect(rig.row("E")).toEqual({ seat: "E", holder, gen: 1 });
		const [message] = rig.entries();
		expect(message?.e).toMatchObject({
			seq: 2,
			auth: rig.auth,
			prevAuth: rig.auth,
			seat: "E",
			gen: 1,
			kind: "seat",
			op: { type: "claim", holder },
		});
		expect(message?.state).toEqual(rig.log.table?.state);
	});

	it("refuses a seat that another holder holds, and a claim without hello", async () => {
		const rig = await new Rig().create();
		await rig.seat(EAST, CLIENT_E, "E");
		await rig.hello(SOUTH, CLIENT_S);
		rig.to(SOUTH);
		await rig.from(SOUTH, { k: "claim-seat", req: 4, seat: "E" });
		expect(rig.to(SOUTH)).toEqual([
			{ k: "seat-result", req: 4, ok: false, code: "taken" },
		]);
		rig.host.join(EAST2);
		await rig.from(EAST2, { k: "claim-seat", req: 5, seat: "W" });
		expect(rig.to(EAST2)).toEqual([
			{ k: "seat-result", req: 5, ok: false, code: "invalid" },
		]);
	});

	it("refuses a same-holder claim while the existing peer is active", async () => {
		const rig = await new Rig().create();
		await rig.seat(EAST, CLIENT_E, "E");
		await rig.hello(EAST2, CLIENT_E);
		rig.to(EAST2);
		await rig.from(EAST2, { k: "claim-seat", req: 6, seat: "E" });
		expect(rig.to(EAST2)).toContainEqual({
			k: "seat-result",
			req: 6,
			ok: false,
			code: "taken",
		});
		expect(rig.row("E")?.holder).toBe(await deriveHolder(TABLE, CLIENT_E));
		await rig.command(EAST, 7, 1);
		expect(rig.to(EAST)).toContainEqual({
			k: "result",
			id: commandId(7),
			status: "accepted",
			seq: 3,
		});
	});

	it("does not bind a second active peer to the same seat generation", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		await rig.hello(EAST2, CLIENT_E, { seat: "E", gen });
		expect(rig.to(EAST2)).toContainEqual({
			k: "welcome",
			status: "superseded",
			auth: rig.auth,
		});
		await rig.command(EAST, 8, gen);
		expect(rig.to(EAST)).toContainEqual({
			k: "result",
			id: commandId(8),
			status: "accepted",
			seq: 3,
		});
	});

	it("gives a seat to another holder after the seat hold", async () => {
		const rig = await new Rig().create();
		await rig.seat(EAST, CLIENT_E, "E");
		rig.clock.now += SEAT_HOLD_MS + 1;
		const gen = await rig.seat(SOUTH, CLIENT_S, "E");
		expect(gen).toBe(2);
		expect(rig.row("E")?.holder).toBe(await deriveHolder(TABLE, CLIENT_S));
	});

	it("refuses a connected holder's seat to another browser", async () => {
		const rig = await new Rig().create();
		await rig.seat(EAST, CLIENT_E, "E");
		await rig.hello(SOUTH, CLIENT_S);
		rig.to(SOUTH);
		await rig.from(SOUTH, { k: "claim-seat", req: 7, seat: "E" });
		expect(rig.to(SOUTH)).toContainEqual({
			k: "seat-result",
			req: 7,
			ok: false,
			code: "taken",
		});
		expect(rig.row("E")?.holder).toBe(await deriveHolder(TABLE, CLIENT_E));
	});

	it("keeps a seat for SEAT_GRACE_MS after its holder leaves, then gives it to another browser", async () => {
		const rig = await new Rig().create();
		await rig.seat(EAST, CLIENT_E, "E");
		await rig.hello(SOUTH, CLIENT_S);
		rig.host.leave(EAST);
		rig.clock.now += SEAT_GRACE_MS - 1;
		await rig.from(SOUTH, { k: "claim-seat", req: 8, seat: "E" });
		expect(rig.to(SOUTH)).toContainEqual({
			k: "seat-result",
			req: 8,
			ok: false,
			code: "taken",
		});
		rig.clock.now += 1;
		await rig.from(SOUTH, { k: "claim-seat", req: 9, seat: "E" });
		expect(rig.to(SOUTH)).toContainEqual({
			k: "seat-result",
			req: 9,
			ok: true,
			seat: "E",
			gen: 2,
		});
	});

	it("a bound peer cannot claim another seat", async () => {
		const rig = await new Rig().create();
		await rig.seat(EAST, CLIENT_E, "E");
		await rig.from(EAST, { k: "claim-seat", req: 2, seat: "S" });
		expect(rig.to(EAST)).toContainEqual({
			k: "seat-result",
			req: 2,
			ok: false,
			code: "invalid",
		});
	});

	it("releases an offline seat only, and only for a seated player", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		await rig.from(HOST, { k: "release", req: 7, seat: "E" });
		expect(rig.to(HOST)).toEqual([
			{ k: "release-result", req: 7, ok: false, code: "online" },
		]);
		await rig.from(HOST, { k: "release", req: 8, seat: "S" });
		expect(rig.to(HOST)).toEqual([
			{ k: "release-result", req: 8, ok: false, code: "invalid" },
		]);
		await rig.hello(SOUTH, CLIENT_S);
		await rig.from(SOUTH, { k: "release", req: 9, seat: "E" });
		expect(rig.to(SOUTH)).toContainEqual({
			k: "release-result",
			req: 9,
			ok: false,
			code: "unseated",
		});
		rig.host.leave(EAST);
		rig.entries();
		await rig.from(HOST, { k: "release", req: 10, seat: "E" });
		expect(rig.to(HOST)).toEqual([{ k: "release-result", req: 10, ok: true }]);
		expect(rig.row("E")).toEqual({ seat: "E", holder: null, gen: gen + 1 });
		const [message] = rig.entries();
		expect(message?.e).toMatchObject({
			kind: "seat",
			seat: "E",
			op: { type: "release", by: "N" },
		});
	});

	it("counts a connected seat as offline once its peer is silent for HOST_LOST_MS", async () => {
		const rig = await new Rig().create();
		await rig.seat(EAST, CLIENT_E, "E");
		rig.clock.now += HOST_LOST_MS;
		await rig.from(HOST, { k: "release", req: 3, seat: "E" });
		expect(rig.to(HOST)).toEqual([{ k: "release-result", req: 3, ok: true }]);
	});

	it("sends the lobby to visitors when seats change and every LOBBY_REFRESH_MS", async () => {
		const rig = await new Rig().create();
		await rig.hello(SOUTH, CLIENT_S);
		rig.to(SOUTH);
		await rig.seat(EAST, CLIENT_E, "E");
		const lobby = rig.to(SOUTH).find((message) => message.k === "lobby");
		expect(
			lobby?.k === "lobby" &&
				lobby.seats.find((row) => row.seat === "E")?.available,
		).toBe(false);
		rig.host.tick();
		rig.to(SOUTH);
		rig.clock.now += LOBBY_REFRESH_MS;
		rig.host.tick();
		expect(rig.to(SOUTH).map((message) => message.k)).toContain("lobby");
	});

	it("broadcasts the roster after ROSTER_COALESCE_MS, with acknowledgements and bound peers", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		rig.host.tick();
		rig.sent.take();
		await rig.from(EAST, { k: "ack", rev: 2 });
		rig.host.tick();
		expect(rig.sent.of("roster")).toEqual([]);
		rig.clock.now += ROSTER_COALESCE_MS;
		rig.host.tick();
		const [sent] = rig.sent.of("roster");
		expect(sent?.to).toBeNull();
		expect(sent?.message.peers).toEqual([
			{ peer: HOST, seat: "N", gen: 1 },
			{ peer: EAST, seat: "E", gen },
		]);
		expect(sent?.message.seats.map((row) => [row.seat, row.acked])).toEqual([
			["N", 2],
			["E", 2],
			["S", 0],
			["W", 0],
		]);
	});
});

describe("commands", () => {
	it("rejects a deal command from a non-host seat", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		await rig.from(EAST, {
			k: "cmd",
			id: commandId(10),
			gen,
			payload: { type: "deal" },
		});
		expect(rig.to(EAST)).toEqual([
			{
				k: "result",
				id: commandId(10),
				status: "rejected",
				reason: "only the host can deal",
			},
		]);
		expect(rig.log.seqOf(commandId(10))).toBeUndefined();
	});

	it("orders accepted commands, answers the sender and broadcasts each entry with the state", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		rig.entries();
		rig.to(EAST);
		rig.host.receive(
			EAST,
			overTheWire(TABLE, "ctl", {
				k: "cmd",
				id: commandId(10),
				gen,
				payload: chatPayload(TABLE, "first"),
			}),
		);
		await rig.command(EAST, 11, gen, "second");
		expect(rig.to(EAST)).toEqual([
			{ k: "result", id: commandId(10), status: "accepted", seq: 3 },
			{ k: "result", id: commandId(11), status: "accepted", seq: 4 },
		]);
		const sent = rig.entries();
		expect(sent.map((message) => message.e.seq)).toEqual([3, 4]);
		expect(sent[1]?.e).toMatchObject({
			kind: "cmd",
			seat: "E",
			gen,
			payload: chatPayload(TABLE, "second"),
			event: { fromSeat: "E", fromName: "player3", text: "second", seq: 4 },
		});
		expect(sent[1]?.state).toMatchObject({ messages: 2 });
		expect(rig.log.position().rev).toBe(4);
	});

	it("answers a resent command with the stored result and logs it once", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		await rig.command(EAST, 10, gen);
		rig.to(EAST);
		rig.entries();
		await rig.command(EAST, 10, gen);
		expect(rig.to(EAST)).toEqual([
			{ k: "result", id: commandId(10), status: "accepted", seq: 3 },
		]);
		expect(rig.entries()).toEqual([]);
		await rig.command(EAST, 10, gen, "another text");
		expect(rig.to(EAST)).toEqual([
			{ k: "result", id: commandId(10), status: "invalid" },
		]);
		expect(rig.log.position().rev).toBe(3);
	});

	it("takes the seat from the binding and refuses a stale generation or an unbound sender", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		await rig.hello(EAST2, CLIENT_E);
		await rig.from(EAST2, { k: "claim-seat", req: 1, seat: "E" });
		expect(rig.to(EAST2)).toContainEqual({
			k: "seat-result",
			req: 1,
			ok: false,
			code: "taken",
		});
		await rig.command(EAST, 10, gen);
		expect(rig.to(EAST)).toEqual([
			{ k: "result", id: commandId(10), status: "accepted", seq: 3 },
		]);
		await rig.command(EAST2, 11, gen);
		expect(rig.to(EAST2)).toEqual([
			{ k: "result", id: commandId(11), status: "busy" },
		]);
		expect(rig.log.seqOf(commandId(10))).toBe(3);
		expect(rig.log.seqOf(commandId(11))).toBeUndefined();
	});

	it("returns the game's reason for a rejected command and stores nothing", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		const before = rig.storage.commits;
		await rig.command(EAST, 10, gen, "   ");
		expect(rig.to(EAST)).toContainEqual({
			k: "result",
			id: commandId(10),
			status: "rejected",
			reason: "message is empty",
		});
		expect(rig.storage.commits).toBe(before);
	});

	it(`answers busy when a seat has ${MAX_PENDING_PER_SEAT} commands waiting`, async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		rig.to(EAST);
		for (let n = 0; n <= MAX_PENDING_PER_SEAT; n++) {
			rig.host.receive(
				EAST,
				overTheWire(TABLE, "ctl", {
					k: "cmd",
					id: commandId(100 + n),
					gen,
					payload: chatPayload(TABLE, `burst ${n}`),
				}),
			);
		}
		await settle();
		const results = rig.to(EAST);
		expect(results[0]).toEqual({
			k: "result",
			id: commandId(100 + MAX_PENDING_PER_SEAT),
			status: "busy",
		});
		expect(
			results.filter(
				(message) => message.k === "result" && message.status === "accepted",
			),
		).toHaveLength(MAX_PENDING_PER_SEAT);
	});

	it("never accepts a command whose write failed, and stops hosting once", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		rig.to(EAST);
		rig.entries();
		rig.storage.fail = true;
		await rig.command(EAST, 10, gen);
		expect(rig.to(EAST)).toEqual([
			{ k: "result", id: commandId(10), status: "storage" },
		]);
		rig.storage.fail = false;
		await rig.command(EAST, 11, gen);
		expect(rig.to(EAST)).toEqual([
			{ k: "result", id: commandId(11), status: "not_host" },
		]);
		expect(rig.entries()).toEqual([]);
		expect(rig.log.seqOf(commandId(10))).toBeUndefined();
		expect(rig.stops).toEqual(["storage"]);
		expect(rig.host.stopped).toBe(true);
	});

	it("stops with conflict when the stored host changes under it", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		rig.to(EAST);
		const better = { ...rig.auth, inc: rig.auth.inc + 1 };
		await storeClaim(rig.log, better);
		await rig.command(EAST, 10, gen);
		expect(rig.to(EAST)).toEqual([
			{ k: "result", id: commandId(10), status: "not_host" },
		]);
		expect(rig.stops).toEqual(["conflict"]);
	});

	it("a crash between the commit and the broadcast leaves one entry; the resend gets the stored result", async () => {
		const rig = await new Rig().create();
		const gen = await rig.seat(EAST, CLIENT_E, "E");
		await rig.command(EAST, 10, gen);
		// The page dies before its messages leave: nothing it sent arrives.
		rig.sent.take();
		rig.host.stop();
		// The host reloads and resumes its term with the next incarnation.
		rig.auth = { ...rig.auth, inc: rig.auth.inc + 1 };
		await storeClaim(rig.log, rig.auth);
		rig.start();
		await rig.hello(EAST, CLIENT_E, { seat: "E", gen });
		expect(rig.to(EAST)[0]).toMatchObject({ k: "welcome", status: "bound" });
		await rig.command(EAST, 10, gen);
		expect(rig.to(EAST)).toEqual([
			{ k: "result", id: commandId(10), status: "accepted", seq: 3 },
		]);
		const logged = rig.log.entries.filter(
			(entry: Entry) => entry.id === commandId(10),
		);
		expect(logged).toHaveLength(1);
		expect(rig.stops).toEqual([]);
	});
});
