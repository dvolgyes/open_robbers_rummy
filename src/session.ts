import { isObject, isSeat, type Seat } from "./protocol";

// ---------------------------------------------------------------------------------------------------------------
// Seat memory (owner decision 2026-10-18: reopening the same link gives the same seat back)

export const SEAT_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
const TAB_PREFIX = "lb.tab.";
const BROWSER_PREFIX = "lb.seat.";

/** Storage that may be missing, for example when the browser blocks site data. */
export type MaybeStorage =
	| Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">
	| undefined;

/**
 * Web storage throws a DOMException when the browser blocks site data (on access) or the quota is full
 * (on write). Seat memory is a convenience, so such a storage acts as empty and read-only.
 */
export function guardedStorage(open: () => Storage): MaybeStorage {
	const attempt = <T>(call: () => T, fallback: T): T => {
		try {
			return call();
		} catch (error) {
			if (error instanceof DOMException) return fallback;
			throw error;
		}
	};
	const storage = attempt<Storage | undefined>(open, undefined);
	if (!storage) return undefined;
	return {
		get length() {
			return attempt(() => storage.length, 0);
		},
		key: (index) => attempt(() => storage.key(index), null),
		getItem: (key) => attempt(() => storage.getItem(key), null),
		setItem: (key, value) =>
			attempt(() => storage.setItem(key, value), undefined),
		removeItem: (key) => attempt(() => storage.removeItem(key), undefined),
	};
}

/**
 * sessionStorage holds this tab's seat (survives reload and an Android tab restore). localStorage holds
 * the browser's last seat per room for 24 hours (survives closing the tab).
 */
export class SeatMemory {
	readonly #tab: MaybeStorage;
	readonly #browser: MaybeStorage;
	readonly #now: () => number;

	constructor(tab: MaybeStorage, browser: MaybeStorage, now: () => number) {
		this.#tab = tab;
		this.#browser = browser;
		this.#now = now;
	}

	tabSeat(roomId: string): Seat | undefined {
		const value = this.#tab?.getItem(TAB_PREFIX + roomId);
		return isSeat(value) ? value : undefined;
	}

	browserSeat(roomId: string): Seat | undefined {
		const record = this.#readBrowser(BROWSER_PREFIX + roomId);
		return record && this.#now() - record.savedAt < SEAT_MEMORY_TTL_MS
			? record.seat
			: undefined;
	}

	remember(roomId: string, seat: Seat): void {
		this.#tab?.setItem(TAB_PREFIX + roomId, seat);
		this.#browser?.setItem(
			BROWSER_PREFIX + roomId,
			JSON.stringify({ seat, savedAt: this.#now() }),
		);
	}

	/** Removes browser records older than the room lifetime. */
	prune(): void {
		const storage = this.#browser;
		if (!storage) return;
		const stale: string[] = [];
		for (let index = 0; index < storage.length; index++) {
			const key = storage.key(index);
			if (!key?.startsWith(BROWSER_PREFIX)) continue;
			const record = this.#readBrowser(key);
			if (!record || this.#now() - record.savedAt >= SEAT_MEMORY_TTL_MS)
				stale.push(key);
		}
		for (const key of stale) storage.removeItem(key);
	}

	#readBrowser(key: string): { seat: Seat; savedAt: number } | undefined {
		const text = this.#browser?.getItem(key);
		if (!text) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return undefined;
		}
		if (
			!isObject(value) ||
			!isSeat(value.seat) ||
			typeof value.savedAt !== "number"
		)
			return undefined;
		return { seat: value.seat, savedAt: value.savedAt };
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Seat locks: which seats another live tab of this browser holds

export interface HoldOptions {
	/** Refuses at once when another tab holds the lock instead of waiting for it. */
	readonly ifAvailable?: boolean;
	/** Runs once when this tab loses the lock before it releases it, for example if the page can no longer hold it. */
	readonly onLost?: () => void;
	/** Runs once when this tab holds the lock; never when it releases the lock before the grant. */
	readonly onAcquired?: () => void;
}

export interface SeatLocks {
	heldElsewhere(roomId: string): Promise<ReadonlySet<Seat>>;
	/** Holds the seat's lock until the returned function runs or the tab closes. */
	hold(roomId: string, seat: Seat, options?: HoldOptions): () => void;
}

const LOCK_PREFIX = "lb.seat.";

function lockName(roomId: string, seat: Seat): string {
	return `${LOCK_PREFIX}${roomId}.${seat}`;
}

/**
 * Web Locks are released when a tab closes or crashes, and kept while a tab is only suspended.
 * Without the API (old browsers), no seat counts as held elsewhere.
 */
export function webSeatLocks(locks: LockManager | undefined): SeatLocks {
	return {
		async heldElsewhere(roomId) {
			const held = new Set<Seat>();
			if (!locks) return held;
			const snapshot = await locks.query();
			for (const lock of snapshot.held ?? []) {
				const prefix = `${LOCK_PREFIX}${roomId}.`;
				const seat = lock.name?.startsWith(prefix)
					? lock.name.slice(prefix.length)
					: undefined;
				if (isSeat(seat)) held.add(seat);
			}
			return held;
		},
		hold(roomId, seat, options = {}) {
			if (!locks) {
				let released = false;
				queueMicrotask(() => {
					if (!released) options.onAcquired?.();
				});
				return () => {
					released = true;
				};
			}
			let ended = false;
			let release: () => void = () => {};
			const released = new Promise<void>((resolve) => {
				release = () => {
					ended = true;
					resolve();
				};
			});
			const requestOptions = options.ifAvailable ? { ifAvailable: true } : {};
			// The request rejects when the page can no longer hold the lock.
			locks
				.request(lockName(roomId, seat), requestOptions, (lock) => {
					if (lock === null) {
						ended = true;
						options.onLost?.();
						return;
					}
					if (!ended) options.onAcquired?.();
					return released;
				})
				.catch(() => {
					if (ended) return;
					ended = true;
					options.onLost?.();
				});
			return release;
		},
	};
}
