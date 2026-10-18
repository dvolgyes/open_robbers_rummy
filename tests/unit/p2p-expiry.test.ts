import { describe, expect, it } from "vitest";
import { cleanup, idleMs, isIdle } from "../../src/p2p/expiry";
import { TABLE_IDLE_MS, TOMBSTONE_MS } from "../../src/p2p/limits";
import { MemoryStorage, type TableStorage } from "../../src/p2p/storage";
import type { Seat } from "../../src/protocol";
import { entries, OTHER_TABLE, TABLE, tableRecord } from "./p2p-fixtures";

const NOW = 100 * TABLE_IDLE_MS;

async function stored(
	storage: TableStorage,
	tableId: string,
	replica: Seat,
	lastActivityAt: number,
): Promise<void> {
	const table = tableRecord({ tableId, replica, lastActivityAt });
	const done = await storage.commit({
		table,
		expect: null,
		append: entries(1, table.rev, table.lastAuth, null),
	});
	if (!done.ok) throw new Error(done.detail);
}

describe("idleMs and isIdle", () => {
	it("count a table as idle from 24 hours without activity", () => {
		expect(isIdle(NOW - TABLE_IDLE_MS + 1, NOW)).toBe(false);
		expect(isIdle(NOW - TABLE_IDLE_MS, NOW)).toBe(true);
		expect(idleMs(NOW - 5_000, NOW)).toBe(5_000);
	});

	it("count no idle time when the device clock moved back", () => {
		expect(idleMs(NOW + 60_000, NOW)).toBe(0);
		expect(isIdle(NOW + 60_000, NOW)).toBe(false);
	});
});

describe("cleanup", () => {
	it("expires idle tables with all their partitions and keeps active ones", async () => {
		const storage = new MemoryStorage();
		await stored(storage, TABLE, "N", NOW - TABLE_IDLE_MS);
		await stored(storage, TABLE, "E", NOW - TABLE_IDLE_MS - 1);
		await stored(storage, OTHER_TABLE, "N", NOW - 1_000);
		expect(await cleanup(storage, NOW)).toEqual({ ok: true, value: [TABLE] });
		const left = await storage.partitions();
		expect(left.ok && left.value.map((info) => info.tableId)).toEqual([
			OTHER_TABLE,
		]);
		expect(await storage.tombstone(TABLE)).toEqual({
			ok: true,
			value: { tableId: TABLE, expiredAt: NOW },
		});
	});

	it("keeps a stale partition while another partition of its table is active", async () => {
		const storage = new MemoryStorage();
		await stored(storage, TABLE, "N", NOW - 2 * TABLE_IDLE_MS);
		await stored(storage, TABLE, "E", NOW - 1_000);
		expect(await cleanup(storage, NOW)).toEqual({ ok: true, value: [] });
		const left = await storage.partitions();
		expect(left.ok && left.value).toHaveLength(2);
	});

	it("forgets tombstones after 30 days", async () => {
		const storage = new MemoryStorage();
		await storage.expireTable(TABLE, NOW);
		expect(await cleanup(storage, NOW + TOMBSTONE_MS)).toEqual({
			ok: true,
			value: [],
		});
		expect(await storage.tombstone(TABLE)).toMatchObject({
			value: { tableId: TABLE },
		});
		await cleanup(storage, NOW + TOMBSTONE_MS + 1);
		expect(await storage.tombstone(TABLE)).toEqual({ ok: true, value: null });
	});

	// A storage failure is tested on Chrome's IndexedDB in tests/browser/p2p-expiry.test.ts.
});
