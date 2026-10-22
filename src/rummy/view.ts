import type {
	HandState,
	LastPlay,
	Outcome,
	Phase,
	Seat,
	TableMeld,
} from "./hand";
import type { RummyRules } from "./rules";

/** What one seat may know. Other hands and the stock are hidden until the hand is over. */
export interface HandView {
	readonly rules: RummyRules;
	readonly players: number;
	readonly dealer: Seat;
	readonly turn: Seat;
	readonly phase: Phase;
	readonly outcome: Outcome | null;
	readonly own: readonly string[];
	readonly handCounts: readonly number[];
	/** All hands, shown only after the hand is over. */
	readonly revealed: readonly (readonly string[])[] | null;
	readonly stockCount: number;
	readonly table: readonly TableMeld[];
	readonly opened: readonly boolean[];
	readonly lastPlay: LastPlay | null;
	readonly passes: number;
}

export function viewFor(hand: HandState, seat: Seat): HandView {
	return {
		rules: hand.rules,
		players: hand.players,
		dealer: hand.dealer,
		turn: hand.turn,
		phase: hand.phase,
		outcome: hand.outcome,
		own: hand.hands[seat] ?? [],
		handCounts: hand.hands.map((cards) => cards.length),
		revealed: hand.outcome === null ? null : hand.hands,
		stockCount: hand.stock.length,
		table: hand.table,
		opened: hand.opened,
		lastPlay: hand.lastPlay,
		passes: hand.passes,
	};
}
