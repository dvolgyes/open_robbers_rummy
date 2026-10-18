import {
	type Card,
	rankOf,
	SUIT_SYMBOLS,
	SUITS,
	suitOf,
} from "../bridge/cards";
import {
	type Action,
	type Board,
	boardStatus,
	type CompletedTrick,
} from "../bridge/engine";
import type { Call, Contract } from "../bridge/rules";
import { SEAT_NAMES, type Seat, seatAfter } from "../protocol";

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

export interface PromptTemplates {
	readonly bidding: string;
	readonly play: string;
}

export type Decision =
	| { readonly type: "call"; readonly call: string }
	| { readonly type: "play"; readonly card: Card };

export type BridgeDecisionState = Record<string, unknown>;

class MissingDecisionTextError extends Error {
	constructor(shape: readonly string[]) {
		super(
			`OpenRouter returned no usable decision text (response items: ${shape.join("; ") || "none"})`,
		);
		this.name = "MissingDecisionTextError";
	}
}

const VULNERABILITY: Readonly<Record<Board["vulnerability"], string>> = {
	none: "None",
	NS: "North-South vulnerable",
	EW: "East-West vulnerable",
	both: "Both vulnerable",
};

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

function handText(cards: readonly Card[]): string {
	return SUITS.map((suit) => {
		const ranks = cards
			.filter((card) => suitOf(card) === suit)
			.map(rankOf)
			.join("");
		return `${SUIT_SYMBOLS[suit]} ${ranks || "—"}`;
	}).join("  ");
}

function callLabel(call: Call): string {
	if (call === "P") return "Pass";
	if (call === "X") return "Double";
	if (call === "XX") return "Redouble";
	return `${call[0]}${call.slice(1) === "NT" ? "NT" : SUIT_SYMBOLS[call.slice(1) as keyof typeof SUIT_SYMBOLS]}`;
}

function contractLabel(contract: Contract): string {
	const strain =
		contract.strain === "NT" ? "NT" : SUIT_SYMBOLS[contract.strain];
	return `${contract.level}${strain}${contract.doubling}`;
}

function cardLabel(card: Card): string {
	const rank = rankOf(card) === "T" ? "10" : rankOf(card);
	return `${SUIT_SYMBOLS[suitOf(card)]}${rank}`;
}

function callsText(board: Board): string {
	if (board.calls.length === 0) return "No calls yet";
	return board.calls
		.map((call, index) => {
			const seat = seatAfter(board.dealer, index);
			return `${SEAT_NAMES[seat]}: ${callLabel(call)}`;
		})
		.join(" · ");
}

function trickText(trick: Pick<CompletedTrick, "leader" | "cards">): string {
	return trick.cards
		.map((card, index) => {
			const seat = seatAfter(trick.leader, index);
			return `${SEAT_NAMES[seat]} ${cardLabel(card)}`;
		})
		.join(" · ");
}

function legalChoices(actions: readonly Action[]): string[] {
	return actions.map((action) =>
		action.type === "call" ? action.call : action.card,
	);
}

export function decisionFormat(
	kind: "call" | "play",
	legal: readonly Action[],
) {
	const field = kind === "call" ? "call" : "card";
	return {
		type: "json_schema" as const,
		name: `bridge_${kind}`,
		strict: true,
		schema: {
			type: "object",
			properties: {
				[field]: {
					type: "string",
					enum: legalChoices(legal),
				},
			},
			required: [field],
			additionalProperties: false,
		},
	};
}

export function renderBidPrompt(
	board: Board,
	seat: Seat,
	legal: readonly Action[],
	templates: PromptTemplates,
): string {
	return renderTemplate(templates.bidding, {
		BOARD: String(board.number),
		DEALER: `${SEAT_NAMES[board.dealer]} (${board.dealer})`,
		SEAT: `${SEAT_NAMES[seat]} (${seat})`,
		VULNERABILITY: VULNERABILITY[board.vulnerability],
		HAND: handText(board.deal[seat]),
		AUCTION: callsText(board),
		LEGAL_BIDS: legalChoices(legal).join(", "),
	});
}

export function renderPlayPrompt(
	board: Board,
	seat: Seat,
	legal: readonly Action[],
	templates: PromptTemplates,
): string {
	const status = boardStatus(board);
	if (status.phase !== "play") throw new Error("the board is not in play");
	const completed = status.tricks.map(
		(trick, index) =>
			`Trick ${index + 1}: ${trickText(trick)}; won by ${SEAT_NAMES[trick.winner]}`,
	);
	const current = status.current.cards.length
		? `Current trick: ${trickText(status.current)}`
		: "Current trick: empty; you are leading";
	const dummy = status.dummy;
	const dummyExposed = board.cards.length > 0;
	const knownHands = [
		`Your hand (${SEAT_NAMES[seat]}): ${handText(status.remaining[seat])}`,
		...(dummy === undefined
			? []
			: [
					dummyExposed
						? `Dummy (${SEAT_NAMES[dummy]}): ${handText(status.remaining[dummy])}`
						: `Dummy (${SEAT_NAMES[dummy]}): not exposed yet`,
				]),
	];
	const contract = status.contract;
	return renderTemplate(templates.play, {
		BOARD: String(board.number),
		VULNERABILITY: VULNERABILITY[board.vulnerability],
		AUCTION: callsText(board),
		CONTRACT: contractLabel(contract),
		DECLARER: `${SEAT_NAMES[contract.declarer]} (${contract.declarer})`,
		DUMMY: dummy === undefined ? "unknown" : `${SEAT_NAMES[dummy]} (${dummy})`,
		KNOWN_HANDS: knownHands.join("\n"),
		COMPLETED_TRICKS: completed.length
			? completed.join("\n")
			: "No completed tricks",
		CURRENT_TRICK: current,
		SEAT: `${SEAT_NAMES[seat]} (${seat})`,
		TRICKS_NS: String(status.tricksNS),
		TRICKS_EW: String(status.tricksEW),
		LEGAL_CARDS: legalChoices(legal).join(", "),
	});
}

/** Builds only the board facts that this player is allowed to know. */
export function decisionState(
	board: Board,
	seat: Seat,
	kind: "call" | "play",
): BridgeDecisionState {
	const auction = board.calls.map((call, index) => ({
		seat: seatAfter(board.dealer, index),
		call: callLabel(call),
	}));
	if (kind === "call") {
		const hand = board.deal[seat];
		const shape = SUITS.map(
			(suit) => hand.filter((card) => suitOf(card) === suit).length,
		).toSorted((a, b) => b - a);
		const highCardPoints = hand.reduce((points, card) => {
			const rank = rankOf(card);
			return (
				points +
				(rank === "A"
					? 4
					: rank === "K"
						? 3
						: rank === "Q"
							? 2
							: rank === "J"
								? 1
								: 0)
			);
		}, 0);
		return {
			board: board.number,
			dealer: board.dealer,
			vulnerability: board.vulnerability,
			seat,
			hand: Object.fromEntries(
				SUITS.map((suit) => [
					suit,
					hand
						.filter((card) => suitOf(card) === suit)
						.map(rankOf)
						.join(""),
				]),
			),
			high_card_points: highCardPoints,
			suit_shape_longest_first: shape,
			auction,
		};
	}

	const status = boardStatus(board);
	if (status.phase !== "play") throw new Error("the board is not in play");
	const contract = status.contract;
	const dummy = status.dummy;
	const dummyVisible = board.cards.length > 0;
	const trickPlays = (trick: Pick<CompletedTrick, "leader" | "cards">) =>
		trick.cards.map((card, index) => ({
			seat: seatAfter(trick.leader, index),
			card: cardLabel(card),
		}));
	return {
		board: board.number,
		vulnerability: board.vulnerability,
		seat,
		contract: {
			level: contract.level,
			strain: contract.strain,
			doubling: contract.doubling,
			declarer: contract.declarer,
		},
		dummy,
		hand: status.remaining[seat].map(cardLabel),
		dummy_hand:
			dummy === undefined || !dummyVisible
				? null
				: status.remaining[dummy].map(cardLabel),
		auction,
		completed_tricks: status.tricks.map((trick) => ({
			plays: trickPlays(trick),
			winner: trick.winner,
		})),
		current_trick: {
			leader: status.current.leader,
			plays: trickPlays(status.current),
		},
		tricks_won: { NS: status.tricksNS, EW: status.tricksEW },
	};
}

export function decisionActionValue(action: Action): string {
	return action.type === "call" ? action.call : action.card;
}

export function decisionActionLabel(action: Action): string {
	return action.type === "call"
		? callLabel(action.call)
		: `Play ${cardLabel(action.card)}`;
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

/** Accept only a single JSON field whose value is one of the locally computed legal actions. */
export function parseDecision(
	text: string,
	kind: "call" | "play",
	legal: readonly Action[],
): Decision {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("OpenRouter returned invalid JSON");
	}
	if (!isRecord(parsed))
		throw new Error("OpenRouter decision must be an object");
	const field = kind === "call" ? "call" : "card";
	if (Object.keys(parsed).length !== 1 || typeof parsed[field] !== "string")
		throw new Error(`OpenRouter decision must contain only ${field}`);
	const value = parsed[field];
	const candidate = legal.find(
		(action) =>
			(kind === "call" && action.type === "call" && action.call === value) ||
			(kind === "play" && action.type === "play" && action.card === value),
	);
	if (!candidate)
		throw new Error("OpenRouter chose an action that is not legal now");
	return candidate.type === "call"
		? { type: "call", call: candidate.call }
		: { type: "play", card: candidate.card };
}

export async function chooseWithSchemaRetry(
	request: (effort: ReasoningEffort) => Promise<unknown>,
	kind: "call" | "play",
	legal: readonly Action[],
	preferredEffort: ReasoningEffort = "low",
): Promise<Decision> {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const effort = attempt === 0 ? preferredEffort : "none";
			return parseDecision(responseText(await request(effort)), kind, legal);
		} catch (error) {
			if (!(error instanceof MissingDecisionTextError) || attempt === 3)
				throw error;
		}
	}
	throw new Error("OpenRouter decision attempts were exhausted");
}

export function randomDecision(legal: readonly Action[]): Decision {
	if (legal.length === 0) throw new Error("no legal actions were provided");
	const index = Math.floor(Math.random() * legal.length);
	const action = legal[index];
	if (!action) throw new Error("could not select a legal action");
	return action.type === "call"
		? { type: "call", call: action.call }
		: { type: "play", card: action.card };
}
