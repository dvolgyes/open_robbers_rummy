/**
 * Pure ordering of a rummy hand. The DOM layer sorts with these functions and only places the result.
 */

/** How the viewer's hand is ordered: by rank (sets read across) or by suit (runs read across). */
export type HandOrder = "rank" | "suit";

/** The rank order of a hand: the ace is lowest, the king is highest, and jokers come last. */
const RANK_ORDER: readonly string[] = [
	"A",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"10",
	"J",
	"Q",
	"K",
	"JK",
];

/** The suit order of a hand. Jokers have no suit and sort after every suit. */
const SUIT_ORDER: readonly string[] = ["C", "D", "H", "S"];

function rankIndex(rank: string): number {
	const index = RANK_ORDER.indexOf(rank);
	return index === -1 ? RANK_ORDER.length : index;
}

function suitIndex(suit: string | null): number {
	return suit === null ? SUIT_ORDER.length : SUIT_ORDER.indexOf(suit);
}

/**
 * A new array with the cards in the given order. The input is not changed. Equal cards keep their input order.
 * By rank: A to K, then jokers; within a rank, clubs, diamonds, hearts, spades.
 * By suit: clubs, diamonds, hearts, spades, then jokers; within a suit, A to K.
 */
export function sortHand<
	T extends { readonly rank: string; readonly suit: string | null },
>(cards: readonly T[], order: HandOrder): T[] {
	const compare = (a: T, b: T): number =>
		order === "rank"
			? rankIndex(a.rank) - rankIndex(b.rank) ||
				suitIndex(a.suit) - suitIndex(b.suit)
			: suitIndex(a.suit) - suitIndex(b.suit) ||
				rankIndex(a.rank) - rankIndex(b.rank);
	return [...cards].sort(compare);
}
