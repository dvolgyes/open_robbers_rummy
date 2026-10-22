import {
	applyAction,
	legalActions,
	type MatchState,
	startMatch,
} from "../../src/canasta";

/**
 * A match in the draw phase where the seat on turn can take the pile, but only with cards from its hand: no pickup
 * goes onto an existing meld with the top card alone. The search plays seeded games with fixed choices, and never
 * takes the pile itself, so the games go on until such a position comes.
 */
export function pairPickupMatch(): MatchState {
	for (let seed = 1; seed <= 50; seed++) {
		let match = startMatch(seed);
		let choice = seed;
		for (let step = 0; step < 300 && match.hand.outcome === null; step++) {
			const hand = match.hand;
			const legal = legalActions(hand, hand.turn);
			const pickups = legal.flatMap((action) =>
				action.type === "takePile" ? [action] : [],
			);
			if (
				hand.phase === "draw" &&
				pickups.length > 0 &&
				pickups.every((action) => action.cards.length >= 2)
			)
				return match;
			const moves = legal.filter(
				(action) => action.type !== "takePile" && action.type !== "resetTurn",
			);
			choice = (choice * 1103515245 + 12345) % 2147483648;
			const action = moves[choice % moves.length];
			if (action === undefined) break;
			const next = applyAction(hand, hand.turn, action);
			if (!next.ok) throw new Error(next.reason);
			match = { ...match, hand: next.hand };
		}
	}
	throw new Error("no seeded game reached a pickup that needs hand cards");
}
