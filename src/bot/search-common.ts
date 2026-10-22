import {
	type NaturalCard,
	penaltyValue,
	type RankNumber,
	SUITS,
} from "../rummy";

/** Limits for one search; the search returns its best complete answer so far when it reaches a limit. */
export interface SolveBudget {
	readonly maxNodes: number;
	/** A time on the `now` clock; no deadline when absent. */
	readonly deadline?: number;
	readonly now?: () => number;
}

/** The best partition of all required cards and some optional cards into melds. */
export interface Partition {
	/** Null when the search found no partition. */
	readonly melds: string[][] | null;
	readonly aborted: boolean;
	readonly nodes: number;
}

export const TYPES = 52;
export const NONE = Number.NEGATIVE_INFINITY;
/** Every placed hand card is worth more than any difference in penalty, so a search first places as many cards as it can. */
export const PLACED = 1000;
export const JOKER_SCORE = PLACED + 25;
/**
 * A search reads the clock once every this many nodes. A deadline can still pass by more than a second: a full garbage
 * collection of a large memo stops the thread between two reads (measured 2026-10-23: 1.2 s and 1.4 s in Node).
 */
const TIME_CHECK_NODES = 1024;

/** Card types are numbered rank first (ace lowest), then suit. */
export function typeOf(card: NaturalCard): number {
	return (card.rank - 1) * 4 + SUITS.indexOf(card.suit);
}

export function rankOfType(type: number): RankNumber {
	return (Math.floor(type / 4) + 1) as RankNumber;
}

/** The score of placing a hand card, by type. */
export const PLACED_VALUE: readonly number[] = Array.from(
	{ length: TYPES },
	(_, type) =>
		PLACED +
		penaltyValue({ id: "", joker: false, rank: rankOfType(type), suit: "C" }),
);

/** Counts the nodes of one search and reports when it must stop. */
export class BudgetClock {
	nodes = 0;
	/** The search reached its budget, so a better play can exist. */
	aborted = false;
	/** The search found a play that places every optional card, so no play is better. */
	complete = false;

	constructor(readonly budget: SolveBudget) {}

	get stopped(): boolean {
		return this.aborted || this.complete;
	}

	/** Counts one node; true when the search must stop. */
	tick(): boolean {
		if (this.stopped) return true;
		this.nodes++;
		if (this.nodes > this.budget.maxNodes) this.aborted = true;
		else if (
			this.budget.deadline !== undefined &&
			this.nodes % TIME_CHECK_NODES === 0 &&
			(this.budget.now ?? Date.now)() >= this.budget.deadline
		)
			this.aborted = true;
		return this.aborted;
	}
}

/** The score of a play that places every optional card: no play scores more. */
export function ceilingOf(optional: Uint8Array, handJokers: number): number {
	let total = handJokers * JOKER_SCORE;
	optional.forEach((count, type) => {
		total += count * (PLACED_VALUE[type] ?? 0);
	});
	return total;
}
