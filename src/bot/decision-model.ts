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
					"Which numbered option is the best action for this seat's turn in classic partnership canasta? Treat the supplied hand, hand counts, pile and stock counts as computed facts. Keep 2s and jokers in the hand while the opponents are not close to going out; use them only to reach the first meld minimum, to complete a canasta, or to go out, and prefer the option with fewer wild cards when two do the same job. A natural canasta scores 500 and a mixed one 300. The opponents are close to going out when one of them has few cards or the stock is low; then complete canastas and meld cards to keep few points in the hand. Keep wild cards out of the discard pile. Assume opponents usually play well but may make ordinary mistakes.",
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
