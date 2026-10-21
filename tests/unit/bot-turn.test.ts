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
import { legalActions, startMatch } from "../../src/canasta";
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
