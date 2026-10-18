import type { JsonObject } from "../protocol";
import {
	type Authority,
	compareAuthority,
	comparePosition,
	EMPTY_POSITION,
	type Position,
	sameAuthority,
} from "./authority";
import { idleMs } from "./expiry";
import { MAX_PAGE_BYTES, MAX_PAGE_ENTRIES } from "./limits";
import type { TableRecord } from "./records";
import {
	type Behind,
	type Entry,
	frame,
	jsonBytes,
	type LogMessage,
	type Page,
	type Snapshot,
	type Sync,
} from "./wire";

/**
 * The sync protocol (plan §4.5). The requester sends its position. The responder answers with the entries after
 * it (extend) when its log contains that position; with a snapshot and its whole log (replace) when the logs
 * diverge and its position or active host authority is better; and with `behind` otherwise. A new host can supersede
 * an unreplicated tail from the previous host even when that old log has a larger revision.
 * Refinement of the plan's "pos.rev greater than the responder's rev → behind": the test is "the responder's
 * position is not better", which also covers a diverged log that is longer than the requester's.
 */

export interface SyncSource {
	readonly tableId: string;
	/** The authority the responder is or follows. */
	readonly auth: Authority | null;
	readonly table: TableRecord | null;
	/** Entries 1..table.rev. */
	readonly entries: readonly Entry[];
	/** Wall clock, for the snapshot's idle time. */
	readonly now: number;
}

export type SyncReply =
	| { readonly kind: "behind"; readonly message: Behind }
	| { readonly kind: "log"; readonly messages: readonly LogMessage[] };

export function samePosition(a: Position, b: Position): boolean {
	return a.rev === b.rev && sameAuthority(a.lastAuth, b.lastAuth);
}

export function answerSync(source: SyncSource, request: Sync): SyncReply {
	const { table, entries } = source;
	const { req, pos } = request;
	if (!table) {
		return {
			kind: "behind",
			message: { k: "behind", req, pos: EMPTY_POSITION },
		};
	}
	const own: Position = { rev: table.rev, lastAuth: table.lastAuth };
	const contained =
		pos.rev > 0 &&
		pos.rev <= table.rev &&
		sameAuthority(entries[pos.rev - 1]?.auth ?? null, pos.lastAuth);
	if (contained) {
		const after = entries.slice(pos.rev, table.rev);
		return { kind: "log", messages: paginate(source, req, pos, after) };
	}
	if (
		comparePosition(own, pos) <= 0 &&
		compareAuthority(source.auth, pos.lastAuth) <= 0
	) {
		return { kind: "behind", message: { k: "behind", req, pos: own } };
	}
	const snap: Snapshot = {
		k: "snap",
		req,
		auth: source.auth,
		mode: "replace",
		config: table.config,
		seats: table.seats,
		pos: own,
		idleMs: idleMs(table.lastActivityAt, source.now),
	};
	const all = entries.slice(0, table.rev);
	return {
		kind: "log",
		messages: [snap, ...paginate(source, req, EMPTY_POSITION, all)],
	};
}

function pageBytes(tableId: string, page: Page): number {
	return jsonBytes(frame(tableId, page));
}

/**
 * Pages of at most MAX_PAGE_ENTRIES entries and MAX_PAGE_BYTES framed bytes, state included on the last page.
 * A page's size is its size without entries, plus the entries and the commas between them. When the state does
 * not fit beside the last entries, an extra last page without entries carries it.
 */
function paginate(
	source: SyncSource,
	req: number,
	base: Position,
	entries: readonly Entry[],
): Page[] {
	const { tableId, auth } = source;
	const state = source.table?.state ?? {};
	const pages: Page[] = [];
	const empty = (start: Position): Page => ({
		k: "page",
		req,
		auth,
		base: start,
		entries: [],
		last: false,
	});
	let start = base;
	let chunk: Entry[] = [];
	let overhead = pageBytes(tableId, empty(start));
	let bytes = 0;
	const close = (): void => {
		pages.push({ ...empty(start), entries: chunk });
		const end = chunk.at(-1);
		if (end) start = { rev: end.seq, lastAuth: end.auth };
		chunk = [];
		overhead = pageBytes(tableId, empty(start));
		bytes = 0;
	};
	for (const entry of entries) {
		const size = jsonBytes(entry);
		const comma = chunk.length > 0 ? 1 : 0;
		if (
			chunk.length === MAX_PAGE_ENTRIES ||
			(chunk.length > 0 && overhead + bytes + comma + size > MAX_PAGE_BYTES)
		) {
			close();
			bytes = size;
		} else {
			bytes += comma + size;
		}
		chunk.push(entry);
	}
	const last = (start: Position, list: Entry[]): Page => ({
		k: "page",
		req,
		auth,
		base: start,
		entries: list,
		last: true,
		state,
	});
	if (
		chunk.length > 0 &&
		pageBytes(tableId, last(start, chunk)) > MAX_PAGE_BYTES
	) {
		close();
	}
	pages.push(last(start, chunk));
	return pages;
}

export type SyncOutcome =
	| { readonly kind: "behind"; readonly pos: Position }
	| {
			readonly kind: "extend";
			readonly base: Position;
			readonly entries: readonly Entry[];
			readonly state: JsonObject;
			readonly auth: Authority | null;
	  }
	| {
			readonly kind: "replace";
			readonly snap: Snapshot;
			readonly entries: readonly Entry[];
			readonly state: JsonObject;
			readonly auth: Authority | null;
	  };

export type SyncProgress = SyncOutcome | "pending" | "ignored" | "failed";

/**
 * One outstanding sync request: collects the reply of one peer until its last page. Messages of other peers
 * or requests are ignored; a reply out of order fails the request.
 */
export class SyncRequest {
	readonly req: number;
	readonly peer: string;
	readonly base: Position;
	#snap: Snapshot | null = null;
	#entries: Entry[] = [];
	#next: Position;
	#started = false;
	#failed = false;

	constructor(req: number, peer: string, base: Position) {
		this.req = req;
		this.peer = peer;
		this.base = base;
		this.#next = base;
	}

	get message(): Sync {
		return { k: "sync", req: this.req, pos: this.base };
	}

	receive(peer: string, message: Behind | Page | Snapshot): SyncProgress {
		if (peer !== this.peer || message.req !== this.req) return "ignored";
		if (this.#failed) return "failed";
		const progress = this.#step(message);
		if (progress === "failed") this.#failed = true;
		return progress;
	}

	#step(message: Behind | Page | Snapshot): SyncProgress {
		if (message.k === "behind") {
			return this.#started ? "failed" : { kind: "behind", pos: message.pos };
		}
		if (message.k === "snap") {
			if (this.#started) return "failed";
			this.#started = true;
			this.#snap = message;
			this.#next = EMPTY_POSITION;
			return "pending";
		}
		if (!samePosition(message.base, this.#next)) return "failed";
		this.#started = true;
		this.#entries.push(...message.entries);
		const end = message.entries.at(-1);
		if (end) this.#next = { rev: end.seq, lastAuth: end.auth };
		if (!message.last) return "pending";
		const state = message.state ?? {};
		const snap = this.#snap;
		if (snap === null) {
			return {
				kind: "extend",
				base: this.base,
				entries: this.#entries,
				state,
				auth: message.auth,
			};
		}
		if (!samePosition(this.#next, snap.pos)) return "failed";
		return {
			kind: "replace",
			snap,
			entries: this.#entries,
			state,
			auth: message.auth,
		};
	}
}
