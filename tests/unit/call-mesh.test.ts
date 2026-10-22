import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CallMesh,
	type CallRoomSnapshot,
	REPLY_COALESCE_MS,
	SILENCE_MS,
	STALE_SNAPSHOT_MS,
	VANISHED_MS,
} from "../../src/call/mesh";
import {
	type AnnounceMessage,
	type CallMessage,
	inboxTopic,
} from "../../src/call/messages";
import type { Party } from "../../src/call/policy";
import {
	type CallTransport,
	createCallSignaling,
	type InboxSubscription,
	type OutgoingSignal,
	type TransportStatus,
} from "../../src/call/signaling";
import { SEATS, type Seat } from "../../src/protocol";
import type { Result } from "../../src/result";
import { AUDIO, BOTH, FakeLink, party, session } from "./call-fakes";
import { ROOM_ID } from "./fixtures";

/** Delays in the range of the C2 P9 measure: an inbox join of about 60 ms, RPC to delivery about 70 ms. */
const SUBSCRIBE_MS = 60;
const REMOVE_MS = 30;
const RPC_MS = 20;
const DELIVERY_MS = 50;
/** Long enough for every exchange in these tests to finish. */
const SETTLE_MS = 5_000;

const CANDIDATE = { candidate: "", sdpMid: "0", sdpMLineIndex: 0 };

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(ms = SETTLE_MS): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

/** One copy of a message that the broker wrote for one receiving seat. */
interface Traffic {
	readonly from: Seat;
	readonly to: Seat;
	/** False for a message to all, which the broker copies to each other holder. */
	readonly addressed: boolean;
	readonly message: CallMessage;
}

interface BrokerInbox {
	readonly seat: Seat;
	readonly topic: string;
	readonly handlers: {
		onPayload(raw: unknown): void;
		onStatus(status: TransportStatus): void;
	};
	state: "joining" | "subscribed" | "removed";
}

/**
 * A call transport for one room: a sender that is not the current holder gets `superseded`, and a copy reaches an
 * inbox only while that inbox is subscribed.
 */
class Broker implements CallTransport {
	readonly holders: Partial<Record<Seat, number>> = {};
	readonly online = new Set<Seat>();
	/** Every copy the broker wrote, in write order. */
	readonly sent: Traffic[] = [];
	readonly log: string[] = [];
	/** True loses the copy between the broker and the inbox. */
	drop: (traffic: Traffic) => boolean = () => false;
	readonly #inboxes = new Set<BrokerInbox>();
	readonly #down = new Set<Seat>();
	#ids = 0;

	subscribe(
		topic: string,
		handlers: BrokerInbox["handlers"],
	): InboxSubscription {
		const seat = topic.split(":")[2] as Seat;
		const inbox: BrokerInbox = { seat, topic, handlers, state: "joining" };
		this.#inboxes.add(inbox);
		this.log.push(`subscribe ${seat}`);
		setTimeout(() => this.#admit(inbox), SUBSCRIBE_MS);
		return {
			remove: async () => {
				inbox.state = "removed";
				await pause(REMOVE_MS);
				this.#inboxes.delete(inbox);
				this.log.push(`remove ${seat}`);
			},
		};
	}

	async send(signal: OutgoingSignal): Promise<Result<number>> {
		await pause(RPC_MS);
		if (this.holders[signal.seat] !== signal.generation) {
			return { ok: false, code: "superseded" };
		}
		const targets =
			signal.to === null
				? SEATS.filter((seat) => seat !== signal.seat)
				: [signal.to];
		let written = 0;
		for (const to of targets) {
			const toGen = this.holders[to];
			if (toGen === undefined) continue;
			written++;
			const traffic: Traffic = {
				from: signal.seat,
				to,
				addressed: signal.to !== null,
				message: signal.message,
			};
			this.sent.push(traffic);
			const topic = inboxTopic({
				roomId: signal.roomId,
				seat: to,
				generation: toGen,
			});
			const envelope = {
				v: 1,
				roomId: signal.roomId,
				from: signal.seat,
				fromGen: signal.generation,
				toGen,
				id: `message-${++this.#ids}`,
				message: signal.message,
			};
			setTimeout(() => {
				if (!this.drop(traffic)) this.deliver(topic, envelope);
			}, DELIVERY_MS);
		}
		return { ok: true, value: written };
	}

	/** Hands a payload to the subscribed inboxes of a topic. */
	deliver(topic: string, payload: unknown): void {
		for (const inbox of this.#inboxes) {
			if (inbox.topic === topic && inbox.state === "subscribed") {
				inbox.handlers.onPayload(structuredClone(payload));
			}
		}
	}

	/** The seat's inbox channel fails; new joins of its topic wait for `restore`. */
	outage(seat: Seat): void {
		this.#down.add(seat);
		for (const inbox of this.#inboxes) {
			if (inbox.seat === seat && inbox.state === "subscribed") {
				inbox.state = "joining";
				inbox.handlers.onStatus("lost");
			}
		}
	}

	restore(seat: Seat): void {
		this.#down.delete(seat);
		for (const inbox of this.#inboxes) {
			if (inbox.seat === seat && inbox.state === "joining") {
				setTimeout(() => this.#admit(inbox), SUBSCRIBE_MS);
			}
		}
	}

	count(
		type: CallMessage["type"],
		where: Partial<Pick<Traffic, "from" | "to" | "addressed">> = {},
	): number {
		return this.sent.filter(
			(traffic) =>
				traffic.message.type === type &&
				(where.from === undefined || traffic.from === where.from) &&
				(where.to === undefined || traffic.to === where.to) &&
				(where.addressed === undefined ||
					traffic.addressed === where.addressed),
		).length;
	}

	#admit(inbox: BrokerInbox): void {
		if (inbox.state !== "joining" || this.#down.has(inbox.seat)) return;
		inbox.state = "subscribed";
		inbox.handlers.onStatus("open");
	}
}

class Player {
	readonly links: FakeLink[] = [];
	readonly mesh: CallMesh;

	constructor(
		readonly seat: Seat,
		readonly generation: number,
		broker: Broker,
		newSession: () => string,
	) {
		this.mesh = new CallMesh({
			openSignaling: (inbox, handlers) =>
				createCallSignaling(broker, inbox, handlers),
			createLink: (options) => {
				const link = new FakeLink(options);
				this.links.push(link);
				return link;
			},
			newSession,
		});
	}

	/** This player's open links to one seat. */
	live(seat: Seat): FakeLink[] {
		return this.links.filter(
			(link) => !link.closed && link.options.seat === seat,
		);
	}

	get inbox(): string {
		return inboxTopic({
			roomId: ROOM_ID,
			seat: this.seat,
			generation: this.generation,
		});
	}
}

class Table {
	readonly broker = new Broker();
	readonly #players: Player[] = [];
	#sessions = 0;

	/** A holder claims the seat at a new generation and is present; `quiet` keeps the other views stale. */
	take(seat: Seat, quiet = false): Player {
		const generation = (this.broker.holders[seat] ?? 0) + 1;
		this.broker.holders[seat] = generation;
		this.broker.online.add(seat);
		const player = new Player(seat, generation, this.broker, () =>
			session(++this.#sessions),
		);
		this.#players.push(player);
		if (quiet) this.publish(player);
		else this.publish();
		return player;
	}

	/** The room channel brings the current seats to these players (all when none are named). */
	publish(...only: Player[]): void {
		for (const player of only.length > 0 ? only : this.#players) {
			player.mesh.update(this.snapshot(player));
		}
	}

	snapshot(player: Player): CallRoomSnapshot {
		const { holders, online } = this.broker;
		return {
			roomId: ROOM_ID,
			self:
				holders[player.seat] === player.generation
					? { seat: player.seat, generation: player.generation }
					: null,
			holders: { ...holders },
			online: new Set(online),
		};
	}
}

/** A message as `send_call_signal` would wrap it for the receiver's current inbox. */
function envelope(
	from: Seat,
	fromGen: number,
	to: Player,
	message: CallMessage,
): unknown {
	return {
		v: 1,
		roomId: ROOM_ID,
		from,
		fromGen,
		toGen: to.generation,
		id: "injected",
		message,
	};
}

function announce(
	type: "join" | "resync",
	sessionId: string,
	who: Party = AUDIO,
): AnnounceMessage {
	return {
		type,
		session: sessionId,
		prefs: who.prefs,
		prefVersion: 0,
		form: who.form,
	};
}

/** Exactly one open link each way, and both connected. */
function expectConnected(a: Player, b: Player): void {
	expect(a.live(b.seat).map((link) => link.connected)).toEqual([true]);
	expect(b.live(a.seat).map((link) => link.connected)).toEqual([true]);
}

let table: Table;

beforeEach(() => {
	vi.useFakeTimers();
	table = new Table();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CallMesh convergence (call/layout plan §4.4 step 3)", () => {
	it("connects A before B with one offer from the impolite side", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		await settle();
		expect(north.mesh.status).toBe("subscribed");
		expect(north.links).toEqual([]);
		east.mesh.join(AUDIO);
		await settle();
		expectConnected(north, east);
		expect(north.live("E")[0]?.options.polite).toBe(false);
		expect(table.broker.count("offer")).toBe(1);
		expect(north.mesh.peer("E")).toEqual(AUDIO);
		expect(east.mesh.peer("N")).toEqual(AUDIO);
	});

	it("connects B before A with one offer from the impolite side", async () => {
		const north = table.take("N");
		const east = table.take("E");
		east.mesh.join(AUDIO);
		await settle();
		north.mesh.join(AUDIO);
		await settle();
		expectConnected(north, east);
		expect(table.broker.count("offer", { from: "N" })).toBe(1);
		expect(table.broker.count("offer")).toBe(1);
	});

	it("connects two seats that join in the same tick", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		expectConnected(north, east);
		expect(table.broker.count("offer")).toBe(1);
	});

	it("connects four seats that join in the same tick with six offers and no extra traffic", async () => {
		const players = SEATS.map((seat) => table.take(seat));
		for (const player of players) player.mesh.join(AUDIO);
		await settle();
		for (const [index, a] of players.entries()) {
			for (const b of players.slice(index + 1)) expectConnected(a, b);
		}
		const types = table.broker.sent.map((traffic) => traffic.message.type);
		expect(types.filter((type) => type === "join")).toHaveLength(12);
		expect(types.filter((type) => type === "prefs")).toHaveLength(12);
		expect(types.filter((type) => type === "offer")).toHaveLength(6);
		expect(types.filter((type) => type === "answer")).toHaveLength(6);
		expect(types).toHaveLength(36);
	});

	it("re-announces after a reconnect and receives a preference change missed during the outage", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		table.broker.outage("E");
		await settle(100);
		expect(east.mesh.status).toBe("lost");
		north.mesh.setLocal(BOTH);
		await settle(500);
		expect(table.broker.count("prefs", { from: "N", addressed: false })).toBe(
			1,
		);
		expect(east.mesh.peer("N")).toEqual(AUDIO);
		table.broker.restore("E");
		await settle();
		expect(east.mesh.status).toBe("subscribed");
		expect(table.broker.count("resync", { from: "E", addressed: false })).toBe(
			1,
		);
		expect(east.mesh.peer("N")).toEqual(BOTH);
		expect(east.live("N")[0]?.remote).toEqual(BOTH);
		expectConnected(north, east);
		expect(table.broker.count("offer")).toBe(1);
	});

	it("recovers a lost join with one addressed resync after 3 s", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		await settle();
		table.broker.drop = (traffic) =>
			traffic.from === "E" && traffic.message.type === "join";
		east.mesh.join(AUDIO);
		await settle(SILENCE_MS - 100);
		expect(north.mesh.peer("E")).toBeUndefined();
		expect(table.broker.count("resync", { from: "E" })).toBe(0);
		await settle();
		expectConnected(north, east);
		expect(table.broker.count("resync", { from: "E", addressed: true })).toBe(
			1,
		);
		await settle(60_000);
		expect(table.broker.count("resync", { from: "E" })).toBe(1);
	});

	it("queues a join from a holder that the snapshot does not show yet, then accepts it", async () => {
		const north = table.take("N");
		north.mesh.join(AUDIO);
		await settle();
		const east = table.take("E", true);
		east.mesh.join(AUDIO);
		await settle(1_000);
		expect(north.mesh.peer("E")).toBeUndefined();
		expect(north.links).toEqual([]);
		table.publish(north);
		await settle();
		expectConnected(north, east);
	});

	it("replaces a lost offer exactly once after the peer's reconnect resync", async () => {
		const north = table.take("N");
		const east = table.take("E");
		let offers = 0;
		table.broker.drop = (traffic) =>
			traffic.message.type === "offer" && offers++ === 0;
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		expect(north.live("E").map((link) => link.connected)).toEqual([false]);
		expect(east.live("N").map((link) => link.connected)).toEqual([false]);
		table.broker.outage("E");
		await settle(100);
		table.broker.restore("E");
		await settle();
		expectConnected(north, east);
		expect(north.live("E")[0]?.offers).toEqual([1, 2]);
		expect(east.live("N")[0]?.offers).toEqual([]);
		expect(table.broker.count("offer")).toBe(2);
	});
});

describe("CallMesh announcements", () => {
	it("sends join only after the own inbox is subscribed, with the latest preferences", async () => {
		const north = table.take("N");
		table.take("E");
		north.mesh.join(AUDIO);
		expect(north.mesh.status).toBe("joining");
		north.mesh.setLocal(BOTH);
		await settle(SUBSCRIBE_MS - 1);
		expect(table.broker.log).toEqual(["subscribe N"]);
		expect(table.broker.sent).toEqual([]);
		await settle(1_000);
		expect(north.mesh.status).toBe("subscribed");
		expect(table.broker.sent).toEqual([
			{
				from: "N",
				to: "E",
				addressed: false,
				message: {
					type: "join",
					session: session(1),
					prefs: BOTH.prefs,
					prefVersion: 1,
					form: "desktop",
				},
			},
		]);
	});

	it("sends one addressed resync to each silent online holder and never repeats it", async () => {
		const north = table.take("N");
		table.take("E");
		table.take("S");
		table.take("W");
		table.broker.online.delete("W");
		table.publish();
		north.mesh.join(AUDIO);
		const addressed = () =>
			table.broker.sent
				.filter((traffic) => traffic.addressed)
				.map((traffic) => `${traffic.message.type}:${traffic.to}`);
		await settle(SILENCE_MS - 1);
		expect(addressed()).toEqual([]);
		await settle(1_000);
		expect(addressed()).toEqual(["resync:E", "resync:S"]);
		await settle(60_000);
		expect(addressed()).toEqual(["resync:E", "resync:S"]);
	});

	it("answers a join and a resync from one seat within 300 ms with one prefs message", async () => {
		table.take("N");
		const west = table.take("W");
		west.mesh.join(AUDIO);
		await settle();
		const before = table.broker.sent.length;
		table.broker.deliver(
			west.inbox,
			envelope("N", 1, west, announce("join", session(50))),
		);
		await settle(REPLY_COALESCE_MS / 2);
		table.broker.deliver(
			west.inbox,
			envelope("N", 1, west, announce("resync", session(50))),
		);
		await settle();
		expect(
			table.broker.sent
				.slice(before)
				.map((t) => `${t.from}>${t.to}:${t.message.type}`),
		).toEqual(["W>N:prefs"]);
		expect(west.live("N")).toHaveLength(1);
	});

	it("never shows video for a compact peer, whatever its message says", async () => {
		table.take("N");
		const west = table.take("W");
		west.mesh.join(AUDIO);
		await settle();
		const message = {
			...announce("join", session(50)),
			prefs: BOTH.prefs,
			form: "compact",
		} satisfies CallMessage;
		table.broker.deliver(west.inbox, envelope("N", 1, west, message));
		expect(west.mesh.peer("N")).toEqual({
			prefs: AUDIO.prefs,
			form: "compact",
		});
		expect(west.live("N")[0]?.remote).toEqual({
			prefs: AUDIO.prefs,
			form: "compact",
		});
	});

	it("Retry restarts the link from the polite side and announces a resync", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		north.live("E")[0]?.fail();
		east.live("N")[0]?.fail();
		east.mesh.retry("N");
		await settle();
		expectConnected(north, east);
		expect(east.live("N")[0]?.offers).toEqual([2]);
		expect(table.broker.count("resync", { from: "E", addressed: false })).toBe(
			1,
		);
	});
});

describe("CallMesh membership and lifecycle", () => {
	it("closes the link when the peer's seat changes generation and ignores the old generation", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		const [oldLink] = north.live("E");
		const before = table.broker.sent.length;
		table.take("E");
		expect(north.live("E")).toEqual([]);
		expect(north.mesh.peer("E")).toBeUndefined();
		expect(east.mesh.status).toBe("outside");
		expect(east.live("N")).toEqual([]);
		oldLink?.options.send({ type: "offer", negotiation: 9, sdp: "v=0" });
		table.broker.deliver(
			north.inbox,
			envelope("E", 1, north, announce("join", session(50))),
		);
		await settle();
		expect(north.mesh.peer("E")).toBeUndefined();
		expect(north.live("E")).toEqual([]);
		expect(table.broker.sent.slice(before)).toEqual([]);
	});

	it("drops a queued message when no snapshot confirms the sender within 3 s", async () => {
		const north = table.take("N");
		north.mesh.join(AUDIO);
		await settle();
		table.broker.drop = (traffic) => traffic.from === "E" && traffic.addressed;
		table.take("E", true).mesh.join(AUDIO);
		await settle(STALE_SNAPSHOT_MS + 500);
		table.publish(north);
		await settle();
		expect(north.mesh.peer("E")).toBeUndefined();
		expect(north.links).toEqual([]);
	});

	it("routes ICE batches only to the link of the current session", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		east.live("N")[0]?.options.send({
			type: "ice",
			negotiation: 1,
			candidates: [CANDIDATE],
		});
		await settle();
		const link = north.live("E")[0];
		expect(link?.received.at(-1)).toEqual({
			type: "ice",
			negotiation: 1,
			candidates: [CANDIDATE],
		});
		const received = link?.received.length;
		table.broker.deliver(
			north.inbox,
			envelope("E", 1, north, {
				type: "ice",
				session: session(2),
				toSession: session(77),
				negotiation: 1,
				candidates: [CANDIDATE],
			}),
		);
		expect(link?.received.length).toBe(received);
	});

	it("ends the link to a peer that stays offline for 10 s and keeps one that returns", async () => {
		const north = table.take("N");
		const east = table.take("E");
		const south = table.take("S");
		for (const player of [north, east, south]) player.mesh.join(AUDIO);
		await settle();
		table.broker.online.delete("E");
		table.broker.online.delete("S");
		table.publish();
		await settle(VANISHED_MS / 2);
		table.broker.online.add("S");
		table.publish();
		await settle(VANISHED_MS / 2 - 1);
		expect(north.live("E")).toHaveLength(1);
		await settle(1);
		expect(north.live("E")).toEqual([]);
		expect(north.mesh.peer("E")).toBeUndefined();
		await settle(VANISHED_MS);
		expectConnected(north, south);
	});

	it("forgets a peer that returns within 10 s but does not answer the greeting, as after a reload", async () => {
		const north = table.take("N");
		const south = table.take("S");
		north.mesh.join(AUDIO);
		south.mesh.join(AUDIO);
		await settle();
		// The page reloads: its inbox is gone, and the new page holds the seat again without joining the call.
		table.broker.outage("S");
		table.broker.online.delete("S");
		table.publish(north);
		await settle(VANISHED_MS / 5);
		table.broker.online.add("S");
		table.publish(north);
		await settle(SILENCE_MS - 1);
		expect(north.mesh.peer("S")).toBeDefined();
		await settle(1);
		expect(north.mesh.peer("S")).toBeUndefined();
		expect(north.live("S")).toEqual([]);
	});

	it("keeps a returning peer that answers the greeting", async () => {
		const north = table.take("N");
		const south = table.take("S");
		north.mesh.join(AUDIO);
		south.mesh.join(AUDIO);
		await settle();
		table.broker.online.delete("S");
		table.publish(north);
		await settle(VANISHED_MS / 5);
		table.broker.online.add("S");
		table.publish(north);
		await settle(SILENCE_MS * 2);
		expect(north.mesh.peer("S")).toEqual(AUDIO);
		expectConnected(north, south);
	});

	it("Leave closes every link and the peers forget the seat", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		east.mesh.leave();
		expect(east.mesh.status).toBe("outside");
		expect(east.live("N")).toEqual([]);
		await settle();
		expect(north.live("E")).toEqual([]);
		expect(north.mesh.peer("E")).toBeUndefined();
	});

	it("Join after Leave opens the inbox only after the old one is removed and the farewell is written", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		table.broker.log.length = 0;
		const before = table.broker.sent.length;
		east.mesh.leave();
		east.mesh.join(BOTH);
		await settle();
		expect(table.broker.log.filter((entry) => entry.endsWith(" E"))).toEqual([
			"remove E",
			"subscribe E",
		]);
		const fromEast = table.broker.sent
			.slice(before)
			.filter((traffic) => traffic.from === "E" && !traffic.addressed)
			.map((traffic) => traffic.message.type);
		expect(fromEast.slice(0, 2)).toEqual(["leave", "join"]);
		expectConnected(north, east);
		expect(north.mesh.peer("E")).toEqual(BOTH);
	});

	it("retires the old link when a new session arrives from the same seat after a lost leave", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		table.broker.drop = (traffic) => traffic.message.type === "leave";
		east.mesh.leave();
		east.mesh.join(AUDIO);
		await settle();
		expectConnected(north, east);
		expect(
			north.links.filter((link) => link.options.seat === "E"),
		).toHaveLength(2);
	});

	it("ends the call when the database answers superseded", async () => {
		const north = table.take("N");
		const east = table.take("E");
		north.mesh.join(AUDIO);
		east.mesh.join(AUDIO);
		await settle();
		table.broker.holders.E = 2;
		east.mesh.setLocal(BOTH);
		await settle();
		expect(east.mesh.status).toBe("outside");
		expect(east.live("N")).toEqual([]);
	});

	it("reports changes until disposed", async () => {
		const north = table.take("N");
		const changes = vi.fn();
		north.mesh.onChange(changes);
		north.mesh.join(AUDIO);
		await settle();
		expect(changes).toHaveBeenCalled();
		north.mesh.dispose();
		expect(north.mesh.status).toBe("outside");
		changes.mockClear();
		table.publish();
		await settle();
		expect(changes).not.toHaveBeenCalled();
	});

	it("throws on caller bugs", () => {
		const north = table.take("N");
		const outside = party("out");
		expect(() => north.mesh.setLocal(AUDIO)).toThrow("not in the call");
		expect(() => north.mesh.join(outside)).toThrow(
			"join needs in-call preferences",
		);
		north.mesh.join(AUDIO);
		expect(() => north.mesh.join(AUDIO)).toThrow("already in the call");
		expect(() => north.mesh.setLocal(outside)).toThrow("use leave()");
		const stranger = new CallMesh({
			openSignaling: () => {
				throw new Error("unused");
			},
			createLink: () => {
				throw new Error("unused");
			},
			newSession: () => session(1),
		});
		expect(() => stranger.join(AUDIO)).toThrow("a call join needs a held seat");
	});
});
