import { beforeEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { cleanup } from "../../src/p2p/expiry";
import { TABLE_IDLE_MS } from "../../src/p2p/limits";
import { entries, TABLE, tableRecord } from "../unit/p2p-fixtures";
import { DB_NAME, deleteDatabase, openStorage, request } from "./indexed-db";

beforeEach(deleteDatabase);

/**
 * Keeps a write transaction on the tombstones open on another connection, as another tab that writes does,
 * until the returned function runs.
 */
async function holdTombstones(): Promise<() => void> {
	const other = await request(indexedDB.open(DB_NAME));
	const tx = other.transaction("tombstones", "readwrite");
	let holding = true;
	const read = () => {
		if (holding) tx.objectStore("tombstones").get(TABLE).onsuccess = read;
	};
	read();
	return () => {
		holding = false;
	};
}

describe("cleanup", () => {
	it("stops at the first storage failure: a removal that waits for another tab fails when the site data is cleared", async () => {
		const storage = await openStorage();
		const table = tableRecord({ lastActivityAt: 0 });
		const created = await storage.commit({
			table,
			expect: null,
			append: entries(1, table.rev, table.lastAuth, null),
		});
		expect(created.ok).toBe(true);
		const release = await holdTombstones();
		const result = cleanup(storage, 2 * TABLE_IDLE_MS);
		// The listing reads only the tables, so it completes; the removal waits for the tombstones.
		expect(await storage.partitions()).toMatchObject({
			ok: true,
			value: [{ tableId: TABLE }],
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		await cdp().send("Storage.clearDataForOrigin", {
			origin: location.origin,
			storageTypes: "indexeddb",
		});
		expect(await result).toMatchObject({
			ok: false,
			code: "storage",
			detail: expect.stringMatching(/^UnknownError: /),
		});
		release();
	});
});
