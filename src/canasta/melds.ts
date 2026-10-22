import { type Card, cardPoints, isWild, type Rank } from "./cards";
import type { CanastaRules } from "./rules";

export type TeamIndex = 0 | 1;

export interface Meld {
	readonly id: string;
	/** The natural rank of the meld; wild cards stand for this rank. */
	readonly rank: Rank;
	readonly team: TeamIndex;
	readonly cards: readonly Card[];
}

export type MeldCheck =
	| { readonly ok: true; readonly rank: Rank }
	| { readonly ok: false; readonly reason: string };

/**
 * Validates a complete meld: at least three cards, at least two naturals of one rank, and at most
 * `maxWildsPerMeld` wilds. Threes are not melded in this ruleset.
 * An extension is validated by passing the existing cards together with the new ones.
 */
export function validateMeld(
	cards: readonly Card[],
	rules: CanastaRules,
	expectedRank?: Rank,
): MeldCheck {
	if (cards.length < 3)
		return { ok: false, reason: "a meld needs at least three cards" };
	const naturals = cards.filter((card) => !isWild(card));
	const wilds = cards.length - naturals.length;
	const first = naturals[0];
	if (first === undefined)
		return { ok: false, reason: "a meld needs natural cards" };
	if (naturals.some((card) => card.rank !== first.rank)) {
		return {
			ok: false,
			reason: "the natural cards of a meld must share one rank",
		};
	}
	if (first.rank === "3")
		return { ok: false, reason: "threes cannot be melded" };
	if (expectedRank !== undefined && first.rank !== expectedRank) {
		return {
			ok: false,
			reason: `the cards do not match the meld rank ${expectedRank}`,
		};
	}
	if (naturals.length < 2)
		return { ok: false, reason: "a meld needs at least two natural cards" };
	if (wilds > rules.maxWildsPerMeld) {
		return {
			ok: false,
			reason: `a meld may hold at most ${rules.maxWildsPerMeld} wild cards`,
		};
	}
	return { ok: true, rank: first.rank };
}

export function meldPoints(cards: readonly Card[]): number {
	return cards.reduce((sum, card) => sum + cardPoints(card), 0);
}

export function isCanasta(meld: Meld, rules: CanastaRules): boolean {
	return meld.cards.length >= rules.canastaSize;
}

/** A natural canasta has no wilds and scores more than a mixed one. */
export function canastaBonus(meld: Meld, rules: CanastaRules): number {
	if (!isCanasta(meld, rules)) return 0;
	const hasWild = meld.cards.some(isWild);
	return hasWild ? rules.mixedCanastaBonus : rules.naturalCanastaBonus;
}
