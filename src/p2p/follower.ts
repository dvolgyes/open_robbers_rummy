import type { Seat } from "../protocol";
import {
	comparePosition,
	EMPTY_POSITION,
	type Position,
	sameAuthority,
} from "./authority";
import type { Followed } from "./election";
import {
	ACK_DEBOUNCE_MS,
	EARLY_ENTRIES,
	GAP_WAIT_MS,
	SYNC_TIMEOUT_MS,
} from "./limits";
import { LINK_VERSION } from "./link";
import {
	appendCommit,
	type LocalLog,
	replaceCommit,
	storeFollowed,
} from "./log";
import type { Clock, Send } from "./ports";
import type { TableRecord } from "./records";
import type { StorageCode } from "./storage";
import { type SyncOutcome, SyncRequest, samePosition } from "./sync";
import type {
	CtlMessage,
	Entry,
	EntryMessage,
	GoneReason,
	Lobby,
	LogMessage,
	ReleaseResult,
	Roster,
	SeatResult,
	Welcome,
} from "./wire";

/**
 * The follower side of replication (plan §4.5, §4.6). A follower says hello to the host it follows, takes or
 * keeps its seat, syncs, and then applies live entries in order. It accepts entries and a replacement log only
 * from the followed host's peer. During a claim, `pull` takes a strictly better log from any peer.
 */

export type FollowerStatus =
	/** No host is followed. */
	| "idle"
	/** Hello sent; waiting for the welcome. */
	| "hello"
	/** The host knows this page as a visitor. */
	| "unseated"
	/** A seat claim is out. */
	| "claiming"
	/** The page holds its seat at the followed host. */
	| "bound"
	/** Another page holds this page's seat now; read-only. */
	| "superseded"
	| "expired"
	| "incompatible";

export interface Target {
	readonly peer: string;
	readonly gen: number;
}

export type FollowerEvent =
	| { readonly type: "status"; readonly status: FollowerStatus }
	/** Bound and in sync: own commands may go to `target`; null stops sending. */
	| { readonly type: "ready"; readonly target: Target | null }
	| { readonly type: "lobby"; readonly lobby: Lobby }
	| { readonly type: "seat-result"; readonly result: SeatResult }
	| { readonly type: "release-result"; readonly result: ReleaseResult }
	| { readonly type: "roster"; readonly roster: Roster }
	/** Own commands that a replacement log does not contain: "Undone after a host change". */
	| { readonly type: "undone"; readonly entries: readonly Entry[] }
	/** A claim pull ended, with or without a better log. */
	| { readonly type: "pulled" }
	| { readonly type: "gone"; readonly reason: GoneReason }
	/** A write failed; `conflict` means another tab writes this partition. */
	| { readonly type: "storage"; readonly code: StorageCode };

export interface FollowerDeps {
	readonly tableId: string;
	/** This browser's client id; only the followed host receives it. */
	readonly client: string;
	readonly send: Send;
	readonly clock: Clock;
	readonly onEvent: (event: FollowerEvent) => void;
}

const TERMINAL: readonly FollowerStatus[] = [
	"superseded",
	"expired",
	"incompatible",
];

interface Pending {
	readonly request: SyncRequest;
	/** `follow` syncs with the followed host; `pull` is the claim pull. */
	readonly purpose: "follow" | "pull";
	readonly deadline: number;
}

function positionOf(table: TableRecord | null): Position {
	return table ? { rev: table.rev, lastAuth: table.lastAuth } : EMPTY_POSITION;
}

/** Own commands of the old log that the new log does not have. */
function undoneEntries(
	seat: Seat,
	previous: readonly Entry[],
	next: readonly Entry[],
): Entry[] {
	const kept = new Set(next.map((entry) => entry.id));
	return previous.filter(
		(entry) =>
			entry.kind === "cmd" && entry.seat === seat && !kept.has(entry.id),
	);
}

export class Follower {
	readonly #deps: FollowerDeps;
	#log: LocalLog | null;
	/** The seat to claim when the host knows this page as a visitor. */
	#want: Seat | null;
	#host: Followed | null = null;
	#status: FollowerStatus = "idle";
	/** This page's generation, restored from its local record and kept across host changes. */
	#gen: number | null = null;
	#sync: Pending | null = null;
	#synced = false;
	#announced = false;
	#early = new Map<number, EntryMessage>();
	#gapSince: number | null = null;
	/** A sequence number the host accepted, from a command result. */
	#ahead = 0;
	#ackDue: number | null = null;
	#req = 0;
	#claimReq: number | null = null;
	#releaseReq: number | null = null;
	#lobby: Lobby | null = null;
	#roster: Roster | null = null;

	constructor(
		deps: FollowerDeps,
		log: LocalLog | null = null,
		want: Seat | null = null,
	) {
		if (log && want !== null && log.seat !== want) {
			throw new Error("the log belongs to another seat");
		}
		this.#deps = deps;
		this.#log = log;
		this.#want = want ?? log?.seat ?? null;
		const row = log?.table?.seats.find((seat) => seat.seat === log.seat);
		if (row && row.holder !== null) this.#gen = row.gen;
	}

	get status(): FollowerStatus {
		return this.#status;
	}

	get host(): Followed | null {
		return this.#host;
	}

	get lobby(): Lobby | null {
		return this.#lobby;
	}

	get roster(): Roster | null {
		return this.#roster;
	}

	get binding(): { readonly seat: Seat; readonly gen: number } | null {
		return this.#log && this.#gen !== null
			? { seat: this.#log.seat, gen: this.#gen }
			: null;
	}

	/** True when bound and in sync with the followed host. */
	get ready(): boolean {
		return this.#status === "bound" && this.#synced;
	}

	/** Follows `host`, or nobody. A terminal status stays. */
	follow(host: Followed | null): void {
		if (TERMINAL.includes(this.#status)) return;
		const current = this.#host;
		const same =
			host === null
				? current === null
				: current !== null &&
					host.peer === current.peer &&
					sameAuthority(host.auth, current.auth);
		if (same) return;
		this.#reset();
		this.#host = host;
		if (host === null) {
			this.#setStatus("idle");
			return;
		}
		if (this.#log?.table) {
			void storeFollowed(this.#log, host.auth).then((result) => {
				if (!result.ok) this.#storage(result.code);
			});
		}
		this.#hello();
	}

	/** The followed host's peer connected again: say hello again. */
	join(peer: string): void {
		if (this.#host?.peer !== peer || TERMINAL.includes(this.#status)) return;
		this.#reset();
		this.#hello();
	}

	leave(peer: string): void {
		if (this.#host?.peer !== peer || TERMINAL.includes(this.#status)) return;
		this.#reset();
		this.#setStatus("hello");
	}

	/** A visitor chose a seat; `log` is its partition (possibly empty). */
	choose(seat: Seat, log: LocalLog): void {
		if (log.seat !== seat) throw new Error("the log belongs to another seat");
		this.#want = seat;
		this.#log = log;
		if (this.#status === "unseated") this.#claim();
	}

	/** This page hosted with generation `gen`; after a step-down, the next host binds it again. */
	adopt(gen: number): void {
		this.#gen = gen;
	}

	/** Asks the followed host to free an offline seat. */
	release(seat: Seat): boolean {
		const host = this.#host;
		if (!host || this.#status !== "bound") return false;
		this.#releaseReq = ++this.#req;
		this.#deps.send.ctl(host.peer, {
			k: "release",
			req: this.#releaseReq,
			seat,
		});
		return true;
	}

	/** An own command was accepted with `seq`; if its entry does not arrive, sync. */
	accepted(seq: number): void {
		this.#ahead = Math.max(this.#ahead, seq);
		this.#checkGap();
	}

	/** The claim pull of election rule 9: sync from `peer`, adopt only a strictly better log. */
	pull(peer: string): void {
		if (!this.#log?.table) {
			this.#deps.onEvent({ type: "pulled" });
			return;
		}
		this.#startSync(peer, "pull");
	}

	cancelPull(): void {
		if (this.#sync?.purpose === "pull") this.#sync = null;
	}

	receive(peer: string, message: CtlMessage): void {
		if (message.k === "behind") {
			this.#syncReply(peer, message);
			return;
		}
		const host = this.#host;
		if (!host || peer !== host.peer || TERMINAL.includes(this.#status)) return;
		switch (message.k) {
			case "welcome":
				this.#welcome(message);
				return;
			case "lobby":
				this.#lobbyMessage(host, message);
				return;
			case "seat-result":
				this.#seatResult(message);
				return;
			case "release-result":
				if (message.req === this.#releaseReq) {
					this.#releaseReq = null;
					this.#deps.onEvent({ type: "release-result", result: message });
				}
				return;
			case "roster":
				if (sameAuthority(message.auth, host.auth)) {
					this.#roster = message;
					this.#deps.onEvent({ type: "roster", roster: message });
				}
				return;
			case "gone":
				if (message.reason === "expired") this.#setStatus("expired");
				this.#deps.onEvent({ type: "gone", reason: message.reason });
				return;
			default:
				return;
		}
	}

	receiveLog(peer: string, message: LogMessage): void {
		if (message.k !== "entry") {
			this.#syncReply(peer, message);
			return;
		}
		const host = this.#host;
		if (!host || peer !== host.peer || this.#status !== "bound") return;
		if (!sameAuthority(message.e.auth, host.auth)) return;
		this.#entry(message);
	}

	tick(): void {
		const now = this.#deps.clock.monotonic();
		const pending = this.#sync;
		if (pending && now >= pending.deadline) {
			this.#sync = null;
			if (pending.purpose === "pull") this.#deps.onEvent({ type: "pulled" });
			else this.#startSync(pending.request.peer, "follow");
		}
		if (
			this.#gapSince !== null &&
			now - this.#gapSince >= GAP_WAIT_MS &&
			this.ready
		) {
			this.#resync();
		}
		const host = this.#host;
		if (this.#ackDue !== null && now >= this.#ackDue && host && this.ready) {
			this.#ackDue = null;
			this.#deps.send.ctl(host.peer, {
				k: "ack",
				rev: this.#log?.position().rev ?? 0,
			});
		}
	}

	// -------------------------------------------------------------------------------------------------------
	// Hello, welcome and seats

	#reset(): void {
		if (this.#sync?.purpose === "follow") this.#sync = null;
		this.#synced = false;
		this.#early.clear();
		this.#gapSince = null;
		this.#ahead = 0;
		this.#claimReq = null;
		this.#releaseReq = null;
		this.#roster = null;
		if (this.#announced) {
			this.#announced = false;
			this.#deps.onEvent({ type: "ready", target: null });
		}
	}

	#hello(): void {
		const host = this.#host;
		if (!host) return;
		const log = this.#log;
		const binding = this.binding;
		this.#deps.send.ctl(host.peer, {
			k: "hello",
			b: LINK_VERSION,
			client: this.#deps.client,
			...(binding ?? {}),
			...(log?.table ? { pos: log.position() } : {}),
		});
		this.#setStatus("hello");
	}

	#welcome(welcome: Welcome): void {
		switch (welcome.status) {
			case "bound":
				if (this.#status !== "hello") return;
				if (welcome.seat === undefined || welcome.gen === undefined) return;
				this.#bound(welcome.seat, welcome.gen);
				return;
			case "unseated":
				if (this.#status !== "hello") return;
				this.#gen = null;
				this.#setStatus("unseated");
				this.#claim();
				return;
			case "superseded":
			case "expired":
			case "incompatible":
				this.#gen = null;
				this.#setStatus(welcome.status);
				return;
		}
	}

	#lobbyMessage(host: Followed, lobby: Lobby): void {
		if (!sameAuthority(lobby.auth, host.auth)) return;
		this.#lobby = lobby;
		this.#deps.onEvent({ type: "lobby", lobby });
		if (this.#status === "unseated") this.#claim();
	}

	/**
	 * Claims the wanted seat once the current host's lobby arrived (so the host has this page's hello). The host
	 * decides; a seat that the lobby shows as taken gets `taken`, and the page is a visitor again.
	 */
	#claim(): void {
		const host = this.#host;
		const seat = this.#want;
		const lobby = this.#lobby;
		if (!host || seat === null || !this.#log || this.#claimReq !== null) return;
		if (!lobby || !sameAuthority(lobby.auth, host.auth)) return;
		this.#claimReq = ++this.#req;
		this.#deps.send.ctl(host.peer, {
			k: "claim-seat",
			req: this.#claimReq,
			seat,
		});
		this.#setStatus("claiming");
	}

	#seatResult(result: SeatResult): void {
		if (result.req !== this.#claimReq) return;
		this.#claimReq = null;
		this.#deps.onEvent({ type: "seat-result", result });
		if (result.ok && result.seat === this.#log?.seat) {
			this.#bound(result.seat, result.gen);
			return;
		}
		if (!result.ok && result.code === "expired") {
			this.#setStatus("expired");
			return;
		}
		// The seat went to someone else; the visitor chooses again. Host trouble keeps the choice.
		if (!result.ok && (result.code === "taken" || result.code === "invalid"))
			this.#want = null;
		this.#setStatus("unseated");
	}

	#bound(seat: Seat, gen: number): void {
		const host = this.#host;
		if (!host || this.#log?.seat !== seat) return;
		this.#gen = gen;
		this.#setStatus("bound");
		this.#startSync(host.peer, "follow");
	}

	#setStatus(status: FollowerStatus): void {
		if (this.#status === status) return;
		this.#status = status;
		this.#deps.onEvent({ type: "status", status });
		if (TERMINAL.includes(status)) this.#reset();
	}

	#storage(code: StorageCode): void {
		this.#deps.onEvent({ type: "storage", code });
	}

	// -------------------------------------------------------------------------------------------------------
	// Sync

	#startSync(peer: string, purpose: Pending["purpose"]): void {
		const log = this.#log;
		if (!log) return;
		const request = new SyncRequest(++this.#req, peer, log.position());
		const deadline = this.#deps.clock.monotonic() + SYNC_TIMEOUT_MS;
		this.#sync = { request, purpose, deadline };
		this.#deps.send.ctl(peer, request.message);
	}

	/** One follow sync at a time; the gap clock restarts, so a lasting gap syncs every GAP_WAIT_MS. */
	#resync(): void {
		const host = this.#host;
		if (!host || this.#status !== "bound" || this.#sync) return;
		if (this.#gapSince !== null) this.#gapSince = this.#deps.clock.monotonic();
		this.#startSync(host.peer, "follow");
	}

	#syncReply(peer: string, message: LogMessage | CtlMessage): void {
		const pending = this.#sync;
		if (
			!pending ||
			(message.k !== "behind" && message.k !== "page" && message.k !== "snap")
		)
			return;
		const progress = pending.request.receive(peer, message);
		if (progress === "pending" || progress === "ignored") return;
		this.#sync = null;
		if (progress === "failed") {
			if (pending.purpose === "pull") this.#deps.onEvent({ type: "pulled" });
			else this.#resync();
			return;
		}
		void this.#finish(pending, progress);
	}

	async #finish(pending: Pending, outcome: SyncOutcome): Promise<void> {
		const adopted =
			outcome.kind === "behind"
				? "skipped"
				: await this.#adopt(pending, outcome);
		if (pending.purpose === "pull") {
			this.#deps.onEvent({ type: "pulled" });
			return;
		}
		if (adopted === "moved") return this.#resync();
		// A host behind this log answers `behind`; its next entry then diverges here, and the sync replaces.
		this.#synced = true;
		this.#markAck();
		this.#drain();
		const host = this.#host;
		if (!this.#announced && host && this.#gen !== null && this.ready) {
			this.#announced = true;
			this.#deps.onEvent({
				type: "ready",
				target: { peer: host.peer, gen: this.#gen },
			});
		}
	}

	/**
	 * Commits a sync outcome when the log is still where the request started. A pull adopts only a strictly
	 * better log. Returns "moved" when the log changed meanwhile.
	 */
	async #adopt(
		pending: Pending,
		outcome: Exclude<SyncOutcome, { kind: "behind" }>,
	): Promise<"written" | "skipped" | "moved"> {
		const log = this.#log;
		if (!log) return "skipped";
		const base = pending.request.base;
		const wall = this.#deps.clock.wall();
		let moved = false;
		let undone: Entry[] = [];
		const result = await log.write((table, current) => {
			if (!samePosition(positionOf(table), base)) {
				moved = true;
				return null;
			}
			if (outcome.kind === "extend") {
				if (!table || outcome.entries.length === 0) return null;
				return appendCommit(table, outcome.entries, outcome.state, wall);
			}
			const { snap } = outcome;
			if (pending.purpose === "pull" && comparePosition(snap.pos, base) <= 0)
				return null;
			undone = undoneEntries(log.seat, current.entries, outcome.entries);
			return replaceCommit(table, {
				tableId: log.tableId,
				replica: log.seat,
				config: snap.config,
				entries: outcome.entries,
				state: outcome.state,
				auth: outcome.auth,
				lastActivityAt: Math.max(0, wall - snap.idleMs),
			});
		});
		if (!result.ok) {
			this.#storage(result.code);
			return "skipped";
		}
		if (moved) return "moved";
		if (undone.length > 0)
			this.#deps.onEvent({ type: "undone", entries: undone });
		return result.value ? "written" : "skipped";
	}

	// -------------------------------------------------------------------------------------------------------
	// Live entries

	#entry(message: EntryMessage): void {
		const log = this.#log;
		if (!log) return;
		const { seq } = message.e;
		const rev = log.position().rev;
		if (seq <= rev) {
			// A duplicate, unless the logs diverged at this entry.
			const mine = log.entry(seq);
			if (this.#synced && !sameAuthority(mine?.auth ?? null, message.e.auth))
				this.#resync();
			return;
		}
		if (seq !== rev + 1 && this.#early.size >= EARLY_ENTRIES) {
			this.#checkGap();
			return;
		}
		this.#early.set(seq, message);
		if (this.#synced && !this.#sync) this.#drain();
		else this.#checkGap();
	}

	/** Applies the buffered entries that continue the log; a prevAuth mismatch syncs at once. */
	#drain(): void {
		const log = this.#log;
		if (!log) return;
		const wall = this.#deps.clock.wall();
		let diverged = false;
		const written = log.write((table) => {
			if (!table) return null;
			const run: Entry[] = [];
			let pos = positionOf(table);
			let state = table.state;
			for (;;) {
				const next = this.#early.get(pos.rev + 1);
				if (!next) break;
				if (!sameAuthority(next.e.prevAuth, pos.lastAuth)) {
					diverged = true;
					break;
				}
				run.push(next.e);
				state = next.state;
				pos = { rev: next.e.seq, lastAuth: next.e.auth };
			}
			return run.length > 0 ? appendCommit(table, run, state, wall) : null;
		});
		void written.then((result) => {
			if (!result.ok) return this.#storage(result.code);
			const rev = log.position().rev;
			for (const seq of this.#early.keys()) {
				if (seq <= rev) this.#early.delete(seq);
			}
			if (result.value) this.#markAck();
			if (diverged) return this.#resync();
			this.#checkGap();
		});
	}

	/** Starts the gap clock when entries are missing; stops it when the log caught up. */
	#checkGap(): void {
		const rev = this.#log?.position().rev ?? 0;
		const missing =
			this.#ahead > rev || [...this.#early.keys()].some((seq) => seq > rev);
		if (!missing) this.#gapSince = null;
		else this.#gapSince ??= this.#deps.clock.monotonic();
	}

	#markAck(): void {
		this.#ackDue ??= this.#deps.clock.monotonic() + ACK_DEBOUNCE_MS;
	}
}
