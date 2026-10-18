import { backoffMs } from "../backoff";
import type { JsonObject } from "../protocol";
import type { Target } from "./follower";
import { MAX_OUTBOX, RESULT_TIMEOUT_MS, WAITING_RETRY_MS } from "./limits";
import type { LocalLog } from "./log";
import type { Clock, Send } from "./ports";
import type { OutboxRecord } from "./records";
import type { StorageCode, TableStorage } from "./storage";
import type { CommandResult, CommandStatus } from "./wire";

/**
 * Own commands that are not in the log yet (plan §4.5). A command is stored before it is sent, so a reload or a
 * host change resends it with the same id, and the host's deduplication answers a command it already has. The
 * log commit that contains a command deletes its record in the same transaction; this queue then drops it.
 */

export type OutboxItemState =
	/** Waiting for a host, or for a retry. */
	| "queued"
	/** Sent; waiting for the result. */
	| "sent"
	/** The host accepted it; waiting for its entry. */
	| "accepted";

export interface OutboxItem {
	readonly id: string;
	readonly payload: JsonObject;
	readonly order: number;
	readonly state: OutboxItemState;
	/** The host's reason while the command waits for absent players; the next other result clears it. */
	readonly waiting?: string;
}

/** Results that end a command without an entry. */
export type FailedStatus = Extract<
	CommandStatus,
	"rejected" | "invalid" | "full"
>;

export type OutboxEvent =
	| { readonly type: "changed" }
	| { readonly type: "accepted"; readonly id: string; readonly seq: number }
	| {
			readonly type: "failed";
			readonly id: string;
			readonly payload: JsonObject;
			readonly status: FailedStatus;
			readonly reason?: string;
	  }
	/** The host answered `superseded` or `expired`; nothing more is sent. */
	| { readonly type: "stopped"; readonly status: "superseded" | "expired" }
	| { readonly type: "storage"; readonly code: StorageCode };

export type SubmitResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "full" | StorageCode };

export interface OutboxDeps {
	readonly storage: TableStorage;
	readonly send: Send;
	readonly clock: Clock;
	readonly onEvent: (event: OutboxEvent) => void;
}

interface Item extends OutboxItem {
	/** Failed sends since the last success; sets the retry delay. */
	readonly attempt: number;
	/** Monotonic time of the next send (queued) or of the result timeout (sent). */
	readonly dueAt: number;
}

const RETRY: readonly CommandStatus[] = ["busy", "storage", "not_host"];

function isFailed(status: CommandStatus): status is FailedStatus {
	return status === "rejected" || status === "invalid" || status === "full";
}

export class Outbox {
	readonly #deps: OutboxDeps;
	readonly #log: LocalLog;
	readonly #items = new Map<string, Item>();
	readonly #unsubscribe: () => void;
	#target: Target | null = null;
	#stopped = false;
	#order: number;

	constructor(
		deps: OutboxDeps,
		log: LocalLog,
		records: readonly OutboxRecord[],
	) {
		this.#deps = deps;
		this.#log = log;
		const sorted = [...records].sort((a, b) => a.order - b.order);
		for (const record of sorted) {
			if (record.tableId !== log.tableId || record.replica !== log.seat) {
				throw new Error("the outbox record belongs to another partition");
			}
			this.#items.set(record.id, {
				id: record.id,
				payload: record.payload,
				order: record.order,
				state: "queued",
				attempt: 0,
				dueAt: 0,
			});
		}
		this.#order = (sorted.at(-1)?.order ?? 0) + 1;
		this.#unsubscribe = log.subscribe(() => this.#dropLogged());
	}

	get items(): readonly OutboxItem[] {
		return [...this.#items.values()].map(
			({ id, payload, order, state, waiting }) => ({
				id,
				payload,
				order,
				state,
				...(waiting === undefined ? {} : { waiting }),
			}),
		);
	}

	/** Stores the command, then sends it when a host is connected. */
	async submit(id: string, payload: JsonObject): Promise<SubmitResult> {
		if (this.#items.size >= MAX_OUTBOX) return { ok: false, code: "full" };
		const order = this.#order++;
		const stored = await this.#deps.storage.putOutbox({
			tableId: this.#log.tableId,
			replica: this.#log.seat,
			id,
			order,
			payload,
		});
		if (!stored.ok) return { ok: false, code: stored.code };
		this.#items.set(id, {
			id,
			payload,
			order,
			state: "queued",
			attempt: 0,
			dueAt: 0,
		});
		this.#changed();
		this.tick();
		return { ok: true };
	}

	/** A host is ready for this seat's commands (after its sync), or none is. Everything queued goes again. */
	connect(target: Target | null): void {
		if (this.#stopped) return;
		this.#target = target;
		const now = this.#deps.clock.monotonic();
		for (const item of this.#items.values()) {
			this.#items.set(item.id, {
				...item,
				state: "queued",
				attempt: 0,
				dueAt: now,
			});
		}
		this.#dropLogged();
		this.tick();
	}

	receive(peer: string, result: CommandResult): void {
		const found = this.#items.get(result.id);
		if (!found || peer !== this.#target?.peer || found.state !== "sent") return;
		const now = this.#deps.clock.monotonic();
		const { status } = result;
		if (status === "waiting") {
			this.#items.set(found.id, {
				...found,
				state: "queued",
				attempt: 0,
				dueAt: now + WAITING_RETRY_MS,
				waiting: result.reason ?? "Waiting for the other players",
			});
			this.#changed();
			return;
		}
		const { waiting: _ended, ...item } = found;
		if (status === "accepted") {
			this.#items.set(item.id, { ...item, state: "accepted", attempt: 0 });
			this.#changed();
			if (result.seq !== undefined)
				this.#deps.onEvent({ type: "accepted", id: item.id, seq: result.seq });
			return;
		}
		if (RETRY.includes(status)) {
			this.#retry(item, now);
			return;
		}
		if (isFailed(status)) {
			this.#items.delete(item.id);
			this.#changed();
			void this.#deps.storage
				.deleteOutbox(this.#log.tableId, this.#log.seat, item.id)
				.then((done) => {
					if (!done.ok)
						this.#deps.onEvent({ type: "storage", code: done.code });
				});
			this.#deps.onEvent({
				type: "failed",
				id: item.id,
				payload: item.payload,
				status,
				...(result.reason === undefined ? {} : { reason: result.reason }),
			});
			return;
		}
		if (status === "superseded" || status === "expired") {
			this.#stopped = true;
			this.#target = null;
			this.#retry(item, now);
			this.#deps.onEvent({ type: "stopped", status });
		}
	}

	/** Sends queued commands that are due, in order; a result that does not come in time sends again. */
	tick(): void {
		const target = this.#target;
		const now = this.#deps.clock.monotonic();
		for (const item of this.#items.values()) {
			if (item.state === "sent" && now >= item.dueAt) this.#retry(item, now);
		}
		if (!target || this.#stopped) return;
		const due = [...this.#items.values()]
			.filter((item) => item.state === "queued" && now >= item.dueAt)
			.sort((a, b) => a.order - b.order);
		for (const item of due) {
			this.#items.set(item.id, {
				...item,
				state: "sent",
				dueAt: now + RESULT_TIMEOUT_MS,
			});
			this.#deps.send.ctl(target.peer, {
				k: "cmd",
				id: item.id,
				gen: target.gen,
				payload: item.payload,
			});
		}
		if (due.length > 0) this.#changed();
	}

	dispose(): void {
		this.#unsubscribe();
		this.#target = null;
	}

	#retry(item: Item, now: number): void {
		this.#items.set(item.id, {
			...item,
			state: "queued",
			attempt: item.attempt + 1,
			dueAt: now + backoffMs(item.attempt),
		});
		this.#changed();
	}

	/** The log commit that contains a command already deleted its record. */
	#dropLogged(): void {
		let changed = false;
		for (const id of this.#items.keys()) {
			if (this.#log.seqOf(id) !== undefined) {
				this.#items.delete(id);
				changed = true;
			}
		}
		if (changed) this.#changed();
	}

	#changed(): void {
		this.#deps.onEvent({ type: "changed" });
	}
}
