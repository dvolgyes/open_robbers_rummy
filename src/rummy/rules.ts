import { MAX_JOKERS, MIN_JOKERS } from "./cards";

export type RulePreset = "gamerules" | "wikipedia" | "machiavelli";

export const RULE_PRESETS: readonly RulePreset[] = [
	"gamerules",
	"wikipedia",
	"machiavelli",
];

/** Every value that a rule preset or the table setup changes lives here, so a variant is a different object, not different code. */
export interface RummyRules {
	readonly preset: RulePreset;
	/** 2 to 6 jokers are added to the two decks. */
	readonly jokers: number;
	/** The table offers the solver's suggestion to human players. */
	readonly assist: boolean;
	readonly handSize: number;
	/** The meld points a player's first play needs; 0 means no opening rule. */
	readonly openingPoints: number;
	/** Null means any number, as long as the meld holds a natural card. */
	readonly maxJokersPerMeld: number | null;
	/** A run may go around the corner, for example K-A-2. */
	readonly aceWraps: boolean;
	/** "play-or-draw": a play or a draw ends the turn. "play-and-draw": a play and a draw may follow each other. */
	readonly turn: "play-or-draw" | "play-and-draw";
}

const PRESET_VALUES: Record<
	RulePreset,
	Omit<RummyRules, "preset" | "jokers" | "assist">
> = {
	gamerules: {
		handSize: 11,
		openingPoints: 40,
		maxJokersPerMeld: 1,
		aceWraps: false,
		turn: "play-and-draw",
	},
	wikipedia: {
		handSize: 13,
		openingPoints: 0,
		maxJokersPerMeld: null,
		aceWraps: true,
		turn: "play-and-draw",
	},
	machiavelli: {
		handSize: 13,
		openingPoints: 0,
		maxJokersPerMeld: 1,
		aceWraps: false,
		turn: "play-or-draw",
	},
};

export const DEFAULT_PRESET: RulePreset = "gamerules";
export const DEFAULT_JOKERS = 4;

export function isRulePreset(value: unknown): value is RulePreset {
	return (RULE_PRESETS as readonly unknown[]).includes(value);
}

export function rulesFor(
	preset: RulePreset,
	jokers: number,
	assist: boolean,
): RummyRules {
	if (!Number.isInteger(jokers) || jokers < MIN_JOKERS || jokers > MAX_JOKERS)
		throw new Error(
			`the joker count must be ${MIN_JOKERS} to ${MAX_JOKERS}, not ${jokers}`,
		);
	return { preset, jokers, assist, ...PRESET_VALUES[preset] };
}
