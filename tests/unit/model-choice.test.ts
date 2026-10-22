import { describe, expect, it } from "vitest";
import {
	BotRequestAbortedError,
	InsufficientBalanceError,
} from "../../src/bot/browser-openrouter";
import {
	decisionsRequestBody,
	parseDecisionsResponse,
} from "../../src/bot/decision-model";
import { decisionFormat, parseChoice } from "../../src/bot/strategy";
import { chooseTurn, type TurnRequest } from "../../src/bot/turn";

const REQUEST: TurnRequest = {
	labels: ["draw", "play", "end"],
	prompt: "0: draw\n1: play\n2: end",
	state: { hand: 5 },
};

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
		expect(format.name).toBe("turn_choice");
		expect(format.schema.properties.choice.enum).toEqual([0, 1, 2, 3]);
	});

	it("parses a Decisions answer and rejects an out-of-range one", () => {
		const answer = (choice: string) => ({
			answers: { turn_choice: { type: "choice", choice } },
		});
		expect(parseDecisionsResponse(answer("1"), 2)).toBe(1);
		expect(() => parseDecisionsResponse(answer("2"), 2)).toThrow();
		expect(() => parseDecisionsResponse(answer("01"), 2)).toThrow();
	});

	it("sends one question whose criteria are the numbered labels", () => {
		const body = decisionsRequestBody("m", {}, ["first", "second"]) as {
			questions: { turn_choice: { criteria: Record<string, string> } };
		};
		expect(body.questions.turn_choice.criteria).toEqual({
			"0": "first",
			"1": "second",
		});
	});
});

describe("chooseTurn fallback", () => {
	it("returns the chosen option", async () => {
		expect(await chooseTurn({ choose: async () => 1 }, REQUEST, () => {})).toBe(
			1,
		);
	});

	it("falls back to the first option after a model failure and reports it", async () => {
		const messages: string[] = [];
		const choice = await chooseTurn(
			{
				choose: async () => {
					throw new Error("OpenRouter request failed (503)");
				},
			},
			REQUEST,
			(message) => messages.push(message),
		);
		expect(choice).toBe(0);
		expect(messages).toHaveLength(1);
	});

	it("refuses an option number that was not offered", async () => {
		await expect(
			chooseTurn({ choose: async () => 3 }, REQUEST, () => {}),
		).rejects.toThrow();
	});

	it.each([
		["balance", () => new InsufficientBalanceError()],
		["abort", () => new BotRequestAbortedError()],
	])("does not fall back on a %s error", async (_name, makeError) => {
		await expect(
			chooseTurn(
				{
					choose: async () => {
						throw makeError();
					},
				},
				REQUEST,
				() => {},
			),
		).rejects.toThrow();
	});
});
