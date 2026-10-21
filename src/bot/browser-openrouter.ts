import { BOT_MODELS, type BotModel, botModelType } from "../protocol";
import {
	DECISIONS_ENDPOINT,
	decisionsRequestBody,
	parseDecisionsResponse,
} from "./decision-model";
import { normalizeHostApiKey } from "./host-key";
import {
	BOT_FALLBACK_MODEL,
	BOT_MODEL,
	decisionFormat,
	decisionOutputTokenLimit,
	parseChoice,
	preferredReasoningEffort,
	reasoningSettings,
	responseText,
} from "./strategy";

const ENDPOINT = "https://openrouter.ai/api/v1/responses";

export interface BrowserStrategySettings {
	readonly model: BotModel;
	readonly fallbackModel: BotModel;
	readonly modelOrder?: readonly BotModel[];
	readonly retries: number;
	readonly retryDelayMs: number;
}

export class OpenRouterRequestError extends Error {
	readonly status: number;
	readonly retryAfterMs: number | undefined;

	constructor(status: number, retryAfterMs?: number) {
		super(`OpenRouter request failed (${status})`);
		this.name = "OpenRouterRequestError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export class InsufficientBalanceError extends OpenRouterRequestError {
	constructor() {
		super(402);
		this.name = "InsufficientBalanceError";
	}
}

export class BotRequestAbortedError extends Error {
	constructor() {
		super("bot request aborted");
		this.name = "AbortError";
	}
}

export function botRequestFailureMessage(error: unknown): string {
	if (error instanceof OpenRouterRequestError) {
		switch (error.status) {
			case 401:
				return "OpenRouter rejected the API key (401). Set the key again, then resume bots.";
			case 402:
				return "OpenRouter has insufficient balance. Update the balance or API key, then resume bots.";
			case 403:
				return "OpenRouter denied access to this model (403). Check the account and model access.";
			case 404:
				return "OpenRouter could not find this model or endpoint (404). Choose another model.";
			case 413:
				return "OpenRouter rejected the request as too large (413). Choose another model.";
			case 429:
				return "OpenRouter kept rate limiting the bot after retries. Wait, then resume bots.";
			default:
				return error.status >= 500
					? `OpenRouter or the model provider returned HTTP ${error.status} after retries. Check provider status or choose another model.`
					: `OpenRouter returned HTTP ${error.status} after retries. Check the selected model and request settings.`;
		}
	}
	if (error instanceof Error && error.name === "AbortError")
		return "The OpenRouter request timed out. Resume bots to try again.";
	if (error instanceof TypeError)
		return "The browser could not reach OpenRouter. Check the connection, then resume bots.";
	if (error instanceof Error && error.message.startsWith("OpenRouter "))
		return `The selected model returned an unusable decision: ${error.message}. Choose another model or resume bots.`;
	return "The bot could not use the model response. Choose another model or resume bots.";
}

function retryAfterMs(
	response: Response,
	now = Date.now(),
): number | undefined {
	const value = response.headers.get("Retry-After");
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.ceil(seconds * 1000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function responseCost(response: unknown): number | undefined {
	if (response === null || typeof response !== "object") return undefined;
	const usage = (response as { usage?: unknown }).usage;
	if (usage === null || typeof usage !== "object") return undefined;
	const cost = (usage as { cost?: unknown }).cost;
	return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
		? cost
		: undefined;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new BotRequestAbortedError());
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = (): void => {
			window.clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(new BotRequestAbortedError());
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

export class BrowserOpenRouterStrategy {
	readonly #apiKey: string;
	readonly #settings: BrowserStrategySettings;
	readonly #signal: AbortSignal;
	readonly #onRateLimit: () => void;
	readonly #onUsageCost: (cost: number) => void;
	readonly #onStatus: (message: string) => void;

	constructor(
		apiKey: string,
		settings: BrowserStrategySettings,
		signal: AbortSignal,
		onRateLimit: () => void = () => {},
		onUsageCost: (cost: number) => void = () => {},
		onStatus: (message: string) => void = () => {},
	) {
		const normalizedApiKey = normalizeHostApiKey(apiKey);
		if (!normalizedApiKey) throw new Error("OpenRouter API key is required");
		this.#apiKey = normalizedApiKey;
		this.#settings = settings;
		this.#signal = signal;
		this.#onRateLimit = onRateLimit;
		this.#onUsageCost = onUsageCost;
		this.#onStatus = onStatus;
	}

	/** Returns the number of the option the model picked; `labels` lists the options in order. */
	async choose(
		prompt: string,
		labels: readonly string[],
		state?: Record<string, unknown>,
	): Promise<number> {
		if (labels.length === 0) throw new Error("no legal actions were provided");
		const modelOrder = this.#settings.modelOrder ?? [
			this.#settings.model || BOT_MODEL,
			this.#settings.fallbackModel || BOT_FALLBACK_MODEL,
			...BOT_MODELS.filter(
				(model) =>
					model !== this.#settings.model &&
					model !== this.#settings.fallbackModel,
			),
		];
		let modelIndex = 0;
		let model = modelOrder[modelIndex] as BotModel;
		for (let attempt = 0; ; attempt++) {
			this.#onStatus(
				`Asking ${model} for a turn choice (attempt ${attempt + 1} of ${this.#settings.retries + 1}).`,
			);
			try {
				const response = await this.#request(model, prompt, labels, state);
				const cost = responseCost(response);
				if (cost !== undefined) this.#onUsageCost(cost);
				return botModelType(model) === "decisions"
					? parseDecisionsResponse(response, labels.length)
					: parseChoice(responseText(response), labels.length);
			} catch (error) {
				if (this.#signal.aborted) throw new BotRequestAbortedError();
				if (error instanceof OpenRouterRequestError && error.status === 402)
					throw new InsufficientBalanceError();
				if (attempt >= this.#settings.retries) throw error;
				const previousModel = model;
				if (
					error instanceof OpenRouterRequestError &&
					error.status >= 500 &&
					modelIndex + 1 < modelOrder.length
				) {
					modelIndex++;
					model = modelOrder[modelIndex] as BotModel;
				}
				if (error instanceof OpenRouterRequestError && error.status === 429)
					this.#onRateLimit();
				const cooldown =
					error instanceof OpenRouterRequestError && error.status === 429
						? (error.retryAfterMs ?? 0)
						: 0;
				const delay = Math.max(
					this.#settings.retryDelayMs,
					cooldown,
					error instanceof OpenRouterRequestError && error.status === 429
						? 5000
						: 0,
				);
				const delayText = `${Math.ceil(delay / 1000)} seconds`;
				if (previousModel !== model) {
					this.#onStatus(
						`HTTP ${(error as OpenRouterRequestError).status} from ${previousModel}; trying next priority model ${model} in ${delayText}.`,
					);
				} else if (
					error instanceof OpenRouterRequestError &&
					error.status === 429
				) {
					this.#onStatus(
						`OpenRouter rate limit (429). Retrying in ${delayText}.`,
					);
				} else if (error instanceof OpenRouterRequestError) {
					this.#onStatus(
						`OpenRouter returned HTTP ${error.status}. Retrying in ${delayText}.`,
					);
				} else if (error instanceof Error && error.name === "AbortError") {
					this.#onStatus(
						`OpenRouter request timed out. Retrying in ${delayText}.`,
					);
				} else {
					this.#onStatus(
						`Could not reach OpenRouter. Retrying in ${delayText}.`,
					);
				}
				await wait(delay, this.#signal);
			}
		}
	}

	async #request(
		model: string,
		prompt: string,
		labels: readonly string[],
		state?: Record<string, unknown>,
	): Promise<unknown> {
		const timeout = new AbortController();
		const timer = window.setTimeout(() => timeout.abort(), 45_000);
		const slowRequestTimer = window.setTimeout(() => {
			this.#onStatus(`Still waiting for ${model} to return a decision.`);
		}, 10_000);
		const abort = (): void => timeout.abort();
		this.#signal.addEventListener("abort", abort, { once: true });
		try {
			const decisions = botModelType(model) === "decisions";
			const response = await fetch(decisions ? DECISIONS_ENDPOINT : ENDPOINT, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#apiKey}`,
					"Content-Type": "application/json",
				},
				signal: timeout.signal,
				body: JSON.stringify(
					decisions
						? decisionsRequestBody(model, state ?? { position: prompt }, labels)
						: {
								model,
								instructions:
									'You are a canasta player. Your final response must be exactly one JSON object of the form {"choice": N}, where N is the number of one supplied option. Do not include explanations, markdown, or hidden reasoning in the final response.',
								input: prompt,
								max_output_tokens: decisionOutputTokenLimit(model),
								reasoning: reasoningSettings(
									model,
									preferredReasoningEffort(model),
								),
								store: false,
								usage: { include: true },
								text: { format: decisionFormat(labels.length) },
							},
				),
			});
			if (!response.ok) {
				const cooldown = retryAfterMs(response);
				if (response.status === 402) throw new InsufficientBalanceError();
				throw new OpenRouterRequestError(response.status, cooldown);
			}
			return await response.json();
		} finally {
			window.clearTimeout(timer);
			window.clearTimeout(slowRequestTimer);
			this.#signal.removeEventListener("abort", abort);
		}
	}
}
