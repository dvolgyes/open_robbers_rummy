import { isRoomId } from "../ids";
import { isNonNegativeInteger, isObject, isSeat, type Seat } from "../protocol";
import { type Authority, sameAuthority } from "./authority";
import {
	type OutboxRecord,
	parseOutboxRecord,
	parseReplica,
	parseTableRecord,
	parseTombstone,
	type Replica,
	type TableRecord,
	type Tombstone,
} from "./records";
import { type Entry, parseEntry } from "./wire";

/**
 * Replica storage (plan §4.3): IndexedDB, or memory when the browser has no usable IndexedDB. Both implement
 * one contract, which tests/unit/p2p-storage.test.ts checks against both. Every write is one transaction, and
 * a commit writes only when the partition still has the revision and host that the caller expects.
 */

export type StorageCode =
	/** The partition is not in the expected state; reload it. */
	| "conflict"
	/** The table expired in this browser. */
	| "expired"
	/** The browser refused the operation, for example a full quota or a closed database. */
	| "storage";

export interface StorageFailure {
	readonly ok: false;
	readonly code: StorageCode;
	readonly detail: string;
}

export type StorageResult<T> =
	| { readonly ok: true; readonly value: T }
	| StorageFailure;

export interface Commit {
	/** The new table record; its tableId and replica name the partition. */
	readonly table: TableRecord;
	/** The partition's current revision and host. Null creates the partition, which must not exist. */
	readonly expect: { readonly rev: number; readonly host: Authority } | null;
	/** Delete every stored entry first; `append` then starts at entry 1. */
	readonly replace?: boolean;
	/** The entries after the expected revision (or from 1 for a new or replaced log). */
	readonly append: readonly Entry[];
	/** Outbox commands that are now in the log. */
	readonly sent?: readonly string[];
}

export interface PartitionInfo {
	readonly tableId: string;
	readonly replica: Seat;
	readonly lastActivityAt: number;
}

export type CorruptRecord = "replica" | "tombstone";

export interface TableStorage {
	/** True when a replica survives a reload. */
	readonly persistent: boolean;
	/** The partition, or null when it is absent. A corrupt partition counts as absent and is deleted. */
	load(tableId: string, replica: Seat): Promise<StorageResult<Replica | null>>;
	commit(change: Commit): Promise<StorageResult<void>>;
	putOutbox(record: OutboxRecord): Promise<StorageResult<void>>;
	deleteOutbox(
		tableId: string,
		replica: Seat,
		id: string,
	): Promise<StorageResult<void>>;
	partitions(): Promise<StorageResult<PartitionInfo[]>>;
	/** Deletes every partition of the table and records its tombstone. */
	expireTable(tableId: string, now: number): Promise<StorageResult<void>>;
	/** Removes this table's tombstone when a valid room link starts a new session. */
	reviveTable(tableId: string): Promise<StorageResult<void>>;
	tombstone(tableId: string): Promise<StorageResult<Tombstone | null>>;
	/** Deletes tombstones that expired before `before`; returns how many. */
	pruneTombstones(before: number): Promise<StorageResult<number>>;
}

function ok<T>(value: T): StorageResult<T> {
	return { ok: true, value };
}

function failure(code: StorageCode, detail: string): StorageFailure {
	return { ok: false, code, detail };
}

/**
 * Errors in the change itself, whatever is stored, are bugs in the caller and throw. Returns the parsed
 * record and entries, so that storage keeps only the known fields.
 */
function checkCommit(change: Commit): {
	table: TableRecord;
	append: Entry[];
} {
	const table = parseTableRecord(change.table);
	if (!table) throw new Error("invalid table record");
	const { expect } = change;
	const fresh = expect === null || change.replace === true;
	const base = fresh ? 0 : expect.rev;
	if (fresh && change.append.length === 0) {
		throw new Error("a new or replaced log needs entries");
	}
	const append: Entry[] = [];
	for (const raw of change.append) {
		const entry = parseEntry(raw);
		if (!entry) throw new Error("invalid entry");
		if (entry.seq !== base + append.length + 1) {
			throw new Error("entries must continue the log");
		}
		const previous = append.at(-1);
		if (previous && !sameAuthority(entry.prevAuth, previous.auth)) {
			throw new Error("entries must link to the entry before");
		}
		append.push(entry);
	}
	if (table.rev !== base + append.length) {
		throw new Error("the table revision must match the log");
	}
	const last = append.at(-1);
	if (last && !sameAuthority(last.auth, table.lastAuth)) {
		throw new Error("the table authority must match the last entry");
	}
	return { table, append };
}

function checkOutbox(record: OutboxRecord): OutboxRecord {
	const parsed = parseOutboxRecord(record);
	if (!parsed) throw new Error("invalid outbox record");
	return parsed;
}

/** Why the checked change does not fit the stored partition, or undefined when it fits. */
function casFailure(
	change: Commit,
	current: TableRecord | undefined,
	tombstoned: boolean,
): StorageFailure | undefined {
	const { expect, append, table } = change;
	if (expect === null) {
		if (tombstoned) return failure("expired", "the table expired");
		return current ? failure("conflict", "the replica exists") : undefined;
	}
	if (!current) return failure("conflict", "the replica is absent");
	if (current.rev !== expect.rev || !sameAuthority(current.host, expect.host)) {
		return failure("conflict", "the replica changed");
	}
	if (change.replace === true) return undefined;
	const linked = append[0]
		? sameAuthority(append[0].prevAuth, current.lastAuth)
		: sameAuthority(table.lastAuth, current.lastAuth);
	return linked ? undefined : failure("conflict", "the log does not continue");
}

function partitionKey(tableId: string, replica: Seat): string {
	return `${tableId}|${replica}`;
}

/** The fields that cleanup needs; a record without them is left to `load`. */
function partitionInfo(value: unknown): PartitionInfo | undefined {
	if (!isObject(value)) return undefined;
	const { tableId, replica, lastActivityAt } = value;
	return isRoomId(tableId) &&
		isSeat(replica) &&
		isNonNegativeInteger(lastActivityAt)
		? { tableId, replica, lastActivityAt }
		: undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Memory

interface MemoryPartition {
	table: TableRecord;
	entries: Entry[];
}

/** For a browser without IndexedDB: the replica lasts as long as the page. Values are copied in and out. */
export class MemoryStorage implements TableStorage {
	readonly persistent = false;
	readonly #partitions = new Map<string, MemoryPartition>();
	readonly #outbox = new Map<string, Map<string, OutboxRecord>>();
	readonly #tombstones = new Map<string, Tombstone>();

	async load(
		tableId: string,
		replica: Seat,
	): Promise<StorageResult<Replica | null>> {
		const key = partitionKey(tableId, replica);
		const partition = this.#partitions.get(key);
		if (!partition) return ok(null);
		const outbox = [...(this.#outbox.get(key)?.values() ?? [])].sort(
			(a, b) => a.order - b.order,
		);
		return ok(
			structuredClone({
				table: partition.table,
				entries: partition.entries,
				outbox,
			}),
		);
	}

	async commit(change: Commit): Promise<StorageResult<void>> {
		const { table, append } = checkCommit(change);
		const key = partitionKey(table.tableId, table.replica);
		const current = this.#partitions.get(key);
		const rejected = casFailure(
			change,
			current?.table,
			this.#tombstones.has(table.tableId),
		);
		if (rejected) return rejected;
		const kept =
			current && change.expect !== null && change.replace !== true
				? current.entries
				: [];
		if (change.expect === null) this.#outbox.delete(key);
		this.#partitions.set(key, {
			table: structuredClone(table),
			entries: [...kept, ...structuredClone(append)],
		});
		for (const id of change.sent ?? []) this.#outbox.get(key)?.delete(id);
		return ok(undefined);
	}

	async putOutbox(record: OutboxRecord): Promise<StorageResult<void>> {
		const checked = checkOutbox(record);
		const key = partitionKey(checked.tableId, checked.replica);
		const queue = this.#outbox.get(key) ?? new Map<string, OutboxRecord>();
		queue.set(checked.id, structuredClone(checked));
		this.#outbox.set(key, queue);
		return ok(undefined);
	}

	async deleteOutbox(
		tableId: string,
		replica: Seat,
		id: string,
	): Promise<StorageResult<void>> {
		this.#outbox.get(partitionKey(tableId, replica))?.delete(id);
		return ok(undefined);
	}

	async partitions(): Promise<StorageResult<PartitionInfo[]>> {
		return ok(
			[...this.#partitions.values()].map(({ table }) => ({
				tableId: table.tableId,
				replica: table.replica,
				lastActivityAt: table.lastActivityAt,
			})),
		);
	}

	async expireTable(
		tableId: string,
		now: number,
	): Promise<StorageResult<void>> {
		for (const [key, { table }] of this.#partitions) {
			if (table.tableId === tableId) {
				this.#partitions.delete(key);
				this.#outbox.delete(key);
			}
		}
		this.#tombstones.set(tableId, { tableId, expiredAt: now });
		return ok(undefined);
	}

	async tombstone(tableId: string): Promise<StorageResult<Tombstone | null>> {
		const tombstone = this.#tombstones.get(tableId);
		return ok(tombstone ? { ...tombstone } : null);
	}

	async reviveTable(tableId: string): Promise<StorageResult<void>> {
		this.#tombstones.delete(tableId);
		return ok(undefined);
	}

	async pruneTombstones(before: number): Promise<StorageResult<number>> {
		let pruned = 0;
		for (const [tableId, tombstone] of this.#tombstones) {
			if (tombstone.expiredAt < before) {
				this.#tombstones.delete(tableId);
				pruned++;
			}
		}
		return ok(pruned);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// IndexedDB

const DB_NAME = "oc-p2p";
const DB_VERSION = 1;
const TABLES = "tables";
const ENTRIES = "entries";
const OUTBOX = "outbox";
const TOMBSTONES = "tombstones";

/** The IndexedDB globals, passed in so tests can use an in-memory implementation. */
export interface IndexedDbApi {
	readonly factory: IDBFactory;
	readonly keyRange: Pick<typeof IDBKeyRange, "bound">;
}

/** An entry as stored: the key fields beside the entry. */
interface EntryRow {
	readonly tableId: string;
	readonly replica: Seat;
	readonly seq: number;
	readonly entry: Entry;
}

/**
 * IndexedDB reports refusals (quota, a closed or blocked database, private mode) as DOMException; those
 * become `storage` results. Other errors are bugs and propagate.
 */
function storageFailure(error: unknown): StorageFailure {
	if (error === null || error === undefined) {
		return failure("storage", "the transaction was aborted");
	}
	if (error instanceof DOMException) {
		return failure("storage", `${error.name}: ${error.message}`);
	}
	throw error;
}

export function openIndexedDbStorage(
	api: IndexedDbApi | undefined,
	onCorrupt: (record: CorruptRecord) => void,
): Promise<StorageResult<TableStorage>> {
	if (!api) {
		return Promise.resolve(failure("storage", "IndexedDB is not available"));
	}
	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = api.factory.open(DB_NAME, DB_VERSION);
		} catch (error) {
			resolve(storageFailure(error));
			return;
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			db.createObjectStore(TABLES, { keyPath: ["tableId", "replica"] });
			db.createObjectStore(ENTRIES, { keyPath: ["tableId", "replica", "seq"] });
			db.createObjectStore(OUTBOX, { keyPath: ["tableId", "replica", "id"] });
			db.createObjectStore(TOMBSTONES, { keyPath: "tableId" });
		};
		request.onsuccess = () => {
			const db = request.result;
			// A newer version in another tab waits until this connection closes.
			db.onversionchange = () => db.close();
			resolve(ok(new IndexedDbStorage(db, api.keyRange, onCorrupt)));
		};
		request.onerror = () => resolve(storageFailure(request.error));
	});
}

class IndexedDbStorage implements TableStorage {
	readonly persistent = true;
	readonly #db: IDBDatabase;
	readonly #keyRange: IndexedDbApi["keyRange"];
	readonly #onCorrupt: (record: CorruptRecord) => void;

	constructor(
		db: IDBDatabase,
		keyRange: IndexedDbApi["keyRange"],
		onCorrupt: (record: CorruptRecord) => void,
	) {
		this.#db = db;
		this.#keyRange = keyRange;
		this.#onCorrupt = onCorrupt;
	}

	/** Every key of the partition, or of the table when `replica` is omitted. Arrays sort after other keys. */
	#range(tableId: string, replica?: Seat): IDBKeyRange {
		const prefix = replica === undefined ? [tableId] : [tableId, replica];
		return this.#keyRange.bound(prefix, [...prefix, []]);
	}

	/**
	 * Runs `body` in one transaction. `body` issues requests and calls `finish` from their callbacks, never
	 * awaiting in between; a failed `finish` aborts the transaction. The result settles when it commits.
	 */
	#transact<T>(
		stores: readonly string[],
		mode: IDBTransactionMode,
		body: (
			tx: IDBTransaction,
			finish: (result: StorageResult<T>) => void,
		) => void,
	): Promise<StorageResult<T>> {
		return new Promise((resolve) => {
			let tx: IDBTransaction;
			try {
				tx = this.#db.transaction(stores, mode);
			} catch (error) {
				resolve(storageFailure(error));
				return;
			}
			let outcome: StorageResult<T> | undefined;
			const finish = (result: StorageResult<T>): void => {
				outcome = result;
				if (!result.ok) tx.abort();
			};
			tx.oncomplete = () =>
				resolve(outcome ?? failure("storage", "the transaction ended early"));
			tx.onabort = () =>
				resolve(outcome && !outcome.ok ? outcome : storageFailure(tx.error));
			try {
				body(tx, finish);
			} catch (error) {
				finish(storageFailure(error));
			}
		});
	}

	async load(
		tableId: string,
		replica: Seat,
	): Promise<StorageResult<Replica | null>> {
		const read = await this.#transact<{
			table: unknown;
			entries: unknown[];
			outbox: unknown[];
		}>([TABLES, ENTRIES, OUTBOX], "readonly", (tx, finish) => {
			const range = this.#range(tableId, replica);
			const table = tx.objectStore(TABLES).get([tableId, replica]);
			const entries = tx.objectStore(ENTRIES).getAll(range);
			const outbox = tx.objectStore(OUTBOX).getAll(range);
			// Requests of one transaction complete in order, so the others are done.
			outbox.onsuccess = () =>
				finish(
					ok({
						table: table.result,
						entries: entries.result,
						outbox: outbox.result,
					}),
				);
		});
		if (!read.ok) return read;
		if (read.value.table === undefined) return ok(null);
		const rows = read.value.entries.map((row) =>
			isObject(row) && isObject(row.entry) && row.seq === row.entry.seq
				? row.entry
				: undefined,
		);
		const loaded = parseReplica(read.value.table, rows, read.value.outbox);
		if (loaded) return ok(loaded);
		this.#onCorrupt("replica");
		const removed = await this.#deletePartition(tableId, replica);
		return removed.ok ? ok(null) : removed;
	}

	#deletePartition(
		tableId: string,
		replica: Seat,
	): Promise<StorageResult<void>> {
		return this.#transact<void>(
			[TABLES, ENTRIES, OUTBOX],
			"readwrite",
			(tx, finish) => {
				const range = this.#range(tableId, replica);
				tx.objectStore(TABLES).delete([tableId, replica]);
				tx.objectStore(ENTRIES).delete(range);
				tx.objectStore(OUTBOX).delete(range);
				finish(ok(undefined));
			},
		);
	}

	async commit(change: Commit): Promise<StorageResult<void>> {
		const { table, append } = checkCommit(change);
		const { tableId, replica } = table;
		return this.#transact<void>(
			[TABLES, ENTRIES, OUTBOX, TOMBSTONES],
			"readwrite",
			(tx, finish) => {
				const tombstone = tx.objectStore(TOMBSTONES).get(tableId);
				const current = tx.objectStore(TABLES).get([tableId, replica]);
				current.onsuccess = () => {
					// A corrupt record counts as absent, as in `load` and `tombstone`.
					const rejected = casFailure(
						change,
						parseTableRecord(current.result),
						parseTombstone(tombstone.result) !== undefined,
					);
					if (rejected) {
						finish(rejected);
						return;
					}
					const range = this.#range(tableId, replica);
					const entries = tx.objectStore(ENTRIES);
					const outbox = tx.objectStore(OUTBOX);
					if (change.expect === null || change.replace === true) {
						entries.delete(range);
					}
					if (change.expect === null) outbox.delete(range);
					for (const entry of append) {
						const row: EntryRow = { tableId, replica, seq: entry.seq, entry };
						entries.put(row);
					}
					for (const id of change.sent ?? []) {
						outbox.delete([tableId, replica, id]);
					}
					tx.objectStore(TABLES).put(table);
					finish(ok(undefined));
				};
			},
		);
	}

	async putOutbox(record: OutboxRecord): Promise<StorageResult<void>> {
		const checked = checkOutbox(record);
		return this.#transact<void>([OUTBOX], "readwrite", (tx, finish) => {
			tx.objectStore(OUTBOX).put(checked);
			finish(ok(undefined));
		});
	}

	deleteOutbox(
		tableId: string,
		replica: Seat,
		id: string,
	): Promise<StorageResult<void>> {
		return this.#transact<void>([OUTBOX], "readwrite", (tx, finish) => {
			tx.objectStore(OUTBOX).delete([tableId, replica, id]);
			finish(ok(undefined));
		});
	}

	partitions(): Promise<StorageResult<PartitionInfo[]>> {
		return this.#transact<PartitionInfo[]>(
			[TABLES],
			"readonly",
			(tx, finish) => {
				const all = tx.objectStore(TABLES).getAll();
				all.onsuccess = () =>
					finish(
						ok(
							all.result.flatMap((value: unknown) => {
								const info = partitionInfo(value);
								return info ? [info] : [];
							}),
						),
					);
			},
		);
	}

	expireTable(tableId: string, now: number): Promise<StorageResult<void>> {
		return this.#transact<void>(
			[TABLES, ENTRIES, OUTBOX, TOMBSTONES],
			"readwrite",
			(tx, finish) => {
				const range = this.#range(tableId);
				tx.objectStore(TABLES).delete(range);
				tx.objectStore(ENTRIES).delete(range);
				tx.objectStore(OUTBOX).delete(range);
				const tombstone: Tombstone = { tableId, expiredAt: now };
				tx.objectStore(TOMBSTONES).put(tombstone);
				finish(ok(undefined));
			},
		);
	}

	reviveTable(tableId: string): Promise<StorageResult<void>> {
		return this.#transact<void>([TOMBSTONES], "readwrite", (tx, finish) => {
			tx.objectStore(TOMBSTONES).delete(tableId);
			finish(ok(undefined));
		});
	}

	async tombstone(tableId: string): Promise<StorageResult<Tombstone | null>> {
		const read = await this.#transact<unknown>(
			[TOMBSTONES],
			"readonly",
			(tx, finish) => {
				const request = tx.objectStore(TOMBSTONES).get(tableId);
				request.onsuccess = () => finish(ok(request.result));
			},
		);
		if (!read.ok) return read;
		if (read.value === undefined) return ok(null);
		const tombstone = parseTombstone(read.value);
		if (tombstone?.tableId === tableId) return ok(tombstone);
		this.#onCorrupt("tombstone");
		return ok(null);
	}

	pruneTombstones(before: number): Promise<StorageResult<number>> {
		return this.#transact<number>([TOMBSTONES], "readwrite", (tx, finish) => {
			const store = tx.objectStore(TOMBSTONES);
			const all = store.getAll();
			all.onsuccess = () => {
				let pruned = 0;
				for (const value of all.result as unknown[]) {
					const tombstone = parseTombstone(value);
					if (tombstone && tombstone.expiredAt < before) {
						store.delete(tombstone.tableId);
						pruned++;
					}
				}
				finish(ok(pruned));
			};
		});
	}
}
