import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BrowserOpenRouterStrategy,
	InsufficientBalanceError,
} from "../../src/bot/browser-openrouter";
import { chooseTurn, turnRequest } from "../../src/bot/turn";
import { startMatch } from "../../src/canasta";
import { tableSeat } from "../../src/game/canasta";
import type { BotModel, Seat } from "../../src/protocol";
import { DECISION_BOT_MODELS } from "../../src/protocol";

const SETTINGS = {
	model: "inception/mercury-3" as BotModel,
	fallbackModel: "openai/gpt-6-luna" as BotModel,
	retries: 2,
	retryDelayMs: 0,
};

const TEMPLATES = { turn: "{{CHOICES}}" };

function responseWithText(text: string): Response {
	return new Response(
		JSON.stringify({
			output: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text }],
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function responseForChoice(choice: number): Response {
	return responseWithText(JSON.stringify({ choice }));
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

function openingRequest() {
	const match = startMatch(7);
	const seat = tableSeat(match.hand.turn) as Seat;
	const request = turnRequest(match, 0, seat, TEMPLATES);
	if (!request) throw new Error("opening turn has no choices");
	return request;
}

function strategy(
	settings: Partial<typeof SETTINGS> = {},
	onRateLimit: () => void = () => {},
	onUsageCost: (cost: number) => void = () => {},
) {
	return new BrowserOpenRouterStrategy(
		"private-test-key",
		{ ...SETTINGS, ...settings },
		new AbortController().signal,
		onRateLimit,
		onUsageCost,
	);
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
					: responseForChoice(0);
			}),
		);
		const request = openingRequest();

		expect(
			await strategy().choose(
				request.prompt,
				request.choices.map((c) => c.label),
			),
		).toBe(0);
		expect(requests.map((body) => body.model)).toEqual([
			"inception/mercury-3",
			"openai/gpt-6-luna",
		]);
		expect(JSON.stringify(requests)).not.toContain("private-test-key");
	});

	it("surfaces insufficient balance without retrying", async () => {
		stubTimers();
		const fetchMock = vi.fn(async () => new Response("", { status: 402 }));
		vi.stubGlobal("fetch", fetchMock);
		const request = openingRequest();

		await expect(
			strategy().choose(
				request.prompt,
				request.choices.map((c) => c.label),
			),
		).rejects.toBeInstanceOf(InsufficientBalanceError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("honors the configured retry count after repeated server errors", async () => {
		stubTimers();
		const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		const request = openingRequest();

		await expect(
			strategy().choose(
				request.prompt,
				request.choices.map((c) => c.label),
			),
		).rejects.toThrow("OpenRouter request failed (503)");
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
			.mockResolvedValueOnce(responseForChoice(0));
		vi.stubGlobal("fetch", fetchMock);
		const request = openingRequest();
		const decision = strategy({ retryDelayMs: 5000 }).choose(
			request.prompt,
			request.choices.map((c) => c.label),
		);
		await vi.advanceTimersByTimeAsync(4999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(decision).resolves.toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("routes decision models through the Decisions API and records cost", async () => {
		stubTimers();
		const request = openingRequest();
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL) =>
				new Response(
					JSON.stringify({
						answers: {
							canasta_choice: { type: "choice", choice: "1" },
						},
						usage: { cost: 0.00001 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onUsageCost = vi.fn();

		expect(
			await strategy(
				{ model: DECISION_BOT_MODELS[0] },
				() => {},
				onUsageCost,
			).choose(
				request.prompt,
				request.choices.map((c) => c.label),
			),
		).toBe(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://openrouter.ai/api/alpha/decisions",
		);
		expect(onUsageCost).toHaveBeenCalledWith(0.00001);
	});
});

describe("fake model responses end in a legal action", () => {
	const badResponses: [string, () => Response | Promise<Response>][] = [
		["malformed JSON", () => responseWithText("choice one")],
		["out-of-range choice", () => responseForChoice(999)],
		["extra key", () => responseWithText('{"choice": 0, "why": "x"}')],
		["empty text", () => responseWithText("")],
	];

	it.each(badResponses)(
		"uses the heuristic top choice for %s",
		async (_name, respond) => {
			stubTimers();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => respond()),
			);
			const request = openingRequest();
			const messages: string[] = [];
			const choice = await chooseTurn(
				strategy({ retries: 0 }),
				request,
				(message) => messages.push(message),
			);
			expect(choice).toBe(request.choices[0]);
			expect(messages.length).toBeGreaterThan(0);
		},
	);

	it("uses the heuristic top choice when the request times out", async () => {
		stubTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("network timeout");
			}),
		);
		const request = openingRequest();
		const choice = await chooseTurn(
			strategy({ retries: 0 }),
			request,
			() => {},
		);
		expect(choice).toBe(request.choices[0]);
	});

	it("returns a valid option the model picks", async () => {
		stubTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => responseForChoice(1)),
		);
		const request = openingRequest();
		const choice = await chooseTurn(
			strategy({ retries: 0 }),
			request,
			() => {},
		);
		expect(choice).toBe(request.choices[1]);
	});
});
