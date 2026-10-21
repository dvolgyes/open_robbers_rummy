import type {
	DataPayload,
	JoinError,
	JoinRoomCallbacks,
	JoinRoomConfig,
	MessageAction,
} from "@trystero-p2p/torrent";
import { APP_ID, type MeshConfig } from "./config";
import {
	CALL_BYTES,
	CTL_BYTES,
	CTL_PER_SECOND,
	LINK_TARGET_MS,
	LINKS_MS,
	LOG_BYTES,
	MAX_PEERS,
	MAX_RECEIVE_BYTES,
	MESH_BYTES,
	REJOIN_MAX_MS,
	REJOIN_MS,
} from "./limits";
import type { Clock, Send } from "./ports";
import { peerRendezvous, Rendezvous } from "./rendezvous";
import {
	type CallFrame,
	type CtlMessage,
	frame,
	isPeerId,
	type Links,
	type LogMessage,
	type Parsed,
	parseCall,
	parseCtl,
	parseLog,
	parseMesh,
	type Rejection,
} from "./wire";

/**
 * The page's Trystero table room (plan §4.2). Trackers only introduce the peers; every message then goes over
 * the WebRTC data channels. Each action caps its size before Trystero buffers a message, and each message passes
 * the wire validators before a handler sees it. Messages from peers above MAX_PEERS, or from peers that are not
 * connected, never reach a handler.
 *
 * Mesh repair: every page sends its peer list (`links`) to its peers. A page that misses a listed peer, or that
 * misses the peer of a seat the controller names (`seek`), meets it in a two-page room (`rendezvous.ts`). A page
 * without links has no list and, as a visitor, no seat, so it joins the table room again (REJOIN_MS).
 */

/** The part of a Trystero room that the mesh uses; the unit tests implement it without WebRTC. */
export interface MeshRoom {
	makeAction(namespace: string): MessageAction<DataPayload>;
	getPeers(): Record<string, RTCPeerConnection>;
	leave(): Promise<void>;
	onPeerJoin: ((peerId: string) => void) | null;
	onPeerLeave: ((peerId: string) => void) | null;
}

export type JoinMeshRoom = (
	config: JoinRoomConfig,
	roomId: string,
	callbacks: JoinRoomCallbacks,
) => MeshRoom;

/** A tracker socket as Trystero's `getRelaySockets` reports it. */
export interface TrackerSocket {
	readonly readyState: number;
}

const OPEN = 1;

export interface MeshDeps {
	readonly tableId: string;
	/** The link key K, used as the room password. Never logged. */
	readonly key: string;
	readonly config: MeshConfig;
	/** A Node-compatible WebRTC implementation; browsers use their global constructor. */
	readonly rtcPolyfill?: typeof RTCPeerConnection;
	readonly joinRoom: JoinMeshRoom;
	/** This page's Trystero peer id. */
	readonly self: string;
	/** Trystero's tracker sockets by URL. */
	readonly trackerSockets: () => Readonly<Record<string, TrackerSocket>>;
	readonly clock: Clock;
}

export interface MeshHandlers {
	readonly join: (peer: string) => void;
	readonly leave: (peer: string) => void;
	readonly ctl: (peer: string, message: CtlMessage) => void;
	readonly log: (peer: string, message: LogMessage) => void;
	readonly call: (peer: string, message: CallFrame) => void;
	/** A diagnostics count changed. */
	readonly change: () => void;
}

/** Why a received message was dropped. `stranger`: the sender is not an admitted peer. */
export type DropReason = Rejection | "oversize" | "rate" | "stranger";

export interface MeshDiagnostics {
	readonly trackersOpen: number;
	readonly trackers: number;
	/** Admitted peers with a data channel. */
	readonly peers: number;
	/** Pages with another key that tried to connect: strangers at the tracker, or a damaged link. */
	readonly wrongKey: number;
	/** Peers whose direct connection failed after the offer and answer were exchanged. */
	readonly unreachable: number;
	/** Peers above MAX_PEERS; each got `gone{full}`. */
	readonly refused: number;
	/** Peers that sent a message of another wire version or an unknown kind. */
	readonly incompatible: number;
	readonly dropped: Readonly<Record<DropReason, number>>;
	readonly sendFailures: number;
	/** Two-page rooms open now to repair missing links. */
	readonly pairRooms: number;
	/** Peers that a two-page room connected. */
	readonly repaired: number;
	/** Two-page rooms closed after PAIR_TIMEOUT_MS without a link. */
	readonly pairTimeouts: number;
	/** Of those, rooms that connected their peer, which the table room then did not admit. */
	readonly unattached: number;
	/** Times this page joined the table room again because it had no links. */
	readonly rejoins: number;
}

const ACTIONS = {
	ctl: "oc-ctl",
	log: "oc-log",
	call: "oc-call",
	mesh: "oc-mesh",
} as const;

type JoinErrorClass = "wrong-key" | "unreachable" | "other";

/** Sorts a Trystero join error by its message, which is the only field that tells the cases apart. */
export function classifyJoinError(error: string): JoinErrorClass {
	if (/incorrect (room )?password/.test(error)) return "wrong-key";
	if (/could not connect to peer/.test(error)) return "unreachable";
	return "other";
}

interface Window {
	start: number;
	count: number;
}

/** The table room and its actions; a rejoin replaces them together. */
interface TableRoom {
	readonly room: MeshRoom;
	readonly ctl: MessageAction<DataPayload>;
	readonly log: MessageAction<DataPayload>;
	readonly call: MessageAction<DataPayload>;
	readonly mesh: MessageAction<DataPayload>;
}

export class Mesh implements Send {
	readonly self: string;
	readonly #deps: MeshDeps;
	readonly #handlers: MeshHandlers;
	readonly #roomConfig: JoinRoomConfig;
	#table: TableRoom;
	readonly #rendezvous: Rendezvous;
	/** Peers that a neighbour listed and this page has no link to, until when they stay repair targets. */
	readonly #targets = new Map<string, number>();
	/** Seat pairs to meet, each with the peer bound to the other seat (`seek`). */
	#seats: ReadonlyMap<string, string> = new Map();
	/** Since when this page has had no links; null while it has one. */
	#aloneSince: number | null;
	#rejoinWait = REJOIN_MS;
	#rejoins = 0;
	#linksAt = Number.NEGATIVE_INFINITY;
	readonly #admitted = new Set<string>();
	readonly #refused = new Set<string>();
	readonly #wrongKey = new Set<string>();
	readonly #unreachable = new Set<string>();
	readonly #incompatible = new Set<string>();
	readonly #windows = new Map<string, Window>();
	readonly #dropped: Record<DropReason, number> = {
		malformed: 0,
		incompatible: 0,
		foreign: 0,
		oversize: 0,
		rate: 0,
		stranger: 0,
	};
	#sendFailures = 0;
	#left = false;

	constructor(deps: MeshDeps, handlers: MeshHandlers) {
		this.self = deps.self;
		this.#deps = deps;
		this.#handlers = handlers;
		const { config } = deps;
		const roomConfig: JoinRoomConfig = {
			appId: APP_ID,
			password: deps.key,
			rtcConfig: config.rtc,
			relayConfig: {
				urls: [...config.trackers],
				redundancy: config.trackers.length,
			},
			maxReceiveBytes: MAX_RECEIVE_BYTES,
			...(deps.rtcPolyfill ? { rtcPolyfill: deps.rtcPolyfill } : {}),
		};
		this.#roomConfig = roomConfig;
		this.#table = this.#joinTable();
		this.#aloneSince = deps.clock.monotonic();
		this.#rendezvous = new Rendezvous({
			key: deps.key,
			join: (roomId) => deps.joinRoom(roomConfig, roomId, {}),
		});
	}

	/** Admitted peers that still have a data channel, in join order. */
	peers(): string[] {
		const connected = this.#table.room.getPeers();
		return [...this.#admitted].filter((peer) => peer in connected);
	}

	/** The peer's connection, for statistics; undefined when it is not an admitted peer. */
	connection(peer: string): RTCPeerConnection | undefined {
		return this.#admitted.has(peer)
			? this.#table.room.getPeers()[peer]
			: undefined;
	}

	/** A tracker socket is open or a peer is connected (election rule 5). */
	online(): boolean {
		return this.#trackersOpen() > 0 || this.peers().length > 0;
	}

	diagnostics(): MeshDiagnostics {
		const repair = this.#rendezvous.counts();
		return {
			trackersOpen: this.#trackersOpen(),
			trackers: this.#deps.config.trackers.length,
			peers: this.peers().length,
			wrongKey: this.#wrongKey.size,
			unreachable: this.#unreachable.size,
			refused: this.#refused.size,
			incompatible: this.#incompatible.size,
			dropped: { ...this.#dropped },
			sendFailures: this.#sendFailures,
			pairRooms: repair.open,
			repaired: repair.repaired,
			pairTimeouts: repair.timeouts,
			unattached: repair.unattached,
			rejoins: this.#rejoins,
		};
	}

	/**
	 * The seat pairs (`seatRendezvous`) whose peers this page misses now, each with the peer that the roster binds
	 * to the other seat, or "" without a binding; `tick` meets them.
	 */
	seek(seats: ReadonlyMap<string, string>): void {
		this.#seats = new Map(seats);
	}

	/** Joins the table room again when alone, sends the peer list when it is due, and opens or closes the two-page rooms. */
	tick(): void {
		if (this.#left) return;
		const now = this.#deps.clock.monotonic();
		this.#rejoinWhenAlone(now);
		if (now - this.#linksAt >= LINKS_MS) this.#sendLinks(now);
		const admitted = new Set(this.peers());
		const wanted = new Map(this.#seats);
		for (const [peer, until] of this.#targets) {
			if (admitted.has(peer) || now >= until) {
				this.#targets.delete(peer);
				continue;
			}
			wanted.set(peerRendezvous(this.self, peer), "");
		}
		if (this.#rendezvous.tick(now, wanted, admitted)) this.#handlers.change();
	}

	ctl(to: string | null, message: CtlMessage): void {
		this.#send(this.#table.ctl, to, frame(this.#deps.tableId, message));
	}

	log(to: string | null, message: LogMessage): void {
		this.#send(this.#table.log, to, frame(this.#deps.tableId, message));
	}

	call(to: string | null, message: CallFrame): void {
		this.#send(this.#table.call, to, frame(this.#deps.tableId, message));
	}

	leave(): Promise<void> {
		if (this.#left) return Promise.resolve();
		this.#left = true;
		Mesh.#detach(this.#table);
		this.#admitted.clear();
		this.#rendezvous.close();
		return this.#table.room.leave();
	}

	// -------------------------------------------------------------------------------------------------------

	/** Joins the table room and makes its actions. */
	#joinTable(): TableRoom {
		const room = this.#deps.joinRoom(this.#roomConfig, this.#deps.tableId, {
			onJoinError: (error) => this.#joinError(error),
		});
		const table: TableRoom = {
			room,
			ctl: this.#action(room, ACTIONS.ctl, CTL_BYTES, true, parseCtl, (p, m) =>
				this.#handlers.ctl(p, m),
			),
			log: this.#action(room, ACTIONS.log, LOG_BYTES, false, parseLog, (p, m) =>
				this.#handlers.log(p, m),
			),
			call: this.#action(
				room,
				ACTIONS.call,
				CALL_BYTES,
				false,
				parseCall,
				(p, m) => this.#handlers.call(p, m),
			),
			mesh: this.#action(
				room,
				ACTIONS.mesh,
				MESH_BYTES,
				true,
				parseMesh,
				(p, m) => this.#links(p, m),
			),
		};
		room.onPeerJoin = (peer) => this.#join(peer);
		room.onPeerLeave = (peer) => this.#leave(peer);
		return table;
	}

	/** After this, the room's late events reach no handler. */
	static #detach({ room, ctl, log, call, mesh }: TableRoom): void {
		room.onPeerJoin = null;
		room.onPeerLeave = null;
		for (const action of [ctl, log, call, mesh]) action.onMessage = null;
	}

	/**
	 * A page alone for REJOIN_MS leaves and joins the table room again, which makes a new offer and repeats
	 * Trystero's first announces; the wait doubles up to REJOIN_MAX_MS and starts again at the next link. The peer
	 * id stays, so the trackers count the page once. A handshake in progress in the old room is lost.
	 */
	#rejoinWhenAlone(now: number): void {
		if (this.peers().length > 0) {
			this.#aloneSince = null;
			this.#rejoinWait = REJOIN_MS;
			return;
		}
		this.#aloneSince ??= now;
		if (now - this.#aloneSince < this.#rejoinWait) return;
		if (this.#trackersOpen() === 0) return;
		const old = this.#table;
		Mesh.#detach(old);
		for (const peer of [...this.#admitted]) this.#leave(peer);
		// Trystero's leave() releases the room id before it returns, so the join below makes a new room.
		void old.room.leave();
		this.#table = this.#joinTable();
		this.#aloneSince = now;
		this.#rejoinWait = Math.min(REJOIN_MAX_MS, this.#rejoinWait * 2);
		this.#rejoins++;
		this.#handlers.change();
	}

	#action<M>(
		room: MeshRoom,
		namespace: string,
		cap: number,
		limited: boolean,
		parse: (value: unknown, tableId: string) => Parsed<M>,
		deliver: (peer: string, message: M) => void,
	): MessageAction<DataPayload> {
		const action = room.makeAction(namespace);
		// Runs before Trystero buffers the message; a refused message never takes memory.
		action.onReceive = ({ peerId, byteLength }) => {
			if (!this.#admitted.has(peerId)) return this.#drop("stranger");
			if (byteLength > cap) return this.#drop("oversize");
			return true;
		};
		action.onMessage = (data, { peerId }) => {
			if (!this.#admitted.has(peerId)) {
				this.#drop("stranger");
				return;
			}
			if (limited && !this.#withinRate(peerId)) {
				this.#drop("rate");
				return;
			}
			const parsed = parse(data, this.#deps.tableId);
			if (!parsed.ok) {
				if (parsed.reason === "incompatible") this.#incompatible.add(peerId);
				this.#drop(parsed.reason);
				return;
			}
			deliver(peerId, parsed.message);
		};
		return action;
	}

	#join(peer: string): void {
		if (this.#admitted.has(peer) || this.#refused.has(peer)) return;
		if (!isPeerId(peer) || this.#admitted.size >= MAX_PEERS) {
			this.#refused.add(peer);
			this.#post(
				this.#table.ctl,
				[peer],
				frame(this.#deps.tableId, { k: "gone", reason: "full" }),
			);
			this.#handlers.change();
			return;
		}
		this.#admitted.add(peer);
		this.#unreachable.delete(peer);
		this.#targets.delete(peer);
		this.#handlers.join(peer);
		this.#handlers.change();
		this.#sendLinks(this.#deps.clock.monotonic());
	}

	#leave(peer: string): void {
		this.#refused.delete(peer);
		this.#windows.delete(peer);
		if (!this.#admitted.delete(peer)) return;
		this.#handlers.leave(peer);
		this.#handlers.change();
		this.#sendLinks(this.#deps.clock.monotonic());
	}

	#sendLinks(now: number): void {
		this.#linksAt = now;
		const links: Links = { k: "links", peers: this.peers() };
		this.#send(this.#table.mesh, null, frame(this.#deps.tableId, links));
	}

	/** A neighbour's peers that this page has no link to become repair targets (`tick`). */
	#links(from: string, { peers }: Links): void {
		const now = this.#deps.clock.monotonic();
		const admitted = new Set(this.peers());
		for (const peer of peers) {
			if (peer !== from) this.#target(peer, now, admitted);
		}
	}

	/**
	 * A failed link also becomes a repair target on both sides. Trystero reports the failure about 23 s after the
	 * exchange and tries the table room again only at a later announce, and a page without peers gets no
	 * neighbour's list.
	 */
	#joinError({ error, peerId }: JoinError): void {
		const kind = classifyJoinError(error);
		if (kind === "wrong-key") this.#wrongKey.add(peerId);
		else if (kind === "unreachable" && !this.#admitted.has(peerId)) {
			this.#unreachable.add(peerId);
			this.#target(peerId, this.#deps.clock.monotonic(), new Set(this.peers()));
		} else return;
		this.#handlers.change();
	}

	/** `peer` is a repair target until LINK_TARGET_MS from now, unless it has a link or cannot be admitted. */
	#target(peer: string, now: number, admitted: ReadonlySet<string>): void {
		if (peer === this.self || admitted.has(peer) || !isPeerId(peer)) return;
		if (this.#refused.has(peer) || this.#wrongKey.has(peer)) return;
		const full = admitted.size + this.#targets.size >= MAX_PEERS;
		if (full && !this.#targets.has(peer)) return;
		this.#targets.set(peer, now + LINK_TARGET_MS);
	}

	/** At most CTL_PER_SECOND control messages per peer in each one-second window. */
	#withinRate(peer: string): boolean {
		const now = this.#deps.clock.monotonic();
		const window = this.#windows.get(peer);
		if (!window || now - window.start >= 1_000) {
			this.#windows.set(peer, { start: now, count: 1 });
			return true;
		}
		window.count++;
		return window.count <= CTL_PER_SECOND;
	}

	#drop(reason: DropReason): false {
		this.#dropped[reason]++;
		return false;
	}

	#trackersOpen(): number {
		const sockets = this.#deps.trackerSockets();
		return this.#deps.config.trackers.filter(
			(url) => sockets[url]?.readyState === OPEN,
		).length;
	}

	#send(
		action: MessageAction<DataPayload>,
		to: string | null,
		message: object,
	): void {
		if (this.#left) return;
		const peers = this.peers();
		const targets =
			to === null ? peers : peers.includes(to) ? [to] : ([] as string[]);
		this.#post(action, targets, message);
	}

	#post(
		action: MessageAction<DataPayload>,
		targets: string[],
		message: object,
	): void {
		if (targets.length === 0) return;
		// Wire messages are plain JSON objects by construction (src/p2p/wire.ts).
		action.send(message as DataPayload, { target: targets }).catch(() => {
			this.#sendFailures++;
		});
	}
}
