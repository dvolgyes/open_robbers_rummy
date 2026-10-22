import { describe, expect, it } from "vitest";
import { sortHand } from "../../src/ui/hand-layout";

const card = (rank: string, suit: string | null) => ({ rank, suit });

describe("sortHand by rank", () => {
	it("orders 3 low to A, then 2, then jokers, and suits within a rank", () => {
		const hand = [
			card("JK", null),
			card("2", "C"),
			card("A", "H"),
			card("3", "S"),
			card("10", "D"),
			card("3", "C"),
		];
		expect(sortHand(hand, "rank")).toEqual([
			card("3", "C"),
			card("3", "S"),
			card("10", "D"),
			card("A", "H"),
			card("2", "C"),
			card("JK", null),
		]);
	});

	it("does not change the input", () => {
		const hand = [card("K", "S"), card("4", "H")];
		const copy = [...hand];
		sortHand(hand, "rank");
		expect(hand).toEqual(copy);
	});
});

describe("sortHand by suit", () => {
	it("orders clubs, diamonds, hearts, spades, then jokers, each suit by rank", () => {
		const hand = [
			card("JK", null),
			card("9", "S"),
			card("3", "H"),
			card("2", "C"),
			card("4", "C"),
			card("K", "D"),
		];
		expect(sortHand(hand, "suit")).toEqual([
			card("4", "C"),
			card("2", "C"),
			card("K", "D"),
			card("3", "H"),
			card("9", "S"),
			card("JK", null),
		]);
	});

	it("keeps an empty hand empty", () => {
		expect(sortHand([], "suit")).toEqual([]);
	});
});
