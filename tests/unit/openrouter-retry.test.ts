import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BrowserOpenRouterStrategy,
	InsufficientBalanceError,
} from "../../src/bot/browser-openrouter";
import { createBoard, legalActions } from "../../src/bridge/engine";
import type { BotModel } from "../../src/protocol";
import { DECISION_BOT_MODELS } from "../../src/protocol";
import { DEAL } from "./bridge-fixtures";

const SETTINGS = {
	model: "inception/mercury-3" as BotModel,
	fallbackModel: "openai/gpt-6-luna" as BotModel,
	retries: 2,
	retryDelayMs: 0,
};

function responseForCall(call: string): Response {
	return new Response(
		JSON.stringify({
			output: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: JSON.stringify({ call }) }],
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function stubTimers(): void {
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
	});
}

describe("browser OpenRouter retry policy", () => {
	it("switches to the fallback model after a server error", async () => {
		stubTimers();
		const requests: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(
					JSON.parse(String(init?.body)) as Record<string, unknown>,
				);
				return requests.length === 1
					? new Response("", { status: 503 })
					: responseForCall("P");
			}),
		);
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const strategy = new BrowserOpenRouterStrategy(
			"private-test-key",
			SETTINGS,
			new AbortController().signal,
		);

		expect(await strategy.choose("call", "prompt", legal)).toEqual({
			type: "call",
			call: "P",
		});
		expect(requests.map((request) => request.model)).toEqual([
			"inception/mercury-3",
			"openai/gpt-6-luna",
		]);
		expect(JSON.stringify(requests)).not.toContain("private-test-key");
	});

	it("surfaces insufficient balance without retrying", async () => {
		stubTimers();
		const fetchMock = vi.fn(async () => new Response("", { status: 402 }));
		vi.stubGlobal("fetch", fetchMock);
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const strategy = new BrowserOpenRouterStrategy(
			"private-test-key",
			SETTINGS,
			new AbortController().signal,
		);

		await expect(
			strategy.choose("call", "prompt", legal),
		).rejects.toBeInstanceOf(InsufficientBalanceError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("honors the configured retry count after repeated server errors", async () => {
		stubTimers();
		const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const strategy = new BrowserOpenRouterStrategy(
			"private-test-key",
			SETTINGS,
			new AbortController().signal,
		);

		await expect(strategy.choose("call", "prompt", legal)).rejects.toThrow(
			"OpenRouter request failed (503)",
		);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("waits at least the configured delay for a rate limit", async () => {
		vi.useFakeTimers();
		stubTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("", {
					status: 429,
					headers: { "Retry-After": "2" },
				}),
			)
			.mockResolvedValueOnce(responseForCall("P"));
		vi.stubGlobal("fetch", fetchMock);
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const strategy = new BrowserOpenRouterStrategy(
			"private-test-key",
			{ ...SETTINGS, retryDelayMs: 5000 },
			new AbortController().signal,
		);
		const decision = strategy.choose("call", "prompt", legal);
		await vi.advanceTimersByTimeAsync(4999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(decision).resolves.toEqual({ type: "call", call: "P" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("routes decision models through the Decisions API and records cost", async () => {
		stubTimers();
		const board = createBoard(1, DEAL);
		const legal = legalActions(board, board.dealer);
		const chosen = legal[0];
		if (chosen?.type !== "call")
			throw new Error("test needs a legal opening call");
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL) =>
				new Response(
					JSON.stringify({
						answers: {
							bridge_action: { type: "choice", choice: chosen.call },
						},
						usage: { cost: 0.00001 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onUsageCost = vi.fn();
		const strategy = new BrowserOpenRouterStrategy(
			"private-test-key",
			{ ...SETTINGS, model: DECISION_BOT_MODELS[0] },
			new AbortController().signal,
			undefined,
			onUsageCost,
		);

		expect(
			await strategy.choose("call", "unused with decision models", legal, {
				seat: board.dealer,
			}),
		).toEqual(chosen);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://openrouter.ai/api/alpha/decisions",
		);
		expect(onUsageCost).toHaveBeenCalledWith(0.00001);
	});
});
