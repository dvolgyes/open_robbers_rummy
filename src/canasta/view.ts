import { type Card, isWild } from "./cards";
import {
	type HandState,
	initialSatisfied,
	type Outcome,
	type Phase,
	type Seat,
	type TeamState,
	teamOf,
} from "./hand";
import type { CanastaRules } from "./rules";

/** What one seat may know. Other hands and the stock are hidden until the hand is over. */
export interface HandView {
	readonly rules: CanastaRules;
	readonly teamScores: readonly [number, number];
	readonly dealer: Seat;
	readonly turn: Seat;
	readonly phase: Phase;
	readonly outcome: Outcome | null;
	readonly turnMeldPoints: number;
	readonly turnActions: number;
	readonly own: readonly Card[];
	readonly handCounts: readonly number[];
	/** All hands, shown only after the hand is over. */
	readonly revealed: readonly (readonly Card[])[] | null;
	readonly stockCount: number;
	readonly pile: readonly Card[];
	/** The viewer's side cannot take the pile to extend a meld: the pile holds a wild card, or the side has no initial meld yet. */
	readonly pileFrozen: boolean;
	readonly teams: readonly [TeamState, TeamState];
}

export function viewFor(hand: HandState, seat: Seat): HandView {
	return {
		rules: hand.rules,
		teamScores: hand.teamScores,
		dealer: hand.dealer,
		turn: hand.turn,
		phase: hand.phase,
		outcome: hand.outcome,
		turnMeldPoints: hand.turnMeldPoints,
		turnActions: hand.turnActions,
		own: hand.hands[seat] ?? [],
		handCounts: hand.hands.map((cards) => cards.length),
		revealed: hand.outcome === null ? null : hand.hands,
		stockCount: hand.stock.length,
		pile: hand.pile,
		pileFrozen: hand.pile.some(isWild) || !initialSatisfied(hand, teamOf(seat)),
		teams: hand.teams,
	};
}
