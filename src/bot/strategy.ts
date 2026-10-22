import {
	type Action,
	type Card,
	type Seat as EngineSeat,
	type HandState,
	type MatchState,
	type TeamIndex,
	teamOf,
	viewFor,
} from "../canasta";
import { tableSeat } from "../game/canasta";
import { SEAT_NAMES, SEATS } from "../protocol";
import { actionLabel, cardLabel, meldLabel } from "./canasta-text";
import { botActions } from "./heuristic";

export const BOT_MODEL = "inception/mercury-3";
export const BOT_FALLBACK_MODEL = "openai/gpt-6-luna";

/** The most options a model sees. The top of the heuristic ranking is always among them. */
export const MAX_CHOICES = 40;

const SIDE_NAMES: Readonly<Record<TeamIndex, string>> = {
	0: "North-South",
	1: "East-West",
};

function otherSide(side: TeamIndex): TeamIndex {
	return side === 0 ? 1 : 0;
}

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

export interface PromptTemplates {
	readonly turn: string;
}

/** One legal action the model may pick, numbered as the model sees it. */
export interface Choice {
	readonly index: number;
	readonly action: Action;
	readonly label: string;
}

class MissingDecisionTextError extends Error {
	constructor(shape: readonly string[]) {
		super(
			`OpenRouter returned no usable decision text (response items: ${shape.join("; ") || "none"})`,
		);
		this.name = "MissingDecisionTextError";
	}
}

function renderTemplate(
	template: string,
	values: Readonly<Record<string, string>>,
): string {
	const rendered = template.replace(
		/\{\{([A-Z_]+)\}\}/g,
		(_placeholder, key: string) => {
			const value = values[key];
			if (value === undefined)
				throw new Error(`missing prompt template value: ${key}`);
			return value;
		},
	);
	if (/\{\{[A-Z_]+\}\}/.test(rendered))
		throw new Error("prompt template contains an unknown placeholder");
	return rendered;
}

/**
 * The legal actions ordered by the heuristic, cut to `MAX_CHOICES`. Numbering starts at 0, and choice 0
 * is the heuristic's first pick, so it doubles as the fallback when no model answers.
 */
export function offeredChoices(hand: HandState, seat: EngineSeat): Choice[] {
	const view = viewFor(hand, seat);
	return botActions(hand, seat)
		.slice(0, MAX_CHOICES)
		.map((action, index) => ({
			index,
			action,
			label: actionLabel(action, view),
		}));
}

export function renderTurnPrompt(
	match: MatchState,
	seat: EngineSeat,
	choices: readonly Choice[],
	templates: PromptTemplates,
): string {
	const view = viewFor(match.hand, seat);
	const side = teamOf(seat);
	const other = otherSide(side);
	const own = view.teams[side];
	const opponents = view.teams[other];
	const top = view.pile.at(-1);
	const redThrees = (cards: readonly Card[]) =>
		cards.length ? cards.map(cardLabel).join(" ") : "none";
	const name = tableSeat(seat);
	return renderTemplate(templates.turn, {
		SEAT: `${SEAT_NAMES[name]} (${name})`,
		SIDE: SIDE_NAMES[side],
		SCORES: `your side ${match.scores[side]}, opponents ${match.scores[other]}`,
		TARGET: String(view.rules.targetScore),
		PHASE:
			view.phase !== "draw"
				? "play (meld, extend, discard, or go out)"
				: view.stockCount > 0
					? "draw (take the stock or the pile first)"
					: "draw (the stock is empty: take the pile, or end the hand)",
		OWN_HAND: view.own.length ? view.own.map(cardLabel).join(" ") : "empty",
		HAND_COUNTS: SEATS.map(
			(name, index) => `${SEAT_NAMES[name]} ${view.handCounts[index] ?? 0}`,
		).join(", "),
		STOCK: `${view.stockCount} cards`,
		PILE: top ? `${view.pile.length} cards, top ${cardLabel(top)}` : "empty",
		OWN_MELDS:
			own.melds.map((meld) => meldLabel(meld, view)).join("\n") || "none",
		OWN_RED_THREES: redThrees(own.redThrees),
		OPPONENT_MELDS:
			opponents.melds.map((meld) => meldLabel(meld, view)).join("\n") || "none",
		OPPONENT_RED_THREES: redThrees(opponents.redThrees),
		TURN_MELD_POINTS: String(view.turnMeldPoints),
		CHOICES: choices
			.map((choice) => `${choice.index}: ${choice.label}`)
			.join("\n"),
	});
}

/** Builds only the facts this seat may know: its own hand, public piles and melds, and the scores. */
export function decisionState(
	match: MatchState,
	seat: EngineSeat,
): Record<string, unknown> {
	const view = viewFor(match.hand, seat);
	const side = teamOf(seat);
	const top = view.pile.at(-1);
	return {
		hand_number: match.handNo,
		seat: tableSeat(seat),
		phase: view.phase,
		own_cards: view.own.map(cardLabel),
		hand_counts: Object.fromEntries(
			SEATS.map((name, index) => [
				SEAT_NAMES[name],
				view.handCounts[index] ?? 0,
			]),
		),
		turn_meld_points: view.turnMeldPoints,
		stock_cards: view.stockCount,
		pile_cards: view.pile.length,
		pile_top: top ? cardLabel(top) : null,
		scores: {
			own_side: match.scores[side],
			opponents: match.scores[otherSide(side)],
		},
	};
}

export function decisionFormat(count: number) {
	return {
		type: "json_schema" as const,
		name: "canasta_choice",
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
