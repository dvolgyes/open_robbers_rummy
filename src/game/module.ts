import type { JsonObject, Seat, TableConfig } from "../protocol";

/** What the host knows when it validates one persisted command. */
export interface ApplyContext {
	readonly tableId: string;
	readonly config: TableConfig;
	/** Sender, taken from the stored command row, never from the payload. */
	readonly seat: Seat;
	/** The holder of the sender's seat, from the table's seat row, never from the payload. */
	readonly holder: string;
	readonly commandId: string;
	/** Sequence number the event gets if the commit succeeds (table revision + 1). */
	readonly seq: number;
	/** Seats at the table now: the host's own seat and each seat whose current peer is connected to the host. */
	readonly present: readonly Seat[];
	/** Features reported by each currently bound seat; used only to avoid incompatible shared workflows. */
	readonly features?: ReadonlyMap<Seat, readonly string[]>;
}

/** `event` is the body only; the host adds the envelope (v, tableId, type, seq, commandId, fromSeat). */
export type ApplyResult =
	| {
			readonly ok: true;
			readonly event: JsonObject;
			readonly state: JsonObject;
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			/** The command needs players who are not present; the sender keeps it and sends it again. */
			readonly waiting?: true;
	  };

/**
 * Game rules run only in the host browser. A module is pure: the same state, context and payload give the
 * same result, with the exception of randomness that a module documents (for example, a deal).
 */
export interface GameModule {
	initialState(tableId: string, config: TableConfig): JsonObject;
	isState(state: JsonObject, tableId: string): boolean;
	apply(
		state: JsonObject,
		context: ApplyContext,
		payload: unknown,
	): ApplyResult;
	/**
	 * True for a command whose result is random, such as a shuffle. Only the host may send it, because followers
	 * cannot recompute the result. Omit when the game has no random commands.
	 */
	isRandomCommand?(payload: unknown): boolean;
}
