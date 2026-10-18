import { SEATS, type Seat } from "../protocol";
import { type Card, DECK, type Deal, sortCards } from "./cards";

/** Returns an integer from 0 to bound - 1. */
export type RandomBelow = (bound: number) => number;

const UINT32_RANGE = 2 ** 32;

/**
 * Builds a uniform `RandomBelow` from a source of uniform 32-bit values. A value in the incomplete top block
 * would make small results more likely, so it is rejected and another value is drawn.
 */
export function randomBelowFrom(nextUint32: () => number): RandomBelow {
	return (bound) => {
		if (!Number.isInteger(bound) || bound < 1 || bound > UINT32_RANGE)
			throw new Error(
				`random bound must be an integer from 1 to 2^32: ${bound}`,
			);
		const limit = UINT32_RANGE - (UINT32_RANGE % bound);
		for (;;) {
			const value = nextUint32();
			if (value < limit) return value % bound;
		}
	};
}

function cryptoUint32(): number {
	const value = crypto.getRandomValues(new Uint32Array(1))[0];
	if (value === undefined)
		throw new Error("crypto.getRandomValues gave no value");
	return value;
}

export const cryptoRandomBelow: RandomBelow = randomBelowFrom(cryptoUint32);

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
