import { beforeEach, describe, expect, it } from "vitest";
import type { Authority } from "../../src/p2p/authority";
import {
	appendCommit,
	creationCommit,
	LocalLog,
	type LogChange,
	openLog,
	storeClaim,
	storeFollowed,
} from "../../src/p2p/log";
import type { TableRecord } from "../../src/p2p/records";
import type { TableStorage } from "../../src/p2p/storage";
import type { Entry } from "../../src/p2p/wire";
import {
	AUTH_1,
	AUTH_2,
	CONFIG,
	commandId,
	entries,
	HOLDER_E,
	HOLDER_N,
	outboxRecord,
	TABLE,
	tableRecord,
} from "../unit/p2p-fixtures";
import { deleteDatabase, openNewerVersion, openStorage } from "./indexed-db";

const AUTH_3: Authority = { term: 3, tag: `${HOLDER_E}.E`, inc: 4 };

beforeEach(deleteDatabase);

/** A stored partition N with entries 1..3 by AUTH_1, opened as a log. */
async function storedLog(
	storage?: TableStorage,
	table: TableRecord = tableRecord(),
	log: Entry[] = entries(1, 3, AUTH_1, null),
): Promise<LocalLog> {
	const into = storage ?? (await openStorage());
	const created = await into.commit({ table, expect: null, append: log });
	if (!created.ok) throw new Error(created.detail);
	const opened = await openLog(into, TABLE, "N");
	if (!opened.ok) throw new Error(opened.detail);
	return opened.value.log;
}

function appendNext(log: LocalLog, count = 1) {
	return log.write((table) => {
		if (!table) return null;
		const next = entries(table.rev + 1, table.rev + count, AUTH_1, AUTH_1);
		return appendCommit(table, next, { phase: "play" }, 2_000);
	});
}

describe("LocalLog", () => {
	it("creates the partition with the creator's seat claim and tells its listeners", async () => {
		const log = new LocalLog(await openStorage(), TABLE, "N");
		const changes: LogChange[] = [];
		log.subscribe((change) => changes.push(change));
		const written = await log.write(() =>
			creationCommit({
				tableId: TABLE,
				seat: "N",
				holder: HOLDER_N,
				config: CONFIG,
				state: { phase: "lobby" },
				auth: AUTH_1,
				id: commandId(1),
				now: 1_000,
			}),
		);
		expect(written).toEqual({ ok: true, value: true });
		expect(log.position()).toEqual({ rev: 1, lastAuth: AUTH_1 });
		expect(log.table?.host).toEqual(AUTH_1);
		expect(log.table?.inc).toBe(1);
		expect(log.table?.seats.find((row) => row.seat === "N")).toEqual({
			seat: "N",
			holder: HOLDER_N,
			gen: 1,
		});
		expect(log.entry(1)?.kind).toBe("seat");
		expect(changes).toEqual([
			{ appended: log.entries, replaced: true, previous: [] },
		]);
	});

	it("leaves its copy unchanged when a write fails", async () => {
		const log = await storedLog();
		const changes: LogChange[] = [];
		log.subscribe((change) => changes.push(change));
		await openNewerVersion();
		const written = await appendNext(log);
		expect(written).toMatchObject({ ok: false, code: "storage" });
		expect(log.position()).toEqual({ rev: 3, lastAuth: AUTH_1 });
		expect(log.entries).toHaveLength(3);
		expect(log.seqOf(commandId(4))).toBeUndefined();
		expect(changes).toEqual([]);
	});

	it("runs queued writes one at a time, each on the copy the one before left", async () => {
		const log = await storedLog();
		const results = await Promise.all([appendNext(log), appendNext(log, 2)]);
		expect(results).toEqual([
			{ ok: true, value: true },
			{ ok: true, value: true },
		]);
		expect(log.position().rev).toBe(6);
		expect(log.seqOf(commandId(6))).toBe(6);
		const reloaded = await openLog(await openStorage(), TABLE, "N");
		expect(reloaded.ok && reloaded.value.log.entries).toEqual(log.entries);
	});

	it("writes nothing when the build returns null", async () => {
		const log = await storedLog();
		// The connection is closed, so any write would fail.
		await openNewerVersion();
		expect(await log.write(() => null)).toEqual({ ok: true, value: false });
	});

	it("deletes the table in this browser when it expires, and refuses later writes", async () => {
		const storage = await openStorage();
		const log = await storedLog(storage);
		await storage.commit({
			table: tableRecord({ replica: "E" }),
			expect: null,
			append: entries(1, 3, AUTH_1, null),
		});
		expect(await log.expire(5_000)).toEqual({ ok: true, value: undefined });
		expect(log.expired).toBe(true);
		expect(log.table).toBeNull();
		expect(await storage.partitions()).toEqual({ ok: true, value: [] });
		expect(await storage.tombstone(TABLE)).toEqual({
			ok: true,
			value: { tableId: TABLE, expiredAt: 5_000 },
		});
		expect(await appendNext(log)).toMatchObject({
			ok: false,
			code: "expired",
		});
	});

	it("opens a stored partition with its outbox, and an absent one as an empty log", async () => {
		const storage = await openStorage();
		await storedLog(storage);
		await storage.putOutbox(outboxRecord(2));
		await storage.putOutbox(outboxRecord(1));
		const opened = await openLog(storage, TABLE, "N");
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.value.log.position()).toEqual({ rev: 3, lastAuth: AUTH_1 });
		expect(opened.value.outbox.map((record) => record.order)).toEqual([1, 2]);
		const absent = await openLog(storage, TABLE, "S");
		expect(absent.ok && absent.value.log.table).toBeNull();
		expect(absent.ok && absent.value.outbox).toEqual([]);
	});

	it("deletes the replica's own commands from its outbox in the commit that logs them", async () => {
		const storage = await openStorage();
		const log = await storedLog(storage);
		await storage.putOutbox(outboxRecord(1, { id: commandId(4) }));
		await storage.putOutbox(outboxRecord(2));
		await appendNext(log);
		const loaded = await storage.load(TABLE, "N");
		expect(
			loaded.ok && loaded.value?.outbox.map((record) => record.id),
		).toEqual([outboxRecord(2).id]);
	});
});

describe("stored host", () => {
	it("a claim raises the host and the incarnation only when it beats the stored host", async () => {
		const log = await storedLog();
		expect(await storeClaim(log, AUTH_1)).toEqual({ ok: true, value: false });
		expect(await storeClaim(log, AUTH_3)).toEqual({ ok: true, value: true });
		expect(log.table).toMatchObject({ host: AUTH_3, inc: 4, rev: 3 });
		expect(await storeClaim(log, AUTH_2)).toEqual({ ok: true, value: false });
		expect(log.table?.host).toEqual(AUTH_3);
	});

	it("a followed authority raises the host but not the incarnation", async () => {
		const log = await storedLog();
		expect(await storeFollowed(log, AUTH_3)).toEqual({ ok: true, value: true });
		expect(log.table).toMatchObject({ host: AUTH_3, inc: 1 });
		expect(await storeFollowed(log, AUTH_2)).toEqual({
			ok: true,
			value: false,
		});
	});

	it("writes nothing without a table", async () => {
		const log = new LocalLog(await openStorage(), TABLE, "N");
		expect(await storeFollowed(log, AUTH_2)).toEqual({
			ok: true,
			value: false,
		});
	});
});
