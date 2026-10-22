/**
 * Measures the solver on seeded positions: short, middle and long tables.
 * Run with `npx tsx scripts/solver-bench.ts [positions] [deadlineMs]`; the report goes to stdout.
 */
import { performance } from "node:perf_hooks";
import { solve } from "../src/bot/solver";
import { type MeldRules, rulesFor } from "../src/rummy";
import {
	type Position,
	randomPosition,
	validMeld,
} from "../tests/unit/solver-fixtures";

const positions = Number(process.argv[2] ?? 200);
const deadlineMs = Number(process.argv[3] ?? 2000);
const SIZES = [
	{ table: 20, hand: 13 },
	{ table: 40, hand: 13 },
	{ table: 70, hand: 15 },
] as const;

function percentile(sorted: readonly number[], p: number): number {
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
	);
}

/** The new table keeps every table card, adds only hand cards, and holds valid melds only. */
function legal(
	position: Position,
	melds: readonly (readonly string[])[] | null,
	rules: MeldRules,
): boolean {
	if (melds === null) return true;
	const all = melds.flat();
	if (new Set(all).size !== all.length) return false;
	const table = new Set(position.table.flat());
	const hand = new Set(position.hand);
	if ([...table].some((id) => !all.includes(id))) return false;
	if (all.some((id) => !table.has(id) && !hand.has(id))) return false;
	return melds.every((meld) => validMeld(meld, rules));
}

function bench(
	name: string,
	rules: MeldRules,
	jokers: number,
	size: (typeof SIZES)[number],
): void {
	const times: number[] = [];
	const nodes: number[] = [];
	let aborted = 0;
	let placed = 0;
	let illegal = 0;
	for (let seed = 1; seed <= positions; seed++) {
		const position = randomPosition(seed, size.table, size.hand, jokers, rules);
		for (const useHandJokers of [false, true]) {
			const start = performance.now();
			const result = solve({
				rules,
				table: position.table,
				hand: position.hand,
				useHandJokers,
				budget: {
					maxNodes: Number.MAX_SAFE_INTEGER,
					deadline: start + deadlineMs,
					now: () => performance.now(),
				},
			});
			times.push(performance.now() - start);
			nodes.push(result.nodes);
			if (result.aborted) aborted++;
			if (!legal(position, result.melds, rules)) illegal++;
			placed += result.placed.length;
		}
	}
	times.sort((a, b) => a - b);
	nodes.sort((a, b) => a - b);
	const ms = (value: number) => `${value.toFixed(1)} ms`;
	console.log(
		[
			name.padEnd(28),
			`solves ${times.length}`,
			`p50 ${ms(percentile(times, 0.5))}`,
			`p95 ${ms(percentile(times, 0.95))}`,
			`max ${ms(times.at(-1) ?? 0)}`,
			`nodes p50 ${percentile(nodes, 0.5)} p95 ${percentile(nodes, 0.95)} max ${nodes.at(-1)}`,
			`aborted ${aborted}`,
			`illegal ${illegal}`,
			`placed/solve ${(placed / times.length).toFixed(2)}`,
		].join("  "),
	);
}

for (const size of SIZES) {
	const label = `${size.table}/${size.hand}`;
	bench(
		`${label} wikipedia, 6 jokers`,
		rulesFor("wikipedia", 6, false),
		6,
		size,
	);
	bench(
		`${label} gamerules, 6 jokers`,
		rulesFor("gamerules", 6, false),
		6,
		size,
	);
	bench(
		`${label} gamerules, 4 jokers`,
		rulesFor("gamerules", 4, false),
		4,
		size,
	);
}
