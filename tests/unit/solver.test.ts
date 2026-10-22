import { describe, expect, it } from "vitest";
import { type SolveResult, solve } from "../../src/bot/solver";
import {
	analyzeMeld,
	cardOf,
	type MeldRules,
	penaltyValue,
} from "../../src/rummy";
import { type Position, randomPosition, validMeld } from "./solver-fixtures";

const GAMERULES: MeldRules = { maxJokersPerMeld: 1, aceWraps: false };
const WIKIPEDIA: MeldRules = { maxJokersPerMeld: null, aceWraps: true };

function score(ids: readonly string[]): number {
	return ids.reduce((sum, id) => sum + 1000 + penaltyValue(cardOf(id)), 0);
}

/** The result keeps every table card, adds only hand cards, and holds valid melds only. */
function expectLegal(
	position: Position,
	result: SolveResult,
	rules: MeldRules,
): void {
	if (result.melds === null) {
		expect(result.placed).toEqual([]);
		return;
	}
	const all = result.melds.flat();
	expect(new Set(all).size).toBe(all.length);
	const tableCards = position.table.flat();
	for (const id of tableCards) expect(all).toContain(id);
	const added = all.filter((id) => !tableCards.includes(id));
	expect([...added].sort()).toEqual([...result.placed].sort());
	for (const id of added) expect(position.hand).toContain(id);
	for (const meld of result.melds) expect(validMeld(meld, rules)).toBe(true);
}

/** Can these cards be split into valid melds? Tries every meld that holds the first card. */
function partitions(
	cards: readonly string[],
	rules: MeldRules,
	known: Map<string, boolean>,
): boolean {
	const [first, ...rest] = cards;
	if (first === undefined) return true;
	const key = cards.join(" ");
	const stored = known.get(key);
	if (stored !== undefined) return stored;
	const found = splits(first, rest, rules, known);
	known.set(key, found);
	return found;
}

function splits(
	first: string,
	rest: readonly string[],
	rules: MeldRules,
	known: Map<string, boolean>,
): boolean {
	const limit = rest.length;
	for (let mask = 1; mask < 1 << limit; mask++) {
		const meld = [first];
		const left: string[] = [];
		rest.forEach((id, bit) => {
			if (mask & (1 << bit)) meld.push(id);
			else left.push(id);
		});
		if (meld.length < 3) continue;
		if (!analyzeMeld(meld.map(cardOf), rules).ok) continue;
		if (partitions(left, rules, known)) return true;
	}
	return false;
}

/** The best score over every subset of the hand that fits with the table cards. */
function bruteForce(position: Position, rules: MeldRules): number {
	const tableCards = position.table.flat().sort();
	const known = new Map<string, boolean>();
	let best = 0;
	const hand = position.hand;
	for (let mask = 1; mask < 1 << hand.length; mask++) {
		const subset = hand.filter((_, bit) => mask & (1 << bit));
		const value = score(subset);
		if (value <= best) continue;
		if (partitions([...tableCards, ...subset].sort(), rules, known))
			best = value;
	}
	return best;
}

describe("solve", () => {
	it("adds a hand card to a run and keeps the table", () => {
		const position = {
			table: [["0-4H", "0-5H", "0-6H"]],
			hand: ["0-7H", "0-KS"],
		};
		const result = solve({
			rules: GAMERULES,
			table: position.table,
			hand: position.hand,
			useHandJokers: false,
		});
		expect(result.placed).toEqual(["0-7H"]);
		expect(result.melds).toEqual([["0-4H", "0-5H", "0-6H", "0-7H"]]);
	});

	it("rearranges the table to place more cards", () => {
		// 5H 6H 7H and 7S 7C 7D on the table; with 7H moved, 8H 9H and the 7H set place both hand cards... not here:
		// the hand 4H and 8H extends the run at both ends.
		const table = [
			["0-5H", "0-6H", "0-7H"],
			["0-7S", "0-7C", "0-7D"],
		];
		const hand = ["0-3H", "0-4H", "1-7H"];
		const result = solve({
			rules: GAMERULES,
			table,
			hand,
			useHandJokers: false,
		});
		expectLegal({ table, hand }, result, GAMERULES);
		expect([...result.placed].sort()).toEqual(["0-3H", "0-4H", "1-7H"]);
	});

	it("keeps hand jokers when told to, and spends them when allowed", () => {
		const table = [["0-4H", "0-5H", "0-6H"]];
		const hand = ["JK0", "0-8H"];
		const kept = solve({ rules: GAMERULES, table, hand, useHandJokers: false });
		expect(kept.melds).toBeNull();
		const spent = solve({ rules: GAMERULES, table, hand, useHandJokers: true });
		expectLegal({ table, hand }, spent, GAMERULES);
		expect([...spent.placed].sort()).toEqual(["0-8H", "JK0"]);
	});

	it("moves a table joker to make room for hand cards", () => {
		const table = [["0-4H", "JK0", "0-6H"]];
		const hand = ["0-5H", "0-9C", "0-9D"];
		const result = solve({
			rules: GAMERULES,
			table,
			hand,
			useHandJokers: false,
		});
		expectLegal({ table, hand }, result, GAMERULES);
		expect([...result.placed].sort()).toEqual(["0-5H", "0-9C", "0-9D"]);
	});

	it("opens only with melds from the hand that reach the opening points", () => {
		const table = [["0-4H", "0-5H", "0-6H"]];
		const low = solve({
			rules: GAMERULES,
			table,
			hand: ["0-2S", "0-3S", "0-4S", "0-7H"],
			useHandJokers: true,
			openingPoints: 40,
		});
		expect(low.melds).toBeNull();
		const high = solve({
			rules: GAMERULES,
			table,
			hand: ["0-QS", "0-KS", "0-AS", "0-9C", "0-9D", "0-9H", "0-7H"],
			useHandJokers: true,
			openingPoints: 40,
		});
		expect(high.melds?.[0]).toEqual(["0-4H", "0-5H", "0-6H"]);
		expect([...high.placed].sort()).toEqual(
			["0-9C", "0-9D", "0-9H", "0-AS", "0-KS", "0-QS"].sort(),
		);
	});

	it("matches a brute-force optimum on small positions", {
		timeout: 120_000,
	}, () => {
		for (const [name, rules] of [
			["gamerules", GAMERULES],
			["wikipedia", WIKIPEDIA],
		] as const) {
			for (let seed = 1; seed <= 60; seed++) {
				const position = randomPosition(seed, 7, 5, 2, rules);
				const result = solve({
					rules,
					table: position.table,
					hand: position.hand,
					useHandJokers: true,
				});
				expectLegal(position, result, rules);
				expect(
					score(result.placed),
					`${name} seed ${seed}: ${JSON.stringify(position)}`,
				).toBe(bruteForce(position, rules));
			}
		}
	});

	it.each([
		{
			name: "a run with the ace high",
			rules: GAMERULES,
			table: [["0-QH", "0-KH", "0-AH"]],
			hand: ["0-JH", "0-2H"],
			placed: ["0-JH"],
		},
		{
			name: "a run around the corner",
			rules: WIKIPEDIA,
			table: [["0-QH", "0-KH", "0-AH"]],
			hand: ["0-2H"],
			placed: ["0-2H"],
		},
		{
			name: "a joker at the low end of a run",
			rules: GAMERULES,
			table: [["JK0", "0-2H", "0-3H"]],
			hand: ["0-5H"],
			placed: ["0-5H"],
		},
		{
			name: "two runs of one suit side by side",
			rules: GAMERULES,
			table: [
				["0-4H", "0-5H", "0-6H"],
				["1-4H", "1-5H", "1-6H"],
			],
			hand: ["0-7H", "1-7H"],
			placed: ["0-7H", "1-7H"],
		},
	])("places the cards of $name", ({ rules, table, hand, placed }) => {
		const result = solve({ rules, table, hand, useHandJokers: false });
		expectLegal({ table, hand }, result, rules);
		expect([...result.placed].sort()).toEqual(placed);
	});

	it("returns the best play so far when the deadline passes", () => {
		const position = randomPosition(7, 60, 15, 6, WIKIPEDIA);
		let time = 0;
		const result = solve({
			rules: WIKIPEDIA,
			table: position.table,
			hand: position.hand,
			useHandJokers: true,
			// Every reading of the clock moves it one second; the deadline passes at the first time check.
			budget: { maxNodes: 1e9, deadline: 3, now: () => time++ },
		});
		expect(result.aborted).toBe(true);
		expect(result.nodes).toBeLessThan(10_000);
		expectLegal(position, result, WIKIPEDIA);
	});

	it("returns a legal play when the budget runs out", () => {
		const position = randomPosition(7, 60, 15, 6, WIKIPEDIA);
		const result = solve({
			rules: WIKIPEDIA,
			table: position.table,
			hand: position.hand,
			useHandJokers: true,
			budget: { maxNodes: 50 },
		});
		expect(result.aborted).toBe(true);
		expectLegal(position, result, WIKIPEDIA);
	});
});
