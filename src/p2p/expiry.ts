import { TABLE_IDLE_MS, TOMBSTONE_MS } from "./limits";
import type { StorageResult, TableStorage } from "./storage";

/**
 * Table expiry. `lastActivityAt` is `Date.now()` of this device; only durations cross devices.
 */

/** How long the table has been idle; zero when this device's clock moved back. */
export function idleMs(lastActivityAt: number, now: number): number {
	return Math.max(0, now - lastActivityAt);
}

export function isIdle(lastActivityAt: number, now: number): boolean {
	return idleMs(lastActivityAt, now) >= TABLE_IDLE_MS;
}

/**
 * Expires every idle table in this browser and forgets old tombstones. A table counts as active while any
 * of its partitions is. Returns the expired table ids.
 */
export async function cleanup(
	storage: TableStorage,
	now: number,
): Promise<StorageResult<string[]>> {
	const listed = await storage.partitions();
	if (!listed.ok) return listed;
	const latest = new Map<string, number>();
	for (const { tableId, lastActivityAt } of listed.value) {
		latest.set(tableId, Math.max(latest.get(tableId) ?? 0, lastActivityAt));
	}
	const expired: string[] = [];
	for (const [tableId, lastActivityAt] of latest) {
		if (!isIdle(lastActivityAt, now)) continue;
		const done = await storage.expireTable(tableId, now);
		if (!done.ok) return done;
		expired.push(tableId);
	}
	const pruned = await storage.pruneTombstones(now - TOMBSTONE_MS);
	return pruned.ok ? { ok: true, value: expired } : pruned;
}
