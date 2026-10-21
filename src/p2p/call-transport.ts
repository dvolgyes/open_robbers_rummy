import { inboxTopic } from "../call/messages";
import type {
	CallTransport,
	InboxSubscription,
	OutgoingSignal,
	TransportStatus,
} from "../call/signaling";
import type { Seat } from "../protocol";
import type { Result } from "../result";
import type { Binding, CallFrame } from "./wire";

/**
 * Call signaling over the table mesh (plan §4.8). A call message travels as an `oc-call` frame on the WebRTC data
 * channel to the peer that the roster binds to the addressed seat; no call message touches a tracker. The roster,
 * never the frame, names the sender's seat. `InboxSignaling` keeps its order, flood limit and envelope checks.
 *
 * An inbox never reports `lost`: the data channel has no subscription to lose. When a seat's link drops and comes
 * back, the call mesh greets the returned seat (`returnedSeats`), so recovery works per seat.
 */

export interface CallRoute {
	/** The latest roster bindings that this page knows. */
	bindings(): readonly Binding[];
	/** Peers with an open data channel to this page. */
	connected(): readonly string[];
	/** The seat and generation that this page holds, or null. */
	self(): { readonly seat: Seat; readonly gen: number } | null;
	send(peer: string, frame: CallFrame): void;
}

export interface CallTarget {
	readonly peer: string;
	readonly seat: Seat;
	readonly gen: number;
}

/** The connected peers bound to other seats; `to` keeps only that seat. */
export function callTargets(
	bindings: readonly Binding[],
	connected: readonly string[],
	self: Seat,
	to: Seat | null,
): CallTarget[] {
	const open = new Set(connected);
	return bindings
		.filter(
			(binding) =>
				open.has(binding.peer) &&
				binding.seat !== self &&
				(to === null || binding.seat === to),
		)
		.map(({ peer, seat, gen }) => ({ peer, seat, gen }));
}

export interface InboundCall {
	/** The inbox that the frame addresses. */
	readonly topic: string;
	/** The value that `parseEnvelope` checks. */
	readonly envelope: {
		readonly v: 1;
		readonly roomId: string;
		readonly toGen: number;
		readonly from: Seat;
		readonly fromGen: number;
		readonly message: unknown;
	};
}

/** The envelope of a frame from `peer`, or undefined unless the roster binds that peer at the frame's `fromGen`. */
export function inboundCall(
	tableId: string,
	bindings: readonly Binding[],
	peer: string,
	frame: CallFrame,
): InboundCall | undefined {
	const binding = bindings.find((item) => item.peer === peer);
	if (binding === undefined || binding.gen !== frame.fromGen) return undefined;
	return {
		topic: inboxTopic({
			roomId: tableId,
			seat: frame.to,
			generation: frame.toGen,
		}),
		envelope: {
			v: 1,
			roomId: tableId,
			toGen: frame.toGen,
			from: binding.seat,
			fromGen: frame.fromGen,
			message: frame.msg,
		},
	};
}

interface Inbox {
	readonly onPayload: (raw: unknown) => void;
	readonly onStatus: (status: TransportStatus) => void;
}

export class MeshCallTransport implements CallTransport {
	readonly #tableId: string;
	readonly #route: CallRoute;
	readonly #inboxes = new Map<string, Inbox>();

	constructor(tableId: string, route: CallRoute) {
		this.#tableId = tableId;
		this.#route = route;
	}

	subscribe(topic: string, handlers: Inbox): InboxSubscription {
		const inbox: Inbox = {
			onPayload: handlers.onPayload,
			onStatus: handlers.onStatus,
		};
		this.#inboxes.set(topic, inbox);
		queueMicrotask(() => {
			if (this.#inboxes.get(topic) === inbox) inbox.onStatus("open");
		});
		return {
			remove: async () => {
				if (this.#inboxes.get(topic) === inbox) this.#inboxes.delete(topic);
			},
		};
	}

	/** A sender that no longer holds the seat at this generation gets `superseded`. */
	async send(signal: OutgoingSignal): Promise<Result<number>> {
		const self = this.#route.self();
		if (
			self === null ||
			self.seat !== signal.seat ||
			self.gen !== signal.generation
		) {
			return { ok: false, code: "superseded" };
		}
		const targets = callTargets(
			this.#route.bindings(),
			this.#route.connected(),
			self.seat,
			signal.to,
		);
		for (const target of targets) {
			this.#route.send(target.peer, {
				k: "call",
				to: target.seat,
				toGen: target.gen,
				fromGen: signal.generation,
				msg: signal.message,
			});
		}
		return { ok: true, value: targets.length };
	}

	/** A frame from `peer` reaches the addressed inbox only when the roster binds the peer and this page has it. */
	receive(peer: string, frame: CallFrame): void {
		const inbound = inboundCall(
			this.#tableId,
			this.#route.bindings(),
			peer,
			frame,
		);
		if (inbound === undefined) return;
		this.#inboxes.get(inbound.topic)?.onPayload(inbound.envelope);
	}
}
