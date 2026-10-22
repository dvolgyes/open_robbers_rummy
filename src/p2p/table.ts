import type { CallRoomSnapshot } from "../call/mesh";
import type { CallTransport } from "../call/signaling";
import type { GameModule } from "../game/module";
import {
	type JsonObject,
	type RoomConfig,
	SEATS,
	type Seat,
} from "../protocol";
import type { MaybeStorage, SeatLocks, SeatMemory } from "../session";
import { botSeatClaims } from "./bot-seats";
import { MeshCallTransport } from "./call-transport";
import {
	ConnectionChecks,
	connectionPath,
	type PathTypes,
	type PeerCheck,
} from "./checks";
import {
	type ElectionEffect,
	type ElectionEvent,
	type ElectionState,
	type ElectionView,
	electionView,
	followedHost,
	initElection,
	type SelfFacts,
	stepElection,
} from "./election";
import { cleanup, isIdle } from "./expiry";
import type { FollowerStatus } from "./follower";
import {
	deriveHolder,
	deriveTableId,
	isClientId,
	makeTag,
	newClientId,
	tagSeat,
} from "./keys";
import { CLEANUP_MS, CONNECTION_FAILED_MS, TICK_MS } from "./limits";
import { creationCommit, LocalLog, openLog } from "./log";
import type { Mesh, MeshDiagnostics, MeshHandlers } from "./mesh";
import type { FailedStatus, OutboxItem, SubmitResult } from "./outbox";
import type { Clock } from "./ports";
import type { TableRecord } from "./records";
import { seatRendezvous } from "./rendezvous";
import { Replication, type ReplicationEvent, type Seated } from "./replication";
import type { StorageCode, StorageResult, TableStorage } from "./storage";
import type {
	AutoplayStatus,
	Binding,
	CtlMessage,
	Entry,
	Lobby,
	ReleaseResult,
	Roster,
	SeatCode,
} from "./wire";

/**
 * The one object the UI uses for a table (plan §4.10). It holds the seat lock, opens the replica, joins the
 * mesh, and connects the election reducer, the replication and the connection checks. `view()` is plain data.
 */

// ---------------------------------------------------------------------------------------------------------------
// Identity and creation

const CLIENT_PREFIX = "lb.client.";
const RELOAD_LOCK_WAIT_MS = 500;
const RELOAD_LOCK_POLL_MS = 50;

export interface TableIdentity {
	readonly tableId: string;
	/** Random, per browser and table; only the followed host receives it. */
	readonly client: string;
	readonly holder: string;
}

/** The table id from K, and this browser's client id (localStorage; per page without it) and holder. */
export async function tableIdentity(
	key: string,
	browser: MaybeStorage,
): Promise<TableIdentity> {
	const tableId = await deriveTableId(key);
	const name = CLIENT_PREFIX + tableId;
	const stored = browser?.getItem(name);
	const client = isClientId(stored) ? stored : newClientId();
	if (client !== stored) browser?.setItem(name, client);
	return { tableId, client, holder: await deriveHolder(tableId, client) };
}

export const CANNOT_STORE =
	"This browser does not allow storing data, so it cannot create a table";

export interface TableCreation {
	readonly storage: TableStorage;
	readonly identity: TableIdentity;
	readonly seat: Seat;
	readonly config: RoomConfig;
	readonly module: GameModule;
	readonly newId: () => string;
	readonly clock: Clock;
	readonly memory: Pick<SeatMemory, "remember">;
	/** Claims bot-named seats for in-page host actors at creation time. */
	readonly hostBots?: boolean;
}

/**
 * Writes term 1 with the creator's seat claim (election rule 11). The key is new, so no other tab writes this
 * partition. Start the controller afterwards with `creator: true`.
 */
export async function createTable(
	input: TableCreation,
): Promise<StorageResult<void>> {
	const { storage, identity, seat } = input;
	if (!storage.persistent) {
		return { ok: false, code: "storage", detail: CANNOT_STORE };
	}
	const { tableId, holder } = identity;
	const botClaims = input.hostBots
		? await botSeatClaims(tableId, input.config, input.newId, seat)
		: [];
	const log = new LocalLog(storage, tableId, seat);
	const written = await log.write(() =>
		creationCommit({
			tableId,
			seat,
			holder,
			config: input.config,
			state: input.module.initialState(tableId, input.config),
			auth: { term: 1, tag: makeTag(holder, seat), inc: 1 },
			id: input.newId(),
			botClaims,
			now: input.clock.wall(),
		}),
	);
	if (!written.ok) return written;
	input.memory.remember(tableId, seat);
	return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------------------------------------------
// Controller

export type TableMesh = Pick<
	Mesh,
	| "self"
	| "peers"
	| "connection"
	| "online"
	| "diagnostics"
	| "ctl"
	| "log"
	| "call"
	| "leave"
	| "seek"
	| "tick"
>;

export interface TableDeps {
	readonly identity: TableIdentity;
	readonly storage: TableStorage;
	readonly locks: SeatLocks;
	readonly memory: Pick<SeatMemory, "tabSeat" | "remember">;
	readonly module: GameModule;
	readonly clock: Clock;
	/** Runs `run` every `ms` until the returned function runs. */
	readonly every: (ms: number, run: () => void) => () => void;
	readonly openMesh: (handlers: MeshHandlers) => TableMesh;
	readonly newId: () => string;
	/** Connection-check nonces. */
	readonly nonce: () => string;
	/** False for automated clients that cannot take over board dealing. */
	readonly hostEligible?: boolean;
	/** This page load created the table: it hosts term 1 at once. */
	readonly creator?: boolean;
	/** An explicit seat from the room URL takes priority over remembered seats. */
	readonly preferredSeat?: Seat;
	/** Valid setup values from the shared URL can initialize a missing local room. */
	readonly bootstrap?: { readonly config: RoomConfig; readonly host: Seat };
}

export type TableStatus =
	| "starting"
	| "open"
	| "expired"
	/** Another tab of this browser (`tab`) or another device (`seat`) holds this page's seat now. */
	| "superseded"
	| "incompatible"
	/** A peer refused this page: the table has too many open pages. */
	| "full"
	/** Trackers introduce peers, but no direct connection works. */
	| "connection-failed";

export interface PeerView {
	readonly peer: string;
	/** The seat the roster binds to the peer. */
	readonly seat: Seat | null;
	readonly check: PeerCheck | null;
	/** Candidate types of the selected path; never an address. */
	readonly path: PathTypes | null;
}

export interface CommandFailure {
	readonly id: string;
	readonly payload: JsonObject;
	readonly status: FailedStatus;
	readonly reason?: string;
}

export interface TableView {
	readonly status: TableStatus;
	readonly supersededBy: "tab" | "seat" | null;
	readonly election: ElectionView | null;
	readonly seat: Seat | null;
	/** Seats that another live tab of this browser holds; keep them out of this tab's choices. */
	readonly heldElsewhere: readonly Seat[];
	readonly follower: FollowerStatus | null;
	readonly hosting: boolean;
	readonly hostSeat: Seat | null;
	readonly table: TableRecord | null;
	readonly lobby: Lobby | null;
	readonly roster: Roster | null;
	/** Own commands reach a host now. */
	readonly ready: boolean;
	readonly outbox: readonly OutboxItem[];
	/** Own commands that a host change undid. */
	readonly undone: readonly Entry[];
	readonly failures: readonly CommandFailure[];
	/** Why the last seat claim failed. */
	readonly seatError: SeatCode | null;
	readonly release: ReleaseResult | null;
	readonly peers: readonly PeerView[];
	/** The peers of the three other seats are connected and passed the connection check. */
	readonly allConnected: boolean;
	readonly network: MeshDiagnostics | null;
	/** STUN found a public address for this page (a server-reflexive candidate). */
	readonly publicAddress: boolean;
	readonly persistent: boolean;
	/** No storage write failed. */
	readonly writable: boolean;
}

export type ChooseResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason:
				| "seated"
				| "held-elsewhere"
				| "closed"
				| "refused"
				| StorageCode;
	  };

type Terminal =
	| { readonly status: "expired" | "incompatible" }
	| { readonly status: "superseded"; readonly by: "tab" | "seat" };

interface Lock {
	readonly token: number;
	readonly seat: Seat;
	readonly release: () => void;
}

type Opened =
	| { readonly ok: true; readonly seated: Seated }
	| { readonly ok: false; readonly code: StorageCode | "closed" | "refused" };

const MAX_FAILURES = 20;

export class TableController {
	readonly #deps: TableDeps;
	readonly #tableId: string;
	readonly #checks: ConnectionChecks;
	readonly #listeners = new Set<() => void>();
	readonly #paths = new Map<string, PathTypes | null>();
	readonly #call: MeshCallTransport;
	#mesh: TableMesh | null = null;
	/**
	 * The latest roster from the host engine or the followed host. A follower has none during a host change; the
	 * call keeps its links meanwhile, and the generation checks drop stale bindings.
	 */
	#lastRoster: Roster | null = null;
	#replication: Replication | null = null;
	#autoplayHandler: (seat: Seat, enabled: boolean) => Promise<AutoplayStatus> =
		async () => "unavailable";
	/** Changes with every replication, so that events of a disposed one are ignored. */
	#session = 0;
	#election: ElectionState | null = null;
	#lock: Lock | null = null;
	#lockToken = 0;
	#unwatch: (() => void) | null = null;
	#stopTimer: (() => void) | null = null;
	#heldElsewhere: ReadonlySet<Seat> = new Set();
	#querying = false;
	#bootstrapAllowed = false;
	#busy = false;
	#started = false;
	#stopped = false;
	#terminal: Terminal | null = null;
	#lastTable: TableRecord | null = null;
	#writable = true;
	#online = false;
	#full = false;
	#publicAddress = false;
	#unreachableSince: number | null = null;
	#lastCleanup = 0;
	#undone: Entry[] = [];
	#failures: CommandFailure[] = [];
	#seatError: SeatCode | null = null;
	#release: ReleaseResult | null = null;
	#notifyQueued = false;

	constructor(deps: TableDeps) {
		this.#deps = deps;
		this.#tableId = deps.identity.tableId;
		this.#checks = new ConnectionChecks({
			ping: (peer, message) => this.#mesh?.ctl(peer, message),
			clock: deps.clock,
			nonce: deps.nonce,
			change: (peer) => {
				if (this.#checks.ready(peer)) this.#samplePath(peer);
				this.#notify();
			},
		});
		this.#call = new MeshCallTransport(this.#tableId, {
			bindings: () => this.#bindings(),
			connected: () => (this.#closed() ? [] : (this.#mesh?.peers() ?? [])),
			self: () => this.#callSelf(),
			send: (peer, frame) => this.#mesh?.call(peer, frame),
		});
	}

	get tableId(): string {
		return this.#tableId;
	}

	/** This browser's holder at this table (plan §4.3); the host stores it with each seat it gives this browser. */
	get holder(): string {
		return this.#deps.identity.holder;
	}

	/** Call signaling over this table's data channels. */
	get callTransport(): CallTransport {
		return this.#call;
	}

	/**
	 * The call's view of the table: holders from the replica, and online = the seats whose peer the roster binds
	 * at the current generation and that have a data channel to this page.
	 */
	callSnapshot(): CallRoomSnapshot {
		const table = this.#closed() ? null : this.#replication?.log?.table;
		const holders: Partial<Record<Seat, number>> = {};
		for (const row of table?.seats ?? []) {
			if (row.holder !== null) holders[row.seat] = row.gen;
		}
		const connected = new Set(this.#closed() ? [] : this.#mesh?.peers());
		const online = new Set<Seat>();
		for (const binding of this.#bindings()) {
			if (
				connected.has(binding.peer) &&
				holders[binding.seat] === binding.gen
			) {
				online.add(binding.seat);
			}
		}
		const self = this.#callSelf();
		return {
			roomId: this.#tableId,
			self:
				self && holders[self.seat] === self.gen
					? { seat: self.seat, generation: self.gen }
					: null,
			holders,
			online,
		};
	}

	/**
	 * Cleans up expired tables, restores an explicit URL seat, and joins the mesh.
	 * A valid setup URL can revive a tombstoned room when this browser has no remaining replica.
	 */
	async start(): Promise<void> {
		if (this.#started) throw new Error("the table controller already started");
		this.#started = true;
		const { storage, locks, memory, clock } = this.#deps;
		const wall = clock.wall();
		this.#lastCleanup = wall;
		await cleanup(storage, wall);
		const partitions = await storage.partitions();
		this.#bootstrapAllowed =
			partitions.ok &&
			!partitions.value.some(
				(partition) => partition.tableId === this.#tableId,
			);
		const tombstone = await storage.tombstone(this.#tableId);
		if (this.#closed()) return;
		if (tombstone.ok && tombstone.value) {
			if (this.#bootstrapAllowed && this.#deps.bootstrap) {
				const revived = await storage.reviveTable(this.#tableId);
				if (!revived.ok) {
					this.#writable = false;
					this.#end({ status: "expired" });
					return;
				}
			} else {
				this.#end({ status: "expired" });
				return;
			}
		}
		this.#heldElsewhere = await locks.heldElsewhere(this.#tableId);
		const tabSeat = memory.tabSeat(this.#tableId);
		const wanted =
			this.#deps.preferredSeat ?? (this.#deps.creator ? tabSeat : undefined);
		let seated: Seated | null = null;
		let seededHost = false;
		if (wanted !== undefined && wanted === tabSeat) {
			await this.#waitForReloadLock(wanted);
		}
		if (wanted !== undefined && !this.#heldElsewhere.has(wanted)) {
			const opened = await this.#openSeat(wanted);
			if (opened.ok) {
				seated = opened.seated;
				if (
					this.#bootstrapAllowed &&
					this.#deps.bootstrap?.host === wanted &&
					seated.log.table === null
				) {
					seededHost = await this.#seedHost(seated, wanted);
				}
			} else if (opened.code === "expired") this.#end({ status: "expired" });
			else if (opened.code === "storage") this.#writable = false;
		}
		if (this.#closed()) return;
		this.#mesh = this.#deps.openMesh({
			join: (peer) => this.#join(peer),
			leave: (peer) => this.#leave(peer),
			ctl: (peer, message) => this.#ctl(peer, message),
			log: (peer, message) => {
				if (!this.#terminal) this.#replication?.receiveLog(peer, message);
			},
			call: (peer, frame) => {
				if (!this.#closed()) this.#call.receive(peer, frame);
			},
			change: () => this.#notify(),
		});
		const holder = this.#deps.identity.holder;
		const creator =
			this.#deps.creator === true &&
			seated !== null &&
			seated.log.table?.host.tag === makeTag(holder, seated.log.seat);
		this.#begin(seated, creator || seededHost);
		this.#stopTimer = this.#deps.every(TICK_MS, () => this.#tick());
		this.#notify();
	}

	/** A visitor takes a free seat. */
	async choose(seat: Seat): Promise<ChooseResult> {
		if (this.#closed() || !this.#replication) return refused("closed");
		if (this.#lock || this.#busy) return refused("seated");
		this.#busy = true;
		try {
			this.#heldElsewhere = await this.#deps.locks.heldElsewhere(this.#tableId);
			if (this.#heldElsewhere.has(seat)) return refused("held-elsewhere");
			const opened = await this.#openSeat(seat);
			if (!opened.ok) return this.#openFailed(opened.code);
			// A host's lobby means the table is live: the seat is claimed from that host, never seeded as a second
			// table (ADR 0005).
			if (
				this.#bootstrapAllowed &&
				this.#deps.bootstrap?.host === seat &&
				opened.seated.log.table === null &&
				this.#replication?.follower.lobby === null
			) {
				const seeded = await this.#seedHost(opened.seated, seat);
				if (seeded) {
					this.#seatError = null;
					this.#begin(opened.seated, true);
					return { ok: true };
				}
			}
			const replication = this.#replication;
			if (this.#closed() || !replication) {
				this.#dropLock();
				return refused("closed");
			}
			this.#seatError = null;
			replication.choose(opened.seated);
			this.#watch(opened.seated.log);
			return { ok: true };
		} finally {
			this.#busy = false;
			this.#notify();
		}
	}

	/** Starts a fresh room from its shared setup when the configured host seat is selected. */
	async #seedHost(seated: Seated, seat: Seat): Promise<boolean> {
		const bootstrap = this.#deps.bootstrap;
		if (!bootstrap || !this.#deps.storage.persistent) return false;
		const { holder } = this.#deps.identity;
		const auth = { term: 1, tag: makeTag(holder, seat), inc: 1 };
		const written = await seated.log.write(() =>
			creationCommit({
				tableId: this.#tableId,
				seat,
				holder,
				config: bootstrap.config,
				state: this.#deps.module.initialState(this.#tableId, bootstrap.config),
				auth,
				id: this.#deps.newId(),
				now: this.#deps.clock.wall(),
			}),
		);
		if (!written.ok || !written.value) return false;
		this.#bootstrapAllowed = false;
		this.#deps.memory.remember(this.#tableId, seat);
		return true;
	}

	/** Queues an own command; it is stored before it is sent. */
	send(payload: JsonObject): Promise<SubmitResult> {
		const terminal = this.#terminal;
		if (terminal?.status === "expired") {
			return Promise.resolve({ ok: false, code: "expired" });
		}
		if (terminal || this.#stopped) {
			return Promise.resolve({ ok: false, code: "conflict" });
		}
		const replication = this.#replication;
		return replication
			? replication.submit(payload)
			: Promise.resolve({ ok: false, code: "storage" });
	}

	/** Starts host-local actors for the configured bot seats. */
	activateBots(seats: readonly Seat[]): Promise<boolean> {
		if (this.#closed() || !this.#replication) return Promise.resolve(false);
		return this.#replication.activateBots(seats);
	}

	/** Enables or disables host bot control for a seat. */
	setBotSeat(seat: Seat, enabled: boolean): Promise<boolean> {
		if (this.#closed() || !this.#replication) return Promise.resolve(false);
		return this.#replication.setBotSeat(seat, enabled);
	}

	setAutoplayHandler(
		handler: (seat: Seat, enabled: boolean) => Promise<AutoplayStatus>,
	): void {
		this.#autoplayHandler = handler;
		this.#replication?.setAutoplayHandler(handler);
	}

	requestAutoplay(enabled: boolean): Promise<AutoplayStatus> {
		if (this.#closed() || !this.#replication) return Promise.resolve("failed");
		return this.#replication.requestAutoplay(enabled);
	}

	/** Submits one action as a host-managed bot through the host's normal game validation. */
	sendBot(
		seat: Seat,
		payload: JsonObject,
	): Promise<
		{ readonly ok: true } | { readonly ok: false; readonly reason: string }
	> {
		if (this.#closed() || !this.#replication)
			return Promise.resolve({ ok: false, reason: "table is closed" });
		return this.#replication.localBotCommand(seat, this.#deps.newId(), payload);
	}

	/** Asks the host to free an offline seat (D2); false when no host can be asked now. */
	release(seat: Seat): boolean {
		if (this.#closed() || !this.#replication) return false;
		this.#release = null;
		return this.#replication.release(seat);
	}

	/** The "Make me the host" button. */
	click(): void {
		this.#step({ type: "click", now: this.#now() });
	}

	/** `visibilitychange` to visible, `pageshow`, or `online`. */
	wake(): void {
		this.#step({ type: "wake", now: this.#now() });
	}

	/** This seat's replicated log; empty for a visitor. */
	entries(): readonly Entry[] {
		return this.#replication?.log?.entries ?? [];
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Leaves the table, for example when the page navigates away. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#shutDown();
	}

	view(): TableView {
		const replication = this.#replication;
		const election = this.#election;
		const live = !this.#terminal && !this.#stopped;
		const engine = live ? (replication?.engine ?? null) : null;
		const hosting = engine !== null && !engine.stopped;
		const followed = live && election ? followedHost(election) : null;
		const roster = hosting
			? engine.roster()
			: (replication?.follower.roster ?? null);
		const bindings = new Map(
			(roster?.peers ?? []).map((binding) => [binding.peer, binding.seat]),
		);
		const mesh = live ? this.#mesh : null;
		const peers: PeerView[] = (mesh?.peers() ?? []).map((peer) => ({
			peer,
			seat: bindings.get(peer) ?? null,
			check: this.#checks.state(peer) ?? null,
			path: this.#paths.get(peer) ?? null,
		}));
		const seat = this.#lock?.seat ?? null;
		const allConnected =
			seat !== null &&
			SEATS.every(
				(other) =>
					other === seat ||
					(roster?.bots.includes(other) ?? false) ||
					peers.some(
						(peer) => peer.seat === other && peer.check?.state === "ready",
					),
			);
		const hostAuth =
			election?.mode.kind === "hosting"
				? election.mode.auth
				: (followed?.auth ?? null);
		const network = mesh?.diagnostics() ?? null;
		const log = replication?.log ?? null;
		return {
			status: this.#status(network, hosting || followed !== null),
			supersededBy:
				this.#terminal?.status === "superseded" ? this.#terminal.by : null,
			election: live && election ? electionView(election) : null,
			seat,
			heldElsewhere:
				seat === null && live
					? SEATS.filter((item) => this.#heldElsewhere.has(item))
					: [],
			follower: replication?.follower.status ?? null,
			hosting,
			hostSeat: live && hostAuth ? tagSeat(hostAuth.tag) : null,
			table: log?.table ?? this.#lastTable,
			lobby: replication?.follower.lobby ?? null,
			roster,
			ready: live && (hosting || replication?.follower.ready === true),
			outbox: replication?.outbox?.items ?? [],
			undone: [...this.#undone],
			failures: [...this.#failures],
			seatError: this.#seatError,
			release: this.#release,
			peers,
			allConnected,
			network,
			publicAddress: this.#publicAddress,
			persistent: this.#deps.storage.persistent,
			writable: this.#writable,
		};
	}

	// -------------------------------------------------------------------------------------------------------
	// Seat lock and replica

	/** A reload can see its previous document's Web Lock briefly before unload releases it. */
	async #waitForReloadLock(seat: Seat): Promise<void> {
		const deadline = Date.now() + RELOAD_LOCK_WAIT_MS;
		while (this.#heldElsewhere.has(seat) && Date.now() < deadline) {
			await new Promise<void>((resolve) =>
				setTimeout(resolve, RELOAD_LOCK_POLL_MS),
			);
			this.#heldElsewhere = await this.#deps.locks.heldElsewhere(this.#tableId);
		}
	}

	/** Holds the seat lock, then opens the partition. An idle replica expires here. */
	async #openSeat(seat: Seat): Promise<Opened> {
		const token = ++this.#lockToken;
		let acquired = false;
		let release: () => void = () => {};
		const held = await new Promise<boolean>((resolve) => {
			release = this.#deps.locks.hold(this.#tableId, seat, {
				ifAvailable: true,
				onAcquired: () => {
					acquired = true;
					resolve(true);
				},
				onLost: () => {
					resolve(false);
					if (acquired && this.#lock?.token === token) this.#lockLost();
				},
			});
		});
		if (!held) return { ok: false, code: "refused" };
		if (this.#closed()) {
			release();
			return { ok: false, code: "closed" };
		}
		this.#lock = { token, seat, release };
		const opened = await openLog(this.#deps.storage, this.#tableId, seat);
		if (this.#lock?.token !== token) return { ok: false, code: "closed" };
		if (!opened.ok) {
			this.#dropLock();
			return { ok: false, code: opened.code };
		}
		const { log } = opened.value;
		const wall = this.#deps.clock.wall();
		if (log.table && isIdle(log.table.lastActivityAt, wall)) {
			await log.expire(wall);
			this.#dropLock();
			return { ok: false, code: "expired" };
		}
		return { ok: true, seated: opened.value };
	}

	#openFailed(code: StorageCode | "closed" | "refused"): ChooseResult {
		if (code === "expired") this.#end({ status: "expired" });
		if (code === "storage") this.#writable = false;
		return refused(code);
	}

	#dropLock(): void {
		const lock = this.#lock;
		this.#lock = null;
		lock?.release();
	}

	/** Another tab stole the seat lock: stop at once, before this tab can write (§4.3). */
	#lockLost(): void {
		this.#lock = null;
		this.#step({ type: "lock-lost", now: this.#now() });
		this.#end({ status: "superseded", by: "tab" });
	}

	#watch(log: LocalLog): void {
		this.#unwatch?.();
		this.#unwatch = log.subscribe(() => queueMicrotask(() => this.#refresh()));
		queueMicrotask(() => this.#refresh());
	}

	// -------------------------------------------------------------------------------------------------------
	// Replication and election

	/** A new replication and election for this page, as on a fresh page load; the mesh stays. */
	#begin(seated: Seated | null, creator: boolean): void {
		const mesh = this.#mesh;
		if (!mesh) throw new Error("the mesh is not open");
		const replication = this.#replicate(seated);
		const now = this.#now();
		const init = initElection({ now, self: this.#facts(), creator });
		this.#election = init.state;
		this.#online = false;
		this.#effects(init.effects);
		if (seated) this.#watch(seated.log);
		if (mesh.online()) {
			this.#online = true;
			this.#step({ type: "network", now, online: true });
		}
		for (const peer of mesh.peers()) {
			this.#step({ type: "join", now, peer });
			replication.join(peer);
		}
	}

	#replicate(seated: Seated | null): Replication {
		const mesh = this.#mesh;
		if (!mesh) throw new Error("the mesh is not open");
		this.#replication?.dispose();
		this.#unwatch?.();
		this.#unwatch = null;
		const session = ++this.#session;
		const { identity, storage, clock, module, newId } = this.#deps;
		const replication = new Replication(
			{
				tableId: this.#tableId,
				client: identity.client,
				self: mesh.self,
				storage,
				send: mesh,
				clock,
				module,
				newId,
				onEvent: (event) =>
					queueMicrotask(() => {
						if (this.#session === session) this.#replicationEvent(event);
					}),
			},
			seated,
		);
		replication.setAutoplayHandler(this.#autoplayHandler);
		this.#replication = replication;
		return replication;
	}

	#facts(): SelfFacts {
		const { holder } = this.#deps.identity;
		const hostEligible = this.#deps.hostEligible !== false;
		const log = this.#replication?.log ?? null;
		if (!log || this.#lock?.seat !== log.seat)
			return { holder, seating: null, hostEligible };
		const table = log.table;
		const row = table?.seats.find((item) => item.seat === log.seat);
		return {
			holder,
			hostEligible,
			seating: {
				seat: log.seat,
				pos: log.position(),
				host: table?.host ?? null,
				inc: table?.inc ?? 0,
				bound: row?.holder === holder,
				persistent: log.persistent,
				writable: this.#writable,
			},
		};
	}

	#refresh(): void {
		this.#step({ type: "self", now: this.#now(), self: this.#facts() });
	}

	#step(event: ElectionEvent): void {
		const state = this.#election;
		if (!state || this.#closed()) return;
		const next = stepElection(state, event);
		this.#election = next.state;
		this.#effects(next.effects);
		this.#notify();
	}

	#effects(effects: readonly ElectionEffect[]): void {
		for (const effect of effects) {
			if (this.#closed()) return;
			if (effect.type === "beat") {
				this.#mesh?.ctl(effect.to, effect.beat);
				continue;
			}
			this.#replication?.apply(effect);
			const seat = this.#lock?.seat;
			if (effect.type === "host" && seat) {
				this.#deps.memory.remember(this.#tableId, seat);
			}
		}
	}

	#replicationEvent(event: ReplicationEvent): void {
		if (this.#closed()) return;
		const now = this.#now();
		switch (event.type) {
			case "pulled":
				this.#step({ type: "pulled", now, auth: event.auth });
				return;
			case "stored":
				this.#step({ type: "stored", now, auth: event.auth, ok: event.ok });
				return;
			case "storage":
				this.#writable = false;
				this.#refresh();
				return;
			case "host-stopped":
				if (event.reason === "expired") {
					this.#expire();
					return;
				}
				this.#writable = false;
				this.#refresh();
				return;
			case "status":
				this.#followerStatus(event.status);
				break;
			case "seat-result":
				if (event.result.ok) this.#seatError = null;
				else this.#claimFailed(event.result.code);
				break;
			case "release-result":
				this.#release = event.result;
				break;
			case "undone":
				this.#undone.push(...event.entries);
				break;
			case "failed":
				this.#failures.push({
					id: event.id,
					payload: event.payload,
					status: event.status,
					...(event.reason === undefined ? {} : { reason: event.reason }),
				});
				this.#failures = this.#failures.slice(-MAX_FAILURES);
				break;
			case "stopped":
				if (event.status === "expired") this.#expire();
				else this.#end({ status: "superseded", by: "seat" });
				return;
			default:
				break;
		}
		this.#notify();
	}

	#followerStatus(status: FollowerStatus): void {
		const seat = this.#lock?.seat;
		switch (status) {
			case "bound":
				this.#full = false;
				if (seat) this.#deps.memory.remember(this.#tableId, seat);
				return;
			case "unseated":
				this.#full = false;
				return;
			case "superseded":
				this.#end({ status: "superseded", by: "seat" });
				return;
			case "expired":
				this.#expire();
				return;
			case "incompatible":
				this.#end({ status: "incompatible" });
				return;
			default:
				return;
		}
	}

	/** The seat went to someone else: this page is a visitor again and may choose another seat. */
	#claimFailed(code: SeatCode): void {
		this.#seatError = code;
		if (code !== "taken" && code !== "invalid") return;
		const election = this.#election;
		this.#dropLock();
		const replication = this.#replicate(null);
		this.#refresh();
		if (election) {
			replication.apply({ type: "follow", host: followedHost(election) });
		}
	}

	// -------------------------------------------------------------------------------------------------------
	// Mesh

	#bindings(): readonly Binding[] {
		if (this.#closed()) return [];
		const replication = this.#replication;
		const engine = replication?.engine;
		const roster =
			engine && !engine.stopped
				? engine.roster()
				: (replication?.follower.roster ?? null);
		if (roster) this.#lastRoster = roster;
		return this.#lastRoster?.peers ?? [];
	}

	/** The seat and generation that the host bound to this page. */
	#callSelf(): { readonly seat: Seat; readonly gen: number } | null {
		if (this.#closed()) return null;
		const binding = this.#replication?.follower.binding ?? null;
		return binding && binding.seat === this.#lock?.seat ? binding : null;
	}

	#join(peer: string): void {
		if (this.#closed()) return;
		this.#step({ type: "join", now: this.#now(), peer });
		this.#replication?.join(peer);
		this.#checks.start(peer);
	}

	#leave(peer: string): void {
		this.#checks.forget(peer);
		this.#paths.delete(peer);
		if (this.#closed()) return;
		this.#step({ type: "leave", now: this.#now(), peer });
		this.#replication?.leave(peer);
	}

	#ctl(peer: string, message: CtlMessage): void {
		if (this.#closed()) return;
		switch (message.k) {
			case "beat":
				// The host engine also gets the beat: it is how the host knows that a quiet player is present.
				this.#step({ type: "beat", now: this.#now(), peer, beat: message });
				break;
			case "ping":
				this.#mesh?.ctl(peer, ConnectionChecks.echoOf(message));
				return;
			case "echo":
				this.#checks.echo(peer, message);
				return;
			case "gone":
				if (message.reason === "full") {
					this.#full = true;
					this.#notify();
				}
				break;
			default:
				break;
		}
		this.#replication?.receiveCtl(peer, message);
	}

	#samplePath(peer: string): void {
		const connection = this.#mesh?.connection(peer);
		if (!connection) return;
		void connectionPath(connection).then(({ path, publicAddress }) => {
			if (this.#closed() || !this.#mesh?.peers().includes(peer)) return;
			this.#paths.set(peer, path);
			if (publicAddress) this.#publicAddress = true;
			this.#notify();
		});
	}

	// -------------------------------------------------------------------------------------------------------
	// Time

	#tick(): void {
		const mesh = this.#mesh;
		if (this.#closed() || !mesh) return;
		const now = this.#now();
		const online = mesh.online();
		if (online !== this.#online) {
			this.#online = online;
			this.#step({ type: "network", now, online });
		}
		this.#step({ type: "tick", now });
		this.#replication?.tick();
		this.#checks.tick();
		mesh.seek(this.#missingSeats(mesh));
		mesh.tick();
		const network = mesh.diagnostics();
		if (network.peers > 0 || network.unreachable === 0) {
			this.#unreachableSince = null;
		} else {
			this.#unreachableSince ??= now;
		}
		if (!this.#lock && !this.#busy) this.#queryLocks();
		const wall = this.#deps.clock.wall();
		if (wall - this.#lastCleanup >= CLEANUP_MS) {
			this.#lastCleanup = wall;
			this.#periodic(wall);
		}
		this.#notify();
	}

	/**
	 * The seat pairs to meet in a two-page room: this page's seat with each other held seat whose bound peer is
	 * not connected to this page, mapped to that peer ("" without a binding), so that a new page at the other
	 * seat starts the pair's retries again. Without a roster (no host yet, or after a reload) every held seat is
	 * missing.
	 */
	#missingSeats(mesh: TableMesh): Map<string, string> {
		const missing = new Map<string, string>();
		const seat = this.#lock?.seat;
		const replication = this.#replication;
		const table = replication?.log?.table;
		if (!seat || !replication || !table) return missing;
		const engine = replication.engine;
		const roster =
			engine && !engine.stopped ? engine.roster() : replication.follower.roster;
		const connected = new Set(mesh.peers());
		const bound = new Map(
			(roster?.peers ?? []).map((binding) => [binding.seat, binding.peer]),
		);
		for (const row of table.seats) {
			if (row.seat === seat || row.holder === null) continue;
			const peer = bound.get(row.seat);
			if (peer !== undefined && connected.has(peer)) continue;
			missing.set(seatRendezvous(seat, row.seat), peer ?? "");
		}
		return missing;
	}

	/** Seats that other live tabs of this browser hold, so this tab can leave them out of its choices. */
	#queryLocks(): void {
		if (this.#querying) return;
		this.#querying = true;
		void this.#deps.locks.heldElsewhere(this.#tableId).then((held) => {
			this.#querying = false;
			if (this.#lock || this.#busy) return;
			this.#heldElsewhere = held;
		});
	}

	/** Expires this replica when it is idle, then cleans up other tables. */
	#periodic(wall: number): void {
		const table = this.#replication?.log?.table;
		if (table && isIdle(table.lastActivityAt, wall)) {
			this.#expire();
			return;
		}
		void cleanup(this.#deps.storage, wall);
	}

	#now(): number {
		return this.#deps.clock.monotonic();
	}

	// -------------------------------------------------------------------------------------------------------
	// End

	#closed(): boolean {
		return this.#stopped || this.#terminal !== null;
	}

	/** The table expired: delete this browser's replicas and record the tombstone. */
	#expire(): void {
		const log = this.#replication?.log ?? null;
		const wall = this.#deps.clock.wall();
		if (log) {
			if (!log.expired) void log.expire(wall);
		} else {
			void this.#deps.storage.expireTable(this.#tableId, wall);
		}
		this.#end({ status: "expired" });
	}

	#end(terminal: Terminal): void {
		if (this.#closed()) return;
		this.#lastTable = this.#replication?.log?.table ?? null;
		this.#terminal = terminal;
		this.#shutDown();
		this.#notify();
	}

	#shutDown(): void {
		this.#session++;
		this.#replication?.dispose();
		this.#unwatch?.();
		this.#unwatch = null;
		this.#dropLock();
		this.#stopTimer?.();
		this.#stopTimer = null;
		void this.#mesh?.leave();
	}

	#status(network: MeshDiagnostics | null, hosted: boolean): TableStatus {
		const terminal = this.#terminal;
		if (terminal) return terminal.status;
		if (!this.#election || this.#stopped) return "starting";
		if (network && network.incompatible > 0 && !hosted) return "incompatible";
		if (this.#full) return "full";
		const since = this.#unreachableSince;
		if (since !== null && this.#now() - since >= CONNECTION_FAILED_MS) {
			return "connection-failed";
		}
		return "open";
	}

	#notify(): void {
		if (this.#notifyQueued) return;
		this.#notifyQueued = true;
		queueMicrotask(() => {
			this.#notifyQueued = false;
			for (const listener of this.#listeners) listener();
		});
	}
}

function refused(
	reason: Extract<ChooseResult, { ok: false }>["reason"],
): ChooseResult {
	return { ok: false, reason };
}
