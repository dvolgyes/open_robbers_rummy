import { isObject, SEATS, type Seat } from "../protocol";

/** Suits in display order (spades first) and ranks from high to low. */
export const SUITS = ["S", "H", "D", "C"] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = [
	"A",
	"K",
	"Q",
	"J",
	"T",
	"9",
	"8",
	"7",
	"6",
	"5",
	"4",
	"3",
	"2",
] as const;
export type Rank = (typeof RANKS)[number];

/** A card is its suit letter and rank letter, for example "SA" or "HT". */
export type Card = `${Suit}${Rank}`;

/** The 52 cards in display order: SA first, C2 last. */
export const DECK: readonly Card[] = SUITS.flatMap((suit) =>
	RANKS.map((rank): Card => `${suit}${rank}`),
);

export const SUIT_SYMBOLS: Readonly<Record<Suit, string>> = {
	S: "♠",
	H: "♥",
	D: "♦",
	C: "♣",
};

/** The four hands of one board, 13 cards each. */
export type Deal = Readonly<Record<Seat, readonly Card[]>>;

export function isCard(value: unknown): value is Card {
	return (
		typeof value === "string" && (DECK as readonly string[]).includes(value)
	);
}

export function suitOf(card: Card): Suit {
	return card[0] as Suit;
}

export function rankOf(card: Card): Rank {
	return card[1] as Rank;
}

/** Returns a copy in display order. */
export function sortCards(cards: readonly Card[]): Card[] {
	return cards.toSorted((a, b) => DECK.indexOf(a) - DECK.indexOf(b));
}

/** True for four hands of 13 cards that together hold each card exactly once. */
export function isDeal(value: unknown): value is Deal {
	if (!isObject(value)) return false;
	const seen = new Set<string>();
	for (const seat of SEATS) {
		const hand = value[seat];
		if (!Array.isArray(hand) || hand.length !== 13) return false;
		for (const card of hand) {
			if (!isCard(card) || seen.has(card)) return false;
			seen.add(card);
		}
	}
	return true;
}
