import { describe, expect, it } from "vitest";
import { actionLabel } from "../../src/bot/canasta-text";
import { startMatch, viewFor } from "../../src/canasta";

describe("action labels", () => {
	const match = startMatch(7);
	const view = viewFor(match.hand, match.hand.turn);
	const top = view.pile.at(-1);
	const [first, second] = view.own;

	it("names the hand cards that take the pile", () => {
		if (!top || !first || !second)
			throw new Error("the deal has no pile top or too few cards");
		const label = actionLabel(
			{ type: "takePile", cards: [first.id, second.id] },
			view,
		);
		expect(label).toBe(
			`Take the pile (top ${top.rank}${top.suit ?? ""}) with ${first.rank}${first.suit ?? ""} ${second.rank}${second.suit ?? ""}, as a new meld`,
		);
	});

	it("leaves out the hand cards when only the top card goes onto a meld", () => {
		if (!top) throw new Error("the deal has no pile top");
		const label = actionLabel(
			{ type: "takePile", cards: [], extend: "m3" },
			view,
		);
		expect(label).toBe(
			`Take the pile (top ${top.rank}${top.suit ?? ""}), added to meld m3`,
		);
	});
});
