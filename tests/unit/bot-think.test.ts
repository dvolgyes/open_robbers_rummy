import { describe, expect, it } from "vitest";
import { inlineThinker, type ThinkRequest, think } from "../../src/bot/think";
import { type ThinkWorker, workerThinker } from "../../src/bot/worker-thinker";
import { type HandState, rulesFor, viewFor } from "../../src/rummy";

function hand(own: string[]): HandState {
	return {
		rules: rulesFor("wikipedia", 4, true),
		players: 2,
		dealer: 1,
		turn: 0,
		phase: "start",
		hands: [own, ["1-2C", "1-9D", "1-KS"]],
		stock: ["1-3S", "1-4S"],
		table: [],
		opened: [true, true],
		lastPlay: null,
		passes: 0,
		nextMeldNo: 1,
		outcome: null,
	};
}

const playable = viewFor(hand(["0-5H", "0-6H", "0-7H", "0-KC"]), 0);

/** A worker that answers each request on the same thread, when the test calls `flush`. */
function fakeWorker() {
	const requests: ThinkRequest[] = [];
	let terminated = false;
	const worker: ThinkWorker = {
		onmessage: null,
		onerror: null,
		postMessage(request) {
			requests.push(request);
		},
		terminate() {
			terminated = true;
		},
	};
	const flush = () => {
		for (const request of requests.splice(0).reverse())
			worker.onmessage?.({ data: think(request) } as MessageEvent);
	};
	return { worker, requests, flush, terminated: () => terminated };
}

describe("bot thinker", () => {
	it("chooses the policy's action on the calling thread", async () => {
		const action = await inlineThinker().choose(playable, 0, 1000);
		expect(action?.type).toBe("play");
	});

	it("gives no action for a seat that is not on turn", async () => {
		expect(await inlineThinker().choose(playable, 1, 1000)).toBeUndefined();
	});

	it("matches each worker answer to its request, also out of order", async () => {
		const fake = fakeWorker();
		const thinker = workerThinker(fake.worker);
		const play = thinker.choose(playable, 0, 1000);
		const draw = thinker.choose(
			viewFor(hand(["0-5H", "0-9C", "0-KC"]), 0),
			0,
			1000,
		);
		expect(fake.requests.map((request) => request.thinkMs)).toEqual([
			1000, 1000,
		]);
		fake.flush();
		expect((await play)?.type).toBe("play");
		expect(await draw).toEqual({ type: "draw" });
	});

	it("rejects the waiting requests when the worker fails or closes", async () => {
		const fake = fakeWorker();
		const thinker = workerThinker(fake.worker);
		const failed = thinker.choose(playable, 0);
		fake.worker.onerror?.({ message: "out of memory" } as ErrorEvent);
		await expect(failed).rejects.toThrow(
			"the solver worker failed: out of memory",
		);
		const waiting = thinker.choose(playable, 0);
		thinker.close();
		expect(fake.terminated()).toBe(true);
		await expect(waiting).rejects.toThrow("the solver worker is closed");
		await expect(thinker.choose(playable, 0)).rejects.toThrow(
			"the solver worker is closed",
		);
	});
});
