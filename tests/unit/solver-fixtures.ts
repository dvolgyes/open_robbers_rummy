import {
	analyzeMeld,
	buildDeck,
	type Card,
	cardOf,
	type MeldRules,
	mulberry32,
	type NaturalCard,
	type Rng,
	SUITS,
	shuffle,
} from "../../src/rummy";

export interface Position {
	readonly table: string[][];
	readonly hand: string[];
}

function pick<T>(items: readonly T[], rng: Rng): T {
	const item = items[Math.floor(rng() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
}

/**
 * A random table of valid melds and a random hand from the rest of the deck.
 * Each meld holds at most one joker, so it is valid under every preset.
 */
export function randomPosition(
	seed: number,
	tableCards: number,
	handCards: number,
	jokers: number,
	rules: MeldRules,
): Position {
	const rng = mulberry32(seed);
	const free = new Map(
		shuffle(buildDeck(jokers), rng).map((card) => [card.id, card]),
	);
	const naturalFree = (rank: number, suit: string): NaturalCard | undefined =>
		[...free.values()].find(
			(card): card is NaturalCard =>
				!card.joker && card.rank === rank && card.suit === suit,
		);
	const jokerFree = (): Card | undefined =>
		[...free.values()].find((card) => card.joker);
	const table: string[][] = [];
	let placed = 0;
	for (let attempt = 0; placed < tableCards && attempt < 500; attempt++) {
		const meld: Card[] = [];
		const useJoker = rng() < 0.25;
		if (rng() < 0.4) {
			const rank = 1 + Math.floor(rng() * 13);
			const suits = shuffle(SUITS, rng).slice(0, rng() < 0.5 ? 3 : 4);
			for (const suit of suits) {
				const card = naturalFree(rank, suit);
				if (card !== undefined) meld.push(card);
			}
		} else {
			const suit = pick(SUITS, rng);
			const length = 3 + Math.floor(rng() * 4);
			const start = 1 + Math.floor(rng() * (14 - length));
			for (let i = 0; i < length; i++) {
				const rank = ((start + i - 1) % 13) + 1;
				const card = naturalFree(rank, suit);
				if (card !== undefined) meld.push(card);
				else break;
			}
		}
		if (useJoker && meld.length >= 2) {
			const joker = jokerFree();
			if (joker !== undefined) meld.splice(1, 1, joker);
		}
		if (meld.length < 3) continue;
		const ids = meld.map((card) => card.id);
		if (!validMeld(ids, rules)) continue;
		for (const id of ids) free.delete(id);
		table.push(ids);
		placed += ids.length;
	}
	const hand = [...free.keys()].slice(0, handCards);
	return { table, hand };
}

export function validMeld(ids: readonly string[], rules: MeldRules): boolean {
	return analyzeMeld(ids.map(cardOf), rules).ok;
}
