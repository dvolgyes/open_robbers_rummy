import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Authority } from "../../src/p2p/authority";
import type { Followed } from "../../src/p2p/election";
import { Follower, type FollowerEvent } from "../../src/p2p/follower";
import {
	ACK_DEBOUNCE_MS,
	GAP_WAIT_MS,
	SYNC_TIMEOUT_MS,
} from "../../src/p2p/limits";
import { LINK_VERSION } from "../../src/p2p/link";
import { LocalLog, openLog } from "../../src/p2p/log";
import { answerSync, type SyncSource } from "../../src/p2p/sync";
import type {
	CtlMessage,
	Entry,
	Lobby,
	LogMessage,
	Sync,
} from "../../src/p2p/wire";
import { SEATS } from "../../src/protocol";
import {
	overTheWire,
	peerId,
	Recorder,
	settle,
	syncDigest,
	TestStorage,
	VirtualClock,
} from "./fake-mesh";
import {
	AUTH_1,
	AUTH_2,
	CONFIG,
	commandId,
	entries,
	HOLDER_E,
	TABLE,
	tableRecord,
} from "./p2p-fixtures";

const HOST = peerId("host");
const HOST2 = peerId("newhost");
const OTHER = peerId("other");
const CLIENT_E = "clientE-0123456789abcd";

const FIRST: Followed = { peer: HOST, auth: AUTH_1 };
const SECOND: Followed = { peer: HOST2, auth: AUTH_2 };

let restoreDigest: () => void;
beforeEach(() => {
	restoreDigest = syncDigest();
});
afterEach(() => restoreDigest());

/** Entries 1..2 by AUTH_1, then E's own command 3 by AUTH_1, which a later host never received. */
function ownTail(): Entry[] {
	const [three] = entries(3, 3, AUTH_1, AUTH_1);
	if (!three) throw new Error("no entry");
	return [
		...entries(1, 2, AUTH_1, null),
		{ ...three, id: commandId(903), seat: "E", gen: 1 },
	];
}

/** The log of the host of term 2: entries 1..2 by AUTH_1, then `to - 2` of its own. */
function secondLog(to: number): Entry[] {
	return [...entries(1, 2, AUTH_1, null), ...entries(3, to, AUTH_2, AUTH_1)];
}

function source(log: Entry[], auth: Authority, now: number): SyncSource {
	const end = log.at(-1);
	return {
		tableId: TABLE,
		auth,
		table: tableRecord({
			rev: log.length,
			lastAuth: end?.auth ?? AUTH_1,
			state: { phase: `after ${log.length}` },
		}),
		entries: log,
		now,
	};
}

class Rig {
	readonly clock = new VirtualClock();
	readonly storage = new TestStorage();
	readonly sent = new Recorder(TABLE);
	readonly events: FollowerEvent[] = [];
	log: LocalLog;
	follower: Follower;

	constructor(log: LocalLog | null = null) {
		this.log = log ?? new LocalLog(this.storage, TABLE, "E");
		this.follower = new Follower(
			{
				tableId: TABLE,
				client: CLIENT_E,
				send: this.sent,
				clock: this.clock,
				onEvent: (event) => this.events.push(event),
			},
			log,
		);
	}

	/** A page whose stored partition E holds `log`, with seat E held at generation 1. */
	static async stored(
		log: Entry[] = entries(1, 3, AUTH_1, null),
	): Promise<Rig> {
		const storage = new TestStorage();
		const end = log.at(-1);
		const table = tableRecord({
			replica: "E",
			rev: log.length,
			lastAuth: end?.auth ?? AUTH_1,
			host: end?.auth ?? AUTH_1,
			seats: SEATS.map((seat) => ({
				seat,
				holder: seat === "E" ? HOLDER_E : null,
				gen: seat === "E" ? 1 : 0,
			})),
		});
		const created = await storage.commit({ table, expect: null, append: log });
		if (!created.ok) throw new Error(created.detail);
		const opened = await openLog(storage, TABLE, "E");
		if (!opened.ok) throw new Error(opened.detail);
		const rig = new Rig(opened.value.log);
		Object.assign(rig, { storage });
		return rig;
	}

	/** A stored page that follows `host` and is bound and in sync with `hostLog`. */
	static async synced(
		host: Followed = FIRST,
		log: Entry[] = entries(1, 3, AUTH_1, null),
		hostLog: Entry[] = log,
	): Promise<Rig> {
		const rig = await Rig.stored(log);
		rig.follower.adopt(1);
		rig.follower.follow(host);
		await settle();
		rig.ctl(host.peer, {
			k: "welcome",
			status: "bound",
			auth: host.auth,
			seat: "E",
			gen: 1,
		});
		await rig.answer(host.peer, source(hostLog, host.auth, rig.clock.wall()));
		if (!rig.follower.ready) throw new Error("the follower is not ready");
		rig.sent.take();
		rig.events.length = 0;
		return rig;
	}

	ctl(peer: string, message: CtlMessage): void {
		this.follower.receive(peer, overTheWire(TABLE, "ctl", message));
	}

	logMessage(peer: string, message: LogMessage): void {
		this.follower.receiveLog(peer, overTheWire(TABLE, "log", message));
	}

	async entry(peer: string, log: Entry[], seq: number): Promise<void> {
		const e = log[seq - 1];
		if (!e) throw new Error(`no entry ${seq}`);
		this.logMessage(peer, { k: "entry", e, state: { phase: `after ${seq}` } });
		await settle();
	}

	/** The last sync this page sent. */
	lastSync(): { to: string | null; message: Sync } | undefined {
		return this.sent.of("sync").at(-1);
	}

	/** Answers the last sync from `peer`'s copy, over the wire. */
	async answer(peer: string, from: SyncSource): Promise<void> {
		const sync = this.lastSync();
		if (!sync || sync.to !== peer) throw new Error(`no sync to ${peer}`);
		const reply = answerSync(from, sync.message);
		if (reply.kind === "behind") this.ctl(peer, reply.message);
		else for (const message of reply.messages) this.logMessage(peer, message);
		await settle();
	}

	types(): string[] {
		return this.events.map((event) =>
			event.type === "status" ? `status:${event.status}` : event.type,
		);
	}

	async tick(ms: number): Promise<void> {
		this.clock.now += ms;
		this.follower.tick();
		await settle();
	}
}

function lobby(auth: Authority): Lobby {
	return {
		k: "lobby",
		auth,
		config: CONFIG,
		idleMs: 0,
		seats: SEATS.map((seat) => ({
			seat,
			available: seat !== "N",
			online: seat === "N",
			mine: false,
		})),
	};
}

describe("joining", () => {
	it("a visitor says hello, claims the chosen seat, syncs the whole log and becomes ready", async () => {
		const rig = new Rig();
		rig.follower.follow(FIRST);
		rig.ctl(HOST, { k: "welcome", status: "unseated", auth: AUTH_1 });
		rig.ctl(HOST, lobby(AUTH_1));
		expect(rig.sent.of("claim-seat")).toEqual([]);
		rig.follower.choose("E", rig.log);
		rig.ctl(HOST, { k: "seat-result", req: 1, ok: true, seat: "E", gen: 1 });
		const hostLog = entries(1, 3, AUTH_1, null);
		await rig.answer(HOST, source(hostLog, AUTH_1, rig.clock.wall()));
		expect(rig.sent.sent.map((item) => [item.to, item.message])).toEqual([
			[
				HOST,
				{
					k: "hello",
					b: LINK_VERSION,
					client: CLIENT_E,
				},
			],
			[HOST, { k: "claim-seat", req: 1, seat: "E" }],
			[HOST, { k: "sync", req: 2, pos: { rev: 0, lastAuth: null } }],
		]);
		expect(rig.types()).toEqual([
			"status:hello",
			"status:unseated",
			"lobby",
			"status:claiming",
			"seat-result",
			"status:bound",
			"ready",
		]);
		expect(rig.events.at(-1)).toEqual({
			type: "ready",
			target: { peer: HOST, gen: 1 },
		});
		expect(rig.log.entries).toEqual(hostLog);
		expect(rig.log.table?.state).toEqual({ phase: "after 3" });
		await rig.tick(ACK_DEBOUNCE_MS);
		expect(rig.sent.of("ack").map((item) => item.message)).toEqual([
			{ k: "ack", rev: 3 },
		]);
	});

	it("a seated page names its seat, generation and position, and extends its log", async () => {
		const rig = await Rig.stored();
		rig.follower.adopt(1);
		rig.follower.follow(FIRST);
		expect(rig.sent.take().map((item) => item.message)).toEqual([
			{
				k: "hello",
				b: LINK_VERSION,
				client: CLIENT_E,
				seat: "E",
				gen: 1,
				pos: { rev: 3, lastAuth: AUTH_1 },
			},
		]);
		rig.ctl(HOST, {
			k: "welcome",
			status: "bound",
			auth: AUTH_1,
			seat: "E",
			gen: 1,
		});
		const hostLog = entries(1, 5, AUTH_1, null);
		await rig.answer(HOST, source(hostLog, AUTH_1, rig.clock.wall()));
		expect(rig.log.entries).toEqual(hostLog);
		expect(rig.follower.ready).toBe(true);
	});

	it("stores the followed authority as the replica's host, without a new incarnation", async () => {
		const rig = await Rig.stored();
		rig.follower.follow(SECOND);
		await settle();
		expect(rig.log.table).toMatchObject({ host: AUTH_2, inc: 1 });
	});

	it("a superseded page stays read-only", async () => {
		const rig = await Rig.stored();
		rig.follower.follow(FIRST);
		rig.ctl(HOST, { k: "welcome", status: "superseded", auth: AUTH_1 });
		expect(rig.follower.status).toBe("superseded");
		rig.sent.take();
		rig.follower.follow(SECOND);
		rig.ctl(HOST2, {
			k: "welcome",
			status: "bound",
			auth: AUTH_2,
			seat: "E",
			gen: 1,
		});
		expect(rig.sent.sent).toEqual([]);
		expect(rig.follower.status).toBe("superseded");
	});

	it("says hello again when the host's peer reconnects", async () => {
		const rig = await Rig.synced();
		rig.follower.leave(HOST);
		expect(rig.events).toEqual([
			{ type: "ready", target: null },
			{ type: "status", status: "hello" },
		]);
		rig.follower.join(HOST);
		expect(rig.sent.of("hello")).toHaveLength(1);
	});
});

describe("live entries", () => {
	it("applies entries in order when they arrive out of order", async () => {
		const rig = await Rig.synced();
		const hostLog = entries(1, 5, AUTH_1, null);
		await rig.entry(HOST, hostLog, 5);
		expect(rig.log.position().rev).toBe(3);
		await rig.entry(HOST, hostLog, 4);
		expect(rig.log.entries).toEqual(hostLog);
		expect(rig.log.table?.state).toEqual({ phase: "after 5" });
		expect(rig.sent.of("sync")).toEqual([]);
	});

	it("syncs when a gap stays for GAP_WAIT_MS", async () => {
		const rig = await Rig.synced();
		await rig.entry(HOST, entries(1, 5, AUTH_1, null), 5);
		await rig.tick(GAP_WAIT_MS - 1);
		expect(rig.sent.of("sync")).toEqual([]);
		await rig.tick(1);
		expect(rig.lastSync()).toEqual({
			to: HOST,
			channel: "ctl",
			message: {
				k: "sync",
				req: expect.any(Number),
				pos: { rev: 3, lastAuth: AUTH_1 },
			},
		});
	});

	it("syncs when an accepted command's entry does not arrive", async () => {
		const rig = await Rig.synced();
		rig.follower.accepted(4);
		await rig.tick(GAP_WAIT_MS);
		expect(rig.sent.of("sync")).toHaveLength(1);
	});

	it("drops entries from any peer but the followed host, and of another authority", async () => {
		const rig = await Rig.synced();
		const hostLog = entries(1, 4, AUTH_1, null);
		await rig.entry(OTHER, hostLog, 4);
		await rig.entry(
			HOST,
			[...entries(1, 3, AUTH_1, null), ...entries(4, 4, AUTH_2, AUTH_1)],
			4,
		);
		expect(rig.log.position().rev).toBe(3);
		await rig.tick(GAP_WAIT_MS);
		expect(rig.sent.of("sync")).toEqual([]);
	});

	it("a new host replaces a longer old-host copy during initial sync", async () => {
		const rig = await Rig.synced(SECOND, ownTail(), secondLog(2));
		expect(rig.log.entries).toEqual(secondLog(2));
		expect(rig.log.table?.host).toEqual(AUTH_2);
	});

	it("takes a replacement only from the followed host", async () => {
		const rig = await Rig.stored(ownTail());
		rig.follower.adopt(1);
		rig.follower.follow(SECOND);
		rig.ctl(HOST2, {
			k: "welcome",
			status: "bound",
			auth: AUTH_2,
			seat: "E",
			gen: 1,
		});
		const sync = rig.lastSync();
		if (!sync) throw new Error("no sync");
		const reply = answerSync(
			source(secondLog(4), AUTH_2, rig.clock.wall()),
			sync.message,
		);
		if (reply.kind !== "log") throw new Error("expected a replacement");
		for (const message of reply.messages) rig.logMessage(OTHER, message);
		await settle();
		expect(rig.log.entries).toEqual(ownTail());
		for (const message of reply.messages) rig.logMessage(HOST2, message);
		await settle();
		expect(rig.log.entries).toEqual(secondLog(4));
	});

	it("asks again when a sync gets no answer within SYNC_TIMEOUT_MS", async () => {
		const rig = await Rig.stored();
		rig.follower.adopt(1);
		rig.follower.follow(FIRST);
		rig.ctl(HOST, {
			k: "welcome",
			status: "bound",
			auth: AUTH_1,
			seat: "E",
			gen: 1,
		});
		await rig.tick(SYNC_TIMEOUT_MS);
		expect(rig.sent.of("sync")).toHaveLength(2);
	});
});

describe("claim pull", () => {
	it("adopts a strictly better log from any peer", async () => {
		const rig = await Rig.stored(ownTail());
		rig.follower.pull(OTHER);
		await rig.answer(OTHER, source(secondLog(4), AUTH_2, rig.clock.wall()));
		expect(rig.log.entries).toEqual(secondLog(4));
		expect(rig.types()).toContain("pulled");
	});

	it("keeps its copy when the peer's log is the same, behind, or worse", async () => {
		const rig = await Rig.stored(secondLog(4));
		const commits = rig.storage.commits;
		rig.follower.pull(OTHER);
		await rig.answer(OTHER, source(secondLog(4), AUTH_2, rig.clock.wall()));
		rig.follower.pull(OTHER);
		await rig.answer(OTHER, source(secondLog(3), AUTH_2, rig.clock.wall()));
		// A peer that sends a replacement worse than this copy, against the protocol.
		rig.follower.pull(OTHER);
		const sync = rig.lastSync();
		if (!sync) throw new Error("no sync");
		const worse = answerSync(source(entries(1, 6, AUTH_1, null), AUTH_1, 0), {
			...sync.message,
			pos: { rev: 0, lastAuth: null },
		});
		if (worse.kind !== "log") throw new Error("expected a replacement");
		for (const message of worse.messages) rig.logMessage(OTHER, message);
		await settle();
		expect(rig.log.entries).toEqual(secondLog(4));
		expect(rig.storage.commits).toBe(commits);
		expect(rig.types().filter((type) => type === "pulled")).toHaveLength(3);
	});

	it("ends at once without a table, and after SYNC_TIMEOUT_MS without an answer", async () => {
		const empty = new Rig();
		empty.follower.pull(OTHER);
		expect(empty.sent.sent).toEqual([]);
		expect(empty.types()).toEqual(["pulled"]);
		const rig = await Rig.stored();
		rig.follower.pull(OTHER);
		await rig.tick(SYNC_TIMEOUT_MS);
		expect(rig.types()).toEqual(["pulled"]);
	});
});
