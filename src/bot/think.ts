import type { Action, HandView, Seat } from "../rummy";
import { chooseAction } from "./policy";

/** The longest search of one decision; a turn has at most two decisions, so the user's 10 s limit holds. */
export const THINK_MS = 5000;
/** A node limit beside the time limit, so the search memory stays small on a fast machine. */
export const THINK_NODES = 1_000_000;

/** A request to choose one action, as it crosses into a worker. */
export interface ThinkRequest {
	readonly id: number;
	readonly view: HandView;
	readonly seat: Seat;
	readonly thinkMs: number;
}

export interface ThinkResponse {
	readonly id: number;
	/** Null when the seat has nothing to do. */
	readonly action: Action | null;
}

/** Chooses one action of a bot seat; the search stops after `thinkMs` with the best play found. */
export interface Thinker {
	choose(
		view: HandView,
		seat: Seat,
		thinkMs?: number,
	): Promise<Action | undefined>;
	/** Stops the thinker and its worker; later calls fail. */
	close(): void;
}

/** Runs one request with the clock of the context that runs it. */
export function think(
	request: ThinkRequest,
	now: () => number = Date.now,
): ThinkResponse {
	const action = chooseAction(request.view, request.seat, {
		maxNodes: THINK_NODES,
		deadline: now() + request.thinkMs,
		now,
	});
	return { id: request.id, action: action ?? null };
}

/** A thinker on the calling thread, for Node and for tests. */
export function inlineThinker(): Thinker {
	return {
		async choose(view, seat, thinkMs = THINK_MS) {
			return think({ id: 0, view, seat, thinkMs }).action ?? undefined;
		},
		close() {},
	};
}
