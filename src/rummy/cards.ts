export type Suit = "C" | "D" | "H" | "S";
/** 1 is the ace, 11 to 13 are the jack, queen and king. */
export type RankNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export interface NaturalCard {
	/** Unique in the game, for example "0-10H" or "1-AS". */
	readonly id: string;
	readonly joker: false;
	readonly rank: RankNumber;
	readonly suit: Suit;
}

export interface JokerCard {
	/** "JK0" to "JK5". */
	readonly id: string;
	readonly joker: true;
}

export type Card = NaturalCard | JokerCard;

export const SUITS: readonly Suit[] = ["C", "D", "H", "S"];
export const MIN_JOKERS = 2;
export const MAX_JOKERS = 6;
const RANK_LABELS = [
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
] as const;

export function rankLabel(rank: RankNumber): string {
	const label = RANK_LABELS[rank - 1];
	if (label === undefined) throw new Error(`no rank ${rank}`);
	return label;
}

/** Two standard 52-card decks and the given number of jokers. */
export function buildDeck(jokers: number): Card[] {
	if (!Number.isInteger(jokers) || jokers < MIN_JOKERS || jokers > MAX_JOKERS)
		throw new Error(
			`the joker count must be ${MIN_JOKERS} to ${MAX_JOKERS}, not ${jokers}`,
		);
	const cards: Card[] = [];
	for (const deck of [0, 1]) {
		for (const suit of SUITS) {
			for (let rank = 1; rank <= 13; rank++) {
				const natural = rank as RankNumber;
				cards.push({
					id: `${deck}-${rankLabel(natural)}${suit}`,
					joker: false,
					rank: natural,
					suit,
				});
			}
		}
	}
	for (let joker = 0; joker < jokers; joker++) {
		cards.push({ id: `JK${joker}`, joker: true });
	}
	return cards;
}

const NATURAL_ID = /^([01])-(A|[2-9]|10|J|Q|K)([CDHS])$/;
const JOKER_ID = /^JK[0-5]$/;

/** Returns null for a string that is not a card id. */
export function parseCardId(id: string): Card | null {
	if (JOKER_ID.test(id)) return { id, joker: true };
	const match = NATURAL_ID.exec(id);
	if (match === null) return null;
	const rank = RANK_LABELS.indexOf(match[2] as (typeof RANK_LABELS)[number]);
	return {
		id,
		joker: false,
		rank: (rank + 1) as RankNumber,
		suit: match[3] as Suit,
	};
}

/** Throws for an id that is not a card; use it only on ids that were validated. */
export function cardOf(id: string): Card {
	const card = parseCardId(id);
	if (card === null) throw new Error(`no card ${id}`);
	return card;
}

/** Penalty points for a card left in hand when another player goes out. */
export function penaltyValue(card: Card): number {
	if (card.joker) return 25;
	if (card.rank === 1) return 15;
	if (card.rank >= 10) return 10;
	return 5;
}
