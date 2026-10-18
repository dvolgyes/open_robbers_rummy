import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Seat } from "../../src/protocol";
import {
	guardedStorage,
	type HoldOptions,
	SEAT_MEMORY_TTL_MS,
	SeatMemory,
	webSeatLocks,
} from "../../src/session";
import { OTHER_ROOM_ID, ROOM_ID } from "../unit/fixtures";

// The tests use the Web Storage and the Web Locks of this page in Chrome. Vitest keeps neither, so the
// tests clear them.
beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

function thrown(call: () => unknown): unknown {
	try {
		call();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

function frame(attributes: Record<string, string>): Promise<HTMLIFrameElement> {
	return new Promise((resolve) => {
		const element = document.createElement("iframe");
		for (const [name, value] of Object.entries(attributes))
			element.setAttribute(name, value);
		element.onload = () => resolve(element);
		document.body.append(element);
	});
}

/** Writes until even a one-character item does not fit. Returns the error of the last refused write. */
function fillLocalStorage(): unknown {
	let size = 1024 * 1024;
	let index = 0;
	let refusal: unknown;
	while (size >= 1) {
		try {
			localStorage.setItem(`fill.${index++}`, "x".repeat(size));
		} catch (error) {
			refusal = error;
			size = Math.floor(size / 2);
		}
	}
	return refusal;
}

describe("SeatMemory on the page's sessionStorage and localStorage", () => {
	const seats = () => new SeatMemory(sessionStorage, localStorage, Date.now);

	it("remembers the seat per tab and per browser, by room, across a reload", () => {
		const before = Date.now();
		seats().remember(ROOM_ID, "E");
		const after = Date.now();
		expect(sessionStorage.getItem(`lb.tab.${ROOM_ID}`)).toBe("E");
		const record = JSON.parse(
			localStorage.getItem(`lb.seat.${ROOM_ID}`) ?? "null",
		);
		expect(record.seat).toBe("E");
		expect(record.savedAt).toBeGreaterThanOrEqual(before);
		expect(record.savedAt).toBeLessThanOrEqual(after);
		const reloaded = seats();
		expect(reloaded.tabSeat(ROOM_ID)).toBe("E");
		expect(reloaded.browserSeat(ROOM_ID)).toBe("E");
		expect(reloaded.tabSeat(OTHER_ROOM_ID)).toBeUndefined();
		expect(reloaded.browserSeat(OTHER_ROOM_ID)).toBeUndefined();
	});

	it("forgets the browser seat after 24 hours and prunes stale records", () => {
		// Records that pages of this browser wrote 24 hours and 23 hours 59 minutes ago.
		const now = Date.now();
		localStorage.setItem(
			`lb.seat.${ROOM_ID}`,
			JSON.stringify({ seat: "E", savedAt: now - SEAT_MEMORY_TTL_MS }),
		);
		localStorage.setItem(
			`lb.seat.${OTHER_ROOM_ID}`,
			JSON.stringify({ seat: "N", savedAt: now - SEAT_MEMORY_TTL_MS + 60_000 }),
		);
		localStorage.setItem("lb.seat.garbage", "{not json");
		localStorage.setItem("unrelated", "kept");
		const memory = seats();
		expect(memory.browserSeat(ROOM_ID)).toBeUndefined();
		expect(memory.browserSeat(OTHER_ROOM_ID)).toBe("N");
		memory.prune();
		expect(localStorage.getItem(`lb.seat.${ROOM_ID}`)).toBeNull();
		expect(localStorage.getItem("lb.seat.garbage")).toBeNull();
		expect(localStorage.getItem(`lb.seat.${OTHER_ROOM_ID}`)).not.toBeNull();
		expect(localStorage.getItem("unrelated")).toBe("kept");
	});

	it("treats unreadable records and missing storage as no memory", () => {
		sessionStorage.setItem(`lb.tab.${ROOM_ID}`, "X");
		localStorage.setItem(`lb.seat.${ROOM_ID}`, '{"seat":"Q","savedAt":0}');
		expect(seats().tabSeat(ROOM_ID)).toBeUndefined();
		expect(seats().browserSeat(ROOM_ID)).toBeUndefined();
		const none = new SeatMemory(undefined, undefined, Date.now);
		none.remember(ROOM_ID, "N");
		none.prune();
		expect(none.tabSeat(ROOM_ID)).toBeUndefined();
	});
});

describe("guardedStorage", () => {
	// A browser that blocks site data throws the same SecurityError from `window.localStorage`;
	// resilience.spec.ts tests that browser with a Chrome profile that does not allow sites to save data.
	it("gives no storage when the browser blocks access: the storage of a cross-origin frame", async () => {
		const sandboxed = await frame({
			sandbox: "allow-scripts",
			srcdoc: "<p>other origin</p>",
		});
		const open = () => (sandboxed.contentWindow as Window).localStorage;
		const error = thrown(open);
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("SecurityError");
		expect(guardedStorage(open)).toBeUndefined();
		sandboxed.remove();
	});

	it("acts as read-only when the browser refuses a write: a full localStorage", () => {
		try {
			const refusal = fillLocalStorage();
			expect(refusal).toBeInstanceOf(DOMException);
			expect((refusal as DOMException).name).toBe("QuotaExceededError");
			const memory = new SeatMemory(
				guardedStorage(() => sessionStorage),
				guardedStorage(() => localStorage),
				Date.now,
			);
			memory.remember(ROOM_ID, "N");
			expect(localStorage.getItem(`lb.seat.${ROOM_ID}`)).toBeNull();
			expect(memory.browserSeat(ROOM_ID)).toBeUndefined();
			expect(memory.tabSeat(ROOM_ID)).toBe("N");
		} finally {
			localStorage.clear();
		}
	});

	it("passes calls through to a working storage", () => {
		const storage = guardedStorage(() => localStorage);
		storage?.setItem("k", "v");
		expect(localStorage.getItem("k")).toBe("v");
		expect(storage?.getItem("k")).toBe("v");
		expect(storage?.length).toBe(1);
		expect(storage?.key(0)).toBe("k");
		storage?.removeItem("k");
		expect(localStorage.length).toBe(0);
	});

	it("does not hide programming errors: a read from a removed frame", async () => {
		const removed = await frame({ srcdoc: "<p>same origin</p>" });
		removed.remove();
		expect(() =>
			guardedStorage(() => (removed.contentWindow as Window).localStorage),
		).toThrow(TypeError);
	});
});

describe("webSeatLocks on the page's lock manager", () => {
	const LOCK_PREFIX = "lb.seat.";
	const locks = webSeatLocks(navigator.locks);
	const releases: (() => void)[] = [];

	function hold(
		roomId: string,
		seat: Seat,
		options: HoldOptions = {},
	): () => void {
		const release = locks.hold(roomId, seat, options);
		releases.push(release);
		return release;
	}

	/** The names of the seat locks that a tab of this browser holds or waits for. */
	async function seatLocks(state: "held" | "pending"): Promise<string[]> {
		const snapshot = await navigator.locks.query();
		return (snapshot[state] ?? [])
			.map((lock) => lock.name ?? "")
			.filter((name) => name.startsWith(LOCK_PREFIX));
	}

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		await expect.poll(() => seatLocks("held")).toEqual([]);
		await expect.poll(() => seatLocks("pending")).toEqual([]);
	});

	it("reports the seats of this room that are held in this browser", async () => {
		const held: string[] = [];
		hold(ROOM_ID, "N", { onAcquired: () => held.push("N") });
		hold(OTHER_ROOM_ID, "E", { onAcquired: () => held.push("other E") });
		let releaseBogus: () => void = () => {};
		const bogus = new Promise<void>((resolve) => {
			releaseBogus = resolve;
		});
		releases.push(releaseBogus);
		void navigator.locks.request(`${LOCK_PREFIX}${ROOM_ID}.bogus`, () => {
			held.push("bogus");
			return bogus;
		});
		await expect.poll(() => held.length).toBe(3);
		expect(await locks.heldElsewhere(ROOM_ID)).toEqual(new Set(["N"]));
	});

	it("reports nothing without the Web Locks API", async () => {
		const none = webSeatLocks(undefined);
		expect(await none.heldElsewhere(ROOM_ID)).toEqual(new Set());
		expect(() => none.hold(ROOM_ID, "N")()).not.toThrow();
	});

	it("does not let another tab take an active seat lock", async () => {
		const events: string[] = [];
		const releaseOld = hold(ROOM_ID, "N", {
			onAcquired: () => events.push("old acquired"),
		});
		await expect.poll(() => events).toEqual(["old acquired"]);
		const releaseNew = hold(ROOM_ID, "N", {
			ifAvailable: true,
			onAcquired: () => events.push("new acquired"),
			onLost: () => events.push("new refused"),
		});
		await expect.poll(() => events).toEqual(["old acquired", "new refused"]);
		await expect.poll(() => seatLocks("pending")).toEqual([]);
		releaseOld();
		releaseNew();
		for (const release of releases.splice(0)) release();
		await expect.poll(() => seatLocks("held")).toEqual([]);
		expect(events).not.toContain("new acquired");
	});

	it("tells a tab when it holds the lock: at once when free, after the holder releases when it waits", async () => {
		const name = `${LOCK_PREFIX}${ROOM_ID}.N`;
		const acquired: string[] = [];
		const releaseFirst = hold(ROOM_ID, "N", {
			onAcquired: () => acquired.push("first"),
		});
		await expect.poll(() => acquired).toEqual(["first"]);
		const releaseSecond = hold(ROOM_ID, "N", {
			onAcquired: () => acquired.push("second"),
		});
		await expect.poll(() => seatLocks("pending")).toEqual([name]);
		expect(acquired).toEqual(["first"]);
		releaseFirst();
		await expect.poll(() => acquired).toEqual(["first", "second"]);
		const releaseWaiting = hold(ROOM_ID, "N", {
			onAcquired: () => acquired.push("released while waiting"),
		});
		await expect.poll(() => seatLocks("pending")).toEqual([name]);
		releaseWaiting();
		releaseSecond();
		await expect.poll(() => seatLocks("pending")).toEqual([]);
		await expect.poll(() => seatLocks("held")).toEqual([]);
		expect(acquired).toEqual(["first", "second"]);
	});

	it("tells a tab at once that it holds the lock without the Web Locks API", async () => {
		const acquired: string[] = [];
		webSeatLocks(undefined).hold(ROOM_ID, "N", {
			onAcquired: () => acquired.push("N"),
		});
		await Promise.resolve();
		expect(acquired).toEqual(["N"]);
	});

	it("reports no loss when a tab releases its lock or waits for one", async () => {
		const events: string[] = [];
		const record = (label: string): HoldOptions => ({
			onAcquired: () => events.push(`${label} acquired`),
			onLost: () => events.push(`${label} lost`),
		});
		const releaseFirst = hold(ROOM_ID, "N", record("first"));
		const releaseSecond = hold(ROOM_ID, "N", record("second"));
		const releaseOther = hold(ROOM_ID, "E", record("other"));
		await expect
			.poll(() => [...events].sort())
			.toEqual(["first acquired", "other acquired"]);
		releaseFirst();
		await expect.poll(() => events).toContain("second acquired");
		releaseSecond();
		releaseOther();
		await expect.poll(() => seatLocks("held")).toEqual([]);
		expect(events.filter((event) => event.endsWith("lost"))).toEqual([]);
	});
});
