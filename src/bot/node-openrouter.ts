import { callModel, OpenRouter } from "@openrouter/agent";
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

export interface NodeStrategySettings {
	readonly model: string;
	readonly fallbackModel: BotModel;
	readonly modelOrder?: readonly string[];
	readonly retries: number;
	readonly retryDelayMs: number;
}

function httpStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("statusCode" in error))
		return undefined;
	const status = error.statusCode;
	return typeof status === "number" ? status : undefined;
}

function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
	if (typeof error !== "object" || error === null || !("headers" in error))
		return undefined;
	const headers = error.headers;
	if (!(headers instanceof Headers)) return undefined;
	const value = headers.get("Retry-After");
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.ceil(seconds * 1000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorDetail(error: unknown, secret: string): string {
	const message = error instanceof Error ? error.message : "unknown error";
	return message
		.replaceAll(secret, "[redacted]")
		.replace(/\p{Cc}/gu, " ")
		.slice(0, 300);
}

export class OpenRouterStrategy {
	readonly #client: OpenRouter;
	readonly #apiKey: string;
	readonly #settings: NodeStrategySettings;

	constructor(apiKey: string, settings: Partial<NodeStrategySettings> = {}) {
		const normalizedApiKey = normalizeHostApiKey(apiKey);
		if (!normalizedApiKey) throw new Error("OPENROUTER_API_KEY is required");
		this.#apiKey = normalizedApiKey;
		this.#client = new OpenRouter({ apiKey: normalizedApiKey });
		this.#settings = {
			model: settings.model ?? BOT_MODEL,
			fallbackModel: settings.fallbackModel ?? BOT_FALLBACK_MODEL,
			modelOrder: settings.modelOrder ?? [
				settings.model ?? BOT_MODEL,
				settings.fallbackModel ?? BOT_FALLBACK_MODEL,
				...BOT_MODELS.filter(
					(model) =>
						model !== (settings.model ?? BOT_MODEL) &&
						model !== (settings.fallbackModel ?? BOT_FALLBACK_MODEL),
				),
			],
			retries: settings.retries ?? 5,
			retryDelayMs: settings.retryDelayMs ?? 3000,
		};
	}

	/** Returns the number of the option the model picked; `labels` lists the options in order. */
	async choose(
		prompt: string,
		labels: readonly string[],
		state?: Record<string, unknown>,
	): Promise<number> {
		if (labels.length === 0) throw new Error("no legal actions were provided");
		let modelIndex = 0;
		let model = this.#settings.modelOrder?.[modelIndex] ?? this.#settings.model;
		for (let attempt = 0; ; attempt++) {
			try {
				if (botModelType(model) === "decisions")
					return await this.#requestDecision(
						model,
						state ?? { position: prompt },
						labels,
					);
				const result = callModel(
					this.#client,
					{
						model,
						instructions:
							'You are a canasta player. Your final response must be exactly one JSON object of the form {"choice": N}, where N is the number of one supplied option. Do not include explanations, markdown, or hidden reasoning in the final response.',
						input: prompt,
						maxOutputTokens: decisionOutputTokenLimit(model),
						reasoning: reasoningSettings(
							model,
							preferredReasoningEffort(model),
						),
						store: false,
						text: { format: decisionFormat(labels.length) },
					},
					{ timeoutMs: 45_000, retries: { strategy: "none" } },
				);
				return parseChoice(
					responseText(await result.getResponse()),
					labels.length,
				);
			} catch (error) {
				const status = httpStatus(error);
				if (status === 402)
					throw new Error("Insufficient OpenRouter balance (402)");
				if (attempt >= this.#settings.retries) {
					const detail = safeErrorDetail(error, this.#apiKey);
					throw new Error(
						status === undefined
							? `OpenRouter request or decision failed: ${detail}`
							: `OpenRouter request failed (${status}): ${detail}`,
					);
				}
				if (
					status !== undefined &&
					status >= 500 &&
					modelIndex + 1 < (this.#settings.modelOrder?.length ?? 0)
				) {
					modelIndex++;
					model =
						this.#settings.modelOrder?.[modelIndex] ??
						this.#settings.fallbackModel;
				}
				const cooldown = status === 429 ? (retryAfterMs(error) ?? 0) : 0;
				await pause(
					Math.max(
						this.#settings.retryDelayMs,
						cooldown,
						status === 429 ? 5000 : 0,
					),
				);
			}
		}
	}

	async #requestDecision(
		model: string,
		state: Record<string, unknown>,
		labels: readonly string[],
	): Promise<number> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 45_000);
		try {
			const response = await fetch(DECISIONS_ENDPOINT, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#apiKey}`,
					"Content-Type": "application/json",
				},
				signal: controller.signal,
				body: JSON.stringify(decisionsRequestBody(model, state, labels)),
			});
			if (!response.ok) {
				const error = new Error(
					`OpenRouter request failed (${response.status})`,
				) as Error & { statusCode: number; headers: Headers };
				error.statusCode = response.status;
				error.headers = response.headers;
				throw error;
			}
			return parseDecisionsResponse(await response.json(), labels.length);
		} finally {
			clearTimeout(timer);
		}
	}
}
