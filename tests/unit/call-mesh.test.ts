import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CallMesh,
	type CallTableSnapshot,
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
import { TABLE_ID } from "./fixtures";

/** Delays in the measured range: an inbox join of about 60 ms, RPC to delivery about 70 ms. */
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
 * A call transport for one table: a sender that is not the current holder gets `superseded`, and a copy reaches an
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
				tableId: signal.tableId,
				seat: to,
				generation: toGen,
			});
			const envelope = {
				v: 1,
				tableId: signal.tableId,
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
			tableId: TABLE_ID,
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

	/** The table channel brings the current seats to these players (all when none are named). */
	publish(...only: Player[]): void {
		for (const player of only.length > 0 ? only : this.#players) {
			player.mesh.update(this.snapshot(player));
		}
	}

	snapshot(player: Player): CallTableSnapshot {
		const { holders, online } = this.broker;
		return {
			tableId: TABLE_ID,
			self:
				holders[player.seat] === player.generation
					? { seat: player.seat, generation: player.generation }
					: null,
			seats: ["1", "2", "3", "4"],
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
		tableId: TABLE_ID,
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

describe("CallMesh convergence", () => {
	it("connects A before B with one offer from the impolite side", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		await settle();
		expect(player1.mesh.status).toBe("subscribed");
		expect(player1.links).toEqual([]);
		player2.mesh.join(AUDIO);
		await settle();
		expectConnected(player1, player2);
		expect(player1.live("2")[0]?.options.polite).toBe(false);
		expect(table.broker.count("offer")).toBe(1);
		expect(player1.mesh.peer("2")).toEqual(AUDIO);
		expect(player2.mesh.peer("1")).toEqual(AUDIO);
	});

	it("connects B before A with one offer from the impolite side", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player2.mesh.join(AUDIO);
		await settle();
		player1.mesh.join(AUDIO);
		await settle();
		expectConnected(player1, player2);
		expect(table.broker.count("offer", { from: "1" })).toBe(1);
		expect(table.broker.count("offer")).toBe(1);
	});

	it("connects two seats that join in the same tick", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		expectConnected(player1, player2);
		expect(table.broker.count("offer")).toBe(1);
	});

	it("connects four seats that join in the same tick with six offers and no extra traffic", async () => {
		const players = SEATS.slice(0, 4).map((seat) => table.take(seat));
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
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		table.broker.outage("2");
		await settle(100);
		expect(player2.mesh.status).toBe("lost");
		player1.mesh.setLocal(BOTH);
		await settle(500);
		expect(table.broker.count("prefs", { from: "1", addressed: false })).toBe(
			1,
		);
		expect(player2.mesh.peer("1")).toEqual(AUDIO);
		table.broker.restore("2");
		await settle();
		expect(player2.mesh.status).toBe("subscribed");
		expect(table.broker.count("resync", { from: "2", addressed: false })).toBe(
			1,
		);
		expect(player2.mesh.peer("1")).toEqual(BOTH);
		expect(player2.live("1")[0]?.remote).toEqual(BOTH);
		expectConnected(player1, player2);
		expect(table.broker.count("offer")).toBe(1);
	});

	it("recovers a lost join with one addressed resync after 3 s", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		await settle();
		table.broker.drop = (traffic) =>
			traffic.from === "2" && traffic.message.type === "join";
		player2.mesh.join(AUDIO);
		await settle(SILENCE_MS - 100);
		expect(player1.mesh.peer("2")).toBeUndefined();
		expect(table.broker.count("resync", { from: "2" })).toBe(0);
		await settle();
		expectConnected(player1, player2);
		expect(table.broker.count("resync", { from: "2", addressed: true })).toBe(
			1,
		);
		await settle(60_000);
		expect(table.broker.count("resync", { from: "2" })).toBe(1);
	});

	it("queues a join from a holder that the snapshot does not show yet, then accepts it", async () => {
		const player1 = table.take("1");
		player1.mesh.join(AUDIO);
		await settle();
		const player2 = table.take("2", true);
		player2.mesh.join(AUDIO);
		await settle(1_000);
		expect(player1.mesh.peer("2")).toBeUndefined();
		expect(player1.links).toEqual([]);
		table.publish(player1);
		await settle();
		expectConnected(player1, player2);
	});

	it("replaces a lost offer exactly once after the peer's reconnect resync", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		let offers = 0;
		table.broker.drop = (traffic) =>
			traffic.message.type === "offer" && offers++ === 0;
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		expect(player1.live("2").map((link) => link.connected)).toEqual([false]);
		expect(player2.live("1").map((link) => link.connected)).toEqual([false]);
		table.broker.outage("2");
		await settle(100);
		table.broker.restore("2");
		await settle();
		expectConnected(player1, player2);
		expect(player1.live("2")[0]?.offers).toEqual([1, 2]);
		expect(player2.live("1")[0]?.offers).toEqual([]);
		expect(table.broker.count("offer")).toBe(2);
	});
});

describe("CallMesh announcements", () => {
	it("sends join only after the own inbox is subscribed, with the latest preferences", async () => {
		const player1 = table.take("1");
		table.take("2");
		player1.mesh.join(AUDIO);
		expect(player1.mesh.status).toBe("joining");
		player1.mesh.setLocal(BOTH);
		await settle(SUBSCRIBE_MS - 1);
		expect(table.broker.log).toEqual(["subscribe 1"]);
		expect(table.broker.sent).toEqual([]);
		await settle(1_000);
		expect(player1.mesh.status).toBe("subscribed");
		expect(table.broker.sent).toEqual([
			{
				from: "1",
				to: "2",
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
		const player1 = table.take("1");
		table.take("2");
		table.take("3");
		table.take("4");
		table.broker.online.delete("4");
		table.publish();
		player1.mesh.join(AUDIO);
		const addressed = () =>
			table.broker.sent
				.filter((traffic) => traffic.addressed)
				.map((traffic) => `${traffic.message.type}:${traffic.to}`);
		await settle(SILENCE_MS - 1);
		expect(addressed()).toEqual([]);
		await settle(1_000);
		expect(addressed()).toEqual(["resync:2", "resync:3"]);
		await settle(60_000);
		expect(addressed()).toEqual(["resync:2", "resync:3"]);
	});

	it("answers a join and a resync from one seat within 300 ms with one prefs message", async () => {
		table.take("1");
		const player4 = table.take("4");
		player4.mesh.join(AUDIO);
		await settle();
		const before = table.broker.sent.length;
		table.broker.deliver(
			player4.inbox,
			envelope("1", 1, player4, announce("join", session(50))),
		);
		await settle(REPLY_COALESCE_MS / 2);
		table.broker.deliver(
			player4.inbox,
			envelope("1", 1, player4, announce("resync", session(50))),
		);
		await settle();
		expect(
			table.broker.sent
				.slice(before)
				.map((t) => `${t.from}>${t.to}:${t.message.type}`),
		).toEqual(["4>1:prefs"]);
		expect(player4.live("1")).toHaveLength(1);
	});

	it("never shows video for a compact peer, whatever its message says", async () => {
		table.take("1");
		const player4 = table.take("4");
		player4.mesh.join(AUDIO);
		await settle();
		const message = {
			...announce("join", session(50)),
			prefs: BOTH.prefs,
			form: "compact",
		} satisfies CallMessage;
		table.broker.deliver(player4.inbox, envelope("1", 1, player4, message));
		expect(player4.mesh.peer("1")).toEqual({
			prefs: AUDIO.prefs,
			form: "compact",
		});
		expect(player4.live("1")[0]?.remote).toEqual({
			prefs: AUDIO.prefs,
			form: "compact",
		});
	});

	it("Retry restarts the link from the polite side and announces a resync", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		player1.live("2")[0]?.fail();
		player2.live("1")[0]?.fail();
		player2.mesh.retry("1");
		await settle();
		expectConnected(player1, player2);
		expect(player2.live("1")[0]?.offers).toEqual([2]);
		expect(table.broker.count("resync", { from: "2", addressed: false })).toBe(
			1,
		);
	});
});

describe("CallMesh membership and lifecycle", () => {
	it("closes the link when the peer's seat changes generation and ignores the old generation", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		const [oldLink] = player1.live("2");
		const before = table.broker.sent.length;
		table.take("2");
		expect(player1.live("2")).toEqual([]);
		expect(player1.mesh.peer("2")).toBeUndefined();
		expect(player2.mesh.status).toBe("outside");
		expect(player2.live("1")).toEqual([]);
		oldLink?.options.send({ type: "offer", negotiation: 9, sdp: "v=0" });
		table.broker.deliver(
			player1.inbox,
			envelope("2", 1, player1, announce("join", session(50))),
		);
		await settle();
		expect(player1.mesh.peer("2")).toBeUndefined();
		expect(player1.live("2")).toEqual([]);
		expect(table.broker.sent.slice(before)).toEqual([]);
	});

	it("drops a queued message when no snapshot confirms the sender within 3 s", async () => {
		const player1 = table.take("1");
		player1.mesh.join(AUDIO);
		await settle();
		table.broker.drop = (traffic) => traffic.from === "2" && traffic.addressed;
		table.take("2", true).mesh.join(AUDIO);
		await settle(STALE_SNAPSHOT_MS + 500);
		table.publish(player1);
		await settle();
		expect(player1.mesh.peer("2")).toBeUndefined();
		expect(player1.links).toEqual([]);
	});

	it("routes ICE batches only to the link of the current session", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		player2.live("1")[0]?.options.send({
			type: "ice",
			negotiation: 1,
			candidates: [CANDIDATE],
		});
		await settle();
		const link = player1.live("2")[0];
		expect(link?.received.at(-1)).toEqual({
			type: "ice",
			negotiation: 1,
			candidates: [CANDIDATE],
		});
		const received = link?.received.length;
		table.broker.deliver(
			player1.inbox,
			envelope("2", 1, player1, {
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
		const player1 = table.take("1");
		const player2 = table.take("2");
		const player3 = table.take("3");
		for (const player of [player1, player2, player3]) player.mesh.join(AUDIO);
		await settle();
		table.broker.online.delete("2");
		table.broker.online.delete("3");
		table.publish();
		await settle(VANISHED_MS / 2);
		table.broker.online.add("3");
		table.publish();
		await settle(VANISHED_MS / 2 - 1);
		expect(player1.live("2")).toHaveLength(1);
		await settle(1);
		expect(player1.live("2")).toEqual([]);
		expect(player1.mesh.peer("2")).toBeUndefined();
		await settle(VANISHED_MS);
		expectConnected(player1, player3);
	});

	it("forgets a peer that returns within 10 s but does not answer the greeting, as after a reload", async () => {
		const player1 = table.take("1");
		const player3 = table.take("3");
		player1.mesh.join(AUDIO);
		player3.mesh.join(AUDIO);
		await settle();
		// The page reloads: its inbox is gone, and the new page holds the seat again without joining the call.
		table.broker.outage("3");
		table.broker.online.delete("3");
		table.publish(player1);
		await settle(VANISHED_MS / 5);
		table.broker.online.add("3");
		table.publish(player1);
		await settle(SILENCE_MS - 1);
		expect(player1.mesh.peer("3")).toBeDefined();
		await settle(1);
		expect(player1.mesh.peer("3")).toBeUndefined();
		expect(player1.live("3")).toEqual([]);
	});

	it("keeps a returning peer that answers the greeting", async () => {
		const player1 = table.take("1");
		const player3 = table.take("3");
		player1.mesh.join(AUDIO);
		player3.mesh.join(AUDIO);
		await settle();
		table.broker.online.delete("3");
		table.publish(player1);
		await settle(VANISHED_MS / 5);
		table.broker.online.add("3");
		table.publish(player1);
		await settle(SILENCE_MS * 2);
		expect(player1.mesh.peer("3")).toEqual(AUDIO);
		expectConnected(player1, player3);
	});

	it("Leave closes every link and the peers forget the seat", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		player2.mesh.leave();
		expect(player2.mesh.status).toBe("outside");
		expect(player2.live("1")).toEqual([]);
		await settle();
		expect(player1.live("2")).toEqual([]);
		expect(player1.mesh.peer("2")).toBeUndefined();
	});

	it("Join after Leave opens the inbox only after the old one is removed and the farewell is written", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		table.broker.log.length = 0;
		const before = table.broker.sent.length;
		player2.mesh.leave();
		player2.mesh.join(BOTH);
		await settle();
		expect(table.broker.log.filter((entry) => entry.endsWith(" 2"))).toEqual([
			"remove 2",
			"subscribe 2",
		]);
		const fromPlayer2 = table.broker.sent
			.slice(before)
			.filter((traffic) => traffic.from === "2" && !traffic.addressed)
			.map((traffic) => traffic.message.type);
		expect(fromPlayer2.slice(0, 2)).toEqual(["leave", "join"]);
		expectConnected(player1, player2);
		expect(player1.mesh.peer("2")).toEqual(BOTH);
	});

	it("retires the old link when a new session arrives from the same seat after a lost leave", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		table.broker.drop = (traffic) => traffic.message.type === "leave";
		player2.mesh.leave();
		player2.mesh.join(AUDIO);
		await settle();
		expectConnected(player1, player2);
		expect(
			player1.links.filter((link) => link.options.seat === "2"),
		).toHaveLength(2);
	});

	it("ends the call when the database answers superseded", async () => {
		const player1 = table.take("1");
		const player2 = table.take("2");
		player1.mesh.join(AUDIO);
		player2.mesh.join(AUDIO);
		await settle();
		table.broker.holders["2"] = 2;
		player2.mesh.setLocal(BOTH);
		await settle();
		expect(player2.mesh.status).toBe("outside");
		expect(player2.live("1")).toEqual([]);
	});

	it("reports changes until disposed", async () => {
		const player1 = table.take("1");
		const changes = vi.fn();
		player1.mesh.onChange(changes);
		player1.mesh.join(AUDIO);
		await settle();
		expect(changes).toHaveBeenCalled();
		player1.mesh.dispose();
		expect(player1.mesh.status).toBe("outside");
		changes.mockClear();
		table.publish();
		await settle();
		expect(changes).not.toHaveBeenCalled();
	});

	it("throws on caller bugs", () => {
		const player1 = table.take("1");
		const outside = party("out");
		expect(() => player1.mesh.setLocal(AUDIO)).toThrow("not in the call");
		expect(() => player1.mesh.join(outside)).toThrow(
			"join needs in-call preferences",
		);
		player1.mesh.join(AUDIO);
		expect(() => player1.mesh.join(AUDIO)).toThrow("already in the call");
		expect(() => player1.mesh.setLocal(outside)).toThrow("use leave()");
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
