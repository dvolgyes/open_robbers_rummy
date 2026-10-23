import {
	analyzeMeld,
	type Card,
	cardOf,
	type MeldRules,
	runWindows,
	setRankPoints,
} from "../rummy";
import {
	BudgetClock,
	ceilingOf,
	JOKER_SCORE,
	NONE,
	type Partition,
	PLACED,
	PLACED_VALUE,
	rankOfType,
	type SolveBudget,
	TYPES,
	typeOf,
} from "./search-common";
import { sweepPartition } from "./sweep";

export type { SolveBudget } from "./search-common";

export interface SolveInput {
	readonly rules: MeldRules;
	/** The melds on the table, as card ids. */
	readonly table: readonly (readonly string[])[];
	readonly hand: readonly string[];
	/** Jokers in the hand may go on the table. */
	readonly useHandJokers: boolean;
	/**
	 * Set for a player who has not opened yet: the table stays as it is, and the new melds come from the hand only and
	 * are worth at least this many points.
	 */
	readonly openingPoints?: number;
	readonly budget?: SolveBudget;
}

export interface SolveResult {
	/** The complete new table, or null when the search found no play that places a hand card. */
	readonly melds: string[][] | null;
	/** The hand cards that the new table holds. */
	readonly placed: readonly string[];
	/** The search reached its budget, so a better play can exist. */
	readonly aborted: boolean;
	readonly nodes: number;
}

export const DEFAULT_BUDGET_NODES = 400_000;

/** Runs longer than this split into shorter runs, so the search needs only these lengths. */
const MAX_SEARCH_RUN = 5;

interface Candidate {
	/** The card types of the meld; the first one is the lowest. */
	readonly types: readonly number[];
	readonly jokers: number;
	readonly points: number;
}

/** The melds whose lowest natural card has this type. */
function candidatesFor(type: number, rules: MeldRules): Candidate[] {
	const rank = rankOfType(type);
	const suit = type % 4;
	const maxJokers = rules.maxJokersPerMeld ?? Number.POSITIVE_INFINITY;
	const best = new Map<string, Candidate>();
	const add = (types: number[], jokers: number, points: number): void => {
		if (jokers > maxJokers) return;
		const key = `${types.join(",")}|${jokers}`;
		const known = best.get(key);
		if (known === undefined || known.points < points)
			best.set(key, { types, jokers, points });
	};
	// Sets: the other naturals have the same rank and a higher suit.
	const higher = [0, 1, 2, 3].filter((other) => other > suit);
	for (let mask = 0; mask < 1 << higher.length; mask++) {
		const types = [type];
		higher.forEach((other, bit) => {
			if (mask & (1 << bit)) types.push(type - suit + other);
		});
		for (let jokers = 0; types.length + jokers <= 4; jokers++) {
			const length = types.length + jokers;
			if (length >= 3) add(types, jokers, setRankPoints(rank) * length);
		}
	}
	// Runs: the other naturals have a higher rank in the same suit; jokers fill the other positions.
	for (let length = 3; length <= MAX_SEARCH_RUN; length++) {
		for (const window of runWindows(length, rules.aceWraps)) {
			const at = window.ranks.indexOf(rank);
			if (at < 0) continue;
			const others = window.ranks
				.map((other, position) => ({ other, position }))
				.filter(({ position }) => position !== at);
			const points = window.points.reduce((sum, value) => sum + value, 0);
			for (let mask = 0; mask < 1 << others.length; mask++) {
				const types = [type];
				let jokers = 0;
				let usable = true;
				others.forEach(({ other }, bit) => {
					if (!(mask & (1 << bit))) {
						jokers++;
						return;
					}
					if (other <= rank) usable = false;
					else types.push((other - 1) * 4 + suit);
				});
				if (usable) add(types, jokers, points);
			}
		}
	}
	return [...best.values()];
}

type Move =
	| { readonly kind: "leave" }
	| { readonly kind: "meld"; readonly candidate: Candidate };

interface Entry {
	readonly value: number;
	readonly move: Move | null;
}

/** Card counts per type: required cards are on the table and must stay there; optional cards are in the hand. */
interface Counts {
	readonly required: Uint8Array;
	readonly optional: Uint8Array;
	tableJokers: number;
	handJokers: number;
	need: number;
}

function lowestType(counts: Counts): number {
	for (let type = 0; type < TYPES; type++) {
		if ((counts.required[type] ?? 0) + (counts.optional[type] ?? 0) > 0)
			return type;
	}
	return -1;
}

function keyOf(counts: Counts, from: number): string {
	let key = `${counts.need}|${counts.tableJokers}|${counts.handJokers}|`;
	for (let type = Math.max(from, 0); type < TYPES; type++) {
		key += String.fromCharCode(
			65 + (counts.required[type] ?? 0) * 3 + (counts.optional[type] ?? 0),
		);
	}
	return key;
}

/** Takes one copy, a required one first; returns the score of the copy or null when no copy is left. */
function take(counts: Counts, type: number): number | null {
	if ((counts.required[type] ?? 0) > 0) {
		counts.required[type] = (counts.required[type] ?? 0) - 1;
		return 0;
	}
	if ((counts.optional[type] ?? 0) > 0) {
		counts.optional[type] = (counts.optional[type] ?? 0) - 1;
		return PLACED_VALUE[type] ?? PLACED;
	}
	return null;
}

interface Applied {
	readonly gain: number;
	readonly fromRequired: readonly boolean[];
	readonly tableJokers: number;
	readonly need: number;
}

function applyMeld(counts: Counts, candidate: Candidate): Applied | null {
	if (candidate.jokers > counts.tableJokers + counts.handJokers) return null;
	const fromRequired: boolean[] = [];
	let gain = 0;
	for (const type of candidate.types) {
		const score = take(counts, type);
		if (score === null) {
			// Undo the copies taken so far.
			candidate.types.slice(0, fromRequired.length).forEach((done, i) => {
				if (fromRequired[i])
					counts.required[done] = (counts.required[done] ?? 0) + 1;
				else counts.optional[done] = (counts.optional[done] ?? 0) + 1;
			});
			return null;
		}
		fromRequired.push(score === 0);
		gain += score;
	}
	const tableJokers = Math.min(candidate.jokers, counts.tableJokers);
	const handJokers = candidate.jokers - tableJokers;
	counts.tableJokers -= tableJokers;
	counts.handJokers -= handJokers;
	gain += handJokers * JOKER_SCORE;
	const need = counts.need;
	counts.need = Math.max(0, need - candidate.points);
	return { gain, fromRequired, tableJokers, need };
}

function undoMeld(
	counts: Counts,
	candidate: Candidate,
	applied: Applied,
): void {
	candidate.types.forEach((type, i) => {
		if (applied.fromRequired[i])
			counts.required[type] = (counts.required[type] ?? 0) + 1;
		else counts.optional[type] = (counts.optional[type] ?? 0) + 1;
	});
	counts.tableJokers += applied.tableJokers;
	counts.handJokers += candidate.jokers - applied.tableJokers;
	counts.need = applied.need;
}

interface BestLeaf {
	readonly total: number;
	readonly path: readonly Move[];
}

class Search {
	readonly memo = new Map<string, Entry>();
	readonly #candidates = new Map<number, Candidate[]>();
	readonly #path: Move[] = [];
	readonly clock: BudgetClock;
	readonly ceiling: number;
	best: BestLeaf | null = null;

	constructor(
		readonly counts: Counts,
		readonly rules: MeldRules,
		budget: SolveBudget,
	) {
		this.clock = new BudgetClock(budget);
		this.ceiling = ceilingOf(counts.optional, counts.handJokers);
	}

	candidates(type: number): Candidate[] {
		let list = this.#candidates.get(type);
		if (list === undefined) {
			list = candidatesFor(type, this.rules);
			this.#candidates.set(type, list);
		}
		return list;
	}

	#record(total: number): void {
		if (this.best === null || total > this.best.total)
			this.best = { total, path: [...this.#path] };
		if (total >= this.ceiling) this.clock.complete = true;
	}

	/** The best score of the cards that are left, or NONE when the required cards cannot all be placed. */
	run(acc: number): number {
		const counts = this.counts;
		const type = lowestType(counts);
		if (type < 0) {
			const value = counts.tableJokers === 0 && counts.need === 0 ? 0 : NONE;
			if (value !== NONE) this.#record(acc);
			return value;
		}
		const key = keyOf(counts, type);
		const known = this.memo.get(key);
		if (known !== undefined) {
			if (known.value !== NONE) this.#record(acc + known.value);
			return known.value;
		}
		if (this.clock.tick()) return NONE;
		let best: Entry = { value: NONE, move: null };
		for (const candidate of this.candidates(type)) {
			const applied = applyMeld(counts, candidate);
			if (applied === null) continue;
			const move: Move = { kind: "meld", candidate };
			this.#path.push(move);
			const rest = this.run(acc + applied.gain);
			this.#path.pop();
			undoMeld(counts, candidate, applied);
			if (rest !== NONE && applied.gain + rest > best.value)
				best = { value: applied.gain + rest, move };
			if (this.clock.stopped) return NONE;
		}
		if ((counts.required[type] ?? 0) === 0) {
			counts.optional[type] = (counts.optional[type] ?? 0) - 1;
			const move: Move = { kind: "leave" };
			this.#path.push(move);
			const rest = this.run(acc);
			this.#path.pop();
			counts.optional[type] = (counts.optional[type] ?? 0) + 1;
			if (rest !== NONE && rest > best.value) best = { value: rest, move };
			if (this.clock.stopped) return NONE;
		}
		this.memo.set(key, best);
		return best.value;
	}
}

/** Card ids per type, the required ones apart from the optional ones, for turning moves back into cards. */
interface Pools {
	readonly required: string[][];
	readonly optional: string[][];
	readonly tableJokers: string[];
	readonly handJokers: string[];
}

function countsOf(
	required: readonly Card[],
	optional: readonly Card[],
	need: number,
): { counts: Counts; pools: Pools } {
	const counts: Counts = {
		required: new Uint8Array(TYPES),
		optional: new Uint8Array(TYPES),
		tableJokers: 0,
		handJokers: 0,
		need,
	};
	const pools: Pools = {
		required: Array.from({ length: TYPES }, () => []),
		optional: Array.from({ length: TYPES }, () => []),
		tableJokers: [],
		handJokers: [],
	};
	for (const card of required) {
		if (card.joker) {
			counts.tableJokers++;
			pools.tableJokers.push(card.id);
			continue;
		}
		const type = typeOf(card);
		counts.required[type] = (counts.required[type] ?? 0) + 1;
		pools.required[type]?.push(card.id);
	}
	for (const card of optional) {
		if (card.joker) {
			counts.handJokers++;
			pools.handJokers.push(card.id);
			continue;
		}
		const type = typeOf(card);
		counts.optional[type] = (counts.optional[type] ?? 0) + 1;
		pools.optional[type]?.push(card.id);
	}
	return { counts, pools };
}

function popId(list: string[] | undefined): string {
	const id = list?.pop();
	if (id === undefined) throw new Error("the solver lost a card");
	return id;
}

/** Replays the moves of a path, then follows the stored best moves to the end. */
function rebuild(
	memo: ReadonlyMap<string, Entry>,
	counts: Counts,
	pools: Pools,
	path: readonly Move[],
): string[][] {
	const melds: string[][] = [];
	const step = (move: Move, type: number): void => {
		if (move.kind === "leave") {
			counts.optional[type] = (counts.optional[type] ?? 0) - 1;
			popId(pools.optional[type]);
			return;
		}
		const ids: string[] = [];
		for (const meldType of move.candidate.types) {
			if ((counts.required[meldType] ?? 0) > 0)
				ids.push(popId(pools.required[meldType]));
			else ids.push(popId(pools.optional[meldType]));
		}
		const tableJokers = Math.min(move.candidate.jokers, counts.tableJokers);
		for (let i = 0; i < move.candidate.jokers; i++)
			ids.push(popId(i < tableJokers ? pools.tableJokers : pools.handJokers));
		if (applyMeld(counts, move.candidate) === null)
			throw new Error("the solver replayed an impossible meld");
		melds.push(ids);
	};
	for (const move of path) step(move, lowestType(counts));
	for (;;) {
		const type = lowestType(counts);
		if (type < 0) break;
		const entry = memo.get(keyOf(counts, type));
		if (entry?.move == null) throw new Error("the solver has no stored move");
		step(entry.move, type);
	}
	return melds;
}

/**
 * Joins runs of one suit that continue each other, so the table shows long runs instead of their pieces. For an
 * opening, a join that gives a joker a lower rank, and so fewer points, is left out.
 */
function joinRuns(
	melds: string[][],
	rules: MeldRules,
	keepPoints: boolean,
): string[][] {
	const out = melds.map((meld) => [...meld]);
	let joined = true;
	while (joined) {
		joined = false;
		search: for (let i = 0; i < out.length; i++) {
			for (let j = i + 1; j < out.length; j++) {
				const a = out[i];
				const b = out[j];
				if (a === undefined || b === undefined) continue;
				const shapeA = analyzeMeld(a.map(cardOf), rules);
				const shapeB = analyzeMeld(b.map(cardOf), rules);
				if (!shapeA.ok || !shapeB.ok) continue;
				if (shapeA.kind !== "run" || shapeB.kind !== "run") continue;
				const both = analyzeMeld([...a, ...b].map(cardOf), rules);
				if (!both.ok || both.kind !== "run") continue;
				if (keepPoints && both.points < shapeA.points + shapeB.points) continue;
				out[i] = [...both.order];
				out.splice(j, 1);
				joined = true;
				break search;
			}
		}
	}
	return out.map((meld) => {
		const shape = analyzeMeld(meld.map(cardOf), rules);
		return shape.ok ? [...shape.order] : meld;
	});
}

/** The best partition of all required cards and some optional cards into melds. */
function partition(
	required: readonly Card[],
	optional: readonly Card[],
	need: number,
	rules: MeldRules,
	budget: SolveBudget,
): Partition {
	const { counts, pools } = countsOf(required, optional, need);
	const search = new Search(counts, rules, budget);
	const value = search.run(0);
	const nodes = search.clock.nodes;
	const aborted = search.clock.aborted;
	if (!search.clock.stopped) {
		if (value === NONE) return { melds: null, aborted, nodes };
		return { melds: rebuild(search.memo, counts, pools, []), aborted, nodes };
	}
	if (search.best === null) return { melds: null, aborted, nodes };
	// The search stopped writing the memo when it stopped early, so every stored value is exact.
	const replay = countsOf(required, optional, need);
	return {
		melds: rebuild(search.memo, replay.counts, replay.pools, search.best.path),
		aborted,
		nodes,
	};
}

/** The score of the hand cards in a partition; -1 for no partition. */
function scoreOf(
	melds: readonly (readonly string[])[] | null,
	handIds: ReadonlySet<string>,
): number {
	if (melds === null) return -1;
	let total = 0;
	for (const id of melds.flat()) {
		if (!handIds.has(id)) continue;
		const card = cardOf(id);
		total += card.joker ? JOKER_SCORE : (PLACED_VALUE[typeOf(card)] ?? 0);
	}
	return total;
}

/**
 * Finds the table arrangement that places the most hand cards, and among those the cards with the highest penalty.
 * A sweep over the ranks and a depth-first search over melds share the budget; at the budget's end the result is the
 * best play found so far, with `aborted` set. Every result passes `analyzeMeld`.
 */
export function solve(input: SolveInput): SolveResult {
	const budget = input.budget ?? { maxNodes: DEFAULT_BUDGET_NODES };
	const hand = input.hand
		.map(cardOf)
		.filter((card) => input.useHandJokers || !card.joker);
	const tableCards = input.table.flatMap((meld) => meld.map(cardOf));
	const opening = input.openingPoints ?? 0;
	const handIds = new Set(input.hand);
	let nodes = 0;
	let aborted = false;
	let result: string[][] | null = null;
	const rest = (): SolveBudget => ({
		...budget,
		maxNodes: Math.max(0, budget.maxNodes - nodes),
	});
	if (opening <= 0) {
		// The sweep is fast on long tables, the depth-first search on short ones: the sweep gets half of the budget,
		// and the depth-first search the rest when the sweep could not finish.
		const now = budget.now ?? Date.now;
		const half: SolveBudget = {
			...budget,
			maxNodes: Math.ceil(budget.maxNodes / 2),
			...(budget.deadline === undefined
				? {}
				: { deadline: (now() + budget.deadline) / 2 }),
		};
		const sweep = sweepPartition(tableCards, hand, input.rules, half);
		nodes += sweep.nodes;
		let best = sweep;
		if (sweep.aborted || sweep.melds === null) {
			const search = partition(tableCards, hand, 0, input.rules, rest());
			nodes += search.nodes;
			if (scoreOf(search.melds, handIds) > scoreOf(sweep.melds, handIds))
				best = search;
		}
		aborted = best.aborted;
		if (best.melds !== null) result = joinRuns(best.melds, input.rules, false);
	}
	if (result === null) {
		// Before opening, or when the search cannot rebuild the table (a long joker run, for example), only new melds.
		const fresh = partition([], hand, opening, input.rules, rest());
		nodes += fresh.nodes;
		aborted ||= fresh.aborted;
		if (fresh.melds !== null) {
			result = [
				...input.table.map((meld) => [...meld]),
				...joinRuns(fresh.melds, input.rules, opening > 0),
			];
		}
	}
	for (const meld of result ?? []) {
		if (!analyzeMeld(meld.map(cardOf), input.rules).ok)
			throw new Error(`the solver built an invalid meld: ${meld.join(" ")}`);
	}
	const placed =
		result?.flat().filter((id) => handIds.has(id)) ?? ([] as string[]);
	return {
		melds: placed.length > 0 ? result : null,
		placed,
		aborted,
		nodes,
	};
}
