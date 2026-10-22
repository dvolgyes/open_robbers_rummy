import { SEATS, type Seat } from "../protocol";
import type { FailureCode } from "../result";
import type {
	AnnounceMessage,
	Announcement,
	CallEnvelope,
	CallMessage,
	IceCandidate,
	InboxIdentity,
} from "./messages";
import { type Party, restrict } from "./policy";
import type {
	CallSignaling,
	OpenCallSignaling,
	SignalingStatus,
} from "./signaling";

/**
 * Peer discovery and link lifecycle for one seat holder (call/layout plan §4.1, §4.4). The mesh knows which seats
 * are in the call, with which session and preferences, and keeps at most one link per remote seat. It knows
 * nothing about WebRTC: the link factory (`peer.ts`) negotiates media; the mesh only routes its signals.
 */

/** Replies to `join` and `resync` from one seat within this delay go out as one `prefs` message. */
export const REPLY_COALESCE_MS = 300;
/** A seat that is silent this long after an announcement gets one addressed `resync` (the C2 P9 maximum). */
export const SILENCE_MS = 3000;
/** A message from a holder that the snapshot does not show yet waits this long for the next snapshot. */
export const STALE_SNAPSHOT_MS = 3000;
/** A peer that is offline at its current generation this long is out of the call. */
export const VANISHED_MS = 10_000;

/** What the room tells the call, on every change (plan §4.1). */
export interface CallRoomSnapshot {
	readonly roomId: string;
	/** Null when this tab is superseded, the room expired, or the room stopped. */
	readonly self: { readonly seat: Seat; readonly generation: number } | null;
	/** Seats with a holder → the holder's current generation. */
	readonly holders: Partial<Record<Seat, number>>;
	/** Seats whose current holder is present in the room channel. */
	readonly online: ReadonlySet<Seat>;
}

export type LinkSignal =
	| {
			readonly type: "offer" | "answer";
			readonly negotiation: number;
			readonly sdp: string;
	  }
	| {
			readonly type: "ice";
			readonly negotiation: number;
			readonly candidates: readonly IceCandidate[];
	  };

/** One media connection to one remote seat (implemented by `peer.ts`). */
export interface CallLink {
	readonly connected: boolean;
	update(local: Party, remote: Party): void;
	receive(signal: LinkSignal): void;
	/** A new negotiation with an ICE restart, offered by this side. */
	restartIce(): void;
	close(): void;
}

export interface LinkOptions {
	readonly seat: Seat;
	/** The seat later in N, E, S, W order is polite; the impolite side makes the first offer. */
	readonly polite: boolean;
	readonly local: Party;
	readonly remote: Party;
	send(signal: LinkSignal): void;
	onState(): void;
}

export interface CallMeshDeps {
	readonly openSignaling: OpenCallSignaling;
	readonly createLink: (options: LinkOptions) => CallLink;
	/** A new call session ID (`crypto.randomUUID()`). */
	readonly newSession: () => string;
}

export type MeshStatus = "outside" | SignalingStatus;

interface Peer {
	readonly seat: Seat;
	readonly generation: number;
	readonly session: string;
	prefVersion: number;
	remote: Party;
	link: CallLink | undefined;
	/** Identifies the current link, so a closed link's late signals are dropped. */
	linkToken: number;
}

interface Joined {
	readonly session: string;
	signaling: CallSignaling | undefined;
	status: SignalingStatus;
	announced: boolean;
}

interface Waiting {
	readonly envelope: CallEnvelope;
	readonly timer: ReturnType<typeof setTimeout>;
}

function remoteParty(announcement: Announcement): Party {
	const { prefs, form } = announcement;
	return { prefs: { inCall: prefs.inCall, ...restrict(prefs, form) }, form };
}

/** Other held seats that are online in `next` but were not in `previous` (none before a first snapshot). */
export function returnedSeats(
	previous: CallRoomSnapshot | undefined,
	next: CallRoomSnapshot,
	self: Seat,
): Seat[] {
	if (previous === undefined) return [];
	return SEATS.filter(
		(seat) =>
			seat !== self &&
			next.holders[seat] !== undefined &&
			next.online.has(seat) &&
			!previous.online.has(seat),
	);
}

export class CallMesh {
	readonly #deps: CallMeshDeps;
	readonly #listeners = new Set<() => void>();
	#snapshot: CallRoomSnapshot | undefined;
	/** Set from Join to Leave. */
	#local: Party | undefined;
	#self: InboxIdentity | undefined;
	#prefVersion = 0;
	#joined: Joined | undefined;
	/** The previous inbox must be gone before a new one opens: both have the same topic. */
	#closing: Promise<void> = Promise.resolve();
	#opening = 0;
	#linkTokens = 0;
	readonly #peers = new Map<Seat, Peer>();
	#waiting: Waiting[] = [];
	readonly #replies = new Map<Seat, ReturnType<typeof setTimeout>>();
	readonly #vanishing = new Map<Seat, ReturnType<typeof setTimeout>>();
	/** Returned peers that have not answered their greeting yet. */
	readonly #greeted = new Map<Seat, ReturnType<typeof setTimeout>>();
	#silence: ReturnType<typeof setTimeout> | undefined;
	#heard = new Set<Seat>();
	#problem: FailureCode | undefined;

	constructor(deps: CallMeshDeps) {
		this.#deps = deps;
	}

	get status(): MeshStatus {
		if (this.#local === undefined) return "outside";
		return this.#joined?.status ?? "joining";
	}

	/** The last refused signaling message, for the call panel. */
	get problem(): FailureCode | undefined {
		return this.#problem;
	}

	/** The seat's last valid announcement while it is in this call; video is already off for compact devices. */
	peer(seat: Seat): Party | undefined {
		return this.#peers.get(seat)?.remote;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	update(snapshot: CallRoomSnapshot): void {
		const previous = this.#snapshot;
		this.#snapshot = snapshot;
		const self = this.#self;
		if (
			self !== undefined &&
			(snapshot.self === null ||
				snapshot.roomId !== self.roomId ||
				snapshot.self.seat !== self.seat ||
				snapshot.self.generation !== self.generation)
		) {
			this.leave();
		}
		for (const peer of [...this.#peers.values()]) {
			if (snapshot.holders[peer.seat] !== peer.generation) {
				this.#forget(peer.seat);
			}
		}
		this.#watchVanished();
		this.#recheckWaiting();
		this.#greetReturned(previous, snapshot);
		this.#emit();
	}

	/** The local user confirmed Join; the inbox opens and `join` goes out once it is subscribed. */
	join(local: Party): void {
		const snapshot = this.#snapshot;
		if (snapshot?.self == null)
			throw new Error("a call join needs a held seat");
		if (this.#local !== undefined) throw new Error("already in the call");
		if (!local.prefs.inCall) throw new Error("join needs in-call preferences");
		this.#local = local;
		this.#prefVersion = 0;
		this.#problem = undefined;
		this.#self = { roomId: snapshot.roomId, ...snapshot.self };
		const token = ++this.#opening;
		// A failed removal still reports its error; the new inbox opens anyway.
		void this.#closing.finally(() => {
			if (token === this.#opening) this.#open();
		});
		this.#emit();
	}

	/** A local switch or device-class change while in the call. */
	setLocal(local: Party): void {
		if (this.#local === undefined) throw new Error("not in the call");
		if (!local.prefs.inCall) throw new Error("use leave() to end the call");
		this.#local = local;
		this.#prefVersion++;
		const joined = this.#joined;
		// Before the first announcement the `join` carries the latest preferences.
		if (joined?.announced) {
			joined.signaling?.send(null, this.#message("prefs", joined.session));
		}
		for (const peer of this.#peers.values()) this.#ensureLink(peer);
		this.#emit();
	}

	/** The user asks to reconnect after a failed link: announce again, and restart this link from either side. */
	retry(seat: Seat): void {
		if (!this.#joined?.announced) return;
		const peer = this.#peers.get(seat);
		if (peer?.link !== undefined && !this.#impolite(seat)) {
			peer.link.restartIce();
		}
		this.#announce("resync", null);
	}

	/** Leaves the call: closes every link and the inbox, after one attempt to tell the peers. */
	leave(): void {
		if (this.#local === undefined) return;
		const joined = this.#joined;
		this.#teardown();
		const signaling = joined?.signaling;
		if (joined !== undefined && signaling !== undefined) {
			this.#closing = signaling.close({
				type: "leave",
				session: joined.session,
			});
		}
		this.#emit();
	}

	/** The room view is gone: leave the call and stop notifying. */
	dispose(): void {
		this.leave();
		this.#listeners.clear();
	}

	#open(): void {
		const self = this.#self;
		if (self === undefined) return;
		const joined: Joined = {
			session: this.#deps.newSession(),
			signaling: undefined,
			status: "joining",
			announced: false,
		};
		this.#joined = joined;
		joined.signaling = this.#deps.openSignaling(self, {
			onStatus: (status) => {
				if (this.#joined === joined) this.#onStatus(joined, status);
			},
			onEnvelope: (envelope) => {
				if (this.#joined === joined) this.#onEnvelope(envelope);
			},
			onEnd: () => {
				if (this.#joined !== joined) return;
				this.#teardown();
				this.#emit();
			},
			onProblem: (failure) => {
				if (this.#joined !== joined) return;
				this.#problem = failure.code;
				this.#emit();
			},
		});
	}

	#teardown(): void {
		this.#local = undefined;
		this.#self = undefined;
		this.#joined = undefined;
		this.#opening++;
		for (const seat of [...this.#peers.keys()]) this.#forget(seat);
		for (const waiting of this.#waiting) clearTimeout(waiting.timer);
		this.#waiting = [];
		for (const timer of this.#replies.values()) clearTimeout(timer);
		this.#replies.clear();
		clearTimeout(this.#silence);
		this.#silence = undefined;
	}

	#onStatus(joined: Joined, status: SignalingStatus): void {
		joined.status = status;
		if (status === "subscribed") {
			// Messages sent to this inbox while it was down are lost, so a later subscription re-announces.
			this.#announce(joined.announced ? "resync" : "join", null);
			joined.announced = true;
		}
		this.#emit();
	}

	#message(type: AnnounceMessage["type"], session: string): AnnounceMessage {
		return { type, session, ...this.#announcement() };
	}

	#announcement(): Announcement {
		const local = this.#local;
		if (local === undefined) throw new Error("not in the call");
		return {
			prefs: local.prefs,
			prefVersion: this.#prefVersion,
			form: local.form,
		};
	}

	#announce(type: "join" | "resync", to: Seat | null): void {
		const joined = this.#joined;
		if (joined?.signaling === undefined) return;
		joined.signaling.send(to, this.#message(type, joined.session));
		if (type === "resync") {
			for (const peer of this.#peers.values()) {
				if (to === null || peer.seat === to) this.#restartIfStuck(peer);
			}
		}
		if (to === null) this.#startSilenceCheck();
	}

	/** The impolite side of a link that is not connected offers again with an ICE restart. */
	#restartIfStuck(peer: Peer): void {
		if (
			peer.link !== undefined &&
			!peer.link.connected &&
			this.#impolite(peer.seat)
		) {
			peer.link.restartIce();
		}
	}

	/**
	 * A seat that comes back online may have missed every message meanwhile, for example after a network change:
	 * one addressed `resync`, which also restarts a stuck link from the impolite side. A known peer that does not
	 * answer it within `SILENCE_MS` left the call meanwhile, for example by a reload that kept its seat, so it is
	 * forgotten: its old link would only show a failed connection.
	 */
	#greetReturned(
		previous: CallRoomSnapshot | undefined,
		snapshot: CallRoomSnapshot,
	): void {
		const self = this.#self;
		if (self === undefined || !this.#joined?.announced) return;
		for (const seat of returnedSeats(previous, snapshot, self.seat)) {
			this.#announce("resync", seat);
			this.#awaitAnswer(seat);
		}
	}

	#awaitAnswer(seat: Seat): void {
		const peer = this.#peers.get(seat);
		if (peer === undefined) return;
		clearTimeout(this.#greeted.get(seat));
		this.#greeted.set(
			seat,
			setTimeout(() => {
				this.#greeted.delete(seat);
				if (this.#peers.get(seat) !== peer) return;
				this.#forget(seat);
				this.#emit();
			}, SILENCE_MS),
		);
	}

	/** A send can be lost silently: one addressed `resync` per seat that stays silent, never more. */
	#startSilenceCheck(): void {
		clearTimeout(this.#silence);
		this.#heard = new Set();
		this.#silence = setTimeout(() => {
			this.#silence = undefined;
			const snapshot = this.#snapshot;
			const self = this.#self;
			if (snapshot === undefined || self === undefined) return;
			for (const seat of SEATS) {
				if (
					seat !== self.seat &&
					snapshot.holders[seat] !== undefined &&
					snapshot.online.has(seat) &&
					!this.#heard.has(seat)
				) {
					this.#announce("resync", seat);
				}
			}
		}, SILENCE_MS);
	}

	/** Membership invariant (plan §4.1): only a current holder at the sending generation is heard. */
	#onEnvelope(envelope: CallEnvelope): void {
		const holder = this.#snapshot?.holders[envelope.from];
		if (holder === envelope.fromGen) {
			this.#accept(envelope);
			return;
		}
		if (holder !== undefined && holder > envelope.fromGen) return;
		const waiting: Waiting = {
			envelope,
			timer: setTimeout(() => {
				this.#waiting = this.#waiting.filter((item) => item !== waiting);
			}, STALE_SNAPSHOT_MS),
		};
		this.#waiting.push(waiting);
	}

	#recheckWaiting(): void {
		const holders = this.#snapshot?.holders ?? {};
		const waiting = this.#waiting;
		this.#waiting = [];
		for (const item of waiting) {
			const holder = holders[item.envelope.from];
			if (holder === item.envelope.fromGen) {
				clearTimeout(item.timer);
				this.#accept(item.envelope);
			} else if (holder !== undefined && holder > item.envelope.fromGen) {
				clearTimeout(item.timer);
			} else {
				this.#waiting.push(item);
			}
		}
	}

	#accept(envelope: CallEnvelope): void {
		const joined = this.#joined;
		if (joined === undefined) return;
		const { from, fromGen, message } = envelope;
		this.#heard.add(from);
		clearTimeout(this.#greeted.get(from));
		this.#greeted.delete(from);
		const known = this.#peers.get(from);
		const current = known?.session === message.session ? known : undefined;
		switch (message.type) {
			case "join":
			case "resync":
				if (current === undefined) {
					this.#introduce(from, fromGen, message);
				} else {
					this.#refresh(current, message);
					this.#restartIfStuck(current);
				}
				this.#reply(from);
				break;
			case "prefs":
				if (current === undefined) this.#introduce(from, fromGen, message);
				else this.#refresh(current, message);
				break;
			case "offer": {
				if (message.toSession !== joined.session) return;
				const peer = current ?? this.#introduce(from, fromGen, message);
				this.#refresh(peer, message);
				peer.link?.receive({
					type: "offer",
					negotiation: message.negotiation,
					sdp: message.sdp,
				});
				break;
			}
			case "answer":
				if (message.toSession !== joined.session || current === undefined) {
					return;
				}
				this.#refresh(current, message);
				current.link?.receive({
					type: "answer",
					negotiation: message.negotiation,
					sdp: message.sdp,
				});
				break;
			case "ice":
				if (message.toSession !== joined.session || current === undefined) {
					return;
				}
				current.link?.receive({
					type: "ice",
					negotiation: message.negotiation,
					candidates: message.candidates,
				});
				break;
			case "leave":
				if (current !== undefined) this.#forget(from);
				break;
		}
		this.#emit();
	}

	/** A new session at a seat retires the link of its previous session. */
	#introduce(
		seat: Seat,
		generation: number,
		message: Announcement & { readonly session: string },
	): Peer {
		this.#forget(seat);
		const peer: Peer = {
			seat,
			generation,
			session: message.session,
			prefVersion: message.prefVersion,
			remote: remoteParty(message),
			link: undefined,
			linkToken: 0,
		};
		this.#peers.set(seat, peer);
		this.#ensureLink(peer);
		this.#watchVanished();
		return peer;
	}

	#refresh(peer: Peer, announcement: Announcement): void {
		if (announcement.prefVersion <= peer.prefVersion) return;
		peer.prefVersion = announcement.prefVersion;
		peer.remote = remoteParty(announcement);
		this.#ensureLink(peer);
	}

	/** One link while both sides are in the call, none otherwise. */
	#ensureLink(peer: Peer): void {
		const local = this.#local;
		const self = this.#self;
		if (
			local === undefined ||
			self === undefined ||
			!peer.remote.prefs.inCall
		) {
			this.#closeLink(peer);
			return;
		}
		if (peer.link !== undefined) {
			peer.link.update(local, peer.remote);
			return;
		}
		const token = ++this.#linkTokens;
		peer.linkToken = token;
		peer.link = this.#deps.createLink({
			seat: peer.seat,
			polite: !this.#impolite(peer.seat),
			local,
			remote: peer.remote,
			send: (signal) => {
				if (peer.linkToken === token && this.#peers.get(peer.seat) === peer) {
					this.#sendLinkSignal(peer, signal);
				}
			},
			onState: () => {
				if (peer.linkToken === token) this.#emit();
			},
		});
	}

	#closeLink(peer: Peer): void {
		peer.linkToken = 0;
		const link = peer.link;
		peer.link = undefined;
		link?.close();
	}

	#sendLinkSignal(peer: Peer, signal: LinkSignal): void {
		const joined = this.#joined;
		if (joined?.signaling === undefined) return;
		const target = {
			session: joined.session,
			toSession: peer.session,
			negotiation: signal.negotiation,
		};
		const message: CallMessage =
			signal.type === "ice"
				? { type: "ice", ...target, candidates: signal.candidates }
				: {
						type: signal.type,
						...target,
						sdp: signal.sdp,
						...this.#announcement(),
					};
		joined.signaling.send(peer.seat, message);
	}

	#reply(seat: Seat): void {
		if (this.#replies.has(seat)) return;
		this.#replies.set(
			seat,
			setTimeout(() => {
				this.#replies.delete(seat);
				const joined = this.#joined;
				if (joined?.signaling === undefined) return;
				joined.signaling.send(seat, this.#message("prefs", joined.session));
			}, REPLY_COALESCE_MS),
		);
	}

	#forget(seat: Seat): void {
		const peer = this.#peers.get(seat);
		if (peer !== undefined) this.#closeLink(peer);
		this.#peers.delete(seat);
		clearTimeout(this.#vanishing.get(seat));
		this.#vanishing.delete(seat);
		clearTimeout(this.#greeted.get(seat));
		this.#greeted.delete(seat);
	}

	/** Replaces call presence (ADR 0003): a peer that stays offline at its generation leaves the call. */
	#watchVanished(): void {
		const online = this.#snapshot?.online;
		for (const peer of this.#peers.values()) {
			const timer = this.#vanishing.get(peer.seat);
			if (online?.has(peer.seat)) {
				clearTimeout(timer);
				this.#vanishing.delete(peer.seat);
			} else if (timer === undefined) {
				this.#vanishing.set(
					peer.seat,
					setTimeout(() => {
						this.#vanishing.delete(peer.seat);
						if (this.#peers.get(peer.seat) !== peer) return;
						this.#forget(peer.seat);
						this.#emit();
					}, VANISHED_MS),
				);
			}
		}
	}

	#impolite(seat: Seat): boolean {
		const self = this.#self;
		return self !== undefined && SEATS.indexOf(self.seat) < SEATS.indexOf(seat);
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}
