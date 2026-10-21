export const DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

const QUESTION_KEY = "canasta_choice";

export function decisionsRequestBody(
	model: string,
	state: Record<string, unknown>,
	labels: readonly string[],
): Record<string, unknown> {
	if (labels.length === 0) throw new Error("no legal actions were provided");
	return {
		model,
		state,
		questions: {
			[QUESTION_KEY]: {
				type: "choice",
				instructions:
					"Which numbered option is the best action for this seat's turn in classic partnership canasta? Treat the supplied hand, melds, pile and stock counts as computed facts. Assume opponents usually play well but may make ordinary mistakes.",
				criteria: Object.fromEntries(
					labels.map((label, index) => [String(index), label]),
				),
			},
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Treats the remote answer as untrusted and returns only an offered option number. */
export function parseDecisionsResponse(
	response: unknown,
	count: number,
): number {
	if (!isRecord(response) || !isRecord(response.answers))
		throw new Error("OpenRouter Decisions returned an invalid response");
	const answer = response.answers[QUESTION_KEY];
	if (!isRecord(answer) || answer.type !== "choice")
		throw new Error("OpenRouter Decisions returned an invalid choice answer");
	if (
		typeof answer.choice !== "string" ||
		!/^(0|[1-9]\d*)$/.test(answer.choice)
	)
		throw new Error("OpenRouter Decisions returned no valid choice");
	const index = Number(answer.choice);
	if (index >= count)
		throw new Error(
			"OpenRouter Decisions chose an option that was not offered",
		);
	return index;
}
