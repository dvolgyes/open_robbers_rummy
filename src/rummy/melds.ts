import {
	type Card,
	type NaturalCard,
	type RankNumber,
	SUITS,
	type Suit,
} from "./cards";
import type { RummyRules } from "./rules";

export type MeldRules = Pick<RummyRules, "maxJokersPerMeld" | "aceWraps">;

export interface JokerRole {
	readonly rank: RankNumber;
	readonly suit: Suit;
}

export interface MeldShape {
	readonly ok: true;
	readonly kind: "set" | "run";
	/** Card ids in display order: a set by suit, a run by rank. */
	readonly order: readonly string[];
	/** The card that each joker stands for, by joker id. */
	readonly jokerAs: Readonly<Record<string, JokerRole>>;
	/** The value of the meld for the opening rule. */
	readonly points: number;
}

export type MeldCheck =
	| MeldShape
	| { readonly ok: false; readonly reason: string };

export const MIN_MELD = 3;
export const MAX_SET = 4;
export const MAX_RUN = 13;

/** Opening value of a card in a set: the ace counts 11, the 10 and the faces 10, the others their number. */
export function setRankPoints(rank: RankNumber): number {
	if (rank === 1) return 11;
	return Math.min(rank, 10);
}

export interface RunWindow {
	/** The ranks of the run from its low end to its high end. */
	readonly ranks: readonly RankNumber[];
	/** The opening value of each position. */
	readonly points: readonly number[];
}

function buildWindows(length: number, aceWraps: boolean): RunWindow[] {
	const windows: RunWindow[] = [];
	const starts = aceWraps ? 13 : 15 - length;
	for (let start = 1; start <= starts; start++) {
		const ranks: RankNumber[] = [];
		for (let i = 0; i < length; i++) {
			ranks.push((((start + i - 1) % 13) + 1) as RankNumber);
		}
		const points = ranks.map((rank, i) =>
			rank === 1 ? (ranks[i + 1] === 2 ? 1 : 11) : Math.min(rank, 10),
		);
		windows.push({ ranks, points });
	}
	return windows;
}

/** Indexed by run length; computed once and never changed. */
const WINDOWS = {
	linear: Array.from({ length: MAX_RUN + 1 }, (_, length) =>
		buildWindows(length, false),
	),
	wrap: Array.from({ length: MAX_RUN + 1 }, (_, length) =>
		buildWindows(length, true),
	),
} as const;

/**
 * Every rank sequence that a run of this length can occupy.
 * Without wrap the ace is low (A-2-3) or high (Q-K-A); with wrap a run also continues from the king to the ace and the 2.
 * The ace counts 1 when the 2 follows it in the run, and 11 otherwise.
 */
export function runWindows(
	length: number,
	aceWraps: boolean,
): readonly RunWindow[] {
	if (length < MIN_MELD) return [];
	return WINDOWS[aceWraps ? "wrap" : "linear"][length] ?? [];
}

function jokerLimitReason(jokers: number, rules: MeldRules): string | null {
	if (rules.maxJokersPerMeld !== null && jokers > rules.maxJokersPerMeld)
		return rules.maxJokersPerMeld === 1
			? "a meld may hold only one joker"
			: `a meld may hold at most ${rules.maxJokersPerMeld} jokers`;
	return null;
}

function asSet(
	naturals: readonly NaturalCard[],
	jokers: readonly Card[],
): MeldShape | string {
	const length = naturals.length + jokers.length;
	const first = naturals[0];
	if (first === undefined) return "a meld needs a natural card";
	if (length > MAX_SET) return "a set has at most four cards";
	if (naturals.some((card) => card.rank !== first.rank))
		return "the cards of a set must share one rank";
	const suits = new Set(naturals.map((card) => card.suit));
	if (suits.size !== naturals.length)
		return "the cards of a set must have different suits";
	const missing = SUITS.filter((suit) => !suits.has(suit));
	const jokerAs: Record<string, JokerRole> = {};
	jokers.forEach((joker, i) => {
		const suit = missing[i];
		if (suit === undefined) throw new Error("a set has no free suit");
		jokerAs[joker.id] = { rank: first.rank, suit };
	});
	const bySuit = [...naturals].sort(
		(a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit),
	);
	return {
		ok: true,
		kind: "set",
		order: [...bySuit.map((card) => card.id), ...jokers.map((card) => card.id)],
		jokerAs,
		points: setRankPoints(first.rank) * length,
	};
}

function asRun(
	naturals: readonly NaturalCard[],
	jokers: readonly Card[],
	rules: MeldRules,
): MeldShape | string {
	const length = naturals.length + jokers.length;
	const first = naturals[0];
	if (first === undefined) return "a meld needs a natural card";
	if (length > MAX_RUN) return "a run has at most thirteen cards";
	if (naturals.some((card) => card.suit !== first.suit))
		return "the cards of a run must share one suit";
	const byRank = new Map<RankNumber, NaturalCard>();
	for (const card of naturals) {
		if (byRank.has(card.rank)) return "a run cannot repeat a rank";
		byRank.set(card.rank, card);
	}
	let best: MeldShape | null = null;
	for (const window of runWindows(length, rules.aceWraps)) {
		if (naturals.some((card) => !window.ranks.includes(card.rank))) continue;
		const points = window.points.reduce((sum, value) => sum + value, 0);
		if (best !== null && points <= best.points) continue;
		const order: string[] = [];
		const jokerAs: Record<string, JokerRole> = {};
		let nextJoker = 0;
		for (const rank of window.ranks) {
			const natural = byRank.get(rank);
			if (natural !== undefined) {
				order.push(natural.id);
				continue;
			}
			const joker = jokers[nextJoker++];
			if (joker === undefined) throw new Error("a run has no joker left");
			order.push(joker.id);
			jokerAs[joker.id] = { rank, suit: first.suit };
		}
		best = { ok: true, kind: "run", order, jokerAs, points };
	}
	return best ?? "the cards do not form a run";
}

/**
 * Checks one meld: a set of three or four cards of one rank in different suits, or a run of three or more cards of
 * one suit in sequence.
 * Jokers stand for any missing card. When the cards fit more than one reading, the reading with the most opening
 * points wins.
 */
export function analyzeMeld(
	cards: readonly Card[],
	rules: MeldRules,
): MeldCheck {
	if (cards.length < MIN_MELD)
		return { ok: false, reason: "a meld needs at least three cards" };
	const naturals = cards.filter((card): card is NaturalCard => !card.joker);
	const jokers = cards.filter((card) => card.joker);
	if (naturals.length === 0)
		return { ok: false, reason: "a meld needs a natural card" };
	const limit = jokerLimitReason(jokers.length, rules);
	if (limit !== null) return { ok: false, reason: limit };
	const set = asSet(naturals, jokers);
	const run = asRun(naturals, jokers, rules);
	if (typeof set === "string" && typeof run === "string") {
		const sameRank = naturals.every((card) => card.rank === naturals[0]?.rank);
		return { ok: false, reason: sameRank && naturals.length > 1 ? set : run };
	}
	if (typeof set === "string") return run as MeldShape;
	if (typeof run === "string") return set;
	return run.points > set.points ? run : set;
}
