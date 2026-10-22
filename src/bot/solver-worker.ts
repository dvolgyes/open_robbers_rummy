import { type ThinkRequest, type ThinkResponse, think } from "./think";

/** The worker's global scope, as far as this entry uses it. */
interface WorkerScope {
	onmessage: ((event: MessageEvent<ThinkRequest>) => void) | null;
	postMessage(response: ThinkResponse): void;
}

const scope = self as unknown as WorkerScope;

/** The worker entry: one response per request, in order. */
scope.onmessage = (event) => {
	scope.postMessage(think(event.data, () => performance.now()));
};
