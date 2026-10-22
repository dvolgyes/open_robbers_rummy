import {
	BOT_MODELS,
	type BotModel,
	type BotSetup,
	DEFAULT_BOT_SETUP,
	isSeat,
	MAX_NAME_LENGTH,
	parseBotSetup,
	type RoomConfig,
	SEATS,
	type Seat,
} from "./protocol";

export const SELECTED_PLAYER_PARAM = "selected_player";

/**
 * Query keys of the four seats, named by direction as in `?east=zsdh&west=dvolgyes`. The `host` key names the
 * seat of the creator. The query never carries the table key: that stays in the fragment.
 */
export const SEAT_PARAM: Readonly<Record<Seat, string>> = {
	N: "north",
	E: "east",
	S: "south",
	W: "west",
};

export interface Bookmark {
	/** Prefilled names; a seat is absent when its value is missing, empty, or too long. */
	readonly names: Partial<Record<Seat, string>>;
	/** The seat the creator takes; absent when the value is missing or unknown. */
	readonly host?: Seat;
	readonly botSetup?: BotSetup;
}

export interface RoomSetup {
	readonly config: RoomConfig;
	readonly host: Seat;
}

/**
 * Reads a bookmark from a query string. The values come from the address bar, so they are untrusted: each name is
 * trimmed and length-checked, and each seat must be one of the four. Anything else is ignored, not an error.
 */
export function parseBookmark(search: string): Bookmark {
	const params = new URLSearchParams(search);
	const names: Partial<Record<Seat, string>> = {};
	for (const seat of SEATS) {
		const name = (params.get(SEAT_PARAM[seat]) ?? "").trim();
		if (name !== "" && Array.from(name).length <= MAX_NAME_LENGTH)
			names[seat] = name;
	}
	const host = SEATS.find((seat) => SEAT_PARAM[seat] === params.get("host"));
	const botSetup = parseBotSetupParams(params);
	return {
		names,
		...(host === undefined ? {} : { host }),
		...(botSetup === undefined ? {} : { botSetup }),
	};
}

/** Reads the complete setup needed to start a room from a shared link. */
export function parseRoomSetup(search: string): RoomSetup | undefined {
	const bookmark = parseBookmark(search);
	if (bookmark.host === undefined) return undefined;
	const names = {} as Record<Seat, string>;
	for (const seat of SEATS) {
		const name = bookmark.names[seat];
		if (name === undefined) return undefined;
		names[seat] = name;
	}
	const botSetup = bookmark.botSetup;
	const params = new URLSearchParams(search);
	if (hasBotSetupParams(params) && bookmark.botSetup === undefined)
		return undefined;
	return {
		config: {
			names,
			...(botSetup === undefined ? {} : { botSetup }),
		},
		host: bookmark.host,
	};
}

/** Reads an explicit seat choice from a room URL. Invalid or repeated values are ignored. */
export function parseSelectedPlayer(search: string): Seat | undefined {
	const params = new URLSearchParams(search);
	const values = params.getAll(SELECTED_PLAYER_PARAM);
	if (values.length !== 1 || !isSeat(values[0])) return undefined;
	return values[0];
}

/** Adds the selected seat to the current query while preserving other room or bookmark values. */
export function selectedPlayerQuery(search: string, seat: Seat): string {
	const params = new URLSearchParams(search);
	params.set(SELECTED_PLAYER_PARAM, seat);
	return params.toString();
}

/** Replaces the bot-seat snapshot in a room URL while preserving player, model, and selection parameters. */
export function botSeatsQuery(search: string, bots: readonly Seat[]): string {
	const params = new URLSearchParams(search);
	const selected = new Set(bots);
	params.set("bot_seats", SEATS.filter((seat) => selected.has(seat)).join(","));
	return params.toString();
}

/** The query of a bookmark for a table: the four names and the creator's seat. */
export function bookmarkQuery(
	names: Readonly<Record<Seat, string>>,
	host: Seat,
	botSetup?: BotSetup,
): string {
	const pairs = SEATS.map((seat): [string, string] => [
		SEAT_PARAM[seat],
		names[seat],
	]);
	pairs.push(["host", SEAT_PARAM[host]]);
	if (botSetup !== undefined) {
		pairs.push(
			["bot_seats", botSetup.seats.join(",")],
			["bot_model", botSetup.model],
			["bot_fallback", botSetup.fallbackModel],
			["bot_retries", String(botSetup.retries)],
			["bot_delay_ms", String(botSetup.retryDelayMs)],
		);
		if (botSetup.modelOrder !== undefined)
			pairs.push(["bot_models", botSetup.modelOrder.join(",")]);
	}
	return new URLSearchParams(pairs).toString();
}

const BOT_SETUP_PARAMS = [
	"bot_seats",
	"bot_model",
	"bot_fallback",
	"bot_models",
	"bot_retries",
	"bot_delay_ms",
] as const;

function hasBotSetupParams(params: URLSearchParams): boolean {
	return BOT_SETUP_PARAMS.some((name) => params.has(name));
}

function parseBotSetupParams(params: URLSearchParams): BotSetup | undefined {
	if (!hasBotSetupParams(params)) return undefined;
	if (BOT_SETUP_PARAMS.some((name) => params.getAll(name).length > 1))
		return undefined;
	const seatsText = params.get("bot_seats");
	const seats =
		seatsText === null || seatsText === ""
			? []
			: seatsText.split(",").map((value) => value.toUpperCase());
	const seatList = SEATS.filter((seat) => seats.includes(seat));
	if (seatList.length !== seats.length) return undefined;
	const retries = parseIntegerParam(
		params.get("bot_retries"),
		DEFAULT_BOT_SETUP.retries,
	);
	const retryDelayMs = parseIntegerParam(
		params.get("bot_delay_ms"),
		DEFAULT_BOT_SETUP.retryDelayMs,
	);
	if (retries === undefined || retryDelayMs === undefined) return undefined;
	const modelOrder = params.has("bot_models")
		? parseModelOrder(params.get("bot_models"))
		: undefined;
	if (params.has("bot_models") && modelOrder === undefined) return undefined;
	return parseBotSetup({
		seats: seatList,
		model: params.get("bot_model") ?? DEFAULT_BOT_SETUP.model,
		fallbackModel:
			params.get("bot_fallback") ?? DEFAULT_BOT_SETUP.fallbackModel,
		...(modelOrder === undefined ? {} : { modelOrder }),
		retries,
		retryDelayMs,
	});
}

function parseModelOrder(value: string | null): BotModel[] | undefined {
	if (value === null) return undefined;
	const models = value.split(",");
	return models.length >= 2 &&
		models.length <= BOT_MODELS.length &&
		new Set(models).size === models.length
		? (models as BotModel[])
		: undefined;
}

function parseIntegerParam(
	value: string | null,
	fallback: number,
): number | undefined {
	if (value === null) return fallback;
	if (!/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}
