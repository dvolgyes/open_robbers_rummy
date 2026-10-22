import { type HandState, newHand, type Seat } from "./hand";
import type { TeamIndex } from "./melds";
import { type CanastaRules, CLASSIC_RULES } from "./rules";
import { scoreHand } from "./scoring";

/** A game of several hands, played until a side reaches the target score. */
export interface MatchState {
	readonly rules: CanastaRules;
	readonly seed: number;
	readonly handNo: number;
	readonly dealer: Seat;
	readonly scores: readonly [number, number];
	readonly hand: HandState;
	/** True once the current hand's outcome has been added to the scores. */
	readonly settled: boolean;
	/** Null while the match goes on. A tie at or above the target continues the match. */
	readonly winner: TeamIndex | null;
}

export type MatchStep =
	| { readonly ok: true; readonly match: MatchState }
	| { readonly ok: false; readonly reason: string };

const fail = (reason: string): MatchStep => ({ ok: false, reason });

/** The caller chooses the first dealer, at random in a real game; the deal then rotates clockwise. */
export function startMatch(
	seed: number,
	rules: CanastaRules = CLASSIC_RULES,
	dealer: Seat = 0,
): MatchState {
	const scores: readonly [number, number] = [0, 0];
	return {
		rules,
		seed,
		handNo: 1,
		dealer,
		scores,
		hand: newHand({
			rules,
			teamScores: scores,
			dealer,
			seed: handSeed(seed, 1),
		}),
		settled: false,
		winner: null,
	};
}

/** Adds the finished hand to the scores and decides whether the match is over. */
export function settleHand(match: MatchState): MatchStep {
	if (match.hand.outcome === null) return fail("the hand is not over");
	if (match.settled) return fail("the hand is already settled");
	const [first, second] = scoreHand(match.hand);
	const scores: readonly [number, number] = [
		match.scores[0] + first.total,
		match.scores[1] + second.total,
	];
	return {
		ok: true,
		match: {
			...match,
			scores,
			settled: true,
			winner: winnerOf(scores, match.rules.targetScore),
		},
	};
}

/** Deals the next hand, with the deal rotated one seat clockwise. */
export function nextHand(match: MatchState): MatchStep {
	if (!match.settled) return fail("settle the finished hand first");
	if (match.winner !== null) return fail("the match is over");
	const handNo = match.handNo + 1;
	const dealer = ((match.dealer + 1) % 4) as Seat;
	const hand = newHand({
		rules: match.rules,
		teamScores: match.scores,
		dealer,
		seed: handSeed(match.seed, handNo),
	});
	return {
		ok: true,
		match: { ...match, handNo, dealer, hand, settled: false },
	};
}

function winnerOf(
	scores: readonly [number, number],
	target: number,
): TeamIndex | null {
	const [a, b] = scores;
	if (a < target && b < target) return null;
	if (a === b) return null;
	return a > b ? 0 : 1;
}

function handSeed(seed: number, handNo: number): number {
	return (seed ^ Math.imul(handNo, 0x9e3779b1)) >>> 0;
}
