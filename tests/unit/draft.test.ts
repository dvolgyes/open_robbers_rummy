import { describe, expect, it } from "vitest";
import { rulesFor } from "../../src/rummy";
import {
	changed,
	type Draft,
	type DraftMove,
	loadPlay,
	meldStatus,
	moveCards,
	newDraft,
	placedCards,
	returnToHand,
} from "../../src/ui/draft";

const table = [
	["0-5H", "0-6H", "0-7H"],
	["0-9C", "0-9D", "0-9S"],
];
const hand = ["0-8H", "0-9H", "1-9H", "0-KC"];

function moved(move: DraftMove): Draft {
	if (!move.ok) throw new Error(move.reason);
	return move.draft;
}

describe("draft editor", () => {
	it("adds hand cards to a table meld and makes new melds", () => {
		let draft = newDraft(table, hand, false);
		draft = moved(moveCards(draft, ["0-8H"], 0));
		expect(draft.melds[0]).toEqual(["0-5H", "0-6H", "0-7H", "0-8H"]);
		draft = moved(moveCards(draft, ["0-KC"], "new"));
		expect(draft.melds).toHaveLength(3);
		expect(draft.hand).toEqual(["0-9H", "1-9H"]);
		expect(placedCards(draft)).toEqual(["0-8H", "0-KC"]);
		expect(changed(draft)).toBe(true);
	});

	it("moves table cards between melds and drops a meld that becomes empty", () => {
		const draft = moved(
			moveCards(newDraft(table, hand, false), ["0-9C", "0-9D", "0-9S"], 0),
		);
		expect(draft.melds).toEqual([
			["0-5H", "0-6H", "0-7H", "0-9C", "0-9D", "0-9S"],
		]);
		expect(draft.hand).toEqual(hand);
	});

	it("takes hand cards back, but never a table card", () => {
		let draft = moved(moveCards(newDraft(table, hand, false), ["0-8H"], 0));
		draft = moved(returnToHand(draft, ["0-8H"]));
		expect(draft.melds).toEqual(table);
		expect(draft.hand).toEqual(["0-9H", "1-9H", "0-KC", "0-8H"]);
		expect(changed(draft)).toBe(false);
		expect(returnToHand(draft, ["0-5H"])).toEqual({
			ok: false,
			reason: "table cards cannot go into a hand",
		});
	});

	it("keeps the table locked before the opening", () => {
		const draft = newDraft(table, hand, true);
		expect(moveCards(draft, ["0-8H"], 0)).toEqual({
			ok: false,
			reason: "before your opening, play only new melds",
		});
		expect(moveCards(draft, ["0-5H"], "new")).toEqual({
			ok: false,
			reason: "before your opening, the table cards stay where they are",
		});
		const opened = moved(moveCards(draft, ["0-9H", "1-9H"], "new"));
		expect(moved(moveCards(opened, ["0-KC"], 2)).melds[2]).toEqual([
			"0-9H",
			"1-9H",
			"0-KC",
		]);
	});

	it("refuses cards that are not in the draft and targets that do not exist", () => {
		const draft = newDraft(table, hand, false);
		expect(moveCards(draft, [], 0).ok).toBe(false);
		expect(moveCards(draft, ["1-AS"], 0).ok).toBe(false);
		expect(moveCards(draft, ["0-8H"], 5).ok).toBe(false);
		expect(moveCards(draft, ["0-8H", "0-8H"], 0).ok).toBe(false);
	});

	it("gives each meld its display order or the reason it is not a meld", () => {
		const rules = rulesFor("gamerules", 4, false);
		expect(meldStatus(["0-7H", "JK0", "0-5H"], rules)).toEqual({
			ok: true,
			order: ["0-5H", "JK0", "0-7H"],
			jokerAs: { JK0: { rank: 6, suit: "H" } },
		});
		expect(meldStatus(["0-7H", "0-5H"], rules)).toEqual({
			ok: false,
			reason: "a meld needs at least three cards",
		});
	});
});

describe("loading a play into the draft", () => {
	it("takes the play's melds and keeps the other hand cards in the hand", () => {
		const draft = moved(
			loadPlay(newDraft(table, hand, false), [
				["0-5H", "0-6H", "0-7H", "0-8H", "0-9H"],
				["0-9C", "0-9D", "0-9S"],
			]),
		);
		expect(draft.hand).toEqual(["1-9H", "0-KC"]);
		expect(placedCards(draft)).toEqual(["0-8H", "0-9H"]);
	});

	it("refuses a play that drops a table card or uses a card from elsewhere", () => {
		const start = newDraft(table, hand, false);
		expect(loadPlay(start, [["0-5H", "0-6H", "0-7H", "0-8H"]])).toEqual({
			ok: false,
			reason: "the suggestion does not fit the table",
		});
		expect(loadPlay(start, [...table, ["1-AS", "1-2S", "1-3S"]])).toEqual({
			ok: false,
			reason: "the suggestion does not fit the table",
		});
	});
});
