import { cardPoints } from "./cards";
import { type HandState, type Seat, teamOf } from "./hand";
import { canastaBonus, meldPoints, type TeamIndex } from "./melds";

export interface TeamScore {
	readonly melds: number;
	readonly canastaBonus: number;
	readonly redThrees: number;
	readonly outBonus: number;
	/** Cards left in the hands of this side, counted negative. */
	readonly handPenalty: number;
	readonly total: number;
}

/** Scores a finished hand. Each side's total is its melds and bonuses minus the cards left in its hands. */
export function scoreHand(hand: HandState): readonly [TeamScore, TeamScore] {
	return [scoreTeam(hand, 0), scoreTeam(hand, 1)];
}

function scoreTeam(hand: HandState, team: TeamIndex): TeamScore {
	const state = hand.teams[team];
	const melds = state.melds.reduce(
		(sum, meld) => sum + meldPoints(meld.cards),
		0,
	);
	const canastas = state.melds.reduce(
		(sum, meld) => sum + canastaBonus(meld, hand.rules),
		0,
	);
	const redCount = state.redThrees.length;
	const redThrees = state.initialMade
		? redCount * hand.rules.redThreeBonus
		: -redCount * hand.rules.redThreeBonus;
	const outBonus =
		hand.outcome?.kind === "out" && teamOf(hand.outcome.seat) === team
			? hand.rules.outBonus +
				(hand.outcome.concealed ? hand.rules.concealedOutBonus : 0)
			: 0;
	const seats: readonly Seat[] = [0, 1, 2, 3];
	const handCards = seats
		.filter((seat) => teamOf(seat) === team)
		.flatMap((seat) => hand.hands[seat] ?? []);
	const handPenalty = -handCards.reduce(
		(sum, card) => sum + cardPoints(card),
		0,
	);
	const total = melds + canastas + redThrees + outBonus + handPenalty;
	return {
		melds,
		canastaBonus: canastas,
		redThrees,
		outBonus,
		handPenalty,
		total,
	};
}
