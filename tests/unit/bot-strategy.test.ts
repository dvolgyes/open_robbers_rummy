import { describe, expect, it, vi } from "vitest";
import { BrowserOpenRouterStrategy } from "../../src/bot/browser-openrouter";
import { NODE_PROMPT_TEMPLATES } from "../../src/bot/node-prompts";
import {
	actionPositionKey,
	matchesActionPosition,
} from "../../src/bot/position";
import {
	BOT_FALLBACK_MODEL,
	chooseWithSchemaRetry,
	decisionFormat,
	decisionOutputTokenLimit,
	parseDecision,
	preferredReasoningEffort,
	reasoningSettings,
	renderBidPrompt,
	renderPlayPrompt,
	responseText,
} from "../../src/bot/strategy";
import { createBoard, legalActions } from "../../src/bridge/engine";
import { bidding, DEAL } from "./bridge-fixtures";

describe("bot decisions", () => {
	it("recognizes the board position carried by a pending action key", () => {
		const board = createBoard(1, DEAL);
		const key = actionPositionKey(board);
		expect(matchesActionPosition(board, key)).toBe(true);
		expect(matchesActionPosition(board, `${key}:stale`)).toBe(false);
	});

	it("accepts only one action from the engine's legal set", () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const choice = legal.find((action) => action.type === "call");
		expect(choice?.type).toBe("call");
		if (choice?.type !== "call") throw new Error("test needs a call");
		expect(
			parseDecision(JSON.stringify({ call: choice.call }), "call", legal),
		).toEqual(choice);
		expect(() =>
			parseDecision(JSON.stringify({ call: "0S" }), "call", legal),
		).toThrow("not legal");
		expect(() =>
			parseDecision(
				JSON.stringify({ call: choice.call, extra: true }),
				"call",
				legal,
			),
		).toThrow("only call");
	});

	it("extracts only assistant JSON text from an OpenResponses result", () => {
		expect(
			responseText({
				output: [
					{ type: "reasoning", summary: "ignored" },
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: '{"call":"P"}' }],
					},
				],
			}),
		).toBe('{"call":"P"}');
	});

	it("trims surrounding whitespace from the key sent to OpenRouter", async () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const choice = legal.find((action) => action.type === "call");
		if (choice?.type !== "call") throw new Error("test needs a legal call");
		let authorization: string | null = null;
		vi.stubGlobal("window", {
			setTimeout: globalThis.setTimeout,
			clearTimeout: globalThis.clearTimeout,
		});
		vi.stubGlobal(
			"fetch",
			async (_input: string | URL | Request, init?: RequestInit) => {
				authorization = new Headers(init?.headers).get("Authorization");
				return new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								role: "assistant",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({ call: choice.call }),
									},
								],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);
		try {
			const strategy = new BrowserOpenRouterStrategy(
				"  test-api-key \n",
				{
					model: BOT_FALLBACK_MODEL,
					fallbackModel: BOT_FALLBACK_MODEL,
					modelOrder: [BOT_FALLBACK_MODEL],
					retries: 0,
					retryDelayMs: 0,
				},
				new AbortController().signal,
			);
			await strategy.choose("call", "prompt", legal);
			expect(authorization).toBe("Bearer test-api-key");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("reports a reasoning-only response so the strategy can retry", () => {
		expect(() => responseText({ output: [{ type: "reasoning" }] })).toThrow(
			"response items: reasoning",
		);
	});

	it("retries reasoning-only output up to three times with reasoning disabled", async () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const firstLegalCall = legal.find((action) => action.type === "call");
		if (firstLegalCall?.type !== "call")
			throw new Error("test needs a legal call");
		const efforts: string[] = [];
		const decision = await chooseWithSchemaRetry(
			async (effort) => {
				efforts.push(effort);
				return efforts.length < 4
					? { output: [{ type: "reasoning" }] }
					: {
							output: [
								{
									type: "message",
									role: "assistant",
									content: [
										{
											type: "output_text",
											text: JSON.stringify({ call: firstLegalCall.call }),
										},
									],
								},
							],
						};
			},
			"call",
			legal,
		);
		expect(efforts).toEqual(["low", "none", "none", "none"]);
		expect(decision).toEqual(firstLegalCall);
	});

	it("starts Mercury-3 without reasoning and keeps its output budget compact", async () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const firstLegalCall = legal.find((action) => action.type === "call");
		if (firstLegalCall?.type !== "call")
			throw new Error("test needs a legal call");
		const efforts: string[] = [];
		await chooseWithSchemaRetry(
			async (effort) => {
				efforts.push(effort);
				return {
					output: [
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "output_text",
									text: JSON.stringify({ call: firstLegalCall.call }),
								},
							],
						},
					],
				};
			},
			"call",
			legal,
			preferredReasoningEffort("inception/mercury-3"),
		);
		expect(efforts).toEqual(["none"]);
		expect(decisionOutputTokenLimit("inception/mercury-3")).toBe(4096);
		expect(reasoningSettings("inception/mercury-3", "none")).toEqual({
			enabled: false,
		});
		expect(preferredReasoningEffort("openai/gpt-6-luna")).toBe("low");
		expect(decisionOutputTokenLimit("openai/gpt-6-luna")).toBe(512);
		expect(reasoningSettings("openai/gpt-6-luna", "low")).toEqual({
			effort: "low",
		});
	});

	it("stops after three retries when no decision text is returned", async () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const efforts: string[] = [];
		await expect(
			chooseWithSchemaRetry(
				async (effort) => {
					efforts.push(effort);
					return { output: [{ type: "reasoning" }] };
				},
				"call",
				legal,
			),
		).rejects.toThrow("response items: reasoning");
		expect(efforts).toEqual(["low", "none", "none", "none"]);
	});

	it("forces a strict schema containing only legal choices", () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const format = decisionFormat("call", legal);
		expect(format.type).toBe("json_schema");
		expect(format.strict).toBe(true);
		expect(format.schema.properties.call?.enum).toEqual(
			legal
				.filter((action) => action.type === "call")
				.map((action) => action.call),
		);
		expect(format.schema.additionalProperties).toBe(false);
	});

	it("renders bidding state with its hand, auction, and legal choices", () => {
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const prompt = renderBidPrompt(
			board,
			board.dealer,
			legal,
			NODE_PROMPT_TEMPLATES,
		);
		expect(prompt).toContain("Standard American Yellow Card");
		expect(prompt).toContain("Legal bids:");
		expect(prompt).toContain("ordinary mistakes in bidding and play");
		expect(prompt).toContain("do not overthink unlikely lines");
		expect(prompt).toContain("♠");
		expect(prompt).not.toContain("♠ 765  ♥ JT987  ♦ QJT  ♣ KQ");
	});

	it("shows only the player's hand and dummy during play", () => {
		const board = bidding(createBoard(1, DEAL), "1S P 4S P P P");
		const legal = legalActions(board, "E");
		const prompt = renderPlayPrompt(board, "E", legal, NODE_PROMPT_TEMPLATES);
		expect(prompt).toContain("Your hand (East):");
		expect(prompt).toContain("Dummy (South):");
		expect(prompt).toContain("ordinary mistakes in bidding and play");
		expect(prompt).toContain("do not overthink unlikely lines");
		expect(prompt).not.toContain("♠ AKQJT98  ♥ AKQ  ♦ K  ♣ A");
		expect(prompt).not.toContain("♠ —  ♥ 32  ♦ 5432  ♣ 8765432");
	});
});
