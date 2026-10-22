import { cardOf, penaltyValue } from "./cards";
import type { HandState, Seat } from "./hand";

export interface Settlement {
	/** By seat: the penalty values of the cards left in hand; 0 for a player who went out. */
	readonly penalties: readonly number[];
	/** The player who went out, or at a blocked end every player with the lowest penalty. */
	readonly winners: readonly Seat[];
}

export function penaltyOf(ids: readonly string[]): number {
	return ids.reduce((sum, id) => sum + penaltyValue(cardOf(id)), 0);
}

/** The result of a finished hand; throws for a hand that is not over. */
export function settle(hand: HandState): Settlement {
	const outcome = hand.outcome;
	if (outcome === null) throw new Error("the hand is not over");
	const penalties = hand.hands.map(penaltyOf);
	if (outcome.kind === "out") return { penalties, winners: [outcome.seat] };
	const lowest = Math.min(...penalties);
	return {
		penalties,
		winners: penalties.flatMap((penalty, seat) =>
			penalty === lowest ? [seat] : [],
		),
	};
}
