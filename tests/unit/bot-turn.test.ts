import { describe, expect, it } from "vitest";
import {
	BotRequestAbortedError,
	InsufficientBalanceError,
} from "../../src/bot/browser-openrouter";
import {
	decisionsRequestBody,
	parseDecisionsResponse,
} from "../../src/bot/decision-model";
import { rankActions, scoreAction } from "../../src/bot/heuristic";
import {
	decisionFormat,
	MAX_CHOICES,
	offeredChoices,
	parseChoice,
} from "../../src/bot/strategy";
import { chooseTurn, turnRequest } from "../../src/bot/turn";
import {
	applyAction,
	buildDecks,
	type Seat as EngineSeat,
	type HandState,
	legalActions,
	startMatch,
	teamOf,
} from "../../src/canasta";
import { mulberry32 } from "../../src/canasta/random";
import { engineSeat, tableSeat } from "../../src/game/canasta";
import type { Seat } from "../../src/protocol";

const TEMPLATES = {
	turn: "SEAT {{SEAT}} CHOICES\n{{CHOICES}}\nSTATE {{OWN_HAND}}",
};

function openingTurn() {
	const match = startMatch(7);
	const seat = tableSeat(match.hand.turn) as Seat;
	return { match, seat };
}

describe("heuristic ranking", () => {
	it("returns the legal actions best first", () => {
		const { match, seat } = openingTurn();
		const engine = engineSeat(seat);
		const legal = legalActions(match.hand, engine);
		const ranked = rankActions(match.hand, engine, legal);
		expect(ranked).toHaveLength(legal.length);
		const scores = ranked.map((action) =>
			scoreAction(match.hand, engine, action),
		);
		expect(scores).toEqual([...scores].sort((a, b) => b - a));
	});

	it("ranks resetTurn below every other action", () => {
		const { match, seat } = openingTurn();
		const engine = engineSeat(seat);
		const reset = scoreAction(match.hand, engine, { type: "resetTurn" });
		const draw = scoreAction(match.hand, engine, { type: "draw" });
		expect(reset).toBeLessThan(draw);
	});

	/**
	 * After the draw, the seat on turn holds three queens, a 2, a joker, a 9 and a 4. Its side has melded six 7s
	 * and three 8s.
	 */
	function holdingWilds(): { hand: HandState; seat: EngineSeat } {
		const match = startMatch(7);
		const seat = match.hand.turn;
		const drawn = applyAction(match.hand, seat, { type: "draw" });
		if (!drawn.ok) throw new Error(drawn.reason);
		const deck = buildDecks();
		const cards = (ids: readonly string[]) =>
			ids.flatMap((id) => deck.filter((card) => card.id === id));
		const team = teamOf(seat);
		const side = {
			melds: [
				{
					id: "sevens",
					rank: "7" as const,
					team,
					cards: cards(["0-7C", "1-7C", "0-7D", "1-7D", "0-7H", "1-7H"]),
				},
				{
					id: "eights",
					rank: "8" as const,
					team,
					cards: cards(["0-8C", "1-8C", "0-8D"]),
				},
			],
			redThrees: [],
			initialMade: true,
		};
		const teams = drawn.hand.teams;
		const own = cards([
			"0-QS",
			"1-QS",
			"0-QH",
			"0-2C",
			"0-JK0",
			"0-9D",
			"0-4S",
		]);
		const hand: HandState = {
			...drawn.hand,
			teams: team === 0 ? [side, teams[1]] : [teams[0], side],
			hands: drawn.hand.hands.map((held, index) =>
				index === seat ? own : held,
			),
		};
		return { hand: { ...hand, turnStart: hand }, seat };
	}

	it("melds natural cards before wild cards", () => {
		const { hand, seat } = holdingWilds();
		const score = (cards: string[]) =>
			scoreAction(hand, seat, { type: "meld", cards });
		const natural = score(["0-QS", "1-QS", "0-QH"]);
		expect(natural).toBeGreaterThan(score(["0-QS", "1-QS", "0-QH", "0-2C"]));
		expect(natural).toBeGreaterThan(score(["0-QS", "1-QS", "0-2C"]));
		expect(score(["0-QS", "1-QS", "0-2C"])).toBeGreaterThan(
			score(["0-QS", "1-QS", "0-2C", "0-JK0"]),
		);
		const melds = legalActions(hand, seat).filter(
			(action) => action.type === "meld",
		);
		expect(rankActions(hand, seat, melds)[0]).toEqual({
			type: "meld",
			cards: ["0-QS", "1-QS", "0-QH"],
		});
	});

	it("keeps a wild card in the hand rather than add it to a meld that it does not make a canasta", () => {
		const { hand, seat } = holdingWilds();
		const discard = scoreAction(hand, seat, { type: "discard", card: "0-9D" });
		const extend = (meldId: string) =>
			scoreAction(hand, seat, { type: "extend", meldId, cards: ["0-2C"] });
		expect(extend("eights")).toBeLessThan(discard);
		expect(extend("sevens")).toBeGreaterThan(discard);
	});

	it("completes a canasta with a natural card rather than a wild card", () => {
		const { hand, seat } = holdingWilds();
		const seven = buildDecks().find((card) => card.id === "0-7S");
		if (seven === undefined) throw new Error("no 7");
		const own = [...(hand.hands[seat] ?? []), seven];
		const holding: HandState = {
			...hand,
			hands: hand.hands.map((held, index) => (index === seat ? own : held)),
		};
		const extend = (card: string) =>
			scoreAction(holding, seat, {
				type: "extend",
				meldId: "sevens",
				cards: [card],
			});
		expect(extend("0-7S")).toBeGreaterThan(extend("0-2C"));
	});
});

/** Plays one hand in which every seat takes the offered option that `pick` names; returns the outcome and resets. */
function playOffered(
	seed: number,
	pick: (count: number) => number,
): { ended: boolean; resets: number } {
	let hand = startMatch(seed).hand;
	let resets = 0;
	for (let step = 0; step < 2000 && hand.outcome === null; step++) {
		const choices = offeredChoices(hand, hand.turn);
		const choice = choices[pick(choices.length)];
		if (!choice) throw new Error(`seed ${seed}: no offered choice`);
		if (choice.action.type === "resetTurn") resets++;
		const next = applyAction(hand, hand.turn, choice.action);
		if (!next.ok) throw new Error(`seed ${seed}: ${next.reason}`);
		hand = next.hand;
	}
	return { ended: hand.outcome !== null, resets };
}

describe("offered choices", () => {
	it("end every hand when each seat always takes option 0", () => {
		for (let seed = 1; seed <= 40; seed++)
			expect(
				playOffered(seed, () => 0),
				`seed ${seed}`,
			).toEqual({
				ended: true,
				resets: 0,
			});
	});

	// 40 full hands take a few seconds, more than the default limit when the other test files run in parallel.
	it("end every hand when each seat takes a random option", () => {
		const random = mulberry32(99);
		for (let seed = 1; seed <= 40; seed++)
			expect(
				playOffered(seed, (count) => Math.floor(random() * count)),
				`seed ${seed}`,
			).toEqual({ ended: true, resets: 0 });
	}, 20_000);

	it("offer only resetTurn when the turn cannot end otherwise", () => {
		// Seed 1, South: after a draw and a partial meld below the minimum, no discard is legal.
		let hand = startMatch(1).hand;
		for (let step = 0; step < 400; step++) {
			const legal = legalActions(hand, hand.turn);
			if (legal.length === 1 && legal[0]?.type === "resetTurn") break;
			const best = rankActions(hand, hand.turn, legal)[0];
			if (!best) throw new Error("no legal action");
			const next = applyAction(hand, hand.turn, best);
			if (!next.ok) throw new Error(next.reason);
			hand = next.hand;
		}
		expect(legalActions(hand, hand.turn)).toEqual([{ type: "resetTurn" }]);
		expect(offeredChoices(hand, hand.turn).map((c) => c.action)).toEqual([
			{ type: "resetTurn" },
		]);
	});
});

describe("turn requests", () => {
	it("keys the position by hand, accepted count, and seat", () => {
		const { match, seat } = openingTurn();
		const request = turnRequest(match, 0, seat, TEMPLATES);
		expect(request?.key).toBe(`action:${match.handNo}:0:${seat}`);
	});

	it("offers at most MAX_CHOICES numbered options with the heuristic top first", () => {
		const { match, seat } = openingTurn();
		const engine = engineSeat(seat);
		const choices = offeredChoices(match.hand, engine);
		expect(choices.length).toBeGreaterThan(0);
		expect(choices.length).toBeLessThanOrEqual(MAX_CHOICES);
		expect(choices.map((choice) => choice.index)).toEqual(
			choices.map((_, index) => index),
		);
		const ranked = rankActions(
			match.hand,
			engine,
			legalActions(match.hand, engine),
		);
		expect(choices[0]?.action).toEqual(ranked[0]);
	});

	it("builds a prompt that lists the numbered choices", () => {
		const { match, seat } = openingTurn();
		const request = turnRequest(match, 0, seat, TEMPLATES);
		expect(request?.prompt).toContain("0: ");
		expect(request?.prompt).not.toContain("{{");
	});
});

describe("choice parsing", () => {
	it("accepts only an in-range integer under the choice key", () => {
		expect(parseChoice('{"choice": 2}', 3)).toBe(2);
	});

	it.each([
		["out of range", '{"choice": 3}', 3],
		["negative", '{"choice": -1}', 3],
		["fractional", '{"choice": 1.5}', 3],
		["string", '{"choice": "1"}', 3],
		["extra key", '{"choice": 1, "why": "x"}', 3],
		["missing key", '{"pick": 1}', 3],
		["not JSON", "choice 1", 3],
		["array", "[1]", 3],
	])("rejects %s", (_name, text, count) => {
		expect(() => parseChoice(text, count)).toThrow();
	});

	it("describes the format with an enum over the offered count", () => {
		const format = decisionFormat(4);
		expect(format.name).toBe("canasta_choice");
		expect(format.schema.properties.choice.enum).toEqual([0, 1, 2, 3]);
	});

	it("parses a Decisions answer and rejects an out-of-range one", () => {
		const answer = (choice: string) => ({
			answers: { canasta_choice: { type: "choice", choice } },
		});
		expect(parseDecisionsResponse(answer("1"), 2)).toBe(1);
		expect(() => parseDecisionsResponse(answer("2"), 2)).toThrow();
		expect(() => parseDecisionsResponse(answer("01"), 2)).toThrow();
	});

	it("sends one question whose criteria are the numbered labels", () => {
		const body = decisionsRequestBody("m", {}, ["first", "second"]) as {
			questions: { canasta_choice: { criteria: Record<string, string> } };
		};
		expect(body.questions.canasta_choice.criteria).toEqual({
			"0": "first",
			"1": "second",
		});
	});
});

describe("chooseTurn fallback", () => {
	const request = () => {
		const { match, seat } = openingTurn();
		const built = turnRequest(match, 0, seat, TEMPLATES);
		if (!built) throw new Error("opening turn has no choices");
		return built;
	};

	it("returns the chosen option", async () => {
		const built = request();
		const choice = await chooseTurn({ choose: async () => 1 }, built, () => {});
		expect(choice).toBe(built.choices[1]);
	});

	it("falls back to the heuristic top choice after a model failure and reports it", async () => {
		const built = request();
		const messages: string[] = [];
		const choice = await chooseTurn(
			{
				choose: async () => {
					throw new Error("OpenRouter request failed (503)");
				},
			},
			built,
			(message) => messages.push(message),
		);
		expect(choice).toBe(built.choices[0]);
		expect(messages).toHaveLength(1);
	});

	it.each([
		["balance", () => new InsufficientBalanceError()],
		["abort", () => new BotRequestAbortedError()],
	])("does not fall back on a %s error", async (_name, makeError) => {
		const built = request();
		await expect(
			chooseTurn(
				{
					choose: async () => {
						throw makeError();
					},
				},
				built,
				() => {},
			),
		).rejects.toThrow();
	});
});
