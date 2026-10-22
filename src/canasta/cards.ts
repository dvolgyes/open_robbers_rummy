export type Suit = "C" | "D" | "H" | "S";
export type Rank =
	| "3"
	| "4"
	| "5"
	| "6"
	| "7"
	| "8"
	| "9"
	| "10"
	| "J"
	| "Q"
	| "K"
	| "A"
	| "2"
	| "JK";

export interface Card {
	/** Unique across both decks, for example "0-10H" or "1-JK0". */
	readonly id: string;
	readonly rank: Rank;
	/** Null for jokers. */
	readonly suit: Suit | null;
}

const SUITS: readonly Suit[] = ["C", "D", "H", "S"];
const STANDARD_RANKS: readonly Rank[] = [
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
	"A",
	"2",
];
const JOKERS_PER_DECK = 2;

/** Two standard decks with two jokers each: 108 cards. */
export function buildDecks(): Card[] {
	const cards: Card[] = [];
	for (const deck of [0, 1]) {
		for (const suit of SUITS) {
			for (const rank of STANDARD_RANKS) {
				cards.push({ id: `${deck}-${rank}${suit}`, rank, suit });
			}
		}
		for (let joker = 0; joker < JOKERS_PER_DECK; joker++) {
			cards.push({ id: `${deck}-JK${joker}`, rank: "JK", suit: null });
		}
	}
	return cards;
}

/** Twos and jokers substitute for any natural rank. */
export function isWild(card: Pick<Card, "rank">): boolean {
	return card.rank === "2" || card.rank === "JK";
}

/** Red threes score for their side and are never melded. */
export function isRed3(card: Pick<Card, "rank" | "suit">): boolean {
	return card.rank === "3" && (card.suit === "H" || card.suit === "D");
}

/** Black threes block the pile and can be discarded only when going out. */
export function isBlack3(card: Pick<Card, "rank" | "suit">): boolean {
	return card.rank === "3" && (card.suit === "C" || card.suit === "S");
}

/** Card points as used in melds and for cards left in hand. Red threes are scored separately, so 100 is only their face value here. */
export function cardPoints(card: Pick<Card, "rank" | "suit">): number {
	if (isRed3(card)) return 100;
	if (isBlack3(card)) return 5;
	switch (card.rank) {
		case "JK":
			return 50;
		case "2":
		case "A":
			return 20;
		case "8":
		case "9":
		case "10":
		case "J":
		case "Q":
		case "K":
			return 10;
		default:
			return 5;
	}
}
