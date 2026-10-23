import { isCommandId, isRoomId } from "../ids";
import {
	isNonNegativeInteger,
	isObject,
	isSeat,
	type JsonObject,
	type RoomConfig,
	type Seat,
} from "../protocol";
import {
	type Authority,
	compareAuthority,
	parseAuthority,
	sameAuthority,
} from "./authority";
import {
	MAX_JSON_DEPTH,
	MAX_LOG_ENTRIES,
	MAX_PAYLOAD_BYTES,
	MAX_STATE_BYTES,
	MAX_TERM,
} from "./limits";
import {
	type Entry,
	jsonBytes,
	parseEntry,
	parseSeatHolders,
	parseTableConfig,
	type SeatHolder,
	withinDepth,
} from "./wire";

/**
 * Stored records of a replica. A browser keeps one replica per table and seat that it holds; the
 * pair (tableId, replica seat) names the partition. Every record read from storage passes a parser here, and
 * a record that fails counts as absent.
 */

export interface TableRecord {
	readonly tableId: string;
	/** The seat of this replica. */
	readonly replica: Seat;
	readonly config: RoomConfig;
	/** The state after entry `rev`. */
	readonly state: JsonObject;
	readonly rev: number;
	/** The authority of entry `rev`. */
	readonly lastAuth: Authority;
	/** The authority that writes this log: this replica's own while it hosts, otherwise the one it follows. */
	readonly host: Authority;
	/** The highest incarnation this replica used; a claim or a resume uses `inc + 1`. */
	readonly inc: number;
	/** `Date.now()` of this device at the last entry, or now − idleMs from a lobby or snapshot. */
	readonly lastActivityAt: number;
	readonly seats: readonly SeatHolder[];
}

/** An own command that is not yet in the log. */
export interface OutboxRecord {
	readonly tableId: string;
	readonly replica: Seat;
	readonly id: string;
	/** Send order. One tab writes a partition, so the outbox assigns it. */
	readonly order: number;
	readonly payload: JsonObject;
}

/** A table that expired in this browser; its link shows "This table has expired". */
export interface Tombstone {
	readonly tableId: string;
	readonly expiredAt: number;
}

export interface Replica {
	readonly table: TableRecord;
	/** Entries 1..rev. */
	readonly entries: readonly Entry[];
	/** By send order. */
	readonly outbox: readonly OutboxRecord[];
}

function isTimestamp(value: unknown): value is number {
	return isNonNegativeInteger(value);
}

function isJsonObjectWithin(
	value: unknown,
	maxBytes: number,
): value is JsonObject {
	return (
		isObject(value) &&
		withinDepth(value, MAX_JSON_DEPTH) &&
		jsonBytes(value) <= maxBytes
	);
}

export function parseTableRecord(value: unknown): TableRecord | undefined {
	if (!isObject(value)) return undefined;
	const { tableId, replica, state, rev, inc, lastActivityAt } = value;
	if (!isRoomId(tableId) || !isSeat(replica)) return undefined;
	if (!isNonNegativeInteger(rev) || rev < 1 || rev > MAX_LOG_ENTRIES)
		return undefined;
	if (!isNonNegativeInteger(inc) || inc > MAX_TERM) return undefined;
	if (!isTimestamp(lastActivityAt)) return undefined;
	if (!isJsonObjectWithin(state, MAX_STATE_BYTES)) return undefined;
	const config = parseTableConfig(value.config);
	const lastAuth = parseAuthority(value.lastAuth);
	const host = parseAuthority(value.host);
	const seats = parseSeatHolders(value.seats);
	if (!config || !lastAuth || !host || !seats) return undefined;
	// A host writes only after it beats every authority in its log.
	if (compareAuthority(host, lastAuth) < 0) return undefined;
	return {
		tableId,
		replica,
		config,
		state,
		rev,
		lastAuth,
		host,
		inc,
		lastActivityAt,
		seats,
	};
}

export function parseOutboxRecord(value: unknown): OutboxRecord | undefined {
	if (!isObject(value)) return undefined;
	const { tableId, replica, id, order, payload } = value;
	if (!isRoomId(tableId) || !isSeat(replica) || !isCommandId(id))
		return undefined;
	if (!isNonNegativeInteger(order)) return undefined;
	if (!isJsonObjectWithin(payload, MAX_PAYLOAD_BYTES)) return undefined;
	return { tableId, replica, id, order, payload };
}

export function parseTombstone(value: unknown): Tombstone | undefined {
	if (!isObject(value)) return undefined;
	const { tableId, expiredAt } = value;
	return isRoomId(tableId) && isTimestamp(expiredAt)
		? { tableId, expiredAt }
		: undefined;
}

/**
 * A partition as read: the table record, its entries and its outbox. The entries must be exactly 1..rev,
 * each linked to the one before, and end at the record's `lastAuth`; the outbox must belong to the partition.
 */
export function parseReplica(
	table: unknown,
	entries: readonly unknown[],
	outbox: readonly unknown[],
): Replica | undefined {
	const record = parseTableRecord(table);
	if (!record || entries.length !== record.rev) return undefined;
	const log: Entry[] = [];
	let lastAuth: Authority | null = null;
	for (const raw of entries) {
		const entry = parseEntry(raw);
		if (
			!entry ||
			entry.seq !== log.length + 1 ||
			!sameAuthority(entry.prevAuth, lastAuth)
		) {
			return undefined;
		}
		log.push(entry);
		lastAuth = entry.auth;
	}
	if (!sameAuthority(lastAuth, record.lastAuth)) return undefined;
	const queued: OutboxRecord[] = [];
	for (const raw of outbox) {
		const item = parseOutboxRecord(raw);
		if (
			!item ||
			item.tableId !== record.tableId ||
			item.replica !== record.replica
		) {
			return undefined;
		}
		queued.push(item);
	}
	queued.sort((a, b) => a.order - b.order);
	return { table: record, entries: log, outbox: queued };
}
