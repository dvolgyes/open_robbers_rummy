import type { MatchState } from "../canasta";
import { engineSeat } from "../game/canasta";
import type { Seat } from "../protocol";
import {
	BotRequestAbortedError,
	botRequestFailureMessage,
	InsufficientBalanceError,
} from "./browser-openrouter";
import { actionPositionKey } from "./position";
import {
	type Choice,
	decisionState,
	offeredChoices,
	type PromptTemplates,
	renderTurnPrompt,
} from "./strategy";

/** Anything that picks one option by number, such as the browser or the node client. */
export interface TurnChooser {
	choose(
		prompt: string,
		labels: readonly string[],
		state?: Record<string, unknown>,
	): Promise<number>;
}

export interface TurnRequest {
	readonly key: string;
	readonly choices: readonly Choice[];
	readonly prompt: string;
	readonly state: Record<string, unknown>;
}

/** The key of one seat's decision in one position; a runner asks for each key once. */
export function turnKey(
	match: MatchState,
	accepted: number,
	seat: Seat,
): string {
	return `${actionPositionKey(match.handNo, accepted)}:${seat}`;
}

/** The request for one seat's turn now, or undefined when that seat has no legal action. */
export function turnRequest(
	match: MatchState,
	accepted: number,
	seat: Seat,
	templates: PromptTemplates,
): TurnRequest | undefined {
	const engine = engineSeat(seat);
	const choices = offeredChoices(match.hand, engine);
	if (choices.length === 0) return undefined;
	return {
		key: turnKey(match, accepted, seat),
		choices,
		prompt: renderTurnPrompt(match, engine, choices, templates),
		state: decisionState(match, engine),
	};
}

/**
 * Asks the model for a choice. A model that fails after its own retries does not stop the table: the top
 * heuristic choice is used instead, and `report` says why. Balance problems and aborts still stop the bot.
 */
export async function chooseTurn(
	chooser: TurnChooser,
	request: TurnRequest,
	report: (message: string) => void,
): Promise<Choice> {
	let index: number;
	try {
		index = await chooser.choose(
			request.prompt,
			request.choices.map((choice) => choice.label),
			request.state,
		);
	} catch (error) {
		if (
			error instanceof InsufficientBalanceError ||
			error instanceof BotRequestAbortedError
		)
			throw error;
		report(`${botRequestFailureMessage(error)} Using the heuristic choice.`);
		index = 0;
	}
	const choice = request.choices[index];
	if (!choice) throw new Error("bot choice is outside the offered options");
	return choice;
}
