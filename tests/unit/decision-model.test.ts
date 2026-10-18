import { describe, expect, it } from "vitest";
import {
	decisionsRequestBody,
	parseDecisionsResponse,
} from "../../src/bot/decision-model";
import { decisionState } from "../../src/bot/strategy";
import {
	applyAction,
	boardStatus,
	createBoard,
	legalActions,
} from "../../src/bridge/engine";
import { botModelType, DECISION_BOT_MODELS } from "../../src/protocol";
import { bidding, DEAL } from "./bridge-fixtures";

describe("OpenRouter decision models", () => {
	it("looks up decision API type by model ID", () => {
		for (const model of DECISION_BOT_MODELS)
			expect(botModelType(model)).toBe("decisions");
		expect(botModelType("typesafe/jev-1.14")).toBe("decisions");
		expect(botModelType("inception/mercury-3")).toBe("responses");
	});

	it("builds one bounded choice from the engine legal actions", () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const state = decisionState(board, board.dealer, "call");
		const request = decisionsRequestBody(
			DECISION_BOT_MODELS[0],
			"call",
			state,
			legal,
		) as {
			questions: Record<
				string,
				{ type: string; criteria: Record<string, string> }
			>;
		};
		const question = request.questions.bridge_action;
		if (!question) throw new Error("test request needs its choice question");
		expect(question.type).toBe("choice");
		expect(Object.keys(question.criteria)).toEqual(
			legal.map((action) =>
				action.type === "call" ? action.call : action.card,
			),
		);
		expect(JSON.stringify(state)).not.toContain("H3");
	});

	it("accepts a typed choice only when it matches a legal action", () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const chosen = legal[0];
		if (chosen?.type !== "call")
			throw new Error("test needs a legal opening call");
		expect(
			parseDecisionsResponse(
				{
					answers: {
						bridge_action: { type: "choice", choice: chosen.call },
					},
				},
				legal,
			),
		).toEqual(chosen);
		expect(() =>
			parseDecisionsResponse(
				{
					answers: {
						bridge_action: { type: "noul", choice: chosen.call },
					},
				},
				legal,
			),
		).toThrow("invalid choice answer");
		expect(() =>
			parseDecisionsResponse(
				{
					answers: {
						bridge_action: { type: "choice", choice: "0S" },
					},
				},
				legal,
			),
		).toThrow("not legal");
	});

	it("includes play state only for the acting hand and visible dummy", () => {
		let board = bidding(createBoard(1, DEAL), "1NT P P P");
		const leader = "E";
		expect(decisionState(board, leader, "play").dummy_hand).toBe(null);
		const openingLead = legalActions(board, leader)[0];
		if (openingLead?.type !== "play")
			throw new Error("test needs a legal opening lead");
		const result = applyAction(board, leader, openingLead);
		if (!result.ok) throw new Error("test opening lead was rejected");
		board = result.board;
		const actor = boardStatus(board).actor;
		if (actor === undefined) throw new Error("test needs a play actor");
		const state = decisionState(board, actor, "play");
		const serialized = JSON.stringify(state);
		expect(serialized).toContain('"dummy_hand":');
		expect(serialized).not.toContain("H3");
	});
});
