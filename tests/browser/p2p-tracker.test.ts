import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_OFFERS,
	type TrackerRoomConfig,
	trackerRooms,
} from "../../src/p2p/tracker";

/** A tracker frame that the page sent. */
interface Sent {
	readonly action?: string;
	readonly info_hash?: string;
	readonly event?: string;
	readonly numwant?: number;
	readonly offers?: readonly unknown[];
}

/** A tracker socket that opens at once, records what the page sends and never answers. */
class FakeTracker {
	static opened: FakeTracker[] = [];
	readyState = 0;
	readonly sent: Sent[] = [];
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(readonly url: string) {
		FakeTracker.opened.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.onopen?.();
		});
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Sent);
	}

	close(): void {
		this.readyState = 3;
	}

	/** The announces with offers, in send order. */
	offers(): Sent[] {
		return this.sent.filter((frame) => (frame.offers?.length ?? 0) > 0);
	}
}

const TRACKERS = ["wss://one.tracker.test", "wss://two.tracker.test"];

function config(offers?: number): TrackerRoomConfig {
	return {
		appId: "github.com/dvolgyes/open_robbers_rummy/test",
		password: "key",
		rtcConfig: { iceServers: [] },
		relayConfig: { urls: TRACKERS, redundancy: TRACKERS.length },
		...(offers === undefined ? {} : { offers }),
	};
}

beforeEach(() => {
	FakeTracker.opened = [];
	vi.stubGlobal("WebSocket", FakeTracker);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("trackerRooms", () => {
	it("announces the configured number of offers, and one offer in a room without a count", async () => {
		const rooms = trackerRooms();
		const table = rooms.joinRoom(config(6), "table");
		const pair = rooms.joinRoom(config(), "pair");
		await expect
			.poll(() => FakeTracker.opened.map((socket) => socket.offers().length))
			.toEqual([2, 2]);
		for (const socket of FakeTracker.opened) {
			const [first, second] = socket.offers();
			const counts = [first, second].map((frame) => frame?.offers?.length);
			expect(counts.toSorted()).toEqual([1, 6]);
			const many = first?.offers?.length === 6 ? first : second;
			expect(many?.numwant).toBeGreaterThanOrEqual(6);
		}
		await Promise.all([table.leave(), pair.leave()]);
	});

	it("ignores tracker messages that are not JSON objects or have fields of another type", async () => {
		const rooms = trackerRooms();
		const table = rooms.joinRoom(config(1), "noise");
		await expect
			.poll(() => FakeTracker.opened.map((socket) => socket.offers().length))
			.toEqual([1, 1]);
		const [socket] = FakeTracker.opened;
		const hash = socket?.offers()[0]?.info_hash;
		for (const data of [
			"not json",
			"[]",
			"null",
			JSON.stringify({ info_hash: hash, offer: "sdp", offer_id: 7 }),
			JSON.stringify({ info_hash: hash, answer: { sdp: 1 }, offer_id: "x" }),
			JSON.stringify({ interval: "soon", info_hash: hash }),
		])
			socket?.onmessage?.(new MessageEvent("message", { data }));
		await table.leave();
	});

	it("refuses an offer count outside 1 to MAX_OFFERS", () => {
		const rooms = trackerRooms();
		for (const offers of [0, 1.5, MAX_OFFERS + 1])
			expect(() => rooms.joinRoom(config(offers), "count")).toThrow(RangeError);
	});

	it("tells every tracker that the page stopped when it leaves a room", async () => {
		const rooms = trackerRooms();
		const table = rooms.joinRoom(config(2), "left");
		await expect
			.poll(() => FakeTracker.opened.map((socket) => socket.offers().length))
			.toEqual([1, 1]);
		await table.leave();
		for (const socket of FakeTracker.opened) {
			const hash = socket.offers()[0]?.info_hash;
			await expect
				.poll(() =>
					socket.sent.some(
						(frame) => frame.event === "stopped" && frame.info_hash === hash,
					),
				)
				.toBe(true);
		}
	});
});
