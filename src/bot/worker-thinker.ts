import type { Action } from "../rummy";
import {
	THINK_MS,
	type Thinker,
	type ThinkRequest,
	type ThinkResponse,
} from "./think";

/** The part of `Worker` that the thinker uses, so a test can give a fake one. */
export interface ThinkWorker {
	postMessage(request: ThinkRequest): void;
	onmessage: ((event: MessageEvent<ThinkResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	terminate(): void;
}

/** The browser's solver worker; Vite bundles the module from this URL. */
export function solverWorker(): ThinkWorker {
	return new Worker(new URL("./solver-worker.ts", import.meta.url), {
		type: "module",
	}) as unknown as ThinkWorker;
}

/** A thinker that runs the search in a worker, so a long search does not block the page. */
export function workerThinker(worker: ThinkWorker = solverWorker()): Thinker {
	const pending = new Map<
		number,
		{ resolve(action: Action | undefined): void; reject(error: Error): void }
	>();
	let nextId = 1;
	let closed = false;
	const failAll = (error: Error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};
	worker.onmessage = (event) => {
		const waiter = pending.get(event.data.id);
		if (waiter === undefined) return;
		pending.delete(event.data.id);
		waiter.resolve(event.data.action ?? undefined);
	};
	worker.onerror = (event) => {
		failAll(new Error(`the solver worker failed: ${event.message}`));
	};
	return {
		choose(view, seat, thinkMs = THINK_MS) {
			if (closed)
				return Promise.reject(new Error("the solver worker is closed"));
			const id = nextId++;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				worker.postMessage({ id, view, seat, thinkMs });
			});
		},
		close() {
			closed = true;
			worker.terminate();
			failAll(new Error("the solver worker is closed"));
		},
	};
}
