export const BOT_MODEL = "inception/mercury-3";
export const BOT_FALLBACK_MODEL = "openai/gpt-6-luna";

export type ReasoningEffort = "low" | "medium" | "none";

export function preferredReasoningEffort(model: string): ReasoningEffort {
	if (model.toLowerCase().startsWith("~openai/gpt-sol-latest")) return "medium";
	return model.toLowerCase().startsWith("inception/mercury-3") ? "none" : "low";
}

export function decisionOutputTokenLimit(model: string): number {
	if (model.toLowerCase().startsWith("~openai/gpt-sol-latest")) return 16_384;
	return model.toLowerCase().startsWith("inception/mercury-3") ? 4096 : 512;
}

export function reasoningSettings(
	model: string,
	effort: ReasoningEffort,
):
	| { readonly enabled: false }
	| { readonly effort: "low" | "medium" | "none" } {
	const normalizedModel = model.toLowerCase();
	if (normalizedModel.startsWith("inception/mercury-3"))
		return { enabled: false };
	return {
		effort: normalizedModel.startsWith("~openai/gpt-sol-latest")
			? "medium"
			: effort,
	};
}

class MissingDecisionTextError extends Error {
	constructor(shape: readonly string[]) {
		super(
			`OpenRouter returned no usable decision text (response items: ${shape.join("; ") || "none"})`,
		);
		this.name = "MissingDecisionTextError";
	}
}

export function decisionFormat(count: number) {
	return {
		type: "json_schema" as const,
		name: "turn_choice",
		strict: true,
		schema: {
			type: "object",
			properties: {
				choice: {
					type: "integer",
					enum: Array.from({ length: count }, (_value, index) => index),
				},
			},
			required: ["choice"],
			additionalProperties: false,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads assistant text from the OpenResponses response without logging model reasoning or request content. */
export function responseText(response: unknown): string {
	if (!isRecord(response) || !Array.isArray(response.output))
		throw new Error("OpenRouter returned an invalid response");
	const parts: string[] = [];
	const shape: string[] = [];
	for (const item of response.output) {
		if (!isRecord(item)) {
			shape.push("unknown-item");
			continue;
		}
		if (!Array.isArray(item.content)) {
			shape.push(String(item.type ?? "unknown-item"));
			continue;
		}
		shape.push(
			`${String(item.type ?? "unknown-item")}[${item.content
				.map((content) =>
					isRecord(content)
						? String(content.type ?? "unknown-content")
						: "unknown-content",
				)
				.join(",")}]`,
		);
		if (item.type !== "message" || item.role !== "assistant") continue;
		for (const content of item.content) {
			if (
				isRecord(content) &&
				content.type === "output_text" &&
				typeof content.text === "string"
			)
				parts.push(content.text);
		}
	}
	const text = parts.join("").trim();
	if (text.length === 0 || text.length > 512)
		throw new MissingDecisionTextError(shape);
	return text;
}

/** Accepts only `{"choice": n}` where n is one of the offered option numbers. */
export function parseChoice(text: string, count: number): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("OpenRouter returned invalid JSON");
	}
	if (!isRecord(parsed))
		throw new Error("OpenRouter decision must be an object");
	if (Object.keys(parsed).length !== 1 || !("choice" in parsed))
		throw new Error("OpenRouter decision must contain only choice");
	const value = parsed.choice;
	if (typeof value !== "number" || !Number.isInteger(value))
		throw new Error("OpenRouter choice must be an integer");
	if (value < 0 || value >= count)
		throw new Error("OpenRouter chose an option that was not offered");
	return value;
}

export async function chooseWithSchemaRetry(
	request: (effort: ReasoningEffort) => Promise<unknown>,
	count: number,
	preferredEffort: ReasoningEffort = "low",
): Promise<number> {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const effort = attempt === 0 ? preferredEffort : "none";
			return parseChoice(responseText(await request(effort)), count);
		} catch (error) {
			if (!(error instanceof MissingDecisionTextError) || attempt === 3)
				throw error;
		}
	}
	throw new Error("OpenRouter decision attempts were exhausted");
}
