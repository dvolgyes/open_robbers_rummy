import { analyzeMeld, type Card, cardOf, type MeldRules } from "../rummy";
import {
	BudgetClock,
	ceilingOf,
	JOKER_SCORE,
	NONE,
	type Partition,
	PLACED_VALUE,
	type SolveBudget,
	TYPES,
	typeOf,
} from "./search-common";

/*
 * A sweep over the ranks, after van Rijn, Takes and Vis, "The complexity of Rummikub problems" (2015).
 * The state at a rank holds, for each suit, only the runs that are still open (their length up to three, their jokers,
 * and their tags), so a long table costs no more than a short one.
 * Positions 1 to 13 are the ace to the king. Without wrap, position 14 is the ace again, for the high end of a run;
 * each suit decides at position 1 how many of its aces it keeps for position 14.
 * With wrap, a run that crosses from the king to the ace starts as a tagged run at position 1; when it closes, it
 * waits as a pending prefix until a run that is open at the king continues it.
 * A run starts with a natural card. Jokers extend a run at its high end; a run that is open at the end gets the
 * jokers that it still needs there, and `analyzeMeld` reads them at whichever end fits.
 */

/** Open runs per suit; a third parallel run of one suit needs a joker beside both copies and is rare. */
const MAX_OPEN = 2;
const SUIT_COUNT = 4;
const SET_STAGE = SUIT_COUNT;

interface RunShape {
	/** The cards so far; 3 stands for three or more. */
	readonly len: number;
	/** Counted only when the rules limit the jokers per meld. */
	readonly jokers: number;
	readonly natural: boolean;
	/** Wrap only: the run started at the ace and continues a run that is open at the king. */
	readonly tagged: boolean;
}

interface Lane {
	/** Run codes in ascending order. */
	readonly runs: readonly number[];
	/** The run code of a closed tagged run, or -1. */
	readonly pending: number;
	/** No wrap: the aces of this suit kept for position 14, from the table and from the hand. */
	readonly highReq: number;
	readonly highOpt: number;
}

type Action = "natural" | "joker" | "close";

interface SuitOption {
	readonly takeReq: number;
	readonly takeOpt: number;
	/** One action for each open run, in lane order. */
	readonly actions: readonly Action[];
	readonly starts: number;
	readonly taggedNatural: number;
	readonly taggedJoker: number;
	readonly toSets: number;
	readonly jokers: number;
	readonly gain: number;
	readonly lane: number;
}

interface SetSize {
	readonly naturals: number;
	readonly jokers: number;
}

interface EndPlan {
	readonly extra: number;
	/** The open run that continues the pending prefix, or -1. */
	readonly match: number;
	/** Jokers added to each open run, in lane order. */
	readonly runJokers: readonly number[];
	/** Jokers added to the pending prefix when no run continues it. */
	readonly pendingJokers: number;
}

type Move =
	| { readonly kind: "suit"; readonly option: SuitOption }
	| { readonly kind: "sets"; readonly jokers: number };

interface Entry {
	readonly value: number;
	readonly move: Move | null;
}

interface Stage {
	readonly position: number;
	readonly suit: number;
	readonly lanes: readonly number[];
	/** Natural cards of this position that go to sets, and the most of them from one suit. */
	readonly sets: number;
	readonly setMax: number;
	readonly jokersUsed: number;
}

const START: Omit<Stage, "lanes"> = {
	position: 1,
	suit: 0,
	sets: 0,
	setMax: 0,
	jokersUsed: 0,
};

/**
 * Sizes of sets for `naturals` natural cards, at most `setMax` of one suit, and `jokers` jokers, or null.
 * The natural cards go round the sets in turn, so their counts differ by one at most and no set repeats a suit.
 */
function setSizes(
	naturals: number,
	setMax: number,
	jokers: number,
	limit: number | null,
): SetSize[] | null {
	if (naturals === 0) return jokers === 0 ? [] : null;
	const cap = limit ?? 4;
	for (let count = Math.max(setMax, 1); count <= naturals; count++) {
		const base = Math.floor(naturals / count);
		const sizes: { naturals: number; low: number; high: number }[] = [];
		for (let i = 0; i < count; i++) {
			const size = i < naturals % count ? base + 1 : base;
			sizes.push({
				naturals: size,
				low: Math.max(0, 3 - size),
				high: Math.min(cap, 4 - size),
			});
		}
		if (sizes.some((size) => size.low > size.high)) continue;
		const low = sizes.reduce((sum, size) => sum + size.low, 0);
		const high = sizes.reduce((sum, size) => sum + size.high, 0);
		if (jokers < low || jokers > high) continue;
		let extra = jokers - low;
		return sizes.map((size) => {
			const more = Math.min(extra, size.high - size.low);
			extra -= more;
			return { naturals: size.naturals, jokers: size.low + more };
		});
	}
	return null;
}

/** Turns run shapes and lanes into small integers and back. */
class Codec {
	readonly #jokerSpan: number;
	readonly #base: number;

	constructor(readonly limit: number | null) {
		this.#jokerSpan = (limit ?? 0) + 1;
		this.#base = 3 * this.#jokerSpan * 4 + 1;
	}

	run(shape: RunShape): number {
		const flags = (shape.natural ? 1 : 0) + (shape.tagged ? 2 : 0);
		return shape.len - 1 + 3 * (shape.jokers + this.#jokerSpan * flags);
	}

	shape(code: number): RunShape {
		const len = (code % 3) + 1;
		const rest = Math.floor(code / 3);
		const jokers = rest % this.#jokerSpan;
		const flags = Math.floor(rest / this.#jokerSpan);
		return {
			len,
			jokers,
			natural: (flags & 1) === 1,
			tagged: (flags & 2) === 2,
		};
	}

	lane(lane: Lane): number {
		const base = this.#base;
		const [first, second] = lane.runs;
		let code = lane.highOpt * 3 + lane.highReq;
		code = code * base + lane.pending + 1;
		code = code * base + (second === undefined ? 0 : second + 1);
		return code * base + (first === undefined ? 0 : first + 1);
	}

	decode(code: number): Lane {
		const base = this.#base;
		const runs: number[] = [];
		let rest = code;
		for (let slot = 0; slot < MAX_OPEN; slot++) {
			const value = rest % base;
			if (value > 0) runs.push(value - 1);
			rest = Math.floor(rest / base);
		}
		const pending = (rest % base) - 1;
		rest = Math.floor(rest / base);
		return { runs, pending, highReq: rest % 3, highOpt: Math.floor(rest / 3) };
	}
}

/** The card counts that a sweep reads. */
interface Pile {
	readonly required: Uint8Array;
	readonly optional: Uint8Array;
	readonly tableJokers: number;
	readonly handJokers: number;
}

function actionLists(runs: number): Action[][] {
	let lists: Action[][] = [[]];
	for (let i = 0; i < runs; i++) {
		lists = lists.flatMap((list) =>
			(["natural", "joker", "close"] as const).map((action) => [
				...list,
				action,
			]),
		);
	}
	return lists;
}

class Sweep {
	readonly memo = new Map<string, Entry>();
	readonly clock: BudgetClock;
	readonly codec: Codec;
	readonly last: number;
	readonly ceiling: number;
	readonly #options = new Map<string, SuitOption[]>();
	readonly #setJokers = new Map<string, number[]>();
	readonly #ends = new Map<number, EndPlan | null>();
	readonly #path: Move[] = [];
	best: { readonly total: number; readonly path: readonly Move[] } | null =
		null;

	constructor(
		readonly pile: Pile,
		readonly rules: MeldRules,
		budget: SolveBudget,
	) {
		this.clock = new BudgetClock(budget);
		this.codec = new Codec(rules.maxJokersPerMeld);
		this.last = rules.aceWraps ? 13 : 14;
		this.ceiling = ceilingOf(pile.optional, pile.handJokers);
	}

	get jokerTotal(): number {
		return this.pile.tableJokers + this.pile.handJokers;
	}

	typeAt(position: number, suit: number): number {
		return ((position - 1) % 13) * 4 + suit;
	}

	options(position: number, suit: number, laneCode: number): SuitOption[] {
		const key = `${position}.${suit}.${laneCode}`;
		let list = this.#options.get(key);
		if (list === undefined) {
			list = this.#buildOptions(position, suit, laneCode);
			this.#options.set(key, list);
		}
		return list;
	}

	#buildOptions(
		position: number,
		suit: number,
		laneCode: number,
	): SuitOption[] {
		const codec = this.codec;
		const limit = this.rules.maxJokersPerMeld;
		const lane = codec.decode(laneCode);
		const shapes = lane.runs.map((code) => codec.shape(code));
		const type = this.typeAt(position, suit);
		const req = this.pile.required[type] ?? 0;
		const opt = this.pile.optional[type] ?? 0;
		const low = !this.rules.aceWraps && position === 1;
		const high = !this.rules.aceWraps && position === 14;
		const tagSlots = this.rules.aceWraps && position === 1 ? 1 : 0;
		const reserves: [number, number][] = [];
		if (low) {
			for (let r = 0; r <= req; r++)
				for (let o = 0; o <= opt; o++) reserves.push([r, o]);
		} else reserves.push([lane.highReq, lane.highOpt]);
		const found = new Map<string, SuitOption>();
		for (const [keepReq, keepOpt] of reserves) {
			const availReq = high ? lane.highReq : low ? req - keepReq : req;
			const availOpt = high ? lane.highOpt : low ? opt - keepOpt : opt;
			const highReq = high ? 0 : keepReq;
			const highOpt = high ? 0 : keepOpt;
			for (let used = availReq; used <= availReq + availOpt; used++) {
				for (const actions of actionLists(shapes.length)) {
					let naturals = 0;
					let jokers = 0;
					let pending = lane.pending;
					let ok = true;
					const next: number[] = [];
					actions.forEach((action, i) => {
						const run = shapes[i];
						if (run === undefined) throw new Error("the sweep lost a run");
						const len = Math.min(3, run.len + 1);
						if (action === "natural") {
							naturals++;
							next.push(codec.run({ ...run, len, natural: true }));
						} else if (action === "joker") {
							if (limit !== null && run.jokers + 1 > limit) ok = false;
							jokers++;
							const count = limit === null ? 0 : run.jokers + 1;
							next.push(codec.run({ ...run, len, jokers: count }));
						} else if (run.tagged) {
							if (pending !== -1) ok = false;
							pending = codec.run({ ...run, tagged: false });
						} else if (run.len < 3 || !run.natural) ok = false;
					});
					if (!ok || naturals > used) continue;
					const left = used - naturals;
					for (let starts = 0; starts <= left; starts++) {
						for (let tn = 0; tn <= Math.min(tagSlots, left - starts); tn++) {
							for (let tj = 0; tj <= tagSlots - tn; tj++) {
								if (tj > 0 && limit !== null && limit < 1) continue;
								const toSets = left - starts - tn;
								if (high && toSets > 0) continue;
								if (next.length + starts + tn + tj > MAX_OPEN) continue;
								const runs = [...next];
								const fresh = { len: 1, jokers: 0, natural: true };
								for (let i = 0; i < starts; i++)
									runs.push(codec.run({ ...fresh, tagged: false }));
								if (tn > 0) runs.push(codec.run({ ...fresh, tagged: true }));
								if (tj > 0)
									runs.push(
										codec.run({
											len: 1,
											jokers: limit === null ? 0 : 1,
											natural: false,
											tagged: true,
										}),
									);
								runs.sort((a, b) => a - b);
								const code = codec.lane({ runs, pending, highReq, highOpt });
								const option: SuitOption = {
									takeReq: availReq,
									takeOpt: used - availReq,
									actions,
									starts,
									taggedNatural: tn,
									taggedJoker: tj,
									toSets,
									jokers: jokers + tj,
									gain: (used - availReq) * (PLACED_VALUE[type] ?? 0),
									lane: code,
								};
								const key = `${code}|${toSets}|${option.jokers}`;
								const known = found.get(key);
								if (known === undefined || known.gain < option.gain)
									found.set(key, option);
							}
						}
					}
				}
			}
		}
		// Higher gains first, so the first leaves that the search reaches are good plays.
		return [...found.values()].sort((a, b) => b.gain - a.gain);
	}

	setJokers(sets: number, setMax: number): number[] {
		const key = `${sets}.${setMax}`;
		let list = this.#setJokers.get(key);
		if (list === undefined) {
			list = [];
			for (let jokers = 0; jokers <= this.jokerTotal; jokers++) {
				if (setSizes(sets, setMax, jokers, this.rules.maxJokersPerMeld))
					list.push(jokers);
			}
			this.#setJokers.set(key, list);
		}
		return list;
	}

	/** How the open runs of a lane close after the last position, with the fewest added jokers. */
	end(laneCode: number): EndPlan | null {
		if (this.#ends.has(laneCode)) return this.#ends.get(laneCode) ?? null;
		const plan = this.#buildEnd(laneCode);
		this.#ends.set(laneCode, plan);
		return plan;
	}

	#buildEnd(laneCode: number): EndPlan | null {
		const limit = this.rules.maxJokersPerMeld;
		const lane = this.codec.decode(laneCode);
		const shapes = lane.runs.map((code) => this.codec.shape(code));
		if (shapes.some((shape) => shape.tagged)) return null;
		/** Jokers that complete a run of this length, or null. */
		const complete = (len: number, jokers: number, natural: boolean) => {
			const extra = Math.max(0, 3 - len);
			if (!natural) return null;
			if (limit !== null && jokers + extra > limit) return null;
			return extra;
		};
		const alone = shapes.map((shape) =>
			complete(shape.len, shape.jokers, shape.natural),
		);
		const prefix = lane.pending === -1 ? null : this.codec.shape(lane.pending);
		let best: EndPlan | null = null;
		const matches = prefix === null ? 0 : shapes.length;
		for (let match = -1; match < matches; match++) {
			const runJokers: number[] = [];
			let extra = 0;
			let ok = true;
			let pendingJokers = 0;
			shapes.forEach((shape, i) => {
				let add: number | null;
				if (i === match && prefix !== null)
					add = complete(
						shape.len + prefix.len,
						shape.jokers + prefix.jokers,
						shape.natural || prefix.natural,
					);
				else add = alone[i] ?? null;
				if (add === null) ok = false;
				else {
					runJokers.push(add);
					extra += add;
				}
			});
			if (prefix !== null && match === -1) {
				const add = complete(prefix.len, prefix.jokers, prefix.natural);
				if (add === null) ok = false;
				else {
					pendingJokers = add;
					extra += add;
				}
			}
			if (ok && (best === null || extra < best.extra))
				best = { extra, match, runJokers, pendingJokers };
		}
		return best;
	}

	#record(total: number): void {
		if (this.best === null || total > this.best.total)
			this.best = { total, path: [...this.#path] };
		if (total >= this.ceiling) this.clock.complete = true;
	}

	#terminal(lanes: readonly number[], jokersUsed: number, acc: number): number {
		let used = jokersUsed;
		for (const lane of lanes) {
			const plan = this.end(lane);
			if (plan === null) return NONE;
			used += plan.extra;
		}
		if (used < this.pile.tableJokers || used > this.jokerTotal) return NONE;
		const value = (used - this.pile.tableJokers) * JOKER_SCORE;
		this.#record(acc + value);
		return value;
	}

	/** The best score of the stages that are left, or NONE when the required cards cannot all be placed. */
	run(stage: Stage, acc: number): number {
		if (stage.position > this.last)
			return this.#terminal(stage.lanes, stage.jokersUsed, acc);
		const key = keyOf(stage);
		const known = this.memo.get(key);
		if (known !== undefined) {
			if (known.value !== NONE) this.#record(acc + known.value);
			return known.value;
		}
		if (this.clock.tick()) return NONE;
		let best: Entry = { value: NONE, move: null };
		for (const [move, next, gain] of this.#moves(stage)) {
			this.#path.push(move);
			const rest = this.run(next, acc + gain);
			this.#path.pop();
			if (rest !== NONE && gain + rest > best.value)
				best = { value: gain + rest, move };
			if (this.clock.stopped) return NONE;
		}
		this.memo.set(key, best);
		return best.value;
	}

	*#moves(stage: Stage): Generator<[Move, Stage, number]> {
		if (stage.suit === SET_STAGE) {
			for (const jokers of this.setJokers(stage.sets, stage.setMax)) {
				if (stage.jokersUsed + jokers > this.jokerTotal) break;
				yield [
					{ kind: "sets", jokers },
					{
						position: stage.position + 1,
						suit: 0,
						lanes: stage.lanes,
						sets: 0,
						setMax: 0,
						jokersUsed: stage.jokersUsed + jokers,
					},
					0,
				];
			}
			return;
		}
		const lane = stage.lanes[stage.suit] ?? 0;
		for (const option of this.options(stage.position, stage.suit, lane)) {
			if (stage.jokersUsed + option.jokers > this.jokerTotal) continue;
			const lanes = [...stage.lanes];
			lanes[stage.suit] = option.lane;
			yield [
				{ kind: "suit", option },
				{
					position: stage.position,
					suit: stage.suit + 1,
					lanes,
					sets: stage.sets + option.toSets,
					setMax: Math.max(stage.setMax, option.toSets),
					jokersUsed: stage.jokersUsed + option.jokers,
				},
				option.gain,
			];
		}
	}
}

function keyOf(stage: Stage): string {
	return `${stage.position}.${stage.suit}.${stage.lanes.join(".")}.${stage.sets}.${stage.setMax}.${stage.jokersUsed}`;
}

/** Card ids per type and the jokers, required ones apart from optional ones; the replay takes cards from here. */
interface Pools {
	readonly required: string[][];
	readonly optional: string[][];
	/** Table jokers first, so the replay spends them before hand jokers. */
	readonly jokers: string[];
}

interface OpenRun {
	readonly shape: RunShape;
	readonly cards: string[];
}

function take(list: string[] | undefined): string {
	const id = list?.shift();
	if (id === undefined) throw new Error("the sweep lost a card");
	return id;
}

/** Splits an over-long run (a rank twice) into two valid runs, or returns null. */
function finishRun(
	cards: readonly string[],
	rules: MeldRules,
): string[][] | null {
	if (analyzeMeld(cards.map(cardOf), rules).ok) return [[...cards]];
	for (let cut = 3; cut <= cards.length - 3; cut++) {
		const head = cards.slice(0, cut);
		const tail = cards.slice(cut);
		if (
			analyzeMeld(head.map(cardOf), rules).ok &&
			analyzeMeld(tail.map(cardOf), rules).ok
		)
			return [head, tail];
	}
	return null;
}

/** Follows the moves of a sweep and turns them into melds of card ids. */
class Replay {
	readonly melds: string[][] = [];
	readonly #open: OpenRun[][] = [[], [], [], []];
	readonly #pending: (OpenRun | null)[] = [null, null, null, null];
	#setCards: string[][] = [[], [], [], []];
	#valid = true;

	constructor(
		readonly sweep: Sweep,
		readonly pools: Pools,
	) {}

	get valid(): boolean {
		return this.#valid;
	}

	#closeRun(cards: readonly string[]): void {
		const pieces = finishRun(cards, this.sweep.rules);
		if (pieces === null) this.#valid = false;
		else this.melds.push(...pieces);
	}

	apply(stage: Stage, move: Move): void {
		if (move.kind === "sets") {
			this.#sets(stage, move.jokers);
			return;
		}
		const { option } = move;
		const codec = this.sweep.codec;
		const type = this.sweep.typeAt(stage.position, stage.suit);
		const naturals: string[] = [];
		for (let i = 0; i < option.takeReq; i++)
			naturals.push(take(this.pools.required[type]));
		for (let i = 0; i < option.takeOpt; i++)
			naturals.push(take(this.pools.optional[type]));
		const runs = this.#open[stage.suit] ?? [];
		const next: OpenRun[] = [];
		option.actions.forEach((action, i) => {
			const run = runs[i];
			if (run === undefined) throw new Error("the replay lost a run");
			const len = Math.min(3, run.shape.len + 1);
			if (action === "natural") {
				run.cards.push(take(naturals));
				next.push({
					shape: { ...run.shape, len, natural: true },
					cards: run.cards,
				});
			} else if (action === "joker") {
				run.cards.push(take(this.pools.jokers));
				const jokers =
					this.sweep.rules.maxJokersPerMeld === null ? 0 : run.shape.jokers + 1;
				next.push({ shape: { ...run.shape, len, jokers }, cards: run.cards });
			} else if (run.shape.tagged)
				this.#pending[stage.suit] = {
					shape: { ...run.shape, tagged: false },
					cards: run.cards,
				};
			else this.#closeRun(run.cards);
		});
		const fresh = { len: 1, jokers: 0, natural: true };
		for (let i = 0; i < option.starts; i++)
			next.push({
				shape: { ...fresh, tagged: false },
				cards: [take(naturals)],
			});
		if (option.taggedNatural > 0)
			next.push({ shape: { ...fresh, tagged: true }, cards: [take(naturals)] });
		if (option.taggedJoker > 0)
			next.push({
				shape: {
					len: 1,
					jokers: this.sweep.rules.maxJokersPerMeld === null ? 0 : 1,
					natural: false,
					tagged: true,
				},
				cards: [take(this.pools.jokers)],
			});
		next.sort((a, b) => codec.run(a.shape) - codec.run(b.shape));
		this.#open[stage.suit] = next;
		this.#setCards[stage.suit] = naturals;
	}

	#sets(stage: Stage, jokers: number): void {
		const sizes = setSizes(
			stage.sets,
			stage.setMax,
			jokers,
			this.sweep.rules.maxJokersPerMeld,
		);
		if (sizes === null) throw new Error("the replay found no sets");
		const sets: string[][] = sizes.map(() => []);
		this.#setCards.flat().forEach((id, i) => {
			sets[i % sizes.length]?.push(id);
		});
		sizes.forEach((size, i) => {
			for (let j = 0; j < size.jokers; j++)
				sets[i]?.push(take(this.pools.jokers));
		});
		for (const set of sets) this.melds.push(set);
		this.#setCards = [[], [], [], []];
	}

	finish(lanes: readonly number[]): void {
		lanes.forEach((lane, suit) => {
			const plan = this.sweep.end(lane);
			if (plan === null) throw new Error("the replay cannot close a lane");
			const runs = this.#open[suit] ?? [];
			const prefix = this.#pending[suit] ?? null;
			runs.forEach((run, i) => {
				const cards = [...run.cards];
				if (i === plan.match && prefix !== null) cards.push(...prefix.cards);
				for (let j = 0; j < (plan.runJokers[i] ?? 0); j++)
					cards.push(take(this.pools.jokers));
				this.#closeRun(cards);
			});
			if (prefix !== null && plan.match === -1) {
				const cards = [...prefix.cards];
				for (let j = 0; j < plan.pendingJokers; j++)
					cards.push(take(this.pools.jokers));
				this.#closeRun(cards);
			}
		});
	}
}

function advance(stage: Stage, move: Move): Stage {
	if (move.kind === "sets")
		return {
			position: stage.position + 1,
			suit: 0,
			lanes: stage.lanes,
			sets: 0,
			setMax: 0,
			jokersUsed: stage.jokersUsed + move.jokers,
		};
	const lanes = [...stage.lanes];
	lanes[stage.suit] = move.option.lane;
	return {
		position: stage.position,
		suit: stage.suit + 1,
		lanes,
		sets: stage.sets + move.option.toSets,
		setMax: Math.max(stage.setMax, move.option.toSets),
		jokersUsed: stage.jokersUsed + move.option.jokers,
	};
}

function pilesOf(
	required: readonly Card[],
	optional: readonly Card[],
): { pile: Pile; pools: Pools } {
	const pools: Pools = {
		required: Array.from({ length: TYPES }, () => []),
		optional: Array.from({ length: TYPES }, () => []),
		jokers: [],
	};
	const requiredCounts = new Uint8Array(TYPES);
	const optionalCounts = new Uint8Array(TYPES);
	const handJokers: string[] = [];
	for (const card of required) {
		if (card.joker) {
			pools.jokers.push(card.id);
			continue;
		}
		const type = typeOf(card);
		requiredCounts[type] = (requiredCounts[type] ?? 0) + 1;
		pools.required[type]?.push(card.id);
	}
	const tableJokers = pools.jokers.length;
	for (const card of optional) {
		if (card.joker) {
			handJokers.push(card.id);
			continue;
		}
		const type = typeOf(card);
		optionalCounts[type] = (optionalCounts[type] ?? 0) + 1;
		pools.optional[type]?.push(card.id);
	}
	pools.jokers.push(...handJokers);
	return {
		pile: {
			required: requiredCounts,
			optional: optionalCounts,
			tableJokers,
			handJokers: handJokers.length,
		},
		pools,
	};
}

/**
 * The best partition of all required cards and some optional cards into melds, by a sweep over the ranks.
 * When the sweep reaches its budget, it returns the best complete partition that it found.
 */
export function sweepPartition(
	required: readonly Card[],
	optional: readonly Card[],
	rules: MeldRules,
	budget: SolveBudget,
): Partition {
	const { pile, pools } = pilesOf(required, optional);
	const sweep = new Sweep(pile, rules, budget);
	const empty = sweep.codec.lane({
		runs: [],
		pending: -1,
		highReq: 0,
		highOpt: 0,
	});
	const start: Stage = { ...START, lanes: [empty, empty, empty, empty] };
	const value = sweep.run(start, 0);
	const nodes = sweep.clock.nodes;
	const aborted = sweep.clock.aborted;
	let path: readonly Move[] = [];
	if (sweep.clock.stopped) {
		if (sweep.best === null) return { melds: null, aborted, nodes };
		path = sweep.best.path;
	} else if (value === NONE) return { melds: null, aborted, nodes };
	// The sweep stops writing the memo when it stops early, so every stored move leads to a complete partition.
	const replay = new Replay(sweep, pools);
	let stage = start;
	for (const move of path) {
		replay.apply(stage, move);
		stage = advance(stage, move);
	}
	while (stage.position <= sweep.last) {
		const move = sweep.memo.get(keyOf(stage))?.move;
		if (move == null) throw new Error("the sweep has no stored move");
		replay.apply(stage, move);
		stage = advance(stage, move);
	}
	replay.finish(stage.lanes);
	return { melds: replay.valid ? replay.melds : null, aborted, nodes };
}
