import { describe, expect, it } from "vitest";
import { createBoard } from "../../src/bridge/engine";
import {
	boardSetup,
	type Contract,
	scoreContract,
	trickWinner,
	type Vulnerability,
} from "../../src/bridge/rules";
import { DEAL } from "./bridge-fixtures";

describe("board rotation", () => {
	it("rotates the dealer clockwise on each consecutive board", () => {
		expect(
			Array.from({ length: 8 }, (_, index) => boardSetup(index + 1).dealer),
		).toEqual(["N", "E", "S", "W", "N", "E", "S", "W"]);
	});

	it.each([
		[1, "N", "none"],
		[2, "E", "NS"],
		[3, "S", "EW"],
		[4, "W", "both"],
		[5, "N", "NS"],
		[16, "W", "EW"],
		[17, "N", "none"],
		[18, "E", "NS"],
	])("board %i: dealer %s, vulnerable %s", (number, dealer, vulnerability) => {
		expect(boardSetup(number)).toEqual({ dealer, vulnerability });
		expect(createBoard(number, DEAL)).toMatchObject({
			number,
			dealer,
			vulnerability,
		});
	});

	it.each([0, -1, 1.5, Number.NaN])("rejects board number %s", (number) => {
		expect(() => boardSetup(number)).toThrow("board number");
	});
});

function contract(
	text: string,
	declarer: Contract["declarer"] = "N",
): Contract {
	const match = /^([1-7])(C|D|H|S|NT)(X{0,2})$/.exec(text);
	if (match === null) throw new Error(`not a contract: ${text}`);
	return {
		level: Number(match[1]) as Contract["level"],
		strain: match[2] as Contract["strain"],
		declarer,
		doubling: match[3] as Contract["doubling"],
	};
}

describe("duplicate scoring, from North-South's side", () => {
	it.each([
		["2S", "none", 8, 110],
		["4S", "none", 10, 420],
		["3NT", "both", 10, 630],
		["6S", "both", 12, 1430],
		["3NT", "both", 7, -200],
		["1NTX", "none", 6, -100],
		["4SX", "none", 6, -800],
		["4HX", "both", 7, -800],
		["7NTXX", "both", 13, 2980],
		["2SX", "none", 9, 570],
		["2SX", "both", 9, 870],
		["1NTXX", "none", 8, 760],
		["1CX", "none", 7, 140],
		["1CXX", "none", 7, 230],
		["7NTXX", "both", 0, -7600],
		["5C", "none", 11, 400],
		["3NT", "none", 9, 400],
		["2H", "both", 11, 200],
	] as const)(
		"%s, vulnerable %s, %i tricks: %i",
		(text, vulnerability, tricks, score) => {
			expect(scoreContract(contract(text), vulnerability, tricks)).toBe(score);
		},
	);

	it.each([
		["N", "NS", 620],
		["E", "NS", -420],
		["E", "EW", -620],
		["N", "EW", 420],
		["W", "both", -620],
	] as const)(
		"4S= by %s with %s vulnerable: %i",
		(declarer, vulnerability, score) => {
			expect(
				scoreContract(
					contract("4S", declarer),
					vulnerability as Vulnerability,
					10,
				),
			).toBe(score);
		},
	);

	it("scores a passed-out board 0", () => {
		expect(scoreContract(null, "both", 0)).toBe(0);
	});

	it.each([-1, 14, 2.5])("rejects %s tricks", (tricks) => {
		expect(() => scoreContract(contract("1C"), "none", tricks)).toThrow(
			"tricks",
		);
	});
});

describe("trickWinner", () => {
	it.each([
		[["S2", "SK", "H2", "SA"], "N", "H", "S", "a ruff beats the led suit"],
		[["S2", "H3", "H9", "SA"], "N", "H", "S", "the higher trump wins"],
		[
			["S2", "SK", "H2", "SA"],
			"N",
			"NT",
			"W",
			"no trumps: highest of the led suit",
		],
		[["D2", "SA", "HA", "D3"], "E", "C", "N", "an off-suit card never wins"],
		[["CT", "C9", "CJ", "C2"], "W", "NT", "E", "the ten ranks below the jack"],
	] as const)(
		"%j led by %s, trumps %s: %s (%s)",
		(trick, leader, strain, winner, _label) => {
			expect(trickWinner([...trick], leader, strain)).toBe(winner);
		},
	);
});
