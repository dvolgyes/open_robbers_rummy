import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallMessage, InboxIdentity } from "../../src/call/messages";
import {
	type CallSignaling,
	type CallSignalingHandlers,
	type CallTransport,
	createCallSignaling,
	FLOOD_LIMIT,
	FLOOD_WINDOW_MS,
	type OutgoingSignal,
	type TransportStatus,
} from "../../src/call/signaling";
import type { Seat } from "../../src/protocol";
import type { Result } from "../../src/result";
import { ROOM_ID } from "./fixtures";

const INBOX: InboxIdentity = { roomId: ROOM_ID, seat: "N", generation: 3 };
const SESSION = "0f8e2c1a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const OTHER_SESSION = "11111111-2222-4333-8444-555555555555";
const PREFS = {
	inCall: true,
	send: { audio: true, video: false },
	receive: { audio: true, video: false },
};

function announce(
	type: "join" | "resync" | "prefs",
	prefVersion = 0,
): CallMessage {
	return { type, session: SESSION, prefs: PREFS, prefVersion, form: "desktop" };
}

const OFFER: CallMessage = {
	type: "offer",
	session: SESSION,
	toSession: OTHER_SESSION,
	negotiation: 1,
	sdp: "v=0",
	prefs: PREFS,
	prefVersion: 0,
	form: "desktop",
};
const LEAVE: CallMessage = { type: "leave", session: SESSION };

const OK: Result<number> = { ok: true, value: 1 };

interface FakeSubscription {
	readonly topic: string;
	readonly onPayload: (raw: unknown) => void;
	readonly onStatus: (status: TransportStatus) => void;
	removed: boolean;
}

interface PendingSend {
	readonly signal: OutgoingSignal;
	readonly resolve: (result: Result<number>) => void;
}

class FakeTransport implements CallTransport {
	readonly subscriptions: FakeSubscription[] = [];
	readonly sends: PendingSend[] = [];
	readonly log: string[] = [];

	subscribe(
		topic: string,
		handlers: {
			onPayload(raw: unknown): void;
			onStatus(status: TransportStatus): void;
		},
	) {
		const subscription: FakeSubscription = {
			topic,
			onPayload: handlers.onPayload,
			onStatus: handlers.onStatus,
			removed: false,
		};
		const index = this.subscriptions.push(subscription) - 1;
		this.log.push(`subscribe ${index}`);
		return {
			remove: async () => {
				subscription.removed = true;
				this.log.push(`remove ${index}`);
			},
		};
	}

	send(signal: OutgoingSignal): Promise<Result<number>> {
		return new Promise((resolve) => this.sends.push({ signal, resolve }));
	}

	get current(): FakeSubscription {
		const subscription = this.subscriptions.at(-1);
		if (subscription === undefined) throw new Error("no subscription");
		return subscription;
	}

	/** Resolves the oldest unanswered send and lets the queue continue. */
	async answer(result: Result<number> = OK): Promise<OutgoingSignal> {
		const pending = this.sends.shift();
		if (pending === undefined) throw new Error("no send in flight");
		pending.resolve(result);
		await vi.advanceTimersByTimeAsync(0);
		return pending.signal;
	}
}

function recorder() {
	return {
		statuses: [] as string[],
		envelopes: [] as unknown[],
		ends: [] as string[],
		problems: [] as string[],
	};
}

function open(transport: FakeTransport, record = recorder()) {
	const handlers: CallSignalingHandlers = {
		onStatus: (status) => record.statuses.push(status),
		onEnvelope: (envelope) => record.envelopes.push(envelope),
		onEnd: (reason) => record.ends.push(reason),
		onProblem: (failure) => record.problems.push(failure.code),
	};
	return { signaling: createCallSignaling(transport, INBOX, handlers), record };
}

function envelope(from: Seat, extra: Record<string, unknown> = {}) {
	return {
		v: 1,
		roomId: ROOM_ID,
		from,
		fromGen: 1,
		toGen: INBOX.generation,
		id: "a0000000-0000-4000-8000-000000000000",
		message: announce("join"),
		...extra,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("call signaling: sending", () => {
	let transport: FakeTransport;
	let signaling: CallSignaling;
	let record: ReturnType<typeof recorder>;

	beforeEach(() => {
		transport = new FakeTransport();
		({ signaling, record } = open(transport));
	});

	it("sends in call order with one request in flight", async () => {
		signaling.send(null, announce("join"));
		signaling.send("E", OFFER);
		signaling.send(null, LEAVE);
		expect(transport.sends).toHaveLength(1);
		expect(transport.sends[0]?.signal).toEqual({
			...INBOX,
			to: null,
			message: announce("join"),
		});
		expect((await transport.answer()).message.type).toBe("join");
		expect(transport.sends).toHaveLength(1);
		expect((await transport.answer()).to).toBe("E");
		expect((await transport.answer()).message.type).toBe("leave");
		expect(transport.sends).toHaveLength(0);
	});

	it("replaces a queued prefs to the same target in place", async () => {
		signaling.send(null, announce("prefs", 1));
		signaling.send(null, announce("prefs", 2));
		signaling.send("E", announce("prefs", 3));
		signaling.send(null, announce("resync", 4));
		signaling.send(null, announce("prefs", 5));
		signaling.send("E", announce("prefs", 6));
		const sent: string[] = [];
		while (transport.sends.length > 0) {
			const signal = await transport.answer();
			const version =
				"prefVersion" in signal.message ? signal.message.prefVersion : -1;
			sent.push(`${signal.message.type}:${signal.to ?? "all"}:${version}`);
		}
		// Version 1 was already in flight when version 2 arrived, so it is not replaced.
		expect(sent).toEqual([
			"prefs:all:1",
			"prefs:all:5",
			"prefs:E:6",
			"resync:all:4",
		]);
	});

	it("retries a transient failure first, with backoff, then continues in order", async () => {
		signaling.send(null, announce("join"));
		signaling.send("E", OFFER);
		await transport.answer({ ok: false, code: "network" });
		await vi.advanceTimersByTimeAsync(999);
		expect(transport.sends).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.sends[0]?.signal.message.type).toBe("join");
		await transport.answer({ ok: false, code: "server" });
		await vi.advanceTimersByTimeAsync(1999);
		expect(transport.sends).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect((await transport.answer()).message.type).toBe("join");
		expect((await transport.answer()).message.type).toBe("offer");
	});

	it("drops a failed prefs when a newer prefs to the same target waits", async () => {
		signaling.send(null, announce("prefs", 1));
		signaling.send(null, announce("prefs", 2));
		await transport.answer({ ok: false, code: "rate_limited" });
		await vi.advanceTimersByTimeAsync(1000);
		const signal = await transport.answer();
		expect(signal.message).toEqual(announce("prefs", 2));
		expect(transport.sends).toHaveLength(0);
	});

	it("reports a refused message and continues with the next", async () => {
		signaling.send(null, announce("join"));
		signaling.send(null, LEAVE);
		await transport.answer({ ok: false, code: "invalid" });
		expect(record.problems).toEqual(["invalid"]);
		expect((await transport.answer()).message.type).toBe("leave");
	});

	it("refuses an invalid outgoing message as a caller bug", () => {
		expect(() =>
			signaling.send(null, { ...announce("join"), form: "tablet" } as never),
		).toThrow("invalid outgoing call message");
		expect(() => signaling.send("N", announce("join"))).toThrow(
			"cannot address its sender",
		);
		expect(() => signaling.send(null, OFFER)).toThrow("must name its target");
		expect(transport.sends).toHaveLength(0);
	});
});

describe("call signaling: end of the seat", () => {
	it.each(["superseded", "unavailable"] as const)(
		"%s ends signaling, drops the queue and removes the inbox",
		async (code) => {
			const transport = new FakeTransport();
			const { signaling, record } = open(transport);
			signaling.send(null, announce("join"));
			signaling.send("E", OFFER);
			await transport.answer({ ok: false, code });
			expect(record.ends).toEqual([code]);
			expect(transport.current.removed).toBe(true);
			signaling.send(null, LEAVE);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(transport.sends).toHaveLength(0);
			await signaling.close(LEAVE);
			expect(transport.sends).toHaveLength(0);
		},
	);
});

describe("call signaling: close", () => {
	it("sends the farewell once, after the request in flight", async () => {
		const transport = new FakeTransport();
		const { signaling } = open(transport);
		signaling.send(null, announce("join"));
		signaling.send("E", OFFER);
		const closed = signaling.close(LEAVE);
		expect(transport.current.removed).toBe(true);
		expect(transport.sends).toHaveLength(1);
		await transport.answer();
		expect(transport.sends.map((s) => s.signal.message.type)).toEqual([
			"leave",
		]);
		await transport.answer({ ok: false, code: "network" });
		await closed;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(transport.sends).toHaveLength(0);
	});

	it("sends nothing without a farewell and ignores later calls", async () => {
		const transport = new FakeTransport();
		const { signaling, record } = open(transport);
		await signaling.close();
		signaling.send(null, announce("join"));
		transport.current.onStatus("lost");
		transport.current.onPayload(envelope("E"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(transport.sends).toHaveLength(0);
		expect(transport.subscriptions).toHaveLength(1);
		expect(record.envelopes).toHaveLength(0);
	});
});

describe("call signaling: receiving", () => {
	it("subscribes to its own inbox and delivers valid envelopes", () => {
		const transport = new FakeTransport();
		const { record } = open(transport);
		expect(transport.current.topic).toBe(`call:${ROOM_ID}:N:3`);
		expect(record.statuses).toEqual(["joining"]);
		transport.current.onStatus("open");
		expect(record.statuses).toEqual(["joining", "subscribed"]);
		transport.current.onPayload(envelope("E"));
		expect(record.envelopes).toEqual([
			{ from: "E", fromGen: 1, message: announce("join") },
		]);
	});

	it("ignores malformed, misaddressed and oversized envelopes", () => {
		const transport = new FakeTransport();
		const { record } = open(transport);
		transport.current.onPayload(envelope("E", { toGen: 2 }));
		transport.current.onPayload(envelope("N"));
		transport.current.onPayload(envelope("E", { message: { type: "join" } }));
		transport.current.onPayload(
			envelope("E", { padding: "x".repeat(64 * 1024) }),
		);
		transport.current.onPayload("not an envelope");
		expect(record.envelopes).toHaveLength(0);
	});

	it("accepts at most FLOOD_LIMIT messages per seat in a window", async () => {
		const transport = new FakeTransport();
		const { record } = open(transport);
		for (let i = 0; i <= FLOOD_LIMIT; i++) {
			transport.current.onPayload(envelope("E"));
		}
		expect(record.envelopes).toHaveLength(FLOOD_LIMIT);
		transport.current.onPayload(envelope("S"));
		expect(record.envelopes).toHaveLength(FLOOD_LIMIT + 1);
		await vi.advanceTimersByTimeAsync(FLOOD_WINDOW_MS - 1);
		transport.current.onPayload(envelope("E"));
		expect(record.envelopes).toHaveLength(FLOOD_LIMIT + 1);
		await vi.advanceTimersByTimeAsync(1);
		transport.current.onPayload(envelope("E"));
		expect(record.envelopes).toHaveLength(FLOOD_LIMIT + 2);
	});
});

describe("call signaling: reconnect", () => {
	it("removes a failed inbox before it subscribes again with backoff", async () => {
		const transport = new FakeTransport();
		const { record } = open(transport);
		transport.current.onStatus("open");
		const first = transport.current;
		first.onStatus("lost");
		expect(record.statuses.at(-1)).toBe("lost");
		// A transport may report `lost` twice; the repeat during the removal must not start a second inbox.
		first.onStatus("lost");
		first.onPayload(envelope("E"));
		expect(record.statuses.filter((s) => s === "lost")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(transport.subscriptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.log).toEqual(["subscribe 0", "remove 0", "subscribe 1"]);
		expect(record.statuses.at(-1)).toBe("joining");

		// The removed channel's late callbacks change nothing.
		first.onStatus("lost");
		first.onPayload(envelope("E"));
		expect(record.envelopes).toHaveLength(0);
		expect(record.statuses.at(-1)).toBe("joining");

		transport.current.onStatus("lost");
		await vi.advanceTimersByTimeAsync(1999);
		expect(transport.subscriptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.subscriptions).toHaveLength(3);
		transport.current.onStatus("open");
		transport.current.onStatus("lost");
		await vi.advanceTimersByTimeAsync(1000);
		expect(transport.subscriptions).toHaveLength(4);
		expect(transport.subscriptions.slice(0, 3).every((s) => s.removed)).toBe(
			true,
		);
	});

	it("keeps sending while the inbox reconnects", async () => {
		const transport = new FakeTransport();
		const { signaling } = open(transport);
		transport.current.onStatus("lost");
		signaling.send(null, announce("resync"));
		expect((await transport.answer()).message.type).toBe("resync");
	});
});
