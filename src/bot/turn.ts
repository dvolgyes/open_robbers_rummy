import {
	BotRequestAbortedError,
	botRequestFailureMessage,
	InsufficientBalanceError,
} from "./browser-openrouter";

/** Anything that picks one option by number, such as the browser or the node client. */
export interface TurnChooser {
	choose(
		prompt: string,
		labels: readonly string[],
		state?: Record<string, unknown>,
	): Promise<number>;
}

/** One numbered decision for a model: the option labels, the prompt that lists them, and the state as facts. */
export interface TurnRequest {
	readonly labels: readonly string[];
	readonly prompt: string;
	readonly state: Record<string, unknown>;
}

/**
 * Asks the model for an option number. A model that fails after its own retries does not stop the table: the first
 * option is used instead, and `report` says why. Balance problems and aborts still stop the bot.
 */
export async function chooseTurn(
	chooser: TurnChooser,
	request: TurnRequest,
	report: (message: string) => void,
): Promise<number> {
	if (request.labels.length === 0) throw new Error("no options were offered");
	let index: number;
	try {
		index = await chooser.choose(request.prompt, request.labels, request.state);
	} catch (error) {
		if (
			error instanceof InsufficientBalanceError ||
			error instanceof BotRequestAbortedError
		)
			throw error;
		report(`${botRequestFailureMessage(error)} Using the first option.`);
		index = 0;
	}
	if (index < 0 || index >= request.labels.length)
		throw new Error("bot choice is outside the offered options");
	return index;
}
