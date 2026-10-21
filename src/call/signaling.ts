import { backoffMs } from "../backoff";
import type { Seat } from "../protocol";
import { type Failure, isTransient, type Result } from "../result";
import {
	type CallEnvelope,
	type CallMessage,
	type InboxIdentity,
	inboxTopic,
	parseCallMessage,
	parseEnvelope,
} from "./messages";

/**
 * Call signaling (call/layout plan §4.4): one inbox per seat holder for receiving, and a `CallTransport` for
 * sending. Messages from one client leave in send order, one at a time, so the transport delivers them in that
 * order.
 */

/** The receive cap of the `oc-call` action is the same (src/p2p/limits.ts). */
export const MAX_ENVELOPE_OCTETS = 64 * 1024;
/** At most this many accepted messages per sending seat in any `FLOOD_WINDOW_MS`; the rest are dropped. */
export const FLOOD_LIMIT = 20;
export const FLOOD_WINDOW_MS = 1000;

export type SignalingStatus = "joining" | "subscribed" | "lost";
export type SignalingEnd = "superseded" | "unavailable";

export interface CallSignalingHandlers {
	onStatus(status: SignalingStatus): void;
	onEnvelope(envelope: CallEnvelope): void;
	/** This tab no longer holds the seat, or the room is gone: the call ends here. */
	onEnd(reason: SignalingEnd): void;
	/** A message was refused and dropped (for example `invalid`); signaling continues. */
	onProblem(failure: Failure): void;
}

export interface CallSignaling {
	/** `to` null sends to every other current holder; offers, answers and ICE batches name one seat. */
	send(to: Seat | null, message: CallMessage): void;
	/** Stops sending and receiving; the optional farewell gets one send attempt after the request in flight. */
	close(farewell?: CallMessage): Promise<void>;
}

export type OpenCallSignaling = (
	inbox: InboxIdentity,
	handlers: CallSignalingHandlers,
) => CallSignaling;

export interface OutgoingSignal extends InboxIdentity {
	readonly to: Seat | null;
	readonly message: CallMessage;
}

export interface InboxSubscription {
	remove(): Promise<void>;
}

/** `open`: the inbox receives. `lost`: it stopped; signaling removes it and subscribes again after a delay. */
export type TransportStatus = "open" | "lost";

/** The two network operations that signaling needs; the P2P adapter (src/p2p/call-transport.ts) implements it. */
export interface CallTransport {
	subscribe(
		topic: string,
		handlers: {
			onPayload(raw: unknown): void;
			onStatus(status: TransportStatus): void;
		},
	): InboxSubscription;
	/** Resolves with the number of inboxes written. */
	send(signal: OutgoingSignal): Promise<Result<number>>;
}

interface Outgoing {
	readonly to: Seat | null;
	readonly message: CallMessage;
}

const NAMED_TARGET: ReadonlySet<CallMessage["type"]> = new Set([
	"offer",
	"answer",
	"ice",
]);

function octets(value: unknown): number {
	const text = JSON.stringify(value);
	return text === undefined ? 0 : new TextEncoder().encode(text).length;
}

class InboxSignaling implements CallSignaling {
	readonly #transport: CallTransport;
	readonly #inbox: InboxIdentity;
	readonly #handlers: CallSignalingHandlers;
	readonly #topic: string;
	#closed = false;
	#queue: Outgoing[] = [];
	#inFlight: Promise<void> | undefined;
	#sendFailures = 0;
	#sendTimer: ReturnType<typeof setTimeout> | undefined;
	/** Increments for each subscription; callbacks of a removed subscription carry an old value. */
	#attempt = 0;
	#subscription: InboxSubscription | undefined;
	#subscribeFailures = 0;
	#subscribeTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #accepted = new Map<Seat, number[]>();

	constructor(
		transport: CallTransport,
		inbox: InboxIdentity,
		handlers: CallSignalingHandlers,
	) {
		this.#transport = transport;
		this.#inbox = inbox;
		this.#handlers = handlers;
		this.#topic = inboxTopic(inbox);
		this.#subscribe();
	}

	send(to: Seat | null, message: CallMessage): void {
		this.#check(to, message);
		if (this.#closed) return;
		if (message.type === "prefs") {
			const index = this.#queue.findIndex(
				(item) => item.message.type === "prefs" && item.to === to,
			);
			if (index >= 0) {
				this.#queue[index] = { to, message };
				return;
			}
		}
		this.#queue.push({ to, message });
		this.#pump();
	}

	async close(farewell?: CallMessage): Promise<void> {
		if (farewell !== undefined) this.#check(null, farewell);
		if (this.#closed) return;
		const pending = this.#inFlight;
		const removal = this.#stop();
		const parting =
			farewell &&
			(async () => {
				await pending;
				await this.#transport.send({
					...this.#inbox,
					to: null,
					message: farewell,
				});
			})();
		await Promise.all([removal, parting]);
	}

	/** An invalid outgoing message is a bug in the caller, not a network condition. */
	#check(to: Seat | null, message: CallMessage): void {
		if (parseCallMessage(message) === undefined) {
			throw new Error(`invalid outgoing call message: ${message.type}`);
		}
		if (to === this.#inbox.seat) {
			throw new Error("a call message cannot address its sender");
		}
		if (to === null && NAMED_TARGET.has(message.type)) {
			throw new Error(`a ${message.type} message must name its target`);
		}
	}

	#stop(): Promise<void> | undefined {
		this.#closed = true;
		this.#queue = [];
		clearTimeout(this.#sendTimer);
		clearTimeout(this.#subscribeTimer);
		this.#attempt++;
		const subscription = this.#subscription;
		this.#subscription = undefined;
		return subscription?.remove();
	}

	#pump(): void {
		if (this.#closed || this.#inFlight || this.#sendTimer) return;
		const next = this.#queue.shift();
		if (next === undefined) return;
		this.#inFlight = this.#transport
			.send({ ...this.#inbox, to: next.to, message: next.message })
			.then((result) => this.#sent(next, result));
	}

	#sent(item: Outgoing, result: Result<number>): void {
		this.#inFlight = undefined;
		if (this.#closed) return;
		if (result.ok) {
			this.#sendFailures = 0;
		} else if (result.code === "superseded" || result.code === "unavailable") {
			void this.#stop();
			this.#handlers.onEnd(result.code);
			return;
		} else if (isTransient(result)) {
			const replaced =
				item.message.type === "prefs" &&
				this.#queue.some(
					(queued) => queued.message.type === "prefs" && queued.to === item.to,
				);
			if (!replaced) this.#queue.unshift(item);
			this.#sendTimer = setTimeout(
				() => {
					this.#sendTimer = undefined;
					this.#pump();
				},
				backoffMs(this.#sendFailures++),
			);
			return;
		} else {
			this.#handlers.onProblem(result);
		}
		this.#pump();
	}

	#subscribe(): void {
		const attempt = ++this.#attempt;
		this.#handlers.onStatus("joining");
		this.#subscription = this.#transport.subscribe(this.#topic, {
			onPayload: (raw) => {
				if (attempt === this.#attempt) this.#receive(raw);
			},
			onStatus: (status) => {
				if (attempt === this.#attempt) this.#status(status);
			},
		});
	}

	/** A lost inbox is removed; a new subscription starts after the removal and a backoff delay. */
	#status(status: TransportStatus): void {
		if (status === "open") {
			this.#subscribeFailures = 0;
			this.#handlers.onStatus("subscribed");
			return;
		}
		this.#attempt++;
		const subscription = this.#subscription;
		this.#subscription = undefined;
		const delay = backoffMs(this.#subscribeFailures++);
		this.#handlers.onStatus("lost");
		void (async () => {
			await subscription?.remove();
			if (this.#closed) return;
			this.#subscribeTimer = setTimeout(() => {
				this.#subscribeTimer = undefined;
				if (!this.#closed) this.#subscribe();
			}, delay);
		})();
	}

	#receive(raw: unknown): void {
		if (octets(raw) > MAX_ENVELOPE_OCTETS) return;
		const envelope = parseEnvelope(raw, this.#inbox);
		if (envelope === undefined || !this.#admit(envelope.from)) return;
		this.#handlers.onEnvelope(envelope);
	}

	/** Only accepted messages count, so a flood from one seat cannot shut out the others. */
	#admit(from: Seat): boolean {
		const now = Date.now();
		const recent = (this.#accepted.get(from) ?? []).filter(
			(time) => now - time < FLOOD_WINDOW_MS,
		);
		const admitted = recent.length < FLOOD_LIMIT;
		if (admitted) recent.push(now);
		this.#accepted.set(from, recent);
		return admitted;
	}
}

export function createCallSignaling(
	transport: CallTransport,
	inbox: InboxIdentity,
	handlers: CallSignalingHandlers,
): CallSignaling {
	return new InboxSignaling(transport, inbox, handlers);
}
