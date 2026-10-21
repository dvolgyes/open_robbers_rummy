import {
	type Action,
	applyAction,
	cardPoints,
	type HandState,
	isWild,
	type Seat,
} from "../canasta";

const GOING_OUT = 1000;

/**
 * A rough value for one legal action, used to order the choices offered to a model and as the fallback when
 * no model answers. It reads only the seat's own cards and the public pile and melds, and it applies the action
 * only to learn whether it goes out.
 */
export function scoreAction(
	hand: HandState,
	seat: Seat,
	action: Action,
): number {
	const step = applyAction(hand, seat, action);
	if (step.ok && step.hand.outcome?.kind === "out") return GOING_OUT;
	switch (action.type) {
		case "draw":
			return 10;
		case "takePile":
			return 30 + hand.pile.length;
		case "meld":
			return 40 + action.cards.length * 3;
		case "extend":
			return 35 + action.cards.length * 3;
		case "discard": {
			const own = hand.hands[seat] ?? [];
			const card = own.find((item) => item.id === action.card);
			if (!card) return Number.NEGATIVE_INFINITY;
			const sameRank = own.filter((item) => item.rank === card.rank).length;
			return (
				20 -
				cardPoints(card) / 10 -
				(isWild(card) ? 40 : 0) +
				(sameRank === 1 ? 3 : 0)
			);
		}
		case "resetTurn":
			return -50;
	}
}

/**
 * The legal actions ordered from the most to the least promising. Ties keep the order of `legal`, so the same
 * position always gives the same order.
 */
export function rankActions(
	hand: HandState,
	seat: Seat,
	legal: readonly Action[],
): Action[] {
	return legal
		.map((action, index) => ({
			action,
			index,
			score: scoreAction(hand, seat, action),
		}))
		.toSorted((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.action);
}
