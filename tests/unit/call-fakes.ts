import type { Form } from "../../src/call/device-class";
import type { CallLink, LinkOptions, LinkSignal } from "../../src/call/mesh";
import {
	join,
	type Party,
	type PresetId,
	presetById,
} from "../../src/call/policy";

export function party(preset: PresetId, form: Form = "desktop"): Party {
	return { prefs: join(presetById(preset).switches, form), form };
}

export const AUDIO = party("audio");
export const BOTH = party("both");

/** A valid call session ID that shows its order: `session(1)` is the first. */
export function session(n: number): string {
	return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Stands in for `peer.ts`: the impolite side offers when created and on an ICE restart; an offer is answered. */
export class FakeLink implements CallLink {
	connected = false;
	closed = false;
	local: Party;
	remote: Party;
	/** The negotiation of each offer this side made. */
	readonly offers: number[] = [];
	readonly received: LinkSignal[] = [];
	#negotiation = 0;

	constructor(readonly options: LinkOptions) {
		this.local = options.local;
		this.remote = options.remote;
		if (!options.polite) this.#offer();
	}

	update(local: Party, remote: Party): void {
		this.local = local;
		this.remote = remote;
	}

	receive(signal: LinkSignal): void {
		this.received.push(signal);
		if (signal.type === "offer") {
			this.#negotiation = signal.negotiation;
			this.options.send({
				type: "answer",
				negotiation: signal.negotiation,
				sdp: "v=0",
			});
			this.#connect();
		} else if (
			signal.type === "answer" &&
			signal.negotiation === this.#negotiation
		) {
			this.#connect();
		}
	}

	restartIce(): void {
		this.connected = false;
		this.#offer();
	}

	close(): void {
		this.closed = true;
		this.connected = false;
	}

	/** ICE failed on this side. */
	fail(): void {
		this.connected = false;
		this.options.onState();
	}

	#offer(): void {
		this.#negotiation++;
		this.offers.push(this.#negotiation);
		this.options.send({
			type: "offer",
			negotiation: this.#negotiation,
			sdp: "v=0",
		});
	}

	#connect(): void {
		this.connected = true;
		this.options.onState();
	}
}
