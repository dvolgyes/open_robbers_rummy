import { describe, expect, it } from "vitest";
import {
	analyzeMeld,
	buildDeck,
	cardOf,
	type MeldRules,
	parseCardId,
	penaltyValue,
	rulesFor,
	runWindows,
} from "../../src/rummy";

const ONE_JOKER: MeldRules = { maxJokersPerMeld: 1, aceWraps: false };
const FREE: MeldRules = { maxJokersPerMeld: null, aceWraps: true };

const check = (ids: string, rules: MeldRules = ONE_JOKER) =>
	analyzeMeld(ids.split(" ").map(cardOf), rules);

describe("cards", () => {
	it("builds two decks and the chosen jokers", () => {
		for (const jokers of [2, 4, 6]) {
			const deck = buildDeck(jokers);
			expect(deck).toHaveLength(104 + jokers);
			expect(new Set(deck.map((card) => card.id)).size).toBe(deck.length);
		}
		expect(() => buildDeck(1)).toThrow();
		expect(() => buildDeck(7)).toThrow();
	});

	it("parses every card id it builds and refuses other strings", () => {
		for (const card of buildDeck(6)) expect(parseCardId(card.id)).toEqual(card);
		for (const bad of ["", "2-AS", "0-1S", "0-11H", "JK6", "0-AX", "0-As"])
			expect(parseCardId(bad)).toBeNull();
	});

	it("gives the penalty values of the scoring rule", () => {
		expect(penaltyValue(cardOf("JK0"))).toBe(25);
		expect(penaltyValue(cardOf("0-AS"))).toBe(15);
		for (const id of ["0-10H", "0-JH", "0-QH", "0-KH"])
			expect(penaltyValue(cardOf(id))).toBe(10);
		for (const id of ["0-2H", "0-9C"]) expect(penaltyValue(cardOf(id))).toBe(5);
	});
});

describe("analyzeMeld", () => {
	it("accepts sets of three and four suits and refuses repeated suits", () => {
		expect(check("0-7H 0-7S 0-7C")).toMatchObject({ ok: true, kind: "set" });
		expect(check("0-7H 0-7S 0-7C 0-7D")).toMatchObject({ ok: true });
		expect(check("0-7H 1-7H 0-7C").ok).toBe(false);
		expect(check("0-7H 0-7S 0-7C 0-7D 1-7D").ok).toBe(false);
		expect(check("0-7H 0-7S").ok).toBe(false);
	});

	it("accepts runs of one suit, with the ace low or high, and refuses gaps", () => {
		expect(check("0-AH 0-2H 0-3H")).toMatchObject({ ok: true, kind: "run" });
		expect(check("0-QH 0-KH 0-AH")).toMatchObject({ ok: true, kind: "run" });
		expect(check("0-4H 0-5H 0-7H").ok).toBe(false);
		expect(check("0-4H 0-5S 0-6H").ok).toBe(false);
		expect(check("0-4H 1-4H 0-5H").ok).toBe(false);
	});

	it("goes around the corner only when the rules allow it", () => {
		expect(check("0-KH 0-AH 0-2H").ok).toBe(false);
		expect(check("0-KH 0-AH 0-2H", FREE)).toMatchObject({
			ok: true,
			order: ["0-KH", "0-AH", "0-2H"],
		});
		const all = [
			"0-AS",
			"0-2S",
			"0-3S",
			"0-4S",
			"0-5S",
			"0-6S",
			"0-7S",
			"0-8S",
			"0-9S",
			"0-10S",
			"0-JS",
			"0-QS",
			"0-KS",
		];
		expect(analyzeMeld(all.map(cardOf), FREE).ok).toBe(true);
		expect(analyzeMeld([...all, "1-2S"].map(cardOf), FREE).ok).toBe(false);
	});

	it("lets a joker fill a gap or an end and records what it stands for", () => {
		const run = check("0-4H JK0 0-6H");
		expect(run).toMatchObject({
			ok: true,
			kind: "run",
			order: ["0-4H", "JK0", "0-6H"],
			jokerAs: { JK0: { rank: 5, suit: "H" } },
		});
		const set = check("0-9H JK1 0-9C");
		expect(set).toMatchObject({
			ok: true,
			kind: "set",
			jokerAs: { JK1: { rank: 9, suit: "D" } },
		});
	});

	it("holds the joker limit of the rules and needs a natural card", () => {
		expect(check("0-4H JK0 JK1").ok).toBe(false);
		expect(check("0-4H JK0 JK1", FREE).ok).toBe(true);
		expect(check("JK0 JK1 JK2", FREE).ok).toBe(false);
	});

	it("counts opening points with the ace high or in a set as 11 and low as 1", () => {
		expect(check("0-AH 0-2H 0-3H")).toMatchObject({ points: 6 });
		expect(check("0-QH 0-KH 0-AH")).toMatchObject({ points: 31 });
		expect(check("0-AH 0-AS 0-AC")).toMatchObject({ points: 33 });
		expect(check("0-10H 0-JH 0-QH")).toMatchObject({ points: 30 });
		// The reading with the most points wins: 9-10-J beats 7-8-9.
		expect(check("0-9H 0-10H JK0")).toMatchObject({
			points: 29,
			jokerAs: { JK0: { rank: 11, suit: "H" } },
		});
	});

	it("gives the run windows that each preset allows", () => {
		const linear = runWindows(3, false).map((w) => w.ranks.join(","));
		expect(linear).toContain("12,13,1");
		expect(linear).not.toContain("13,1,2");
		expect(runWindows(3, true).map((w) => w.ranks.join(","))).toContain(
			"13,1,2",
		);
		expect(runWindows(2, true)).toHaveLength(0);
	});

	it("builds the three presets with the joker count of the table", () => {
		expect(rulesFor("gamerules", 4, true)).toMatchObject({
			handSize: 11,
			openingPoints: 40,
			maxJokersPerMeld: 1,
			aceWraps: false,
			jokers: 4,
			assist: true,
		});
		expect(rulesFor("wikipedia", 6, false)).toMatchObject({
			handSize: 13,
			openingPoints: 0,
			maxJokersPerMeld: null,
			aceWraps: true,
		});
		expect(rulesFor("machiavelli", 2, false)).toMatchObject({
			turn: "play-or-draw",
		});
		expect(() => rulesFor("gamerules", 7, false)).toThrow();
	});
});
