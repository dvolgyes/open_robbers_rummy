import type { Action } from "../bridge/engine";
import type { BotModel } from "../protocol";
import {
	type Decision,
	decisionActionLabel,
	decisionActionValue,
} from "./strategy";

export const DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

const QUESTION_KEY = "bridge_action";

export function decisionsRequestBody(
	model: BotModel | string,
	kind: "call" | "play",
	state: Record<string, unknown>,
	legal: readonly Action[],
): Record<string, unknown> {
	if (legal.length === 0) throw new Error("no legal actions were provided");
	return {
		model,
		state,
		questions: {
			[QUESTION_KEY]: {
				type: "choice",
				instructions:
					kind === "call"
						? "Which legal call is the soundest action for this hand and auction in Standard American Yellow Card? Use the supplied high-card points and suit shape as computed facts. Assume opponents usually play well but may make ordinary mistakes."
						: "Which legal card best advances this side's bridge contract, given the visible cards, contract, and play so far? Treat the supplied card and trick counts as computed facts. Assume opponents usually play well but may make ordinary mistakes.",
				criteria: Object.fromEntries(
					legal.map((action) => [
						decisionActionValue(action),
						decisionActionLabel(action),
					]),
				),
			},
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Treats the remote answer as untrusted and returns only a locally legal action. */
export function parseDecisionsResponse(
	response: unknown,
	legal: readonly Action[],
): Decision {
	if (!isRecord(response) || !isRecord(response.answers))
		throw new Error("OpenRouter Decisions returned an invalid response");
	const answer = response.answers[QUESTION_KEY];
	if (!isRecord(answer) || answer.type !== "choice")
		throw new Error("OpenRouter Decisions returned an invalid choice answer");
	if (typeof answer.choice !== "string")
		throw new Error("OpenRouter Decisions returned no choice");
	const action = legal.find(
		(candidate) => decisionActionValue(candidate) === answer.choice,
	);
	if (!action)
		throw new Error(
			"OpenRouter Decisions chose an action that is not legal now",
		);
	return action.type === "call"
		? { type: "call", call: action.call }
		: { type: "play", card: action.card };
}
