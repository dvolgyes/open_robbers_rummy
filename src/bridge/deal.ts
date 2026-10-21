import { SEATS, type Seat } from "../protocol";
import type { RandomBelow } from "../random";
import { type Card, DECK, type Deal, sortCards } from "./cards";

export {
	cryptoRandomBelow,
	type RandomBelow,
	randomBelowFrom,
} from "../random";

/** Fisher–Yates shuffle into a new array; the input stays as it was. */
export function shuffle<T>(items: readonly T[], randomBelow: RandomBelow): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = randomBelow(i + 1);
		[result[i], result[j]] = [result[j] as T, result[i] as T];
	}
	return result;
}

/** Shuffles the deck and gives 13 consecutive cards to each seat, each hand in display order. */
export function dealCards(randomBelow: RandomBelow): Deal {
	const deck = shuffle(DECK, randomBelow);
	const hands: Partial<Record<Seat, Card[]>> = {};
	SEATS.forEach((seat, index) => {
		hands[seat] = sortCards(deck.slice(index * 13, (index + 1) * 13));
	});
	return hands as Record<Seat, Card[]>;
}
