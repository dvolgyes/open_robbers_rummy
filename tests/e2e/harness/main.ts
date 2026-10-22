import { getRelaySockets, joinRoom } from "@trystero-p2p/torrent";
import type { CallMessage } from "../../../src/call/messages";
import { type CallRecords, callRecordPayload } from "../../../src/call/record";
import {
	type CallSignaling,
	createCallSignaling,
	type SignalingEnd,
} from "../../../src/call/signaling";
import { legalActions } from "../../../src/canasta";
import {
	actionPayload,
	type CanastaState,
	canastaModule,
	engineSeat,
	parseCanastaState,
	startPayload,
} from "../../../src/game/canasta";
import { chatPayload } from "../../../src/game/chat";
import { newCommandId } from "../../../src/ids";
import { randomNonce } from "../../../src/p2p/checks";
import {
	APP_ID,
	type MeshConfig,
	readMeshConfig,
} from "../../../src/p2p/config";
import { deriveTableId } from "../../../src/p2p/keys";
import { newTableKey } from "../../../src/p2p/link";
import type { Mesh, MeshDiagnostics } from "../../../src/p2p/mesh";
import type { SubmitResult } from "../../../src/p2p/outbox";
import type { Clock } from "../../../src/p2p/ports";
import { openIndexedDbStorage } from "../../../src/p2p/storage";
import {
	type ChooseResult,
	createTable,
	TableController,
	type TableView,
	tableIdentity,
} from "../../../src/p2p/table";
import { trysteroMesh } from "../../../src/p2p/trystero";
import { frame } from "../../../src/p2p/wire";
import type { RoomConfig, Seat } from "../../../src/protocol";
import { guardedStorage, SeatMemory, webSeatLocks } from "../../../src/session";

/**
 * The real-network harness for `tests/e2e/p2p-mesh.spec.ts`: production modules (Trystero over the public
 * trackers, IndexedDB, Web Locks), driven by Playwright through `window.ocHarness`. One page holds at most one
 * Trystero room, because Trystero has one peer id per page.
 */

export interface TranscriptLine {
	readonly seq: number;
	readonly id: string;
	readonly kind: "cmd" | "seat";
	readonly seat: Seat;
	readonly term: number;
}

/** A call message that reached this page's inbox: the sender and the message type, never SDP or candidates. */
export interface CallReceived {
	readonly from: Seat;
	readonly fromGen: number;
	readonly type: CallMessage["type"];
	readonly session: string;
}

export interface CallView {
	readonly self: { readonly seat: Seat; readonly generation: number } | null;
	readonly holders: Partial<Record<Seat, number>>;
	readonly online: readonly Seat[];
}

export interface Harness {
	createTable(seat: Seat): Promise<{ readonly key: string }>;
	/**
	 * Opens a table link. `seat` stands for the `selected_player` of a player's own URL, which a reload or a
	 * reopened tab keeps (ADR 0005); the page then takes that seat back from its own replica.
	 */
	openTable(key: string, seat?: Seat): Promise<void>;
	view(): TableView | null;
	transcript(): readonly TranscriptLine[];
	choose(seat: Seat): Promise<ChooseResult>;
	send(text: string): Promise<SubmitResult>;
	/**
	 * Takes the first legal canasta action when this page's seat is the actor, otherwise null. The engine lists
	 * only actions that it accepts, so any sequence of these actions is legal.
	 */
	act(): Promise<SubmitResult | null>;
	/** Sends the start of the match, which deals hand 1; only the host may send it. */
	deal(): Promise<SubmitResult>;
	click(): void;
	/**
	 * Approximates a network change (Wi-Fi to cellular): every link closes on both sides and the tracker sockets
	 * reconnect, while the page keeps its peer id and its state. Limits: the other pages learn of the loss at
	 * once, where after a real change they wait for their ICE checks, and no address changes.
	 */
	dropLinks(): { readonly closed: number; readonly peersAfter: number };
	/**
	 * For `ms` milliseconds, each new WebRTC connection of this page may use only relay candidates. There is no
	 * TURN server, so the ICE checks of those connections really fail; later connections are normal. Call it
	 * before `openTable`.
	 */
	failLinksFor(ms: number): void;
	/** Joins the table's room with another password, as a stranger with a damaged link would. */
	wrongKeyJoin(key: string): Promise<void>;
	/** Sends a control message above the receive cap, then a valid ping; true when the echo arrives. */
	oversizeThenPing(key: string): Promise<boolean>;
	/** Mesh numbers of a wrong-key page. */
	strangerView(): {
		readonly peers: number;
		readonly network: MeshDiagnostics;
	} | null;

	/** Opens this seat's call inbox on the table transport; resolves when it receives. */
	callOpen(): Promise<{ readonly seat: Seat; readonly generation: number }>;
	/** Sends a `join` through call signaling (null: every other seat); returns its session id. */
	callSend(to: Seat | null): string;
	callReceived(): readonly CallReceived[];
	/** Why the inbox ended, if it did. */
	callEnded(): SignalingEnd | null;
	/**
	 * Sends `count` raw `join` frames to every connected peer, past call signaling, with the given seat and
	 * generations; only the inbox of (`to`, `toGen`) can take them. Returns their session id.
	 */
	callForge(to: Seat, toGen: number, fromGen: number, count: number): string;
	/**
	 * Sends one raw call frame with any message to every connected peer, as a modified client would: nothing on
	 * this side checks the message. Only the inbox of (`to`, `toGen`) can take it, and only when it is valid.
	 */
	callRaw(to: Seat, toGen: number, fromGen: number, msg: unknown): void;
	callView(): CallView;
	/** Every distinct online set since `callOpen`, in order, as seat strings such as "ESW". */
	callOnlineHistory(): readonly string[];
	/** Sends this seat's call status record with `version`. */
	sendMedia(version: number, video: boolean): Promise<SubmitResult>;
	/** The call status records in this page's replica. */
	media(): CallRecords;
	/** This browser's holder at the open table, which the host stores with each of its seat's call records. */
	holder(): string;
}

declare global {
	interface Window {
		ocHarness?: Harness;
	}
}

const CONFIG: RoomConfig = {
	names: { N: "north", E: "east", S: "south", W: "west" },
};

const SEATS: readonly Seat[] = ["N", "E", "S", "W"];

const clock: Clock = {
	monotonic: () => performance.now(),
	wall: () => Date.now(),
};

function meshConfig(): MeshConfig {
	const read = readMeshConfig(import.meta.env);
	if (!read.ok) throw new Error(read.error);
	return read.config;
}

const tab = guardedStorage(() => sessionStorage);
const browser = guardedStorage(() => localStorage);
const memory = new SeatMemory(tab, browser, clock.wall);
const locks = webSeatLocks(navigator.locks);

let controller: TableController | null = null;
/** The table controller's mesh, for `dropLinks`. */
let tableMesh: Mesh | null = null;
let stranger: ReturnType<ReturnType<typeof trysteroMesh>> | null = null;
let signaling: CallSignaling | null = null;
let callEnded: SignalingEnd | null = null;
const callReceived: CallReceived[] = [];
const onlineHistory: string[] = [];

async function storage() {
	const opened = await openIndexedDbStorage(
		{ factory: indexedDB, keyRange: IDBKeyRange },
		(record) => console.error(`corrupt ${record} record`),
	);
	if (!opened.ok) throw new Error(opened.detail);
	return opened.value;
}

async function open(
	key: string,
	creator: boolean,
	preferredSeat?: Seat,
): Promise<void> {
	if (controller || stranger) throw new Error("this page already joined");
	const identity = await tableIdentity(key, browser);
	const config = meshConfig();
	const table = new TableController({
		identity,
		storage: await storage(),
		locks,
		memory,
		module: canastaModule,
		clock,
		every: (ms, run) => {
			const timer = setInterval(run, ms);
			return () => clearInterval(timer);
		},
		openMesh: (handlers) => {
			tableMesh = trysteroMesh(identity.tableId, key, config, clock)(handlers);
			return tableMesh;
		},
		newId: newCommandId,
		nonce: randomNonce,
		creator,
		preferredSeat,
	});
	controller = table;
	await table.start();
}

function seated(): TableController {
	if (!controller) throw new Error("no table is open");
	return controller;
}

function currentState(table: TableController): CanastaState {
	const state = table.view().table?.state;
	const parsed = state ? parseCanastaState(state, table.tableId) : undefined;
	if (!parsed) throw new Error("the table has no canasta state");
	return parsed;
}

function joinMessage(): CallMessage {
	return {
		type: "join",
		session: crypto.randomUUID(),
		prefs: {
			inCall: true,
			send: { audio: true, video: false },
			receive: { audio: true, video: true },
		},
		prefVersion: 1,
		form: "desktop",
	};
}

function callView(table: TableController): CallView {
	const snapshot = table.callSnapshot();
	return {
		self: snapshot.self,
		holders: snapshot.holders,
		online: SEATS.filter((seat) => snapshot.online.has(seat)),
	};
}

function recordOnline(table: TableController): void {
	const online = callView(table).online.join("");
	if (onlineHistory.at(-1) !== online) onlineHistory.push(online);
}

window.ocHarness = {
	async createTable(seat) {
		const key = newTableKey();
		const identity = await tableIdentity(key, browser);
		const created = await createTable({
			storage: await storage(),
			identity,
			seat,
			config: CONFIG,
			module: canastaModule,
			newId: newCommandId,
			clock,
			memory,
		});
		if (!created.ok) throw new Error(created.detail);
		await open(key, true);
		return { key };
	},
	openTable: (key, seat) => open(key, false, seat),
	view: () => controller?.view() ?? null,
	transcript: () =>
		(controller?.entries() ?? []).map((entry) => ({
			seq: entry.seq,
			id: entry.id,
			kind: entry.kind,
			seat: entry.seat,
			term: entry.auth.term,
		})),
	choose: (seat) => seated().choose(seat),
	send: (text) => {
		const table = seated();
		return table.send(chatPayload(table.tableId, text));
	},
	async act() {
		const table = seated();
		const state = currentState(table);
		const seat = table.view().seat;
		if (!state.match || !seat) return null;
		const action = legalActions(state.match.hand, engineSeat(seat))[0];
		if (!action) return null;
		return table.send(
			actionPayload(table.tableId, state.match, state.actions, action),
		);
	},
	deal() {
		const table = seated();
		return table.send(startPayload(table.tableId));
	},
	click: () => seated().click(),

	dropLinks() {
		const mesh = tableMesh;
		if (!mesh) throw new Error("no table is open");
		let closed = 0;
		for (const peer of mesh.peers()) {
			const connection = mesh.connection(peer);
			if (!connection) continue;
			connection.close();
			// close() fires no state event on this side; Trystero reads the state on this event and drops the link.
			connection.dispatchEvent(new Event("iceconnectionstatechange"));
			closed++;
		}
		for (const socket of Object.values(getRelaySockets())) {
			(socket as WebSocket).close();
		}
		return { closed, peersAfter: mesh.peers().length };
	},

	failLinksFor(ms) {
		const native = globalThis.RTCPeerConnection;
		// Trystero reads the global constructor for each new connection.
		globalThis.RTCPeerConnection = class extends native {
			constructor(configuration?: RTCConfiguration) {
				super({ ...configuration, iceTransportPolicy: "relay" });
			}
		};
		setTimeout(() => {
			globalThis.RTCPeerConnection = native;
		}, ms);
	},

	async wrongKeyJoin(key) {
		if (controller || stranger) throw new Error("this page already joined");
		const tableId = await deriveTableId(key);
		stranger = trysteroMesh(
			tableId,
			newTableKey(),
			meshConfig(),
			clock,
		)({
			join: () => {},
			leave: () => {},
			ctl: () => {},
			log: () => {},
			call: () => {},
			change: () => {},
		});
	},

	strangerView: () =>
		stranger
			? { peers: stranger.peers().length, network: stranger.diagnostics() }
			: null,

	async oversizeThenPing(key) {
		if (controller || stranger) throw new Error("this page already joined");
		const tableId = await deriveTableId(key);
		const config = meshConfig();
		const room = joinRoom(
			{
				appId: APP_ID,
				password: key,
				rtcConfig: config.rtc,
				relayConfig: {
					urls: [...config.trackers],
					redundancy: config.trackers.length,
				},
			},
			tableId,
		);
		const action = room.makeAction("oc-ctl");
		const nonce = randomNonce();
		const echoed = new Promise<boolean>((resolve) => {
			action.onMessage = (data) => {
				const message = data as { k?: unknown; n?: unknown };
				if (message.k === "echo" && message.n === nonce) resolve(true);
			};
			setTimeout(() => resolve(false), 30_000);
		});
		const peer = await new Promise<string>((resolve) => {
			room.onPeerJoin = resolve;
		});
		const oversize = {
			...frame(tableId, { k: "ping", n: randomNonce() }),
			pad: "x".repeat(9 * 1024),
		};
		await action.send(oversize, { target: peer });
		await action.send(frame(tableId, { k: "ping", n: nonce }), {
			target: peer,
		});
		const result = await echoed;
		await room.leave();
		return result;
	},

	callOpen() {
		const table = seated();
		if (signaling) throw new Error("the call inbox is already open");
		const self = table.callSnapshot().self;
		if (!self) throw new Error("this page holds no seat");
		recordOnline(table);
		table.onChange(() => recordOnline(table));
		return new Promise((resolve) => {
			signaling = createCallSignaling(
				table.callTransport,
				{ roomId: table.tableId, ...self },
				{
					onStatus: (status) => {
						if (status === "subscribed") resolve(self);
					},
					onEnvelope: (envelope) =>
						callReceived.push({
							from: envelope.from,
							fromGen: envelope.fromGen,
							type: envelope.message.type,
							session: envelope.message.session,
						}),
					onEnd: (reason) => {
						callEnded = reason;
					},
					onProblem: (failure) =>
						console.error(`call signaling problem: ${failure.code}`),
				},
			);
		});
	},

	callSend(to) {
		if (!signaling) throw new Error("the call inbox is not open");
		const message = joinMessage();
		signaling.send(to, message);
		return message.session;
	},

	callReceived: () => [...callReceived],
	callEnded: () => callEnded,

	callForge(to, toGen, fromGen, count) {
		const mesh = tableMesh;
		if (!mesh) throw new Error("no table is open");
		const msg = joinMessage();
		for (let index = 0; index < count; index++) {
			mesh.call(null, { k: "call", to, toGen, fromGen, msg });
		}
		return msg.session;
	},

	callRaw(to, toGen, fromGen, msg) {
		const mesh = tableMesh;
		if (!mesh) throw new Error("no table is open");
		// A forged message need not be a call message; the receiving pages decide.
		mesh.call(null, { k: "call", to, toGen, fromGen, msg: msg as CallMessage });
	},

	callView: () => callView(seated()),
	callOnlineHistory: () => [...onlineHistory],

	sendMedia(version, video) {
		const table = seated();
		return table.send(
			callRecordPayload(table.tableId, {
				version,
				prefs: {
					inCall: true,
					send: { audio: true, video },
					receive: { audio: true, video: true },
				},
				form: "desktop",
			}),
		);
	},

	media() {
		return currentState(seated()).media;
	},

	holder: () => seated().holder,
};
