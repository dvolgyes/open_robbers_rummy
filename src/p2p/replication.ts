import type { GameModule } from "../game/module";
import type { JsonObject, Seat } from "../protocol";
import { type Authority, sameAuthority } from "./authority";
import type { ElectionEffect } from "./election";
import { Follower, type FollowerEvent } from "./follower";
import { HostEngine, type HostStop } from "./host-engine";
import { type LocalLog, storeClaim } from "./log";
import { Outbox, type OutboxEvent, type SubmitResult } from "./outbox";
import type { Clock, Send } from "./ports";
import type { OutboxRecord } from "./records";
import type { TableStorage } from "./storage";
import { answerSync } from "./sync";
import type {
	AutoplayStatus,
	CtlMessage,
	LogMessage,
	ReleaseResult,
} from "./wire";

/**
 * One page's replication (plan §4.5): it routes messages to the host engine, the follower, the outbox and the
 * sync responder, and carries out the election's replication effects. Messages to this page's own peer id loop
 * back in a microtask, so the host's own commands take the same path as everyone else's.
 */

export type ReplicationEvent =
	| Exclude<FollowerEvent, { readonly type: "pulled" }>
	| OutboxEvent
	/** Answers to the election's `pull` and `store` effects. */
	| { readonly type: "pulled"; readonly auth: Authority }
	| { readonly type: "stored"; readonly auth: Authority; readonly ok: boolean }
	/** The host engine stopped on its own; this page should not host. */
	| { readonly type: "host-stopped"; readonly reason: HostStop };

export interface ReplicationDeps {
	readonly tableId: string;
	/** This browser's client id for the table. */
	readonly client: string;
	/** This page's peer id. */
	readonly self: string;
	readonly storage: TableStorage;
	/** Sends to other peers; null means every other peer. */
	readonly send: Send;
	readonly clock: Clock;
	readonly module: GameModule;
	readonly newId: () => string;
	readonly onEvent: (event: ReplicationEvent) => void;
}

export interface Seated {
	readonly log: LocalLog;
	readonly outbox: readonly OutboxRecord[];
}

export class Replication {
	readonly #deps: ReplicationDeps;
	readonly #send: Send;
	readonly follower: Follower;
	/** Connected peers, so that an engine that starts later knows the players who are already here. */
	readonly #peers = new Set<string>();
	#log: LocalLog | null = null;
	#outbox: Outbox | null = null;
	#engine: HostEngine | null = null;
	#hostAuth: Authority | null = null;
	#pullAuth: Authority | null = null;
	#req = 0;
	#releaseReq: number | null = null;
	#autoplayReq = 0;
	readonly #autoplayPending = new Map<
		number,
		{
			readonly peer: string;
			readonly timeout: ReturnType<typeof globalThis.setTimeout>;
			readonly resolve: (status: AutoplayStatus) => void;
		}
	>();
	#autoplayHandler: (seat: Seat, enabled: boolean) => Promise<AutoplayStatus> =
		async () => "unavailable";

	constructor(deps: ReplicationDeps, seated: Seated | null) {
		this.#deps = deps;
		const { self } = deps;
		this.#send = {
			ctl: (to, message) => {
				if (to === self) queueMicrotask(() => this.receiveCtl(self, message));
				else deps.send.ctl(to, message);
			},
			log: (to, message) => {
				if (to === self) queueMicrotask(() => this.receiveLog(self, message));
				else deps.send.log(to, message);
			},
		};
		this.follower = new Follower(
			{
				tableId: deps.tableId,
				client: deps.client,
				send: this.#send,
				clock: deps.clock,
				onEvent: (event) => this.#followerEvent(event),
			},
			seated?.log ?? null,
		);
		if (seated) this.#seat(seated);
	}

	get log(): LocalLog | null {
		return this.#log;
	}

	get outbox(): Outbox | null {
		return this.#outbox;
	}

	get engine(): HostEngine | null {
		return this.#engine;
	}

	/** A visitor chose a seat; the page holds its lock and opened its partition. */
	choose(seated: Seated): void {
		if (this.#log) throw new Error("this page already has a seat");
		this.#seat(seated);
		this.follower.choose(seated.log.seat, seated.log);
	}

	submit(payload: JsonObject): Promise<SubmitResult> {
		const outbox = this.#outbox;
		if (!outbox) {
			return Promise.resolve({ ok: false, code: "storage" });
		}
		return outbox.submit(this.#deps.newId(), payload);
	}

	/** Asks the host, or this page's own engine, to free an offline seat. */
	release(seat: Seat): boolean {
		if (!this.#engine) return this.follower.release(seat);
		this.#releaseReq = ++this.#req;
		this.#send.ctl(this.#deps.self, {
			k: "release",
			req: this.#releaseReq,
			seat,
		});
		return true;
	}

	receiveCtl(peer: string, message: CtlMessage): void {
		const engine = this.#engine;
		if (engine) engine.receive(peer, message);
		else this.#notHost(peer, message);
		switch (message.k) {
			case "sync":
				this.#answer(peer, message);
				return;
			case "result":
				this.#outbox?.receive(peer, message);
				return;
			case "release-result":
				if (engine && peer === this.#deps.self) this.#ownRelease(message);
				else this.follower.receive(peer, message);
				return;
			case "autoplay-result":
				{
					const pending = this.#autoplayPending.get(message.req);
					if (pending?.peer !== peer) return;
					pending.resolve(message.status);
					this.#autoplayPending.delete(message.req);
				}
				return;
			case "welcome":
			case "lobby":
			case "seat-result":
			case "roster":
			case "gone":
			case "behind":
				this.follower.receive(peer, message);
				return;
			default:
				return;
		}
	}

	receiveLog(peer: string, message: LogMessage): void {
		this.follower.receiveLog(peer, message);
	}

	join(peer: string): void {
		this.#peers.add(peer);
		this.#engine?.join(peer);
		this.follower.join(peer);
	}

	leave(peer: string): void {
		this.#peers.delete(peer);
		this.#engine?.leave(peer);
		this.follower.leave(peer);
	}

	activateBots(seats: readonly import("../protocol").Seat[]): Promise<boolean> {
		return this.#engine?.activateBots(seats) ?? Promise.resolve(false);
	}

	setBotSeat(
		seat: import("../protocol").Seat,
		enabled: boolean,
	): Promise<boolean> {
		return this.#engine?.setBotSeat(seat, enabled) ?? Promise.resolve(false);
	}

	setAutoplayHandler(
		handler: (seat: Seat, enabled: boolean) => Promise<AutoplayStatus>,
	): void {
		this.#autoplayHandler = handler;
	}

	requestAutoplay(enabled: boolean): Promise<AutoplayStatus> {
		const req = ++this.#autoplayReq;
		const peer = this.#engine ? this.#deps.self : this.follower.host?.peer;
		if (!peer) return Promise.resolve("failed");
		return new Promise((resolve) => {
			const timeout = globalThis.setTimeout(() => {
				this.#autoplayPending.delete(req);
				resolve("failed");
			}, 15_000);
			this.#autoplayPending.set(req, {
				peer,
				timeout,
				resolve: (status) => {
					globalThis.clearTimeout(timeout);
					resolve(status);
				},
			});
			this.#send.ctl(peer, {
				k: "autoplay-request",
				req,
				enabled,
			});
		});
	}

	localBotCommand(
		seat: import("../protocol").Seat,
		id: string,
		payload: import("../protocol").JsonObject,
	): Promise<
		{ readonly ok: true } | { readonly ok: false; readonly reason: string }
	> {
		return (
			this.#engine?.localCommand(seat, id, payload) ??
			Promise.resolve({
				ok: false,
				reason: "this page is not the host",
			})
		);
	}

	tick(): void {
		this.#engine?.tick();
		this.follower.tick();
		this.#outbox?.tick();
	}

	/** Carries out one election effect; beats are the controller's. */
	apply(effect: ElectionEffect): void {
		switch (effect.type) {
			case "beat":
				return;
			case "pull":
				this.#pullAuth = effect.auth;
				this.follower.pull(effect.peer);
				return;
			case "store":
				this.#store(effect.auth);
				return;
			case "host":
				this.#host(effect.auth);
				return;
			case "step-down":
				this.#stepDown();
				return;
			case "follow":
				this.follower.follow(effect.host);
				return;
		}
	}

	dispose(): void {
		this.#engine?.stop();
		this.#engine = null;
		for (const pending of this.#autoplayPending.values()) {
			globalThis.clearTimeout(pending.timeout);
			pending.resolve("failed");
		}
		this.#autoplayPending.clear();
		this.#outbox?.dispose();
	}

	// -------------------------------------------------------------------------------------------------------

	#seat(seated: Seated): void {
		this.#log = seated.log;
		this.#outbox = new Outbox(
			{
				storage: this.#deps.storage,
				send: this.#send,
				clock: this.#deps.clock,
				onEvent: (event) => this.#outboxEvent(event),
			},
			seated.log,
			seated.outbox,
		);
	}

	#store(auth: Authority): void {
		const log = this.#log;
		if (!log) {
			this.#deps.onEvent({ type: "stored", auth, ok: false });
			return;
		}
		void storeClaim(log, auth).then((result) => {
			const host = log.table?.host ?? null;
			const ok = result.ok && sameAuthority(host, auth);
			this.#deps.onEvent({ type: "stored", auth, ok });
		});
	}

	#host(auth: Authority): void {
		const log = this.#log;
		if (!log) throw new Error("only a seated page can host");
		this.follower.cancelPull();
		this.#engine?.stop();
		const engine = new HostEngine({
			log,
			auth,
			self: this.#deps.self,
			module: this.#deps.module,
			send: this.#send,
			clock: this.#deps.clock,
			newId: this.#deps.newId,
			autoplay: (seat, enabled) => this.#autoplayHandler(seat, enabled),
			onStop: (reason) => {
				if (this.#engine === engine) {
					this.#deps.onEvent({ type: "host-stopped", reason });
				}
			},
		});
		for (const peer of this.#peers) engine.join(peer);
		this.#engine = engine;
		this.#hostAuth = auth;
		const own = log.table?.seats.find((row) => row.seat === log.seat);
		if (own) {
			this.follower.adopt(own.gen);
			this.#outbox?.connect({ peer: this.#deps.self, gen: own.gen });
		}
	}

	#stepDown(): void {
		const engine = this.#engine;
		if (!engine) return;
		engine.stop();
		this.#engine = null;
		this.#hostAuth = null;
		this.#outbox?.connect(null);
	}

	/** A page that does not host tells a requester at once, so its outbox retries soon. */
	#notHost(peer: string, message: CtlMessage): void {
		if (peer === this.#deps.self) return;
		if (message.k === "cmd") {
			this.#send.ctl(peer, {
				k: "result",
				id: message.id,
				status: "not_host",
			});
		} else if (message.k === "claim-seat") {
			this.#send.ctl(peer, {
				k: "seat-result",
				req: message.req,
				ok: false,
				code: "not_host",
			});
		} else if (message.k === "release") {
			this.#send.ctl(peer, {
				k: "release-result",
				req: message.req,
				ok: false,
				code: "not_host",
			});
		} else if (message.k === "autoplay-request") {
			this.#send.ctl(peer, {
				k: "autoplay-result",
				req: message.req,
				status: "failed",
			});
		}
	}

	#answer(peer: string, message: Extract<CtlMessage, { k: "sync" }>): void {
		const log = this.#log;
		const reply = answerSync(
			{
				tableId: this.#deps.tableId,
				auth: this.#hostAuth ?? this.follower.host?.auth ?? null,
				table: log?.table ?? null,
				entries: log?.entries ?? [],
				now: this.#deps.clock.wall(),
			},
			message,
		);
		if (reply.kind === "behind") this.#send.ctl(peer, reply.message);
		else for (const part of reply.messages) this.#send.log(peer, part);
	}

	#ownRelease(result: ReleaseResult): void {
		if (result.req !== this.#releaseReq) return;
		this.#releaseReq = null;
		this.#deps.onEvent({ type: "release-result", result });
	}

	#followerEvent(event: FollowerEvent): void {
		if (event.type === "ready") {
			// While this page hosts, its outbox sends to its own engine.
			if (!this.#engine) this.#outbox?.connect(event.target);
		} else if (event.type === "pulled") {
			const auth = this.#pullAuth;
			this.#pullAuth = null;
			if (auth) this.#deps.onEvent({ type: "pulled", auth });
			return;
		}
		this.#deps.onEvent(event);
	}

	#outboxEvent(event: OutboxEvent): void {
		if (event.type === "accepted") this.follower.accepted(event.seq);
		this.#deps.onEvent(event);
	}
}
