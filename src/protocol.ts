/** Shared vocabulary of the room protocol. Every command payload, event and state carries `v` and `roomId`. */

export const PROTOCOL_VERSION = 1;
export const APPLICATION_FEATURES = {
	bridgeUndo: "bridge-undo-v1",
	bridgeClaim: "bridge-claim-v1",
	bridgeReset: "bridge-reset-v1",
} as const;

export const SEATS = ["N", "E", "S", "W"] as const;
export type Seat = (typeof SEATS)[number];

export const SEAT_NAMES: Readonly<Record<Seat, string>> = {
	N: "North",
	E: "East",
	S: "South",
	W: "West",
};

export const MAX_NAME_LENGTH = 40;

export type Scoring = "duplicate";

export const DECISION_BOT_MODELS = [
	"~perplexity/pplx-decider-latest",
	"openai/gpt-6-luna-decisions",
	"inception/mercury-decide",
	"typesafe/jev-1.14",
] as const;

export const BOT_MODELS = [
	"inception/mercury-3",
	"openai/gpt-6-luna",
	...DECISION_BOT_MODELS,
	"~openai/gpt-sol-latest",
] as const;
export type BotModel = (typeof BOT_MODELS)[number];
export type BotModelType = "responses" | "decisions";

const DECISION_MODEL_NAMES: ReadonlySet<string> = new Set([
	...DECISION_BOT_MODELS,
	"liquid/d1-ultra-20261015",
	"liquid/d1-ultra",
	"inception/mercury-decide-20260930",
	"typesafe/jev-1.14-20261014",
	"openai/gpt-6-luna-decisions-20261006",
	"inception/mercury-decide",
	"typesafe/jev-1.14",
	"openai/gpt-6-luna-decisions",
]);

const BOT_MODEL_LABELS: Readonly<Record<BotModel, string>> = {
	"inception/mercury-3": "inception/mercury-3 · Responses",
	"openai/gpt-6-luna": "openai/gpt-6-luna · Responses",
	"~perplexity/pplx-decider-latest":
		"~perplexity/pplx-decider-latest · Decisions",
	"openai/gpt-6-luna-decisions": "openai/gpt-6-luna-decisions · Decisions",
	"inception/mercury-decide": "inception/mercury-decide · Decisions",
	"typesafe/jev-1.14": "typesafe/jev-1.14 · Decisions",
	"~openai/gpt-sol-latest":
		"~openai/gpt-sol-latest · Responses · medium reasoning",
};

const LEGACY_BOT_MODEL_ALIASES: Readonly<Record<string, BotModel>> = {
	"liquid/d1-ultra-20261015": "~perplexity/pplx-decider-latest",
	"inception/mercury-decide-20260930": "inception/mercury-decide",
	"typesafe/jev-1.14-20261014": "typesafe/jev-1.14",
	"openai/gpt-6-luna-decisions-20261006": "openai/gpt-6-luna-decisions",
};

/** The model ID selects the Responses or Decisions API contract. */
export function botModelType(model: string): BotModelType {
	return DECISION_MODEL_NAMES.has(model) ? "decisions" : "responses";
}

export function botModelLabel(model: BotModel): string {
	return BOT_MODEL_LABELS[model];
}

export interface BotSetup {
	/** The bot seats when the room is first created. */
	readonly seats: readonly Seat[];
	readonly model: BotModel;
	readonly fallbackModel: BotModel;
	/** Ordered model priority. The first two entries match model and fallbackModel. */
	readonly modelOrder?: readonly BotModel[];
	/** Retries after the first request, from 0 through 10. */
	readonly retries: number;
	readonly retryDelayMs: number;
}

export const DEFAULT_BOT_SETUP: BotSetup = {
	seats: [],
	model: "inception/mercury-3",
	fallbackModel: "openai/gpt-6-luna",
	retries: 5,
	retryDelayMs: 3000,
};

export function botModelOrder(
	setup: Pick<BotSetup, "model" | "fallbackModel" | "modelOrder">,
): BotModel[] {
	return [
		...(setup.modelOrder ?? [
			setup.model,
			setup.fallbackModel,
			...BOT_MODELS.filter(
				(model) => model !== setup.model && model !== setup.fallbackModel,
			),
		]),
	];
}

export interface RoomConfig {
	readonly names: Readonly<Record<Seat, string>>;
	readonly scoring: Scoring;
	/** Optional for rooms created by older app versions. */
	readonly botSetup?: BotSetup;
}

export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSeat(value: unknown): value is Seat {
	return (
		typeof value === "string" && (SEATS as readonly string[]).includes(value)
	);
}

/** Seat names containing "bot" or "robot" are reserved for an automated bridge player. */
export function isBotName(name: string): boolean {
	return /bot|robot/i.test(name);
}

export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseRoomConfig(value: unknown): RoomConfig | undefined {
	if (!isObject(value) || !isObject(value.names)) return undefined;
	const names: Partial<Record<Seat, string>> = {};
	for (const seat of SEATS) {
		const name = value.names[seat];
		if (typeof name !== "string" || name.length === 0) return undefined;
		names[seat] = name;
	}
	const { scoring } = value;
	if (scoring !== "duplicate") return undefined;
	let botSetup: BotSetup | undefined;
	if (Object.hasOwn(value, "botSetup")) {
		const parsedBotSetup = parseBotSetup(value.botSetup);
		if (parsedBotSetup === undefined) return undefined;
		botSetup = parsedBotSetup;
	}
	return {
		names: names as Record<Seat, string>,
		scoring,
		...(botSetup === undefined ? {} : { botSetup }),
	};
}

export function parseBotSetup(value: unknown): BotSetup | undefined {
	if (!isObject(value)) return undefined;
	const { seats, model, fallbackModel, modelOrder, retries, retryDelayMs } =
		value;
	const parsedModelOrder =
		modelOrder === undefined
			? undefined
			: Array.isArray(modelOrder) &&
					modelOrder.length >= 2 &&
					modelOrder.length <= BOT_MODELS.length &&
					modelOrder.every((model) => normalizeBotModel(model) !== undefined) &&
					new Set(modelOrder.map(normalizeBotModel)).size === modelOrder.length
				? [
						...(modelOrder.map(normalizeBotModel) as BotModel[]),
						...BOT_MODELS.filter(
							(model) =>
								!modelOrder.some((entry) => normalizeBotModel(entry) === model),
						),
					]
				: null;
	const parsedModel = normalizeBotModel(model);
	const parsedFallbackModel = normalizeBotModel(fallbackModel);
	if (
		!Array.isArray(seats) ||
		!seats.every(isSeat) ||
		new Set(seats).size !== seats.length ||
		seats.length > SEATS.length ||
		parsedModel === undefined ||
		parsedFallbackModel === undefined ||
		parsedModel === parsedFallbackModel ||
		parsedModelOrder === null ||
		(parsedModelOrder !== undefined &&
			(parsedModelOrder[0] !== parsedModel ||
				parsedModelOrder[1] !== parsedFallbackModel)) ||
		!Number.isSafeInteger(retries) ||
		(retries as number) < 0 ||
		(retries as number) > 10 ||
		!Number.isSafeInteger(retryDelayMs) ||
		(retryDelayMs as number) < 1000 ||
		(retryDelayMs as number) > 60_000
	)
		return undefined;
	return {
		seats: [...seats],
		model: parsedModel,
		fallbackModel: parsedFallbackModel,
		...(parsedModelOrder === undefined
			? {}
			: { modelOrder: [...parsedModelOrder] }),
		retries: retries as number,
		retryDelayMs: retryDelayMs as number,
	};
}

export function isBotModel(value: unknown): value is BotModel {
	return (
		typeof value === "string" &&
		(BOT_MODELS as readonly string[]).includes(value)
	);
}

function normalizeBotModel(value: unknown): BotModel | undefined {
	if (isBotModel(value)) return value;
	return typeof value === "string"
		? LEGACY_BOT_MODEL_ALIASES[value]
		: undefined;
}

export interface EventEnvelope {
	readonly roomId: string;
	readonly seq: number;
	readonly commandId: string;
	readonly fromSeat: Seat;
}

/** Envelope fields win over body fields, so a game module cannot forge sender, room or order. */
export function envelopeEvent(
	envelope: EventEnvelope,
	body: JsonObject,
): JsonObject {
	return {
		...body,
		v: PROTOCOL_VERSION,
		roomId: envelope.roomId,
		type: "event",
		seq: envelope.seq,
		commandId: envelope.commandId,
		fromSeat: envelope.fromSeat,
	};
}

/** The seat `steps` places clockwise from `seat`. */
export function seatAfter(seat: Seat, steps: number): Seat {
	return SEATS[(SEATS.indexOf(seat) + steps) % 4] as Seat;
}

export function seatLabel(config: RoomConfig, seat: Seat): string {
	return `${SEAT_NAMES[seat]} — ${config.names[seat]}`;
}
