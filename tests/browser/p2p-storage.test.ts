import { beforeEach, describe, expect, it } from "vitest";
import type { Authority } from "../../src/p2p/authority";
import type { TableRecord } from "../../src/p2p/records";
import {
	type Commit,
	type CorruptRecord,
	MemoryStorage,
	openIndexedDbStorage,
	type StorageResult,
	type TableStorage,
} from "../../src/p2p/storage";
import type { Seat } from "../../src/protocol";
import {
	AUTH_1,
	AUTH_2,
	entries,
	OTHER_TABLE,
	outboxRecord,
	TABLE,
	tableRecord,
} from "../unit/p2p-fixtures";
import {
	DB_NAME,
	deleteDatabase,
	openNewerVersion,
	openStorage,
	request,
} from "./indexed-db";

interface Subject {
	readonly storage: TableStorage;
	readonly corrupt: CorruptRecord[];
}

/** The storage on Chrome's IndexedDB. Each test starts with no database. */
async function indexedDb(): Promise<Subject> {
	const corrupt: CorruptRecord[] = [];
	const storage = await openStorage((record) => corrupt.push(record));
	return { storage, corrupt };
}

beforeEach(deleteDatabase);

const SUBJECTS: [string, () => Promise<Subject>][] = [
	["memory", async () => ({ storage: new MemoryStorage(), corrupt: [] })],
	["IndexedDB", () => indexedDb()],
];

function value<T>(result: StorageResult<T>): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
	return result.value;
}

/** A new partition with entries 1..rev by `AUTH_1`. */
function created(overrides: Partial<TableRecord> = {}): Commit {
	const table = tableRecord(overrides);
	return {
		table,
		expect: null,
		append: entries(1, table.rev, table.lastAuth, null),
	};
}

/** Entries rev+1..rev+count by `auth`, after a partition at `table`. */
function extended(
	table: TableRecord,
	count: number,
	auth: Authority = table.host,
): Commit {
	const rev = table.rev + count;
	return {
		table: { ...table, rev, lastAuth: auth, host: auth },
		expect: { rev: table.rev, host: table.host },
		append: entries(table.rev + 1, rev, auth, table.lastAuth),
	};
}

async function loaded(
	storage: TableStorage,
	tableId = TABLE,
	seat: Seat = "N",
) {
	return value(await storage.load(tableId, seat));
}

describe.each(SUBJECTS)("%s storage", (_name, make) => {
	it("loads an absent partition as null", async () => {
		const { storage } = await make();
		expect(await loaded(storage)).toBeNull();
		expect(value(await storage.partitions())).toEqual([]);
	});

	it("loads a created partition back with its entries in order", async () => {
		const { storage } = await make();
		const change = created();
		value(await storage.commit(change));
		expect(await loaded(storage)).toEqual({
			table: change.table,
			entries: change.append,
			outbox: [],
		});
	});

	it("rejects a second create of the same partition", async () => {
		const { storage } = await make();
		value(await storage.commit(created()));
		const again = await storage.commit(created({ rev: 1 }));
		expect(again).toMatchObject({ ok: false, code: "conflict" });
		expect((await loaded(storage))?.table.rev).toBe(3);
	});

	it("appends when the stored revision and host match", async () => {
		const { storage } = await make();
		const start = created();
		value(await storage.commit(start));
		const next = extended(start.table, 2);
		value(await storage.commit(next));
		const replica = await loaded(storage);
		expect(replica?.table).toEqual(next.table);
		expect(replica?.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
	});

	it.each<[string, (table: TableRecord) => Commit]>([
		// A writer that still believes the log ends at entry 2.
		["a stale revision", (table) => extended({ ...table, rev: 2 }, 1)],
		[
			"another host",
			(table) => ({ ...extended(table, 1), expect: { rev: 3, host: AUTH_2 } }),
		],
		[
			"another incarnation of the same tag",
			(table) => ({
				...extended(table, 1),
				expect: { rev: 3, host: { ...AUTH_1, inc: 2 } },
			}),
		],
	])("rejects %s and changes nothing", async (_label, change) => {
		const { storage } = await make();
		const start = created();
		value(await storage.commit(start));
		const next = change(start.table);
		expect(await storage.commit(next)).toMatchObject({
			ok: false,
			code: "conflict",
		});
		expect(await loaded(storage)).toEqual({
			table: start.table,
			entries: start.append,
			outbox: [],
		});
	});

	it("rejects an append that does not continue the stored log", async () => {
		const { storage } = await make();
		const start = created();
		value(await storage.commit(start));
		// The entries claim to follow a log that ends with an AUTH_2 entry.
		const forked = extended(
			{ ...start.table, lastAuth: AUTH_2, host: AUTH_2 },
			1,
		);
		const next = { ...forked, expect: { rev: 3, host: AUTH_1 } };
		expect(await storage.commit(next)).toMatchObject({
			ok: false,
			code: "conflict",
		});
	});

	it("rejects an update without entries whose last authority differs", async () => {
		const { storage } = await make();
		const start = created();
		value(await storage.commit(start));
		const change: Commit = {
			table: { ...start.table, lastAuth: AUTH_2, host: AUTH_2 },
			expect: { rev: 3, host: AUTH_1 },
			append: [],
		};
		expect(await storage.commit(change)).toMatchObject({
			ok: false,
			code: "conflict",
		});
	});

	it("changes the host without entries, and the old host then conflicts", async () => {
		const { storage } = await make();
		const start = created();
		value(await storage.commit(start));
		const claimed = { ...start.table, host: AUTH_2, inc: 2 };
		value(
			await storage.commit({
				table: claimed,
				expect: { rev: 3, host: AUTH_1 },
				append: [],
			}),
		);
		expect((await loaded(storage))?.table).toEqual(claimed);
		expect(await storage.commit(extended(start.table, 1))).toMatchObject({
			ok: false,
			code: "conflict",
		});
		value(await storage.commit(extended(claimed, 1)));
		expect((await loaded(storage))?.table.rev).toBe(4);
	});

	it("replaces the whole log and keeps the outbox", async () => {
		const { storage } = await make();
		const start = created();
		value(await storage.commit(start));
		const queued = outboxRecord(1);
		value(await storage.putOutbox(queued));
		const table = { ...start.table, rev: 2, lastAuth: AUTH_2, host: AUTH_2 };
		const append = entries(1, 2, AUTH_2, null);
		value(
			await storage.commit({
				table,
				expect: { rev: 3, host: AUTH_1 },
				replace: true,
				append,
			}),
		);
		expect(await loaded(storage)).toEqual({
			table,
			entries: append,
			outbox: [queued],
		});
	});

	it("keeps partitions of other tables and seats apart", async () => {
		const { storage } = await make();
		const north = created();
		const east = created({ replica: "E", rev: 2 });
		const other = created({ tableId: OTHER_TABLE, rev: 1 });
		for (const change of [north, east, other]) {
			value(await storage.commit(change));
		}
		value(await storage.putOutbox(outboxRecord(1, { replica: "E" })));
		value(await storage.commit(extended(north.table, 1)));
		expect((await loaded(storage))?.table.rev).toBe(4);
		expect((await loaded(storage))?.outbox).toEqual([]);
		expect(await loaded(storage, TABLE, "E")).toEqual({
			table: east.table,
			entries: east.append,
			outbox: [outboxRecord(1, { replica: "E" })],
		});
		expect((await loaded(storage, OTHER_TABLE))?.table).toEqual(other.table);
		expect(await loaded(storage, TABLE, "S")).toBeNull();
	});

	it("returns the outbox in send order and removes sent commands", async () => {
		const { storage } = await make();
		const start = created();
		value(await storage.commit(start));
		const first = outboxRecord(1);
		const second = outboxRecord(2);
		const third = outboxRecord(3);
		for (const record of [third, first, second]) {
			value(await storage.putOutbox(record));
		}
		expect((await loaded(storage))?.outbox).toEqual([first, second, third]);

		const rewritten = { ...first, payload: { type: "chat", text: "again" } };
		value(await storage.putOutbox(rewritten));
		value(await storage.deleteOutbox(TABLE, "N", second.id));
		expect((await loaded(storage))?.outbox).toEqual([rewritten, third]);

		value(
			await storage.commit({ ...extended(start.table, 1), sent: [third.id] }),
		);
		expect((await loaded(storage))?.outbox).toEqual([rewritten]);
	});

	it("clears a stray outbox when it creates the partition", async () => {
		const { storage } = await make();
		value(await storage.putOutbox(outboxRecord(1)));
		value(await storage.commit(created()));
		expect((await loaded(storage))?.outbox).toEqual([]);
	});

	it("expires every partition of a table and remembers it", async () => {
		const { storage } = await make();
		const other = created({ tableId: OTHER_TABLE });
		for (const change of [created(), created({ replica: "E" }), other]) {
			value(await storage.commit(change));
		}
		value(await storage.putOutbox(outboxRecord(1)));
		value(await storage.expireTable(TABLE, 5_000));
		expect(await loaded(storage)).toBeNull();
		expect(await loaded(storage, TABLE, "E")).toBeNull();
		expect((await loaded(storage, OTHER_TABLE))?.table).toEqual(other.table);
		expect(value(await storage.tombstone(TABLE))).toEqual({
			tableId: TABLE,
			expiredAt: 5_000,
		});
		expect(value(await storage.tombstone(OTHER_TABLE))).toBeNull();
		expect(await storage.commit(created())).toMatchObject({
			ok: false,
			code: "expired",
		});
		value(await storage.putOutbox(outboxRecord(2)));
		expect(await loaded(storage)).toBeNull();
	});

	it("forgets only tombstones older than the limit", async () => {
		const { storage } = await make();
		value(await storage.expireTable(TABLE, 1_000));
		value(await storage.expireTable(OTHER_TABLE, 3_000));
		expect(value(await storage.pruneTombstones(2_000))).toBe(1);
		expect(value(await storage.tombstone(TABLE))).toBeNull();
		expect(value(await storage.tombstone(OTHER_TABLE))).not.toBeNull();
		value(await storage.commit(created()));
	});

	it("lists every partition with its last activity", async () => {
		const { storage } = await make();
		value(await storage.commit(created({ lastActivityAt: 7 })));
		value(await storage.commit(created({ replica: "W", lastActivityAt: 9 })));
		const listed = value(await storage.partitions());
		expect(listed).toHaveLength(2);
		expect(listed).toEqual(
			expect.arrayContaining([
				{ tableId: TABLE, replica: "N", lastActivityAt: 7 },
				{ tableId: TABLE, replica: "W", lastActivityAt: 9 },
			]),
		);
	});

	it("stores copies with only the known fields", async () => {
		const { storage } = await make();
		const change = created();
		const table = { ...change.table, extra: "dropped" } as TableRecord;
		value(await storage.commit({ ...change, table }));
		const first = await loaded(storage);
		expect(first?.table).toEqual(change.table);
		(first?.table.state as Record<string, unknown>).phase = "changed";
		expect((await loaded(storage))?.table.state).toEqual({ phase: "lobby" });
	});

	it.each<[string, (start: Commit) => Commit, RegExp]>([
		[
			"an invalid record",
			(start) => ({ ...start, table: { ...start.table, rev: 0 } }),
			/invalid table record/,
		],
		[
			"a create without entries",
			(start) => ({ ...start, append: [] }),
			/needs entries/,
		],
		[
			"a gap in the entries",
			(start) => ({ ...start, append: start.append.slice(1) }),
			/continue the log/,
		],
		[
			"entries that do not link",
			(start) => ({
				...start,
				append: [...start.append.slice(0, 2), ...entries(3, 3, AUTH_2, AUTH_2)],
			}),
			/link to the entry before/,
		],
		[
			"a revision that does not match the entries",
			(start) => ({ ...start, table: { ...start.table, rev: 4 } }),
			/revision must match/,
		],
		[
			"a last authority that does not match the entries",
			(start) => ({
				...start,
				table: { ...start.table, lastAuth: AUTH_2, host: AUTH_2 },
			}),
			/authority must match/,
		],
		[
			"an invalid entry",
			(start) => ({
				...start,
				append: start.append.map((entry, index) =>
					index === 0 ? { ...entry, id: "x" } : entry,
				),
			}),
			/invalid entry/,
		],
	])("throws on %s", async (_label, broken, message) => {
		const { storage } = await make();
		await expect(storage.commit(broken(created()))).rejects.toThrow(message);
		expect(await loaded(storage)).toBeNull();
	});

	it("throws on an invalid outbox record", async () => {
		const { storage } = await make();
		await expect(
			storage.putOutbox(outboxRecord(1, { id: "not-a-uuid" })),
		).rejects.toThrow(Error);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// IndexedDB only

/** Writes raw values next to the storage, as damaged or foreign data would be. */
async function rawPut(
	store: string,
	values: readonly unknown[],
): Promise<void> {
	const db = await request(indexedDB.open(DB_NAME));
	const tx = db.transaction(store, "readwrite");
	for (const item of values) tx.objectStore(store).put(item);
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error);
	});
	db.close();
}

describe("IndexedDB storage", () => {
	it("treats a corrupt partition as absent, reports it and deletes it", async () => {
		const { storage, corrupt } = await indexedDb();
		value(await storage.commit(created()));
		value(await storage.putOutbox(outboxRecord(1)));
		// The record claims more entries than the log holds.
		await rawPut("tables", [tableRecord({ rev: 5 })]);
		expect(await loaded(storage)).toBeNull();
		expect(corrupt).toEqual(["replica"]);
		expect(value(await storage.partitions())).toEqual([]);
		value(await storage.commit(created()));
		expect((await loaded(storage))?.outbox).toEqual([]);
	});

	it.each<[string, string, unknown]>([
		[
			"a damaged entry",
			"entries",
			{ tableId: TABLE, replica: "N", seq: 2, entry: { seq: 2 } },
		],
		[
			"an entry row with another sequence number",
			"entries",
			{
				tableId: TABLE,
				replica: "N",
				seq: 2,
				entry: entries(3, 3, AUTH_1, AUTH_1)[0],
			},
		],
		["an invalid outbox record", "outbox", { ...outboxRecord(1), order: -1 }],
	])("treats a partition with %s as absent", async (_label, store, row) => {
		const { storage, corrupt } = await indexedDb();
		value(await storage.commit(created()));
		await rawPut(store, [row]);
		expect(await loaded(storage)).toBeNull();
		expect(corrupt).toEqual(["replica"]);
	});

	it("skips records without the fields that cleanup needs", async () => {
		const { storage } = await indexedDb();
		value(await storage.commit(created()));
		await rawPut("tables", [
			{ tableId: TABLE, replica: "E", lastActivityAt: "yesterday" },
		]);
		expect(value(await storage.partitions())).toEqual([
			{ tableId: TABLE, replica: "N", lastActivityAt: 1_000 },
		]);
	});

	it("treats a corrupt tombstone as absent", async () => {
		const { storage, corrupt } = await indexedDb();
		await rawPut("tombstones", [{ tableId: TABLE, expiredAt: -1 }]);
		expect(value(await storage.tombstone(TABLE))).toBeNull();
		expect(corrupt).toEqual(["tombstone"]);
		value(await storage.commit(created()));
	});

	it("keeps the data when the page opens the database again", async () => {
		const first = await indexedDb();
		const change = created();
		value(await first.storage.commit(change));
		const second = await indexedDb();
		expect((await loaded(second.storage))?.table).toEqual(change.table);
		expect(second.storage.persistent).toBe(true);
	});

	it("reports writes as storage failures after the connection closes", async () => {
		const { storage } = await indexedDb();
		const start = created();
		value(await storage.commit(start));
		await openNewerVersion();
		const closed = {
			ok: false,
			code: "storage",
			detail: expect.stringMatching(/^InvalidStateError: /),
		};
		expect(await storage.commit(extended(start.table, 1))).toMatchObject(
			closed,
		);
		expect(await storage.load(TABLE, "N")).toMatchObject(closed);
	});

	it("reports a database that a newer version of the page upgraded", async () => {
		await openNewerVersion();
		expect(
			await openIndexedDbStorage(
				{ factory: indexedDB, keyRange: IDBKeyRange },
				() => {},
			),
		).toMatchObject({
			ok: false,
			code: "storage",
			detail: expect.stringMatching(/^VersionError: /),
		});
	});

	// A browser that refuses IndexedDB is tested in resilience.spec.ts, with a Chrome profile that does not
	// allow sites to save data.
	it("reports a browser without IndexedDB", async () => {
		expect(await openIndexedDbStorage(undefined, () => {})).toMatchObject({
			ok: false,
			code: "storage",
		});
	});
});
