/** Shared vocabulary of the table protocol. Every command payload, event and state carries `v` and `tableId`. */

export const PROTOCOL_VERSION = 1;
/** Every seat a table can have. A table uses the first two to six of them (`seatsOf`). */
export const SEATS = ["1", "2", "3", "4", "5", "6"] as const;
export type Seat = (typeof SEATS)[number];
export const MIN_PLAYERS = 2;

export const SEAT_NAMES: Readonly<Record<Seat, string>> = {
	"1": "Player 1",
	"2": "Player 2",
	"3": "Player 3",
	"4": "Player 4",
	"5": "Player 5",
	"6": "Player 6",
};

/** The rule presets of the table; `src/rummy/rules.ts` owns their meaning. */
export const TABLE_PRESETS = ["gamerules", "wikipedia", "machiavelli"] as const;
export type TablePreset = (typeof TABLE_PRESETS)[number];
export const MIN_JOKERS = 2;
export const MAX_JOKERS = 6;

/** The rules chosen at table creation. Every peer reads them from the table config. */
export interface TableSetup {
	readonly preset: TablePreset;
	readonly jokers: number;
	/** The solver may suggest a play to a human player. */
	readonly assist: boolean;
}

export const DEFAULT_TABLE_SETUP: TableSetup = {
	preset: "gamerules",
	jokers: 4,
	assist: true,
};

export const MAX_NAME_LENGTH = 40;

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

/** The model ID selects the Responses or Decisions API contract. */
export function botModelType(model: string): BotModelType {
	return DECISION_MODEL_NAMES.has(model) ? "decisions" : "responses";
}

export interface BotSetup {
	/** The bot seats when the table is first created. */
	readonly seats: readonly Seat[];
}

export interface TableConfig {
	/** One name for each seat in play: seats "1" to "n", 2 ≤ n ≤ 6. */
	readonly names: Readonly<Partial<Record<Seat, string>>>;
	readonly table: TableSetup;
	readonly botSetup?: BotSetup;
}

/** The seats in play, in `SEATS` order. */
export function seatsOf(config: Pick<TableConfig, "names">): Seat[] {
	return SEATS.filter((seat) => config.names[seat] !== undefined);
}

/** The name of a seat in play; an empty text for a seat outside the table. */
export function seatName(
	config: Pick<TableConfig, "names">,
	seat: Seat,
): string {
	return config.names[seat] ?? "";
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

/** Seat names containing "bot" or "robot" are reserved for an automated player. */
export function isBotName(name: string): boolean {
	return /bot|robot/i.test(name);
}

export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseTableConfig(value: unknown): TableConfig | undefined {
	if (!isObject(value) || !isObject(value.names)) return undefined;
	const names: Partial<Record<Seat, string>> = {};
	for (const key of Object.keys(value.names))
		if (!isSeat(key)) return undefined;
	let count = 0;
	for (const seat of SEATS) {
		const name = value.names[seat];
		if (name === undefined) break;
		if (typeof name !== "string" || name.length === 0) return undefined;
		names[seat] = name;
		count += 1;
	}
	if (count < MIN_PLAYERS || Object.keys(value.names).length !== count)
		return undefined;
	const table = parseTableSetup(value.table);
	if (table === undefined) return undefined;
	let botSetup: BotSetup | undefined;
	if (Object.hasOwn(value, "botSetup")) {
		const parsedBotSetup = parseBotSetup(value.botSetup);
		if (
			parsedBotSetup === undefined ||
			!parsedBotSetup.seats.every((seat) => names[seat] !== undefined)
		)
			return undefined;
		botSetup = parsedBotSetup;
	}
	return { names, table, ...(botSetup === undefined ? {} : { botSetup }) };
}

export function parseTableSetup(value: unknown): TableSetup | undefined {
	if (!isObject(value)) return undefined;
	const { preset, jokers, assist } = value;
	if (
		!isTablePreset(preset) ||
		!Number.isSafeInteger(jokers) ||
		(jokers as number) < MIN_JOKERS ||
		(jokers as number) > MAX_JOKERS ||
		typeof assist !== "boolean"
	)
		return undefined;
	return { preset, jokers: jokers as number, assist };
}

export function isTablePreset(value: unknown): value is TablePreset {
	return (
		typeof value === "string" &&
		(TABLE_PRESETS as readonly string[]).includes(value)
	);
}

export function parseBotSetup(value: unknown): BotSetup | undefined {
	if (!isObject(value)) return undefined;
	const { seats } = value;
	if (
		!Array.isArray(seats) ||
		!seats.every(isSeat) ||
		new Set(seats).size !== seats.length
	)
		return undefined;
	return { seats: [...seats] };
}

export interface EventEnvelope {
	readonly tableId: string;
	readonly seq: number;
	readonly commandId: string;
	readonly fromSeat: Seat;
}

/** Envelope fields win over body fields, so a game module cannot forge sender, table or order. */
export function envelopeEvent(
	envelope: EventEnvelope,
	body: JsonObject,
): JsonObject {
	return {
		...body,
		v: PROTOCOL_VERSION,
		tableId: envelope.tableId,
		type: "event",
		seq: envelope.seq,
		commandId: envelope.commandId,
		fromSeat: envelope.fromSeat,
	};
}

export function seatLabel(config: TableConfig, seat: Seat): string {
	return `${SEAT_NAMES[seat]} — ${seatName(config, seat)}`;
}
