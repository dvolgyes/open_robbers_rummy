import {
	envelopeEvent,
	type JsonObject,
	type RoomConfig,
	SEATS,
	type Seat,
} from "../protocol";
import {
	type Authority,
	compareAuthority,
	EMPTY_POSITION,
	type Position,
} from "./authority";
import type { OutboxRecord, TableRecord } from "./records";
import type { Commit, StorageResult, TableStorage } from "./storage";
import type { Entry, SeatHolder } from "./wire";

/**
 * The local copy of one replica partition: the table record and its log in memory, kept equal
 * to storage. Commits run one at a time; each is built from the latest copy at the head of the queue, so two
 * writers in one page never build on the same revision. Only the tab that holds the seat lock opens the log.
 */

export interface LogChange {
	/** The entries that the commit added, in order. */
	readonly appended: readonly Entry[];
	/** True when the commit created the log or replaced all of it. */
	readonly replaced: boolean;
	/** The entries before a replace; empty otherwise. */
	readonly previous: readonly Entry[];
}

/** Builds a commit from the current table record (null before the first commit), or null to write nothing. */
export type Build = (table: TableRecord | null, log: LocalLog) => Commit | null;

const NO_SEATS: readonly SeatHolder[] = SEATS.map((seat) => ({
	seat,
	holder: null,
	gen: 0,
}));

export class LocalLog {
	readonly tableId: string;
	readonly seat: Seat;
	readonly #storage: TableStorage;
	#table: TableRecord | null;
	#entries: Entry[];
	/** Command id → sequence number. */
	#ids = new Map<string, number>();
	#queue: Promise<unknown> = Promise.resolve();
	#expired = false;
	readonly #listeners = new Set<(change: LogChange) => void>();

	constructor(
		storage: TableStorage,
		tableId: string,
		seat: Seat,
		table: TableRecord | null = null,
		entries: readonly Entry[] = [],
	) {
		if (table && (table.tableId !== tableId || table.replica !== seat)) {
			throw new Error("the record belongs to another partition");
		}
		this.#storage = storage;
		this.tableId = tableId;
		this.seat = seat;
		this.#table = table;
		this.#entries = [...entries];
		this.#index(this.#entries);
	}

	get persistent(): boolean {
		return this.#storage.persistent;
	}

	get table(): TableRecord | null {
		return this.#table;
	}

	get entries(): readonly Entry[] {
		return this.#entries;
	}

	get expired(): boolean {
		return this.#expired;
	}

	position(): Position {
		const table = this.#table;
		return table
			? { rev: table.rev, lastAuth: table.lastAuth }
			: EMPTY_POSITION;
	}

	entry(seq: number): Entry | undefined {
		return this.#entries[seq - 1];
	}

	/** The sequence number of the command with this id, if the log has it. */
	seqOf(id: string): number | undefined {
		return this.#ids.get(id);
	}

	/** Calls `listener` after each successful commit; returns the unsubscribe function. */
	subscribe(listener: (change: LogChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Queues one commit. Resolves to true when it was written, false when `build` returned null. A storage
	 * failure leaves the copy unchanged. An exception from `build` or storage (a caller bug) rejects.
	 */
	write(build: Build): Promise<StorageResult<boolean>> {
		const run = async (): Promise<StorageResult<boolean>> => {
			if (this.#expired) {
				return { ok: false, code: "expired", detail: "the table expired" };
			}
			const change = build(this.#table, this);
			if (change === null) return { ok: true, value: false };
			const done = await this.#storage.commit(change);
			if (!done.ok) return done;
			this.#apply(change);
			return { ok: true, value: true };
		};
		const result = this.#queue.then(run);
		this.#queue = result.catch(() => undefined);
		return result;
	}

	/** Deletes every partition of the table in this browser and records its tombstone. */
	expire(now: number): Promise<StorageResult<void>> {
		const run = async (): Promise<StorageResult<void>> => {
			this.#expired = true;
			this.#table = null;
			this.#entries = [];
			this.#ids.clear();
			return this.#storage.expireTable(this.tableId, now);
		};
		const result = this.#queue.then(run);
		this.#queue = result.catch(() => undefined);
		return result;
	}

	#apply(change: Commit): void {
		const replaced = change.expect === null || change.replace === true;
		const previous = replaced ? this.#entries : [];
		if (replaced) {
			this.#entries = [...change.append];
			this.#ids.clear();
			this.#index(this.#entries);
		} else {
			this.#entries.push(...change.append);
			this.#index(change.append);
		}
		this.#table = change.table;
		const notice: LogChange = { appended: change.append, replaced, previous };
		for (const listener of this.#listeners) listener(notice);
	}

	#index(entries: readonly Entry[]): void {
		for (const entry of entries) {
			if (entry.kind === "cmd") this.#ids.set(entry.id, entry.seq);
		}
	}
}

/** Loads the partition; an absent partition gives an empty log. */
export async function openLog(
	storage: TableStorage,
	tableId: string,
	seat: Seat,
): Promise<StorageResult<{ log: LocalLog; outbox: readonly OutboxRecord[] }>> {
	const loaded = await storage.load(tableId, seat);
	if (!loaded.ok) return loaded;
	const replica = loaded.value;
	const log = new LocalLog(
		storage,
		tableId,
		seat,
		replica?.table ?? null,
		replica?.entries ?? [],
	);
	return { ok: true, value: { log, outbox: replica?.outbox ?? [] } };
}

export function betterAuthority(a: Authority, b: Authority | null): Authority {
	return b === null || compareAuthority(a, b) >= 0 ? a : b;
}

/** The seat holders after `entries`: a claim gives the seat to its holder, a release frees it. */
export function seatsAfter(
	seats: readonly SeatHolder[],
	entries: readonly Entry[],
): SeatHolder[] {
	const rows = new Map(seats.map((row) => [row.seat, row]));
	for (const entry of entries) {
		if (entry.kind !== "seat") continue;
		const holder = entry.op.type === "claim" ? entry.op.holder : null;
		rows.set(entry.seat, { seat: entry.seat, holder, gen: entry.gen });
	}
	return SEATS.map((seat) => rows.get(seat) ?? { seat, holder: null, gen: 0 });
}

/** Ids of the replica's own commands in `entries`, which leave its outbox in the same transaction. */
function ownCommands(replica: Seat, entries: readonly Entry[]): string[] {
	return entries
		.filter((entry) => entry.kind === "cmd" && entry.seat === replica)
		.map((entry) => entry.id);
}

/** The event of a seat entry. A release names the seat that released, as `fromSeat`. */
export function seatEvent(
	tableId: string,
	seq: number,
	id: string,
	seat: Seat,
	change: "claim" | "release",
	by: Seat = seat,
): JsonObject {
	return envelopeEvent(
		{ roomId: tableId, seq, commandId: id, fromSeat: by },
		{ kind: "seat", change, seat },
	);
}

/** Appends `append` to `table`'s log; `state` is the state after the last entry, `now` the wall clock. */
export function appendCommit(
	table: TableRecord,
	append: readonly Entry[],
	state: JsonObject,
	now: number,
): Commit {
	const last = append.at(-1);
	if (!last) throw new Error("nothing to append");
	return {
		table: {
			...table,
			state,
			rev: last.seq,
			lastAuth: last.auth,
			host: betterAuthority(last.auth, table.host),
			seats: seatsAfter(table.seats, append),
			lastActivityAt: now,
		},
		expect: { rev: table.rev, host: table.host },
		append,
		sent: ownCommands(table.replica, append),
	};
}

export interface Replacement {
	readonly tableId: string;
	readonly replica: Seat;
	readonly config: RoomConfig;
	/** The whole new log, from entry 1. */
	readonly entries: readonly Entry[];
	readonly state: JsonObject;
	/** The authority of the source, kept as host when it beats the stored one. */
	readonly auth: Authority | null;
	readonly lastActivityAt: number;
}

/** Replaces the log of `current`, or creates the partition when `current` is null. */
export function replaceCommit(
	current: TableRecord | null,
	next: Replacement,
): Commit {
	const last = next.entries.at(-1);
	if (!last) throw new Error("a replacement needs entries");
	const host = betterAuthority(
		betterAuthority(last.auth, next.auth),
		current?.host ?? null,
	);
	return {
		table: {
			tableId: next.tableId,
			replica: next.replica,
			config: next.config,
			state: next.state,
			rev: last.seq,
			lastAuth: last.auth,
			host,
			inc: current?.inc ?? 0,
			lastActivityAt: next.lastActivityAt,
			seats: seatsAfter(NO_SEATS, next.entries),
		},
		expect: current ? { rev: current.rev, host: current.host } : null,
		...(current ? { replace: true } : {}),
		append: next.entries,
		sent: ownCommands(next.replica, next.entries),
	};
}

export interface Creation {
	readonly tableId: string;
	readonly seat: Seat;
	readonly holder: string;
	readonly config: RoomConfig;
	readonly state: JsonObject;
	/** Term 1 with the creator's tag. */
	readonly auth: Authority;
	/** The id of entry 1. */
	readonly id: string;
	/** Optional host-managed bot seats claimed in the initial commit. */
	readonly botClaims?: readonly {
		readonly seat: Seat;
		readonly holder: string;
		readonly id: string;
	}[];
	readonly now: number;
}

/** The creator's first commit (rule 11): entry 1 claims its seat, and it hosts term 1. */
export function creationCommit(input: Creation): Commit {
	const { tableId, seat, holder, auth, id } = input;
	const claims = [{ seat, holder, id }, ...(input.botClaims ?? [])];
	if (
		claims.some((claim, index) =>
			claims.slice(0, index).some((prior) => prior.seat === claim.seat),
		)
	)
		throw new Error("a seat can be claimed only once at table creation");
	const entries: Entry[] = claims.map((claim, index) => {
		const seq = index + 1;
		return {
			seq,
			auth,
			prevAuth: seq === 1 ? null : auth,
			id: claim.id,
			seat: claim.seat,
			gen: 1,
			kind: "seat",
			op: { type: "claim", holder: claim.holder },
			event: seatEvent(tableId, seq, claim.id, claim.seat, "claim"),
		};
	});
	const last = entries.at(-1);
	if (!last) throw new Error("table creation must claim the host seat");
	return {
		table: {
			tableId,
			replica: seat,
			config: input.config,
			state: input.state,
			rev: last.seq,
			lastAuth: last.auth,
			host: auth,
			inc: auth.inc,
			lastActivityAt: input.now,
			seats: seatsAfter(NO_SEATS, entries),
		},
		expect: null,
		append: entries,
	};
}

/** Writes `host` (and for a claim the incarnation) when `auth` beats the stored host; skips otherwise. */
function raiseHost(log: LocalLog, auth: Authority, claim: boolean) {
	return log.write((table) =>
		table && compareAuthority(auth, table.host) > 0
			? {
					table: {
						...table,
						host: auth,
						inc: claim ? Math.max(table.inc, auth.inc) : table.inc,
					},
					expect: { rev: table.rev, host: table.host },
					append: [],
				}
			: null,
	);
}

/** The store step of a claim or resume (election rules 9 and 10): true when the claim was written. */
export function storeClaim(
	log: LocalLog,
	auth: Authority,
): Promise<StorageResult<boolean>> {
	return raiseHost(log, auth, true);
}

/** Keeps the better of the followed and the stored authority, so a reload never follows an older host. */
export function storeFollowed(
	log: LocalLog,
	auth: Authority,
): Promise<StorageResult<boolean>> {
	return raiseHost(log, auth, false);
}
