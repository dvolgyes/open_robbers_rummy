/** Score threshold and the meld total a side needs for its first meld. */
export interface InitialMeldStep {
	/** Applies while the side's score is at least this value. */
	readonly fromScore: number;
	readonly minimum: number;
}

/** Every value that changes the game lives here, so a variant is a different object, not different code. */
export interface CanastaRules {
	readonly targetScore: number;
	readonly handSize: number;
	readonly drawCount: number;
	readonly maxWildsPerMeld: number;
	readonly canastaSize: number;
	readonly naturalCanastaBonus: number;
	readonly mixedCanastaBonus: number;
	readonly redThreeBonus: number;
	readonly outBonus: number;
	readonly concealedOutBonus: number;
	/** A side may go out only after it holds a canasta. */
	readonly goOutNeedsCanasta: boolean;
	/** Sorted by fromScore ascending. */
	readonly initialMeld: readonly InitialMeldStep[];
}

/** Classic partnership canasta, 2 decks, target 5000. */
export const CLASSIC_RULES: CanastaRules = {
	targetScore: 5000,
	handSize: 11,
	drawCount: 2,
	maxWildsPerMeld: 3,
	canastaSize: 7,
	naturalCanastaBonus: 500,
	mixedCanastaBonus: 300,
	redThreeBonus: 100,
	outBonus: 100,
	concealedOutBonus: 100,
	goOutNeedsCanasta: true,
	initialMeld: [
		{ fromScore: 0, minimum: 15 },
		{ fromScore: 1500, minimum: 50 },
		{ fromScore: 3000, minimum: 90 },
		{ fromScore: 5000, minimum: 120 },
	],
};

/** A side below the first threshold (including negative scores) uses the first step. */
export function initialMeldMinimum(
	steps: readonly InitialMeldStep[],
	teamScore: number,
): number {
	let minimum = steps[0]?.minimum;
	if (minimum === undefined)
		throw new Error("the rules define no initial meld steps");
	for (const step of steps) {
		if (teamScore >= step.fromScore) minimum = step.minimum;
	}
	return minimum;
}
