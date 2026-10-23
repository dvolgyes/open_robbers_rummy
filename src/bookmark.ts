import {
	type BotSetup,
	isSeat,
	isTablePreset,
	MAX_JOKERS,
	MAX_NAME_LENGTH,
	MIN_JOKERS,
	MIN_PLAYERS,
	SEATS,
	type Seat,
	seatsOf,
	type TableConfig,
	type TableSetup,
} from "./protocol";

export const SELECTED_PLAYER_PARAM = "selected_player";
/** In the host's own URL: its bots are paused, so a reload does not start them. */
export const BOTS_PAUSED_PARAM = "bots_paused";

/**
 * Query keys of the six seats, as in `?p1=zsdh&p2=dvolgyes`. The `host` key names the seat of the creator. The query
 * never carries the table key: that stays in the fragment.
 */
export const SEAT_PARAM: Readonly<Record<Seat, string>> = {
	"1": "p1",
	"2": "p2",
	"3": "p3",
	"4": "p4",
	"5": "p5",
	"6": "p6",
};

const RULE_PARAMS = ["rules", "jokers", "assist", "bot_seats", "host"] as const;

export interface Bookmark {
	/** Prefilled names; a seat is absent when its value is missing, empty, or too long. */
	readonly names: Partial<Record<Seat, string>>;
	/** The seat the creator takes; absent when the value is missing or unknown. */
	readonly host?: Seat;
	/** Prefilled table rules; a value is absent when it is missing or invalid. */
	readonly table: Partial<TableSetup>;
	readonly botSetup?: BotSetup;
}

export interface LinkSetup {
	readonly config: TableConfig;
	readonly host: Seat;
}

/**
 * Reads a bookmark from a query string. The values come from the address bar, so they are untrusted: each name is
 * trimmed and length-checked, each seat must be one of the six, and each rule value must be valid. Anything else is
 * ignored, not an error.
 */
export function parseBookmark(search: string): Bookmark {
	const params = new URLSearchParams(search);
	const names: Partial<Record<Seat, string>> = {};
	for (const seat of SEATS) {
		const name = (params.get(SEAT_PARAM[seat]) ?? "").trim();
		if (name !== "" && Array.from(name).length <= MAX_NAME_LENGTH)
			names[seat] = name;
	}
	const host = params.get("host");
	const botSetup = parseBotSeats(params.get("bot_seats"));
	return {
		names,
		...(isSeat(host) ? { host } : {}),
		table: parseTableParams(params),
		...(botSetup === undefined ? {} : { botSetup }),
	};
}

/**
 * Reads the complete setup needed to start a table from a shared link. It fails closed: a seat gap, fewer than two
 * players, a host or bot outside the table, a missing or invalid rule value, or a repeated key gives `undefined`.
 */
export function parseLinkSetup(search: string): LinkSetup | undefined {
	const params = new URLSearchParams(search);
	if (
		[...RULE_PARAMS, ...SEATS.map((seat) => SEAT_PARAM[seat])].some(
			(name) => params.getAll(name).length > 1,
		)
	)
		return undefined;
	const bookmark = parseBookmark(search);
	const names: Partial<Record<Seat, string>> = {};
	let gap = false;
	for (const seat of SEATS) {
		const name = bookmark.names[seat];
		if (name === undefined) {
			if (params.has(SEAT_PARAM[seat])) return undefined;
			gap = true;
		} else if (gap) return undefined;
		else names[seat] = name;
	}
	const seats = seatsOf({ names });
	const { preset, jokers, assist } = bookmark.table;
	const host = bookmark.host;
	if (
		seats.length < MIN_PLAYERS ||
		host === undefined ||
		!seats.includes(host) ||
		preset === undefined ||
		jokers === undefined ||
		assist === undefined
	)
		return undefined;
	const botSetup = bookmark.botSetup;
	if (params.has("bot_seats") && botSetup === undefined) return undefined;
	if (
		botSetup !== undefined &&
		!botSetup.seats.every((seat) => seats.includes(seat))
	)
		return undefined;
	return {
		config: {
			names,
			table: { preset, jokers, assist },
			...(botSetup === undefined ? {} : { botSetup }),
		},
		host,
	};
}

/** The bot seats of a `bot_seats` value such as `2,5`; undefined when absent or invalid. */
function parseBotSeats(value: string | null): BotSetup | undefined {
	if (value === null) return undefined;
	const seats = value === "" ? [] : value.split(",");
	if (!seats.every(isSeat) || new Set(seats).size !== seats.length)
		return undefined;
	return { seats: SEATS.filter((seat) => seats.includes(seat)) };
}

function parseTableParams(params: URLSearchParams): Partial<TableSetup> {
	const preset = params.get("rules");
	const jokersText = params.get("jokers") ?? "";
	const jokers = /^\d$/.test(jokersText) ? Number(jokersText) : Number.NaN;
	const assist = params.get("assist");
	return {
		...(isTablePreset(preset) ? { preset } : {}),
		...(jokers >= MIN_JOKERS && jokers <= MAX_JOKERS ? { jokers } : {}),
		...(assist === "1" || assist === "0" ? { assist: assist === "1" } : {}),
	};
}

/** Reads an explicit seat choice from a table URL. Invalid or repeated values are ignored. */
export function parseSelectedPlayer(search: string): Seat | undefined {
	const params = new URLSearchParams(search);
	const values = params.getAll(SELECTED_PLAYER_PARAM);
	if (values.length !== 1 || !isSeat(values[0])) return undefined;
	return values[0];
}

/** Adds the selected seat to the current query while preserving other table or bookmark values. */
export function selectedPlayerQuery(search: string, seat: Seat): string {
	const params = new URLSearchParams(search);
	params.set(SELECTED_PLAYER_PARAM, seat);
	return params.toString();
}

/** Replaces the bot-seat snapshot in a table URL while preserving player, model, and selection parameters. */
export function botSeatsQuery(search: string, bots: readonly Seat[]): string {
	const params = new URLSearchParams(search);
	const selected = new Set(bots);
	params.set("bot_seats", SEATS.filter((seat) => selected.has(seat)).join(","));
	return params.toString();
}

/** Reads whether the host's bots were paused before this page loaded. */
export function parseBotsPaused(search: string): boolean {
	return new URLSearchParams(search).get(BOTS_PAUSED_PARAM) === "1";
}

/** Sets or removes the paused-bots mark while preserving the other values. */
export function botsPausedQuery(search: string, paused: boolean): string {
	const params = new URLSearchParams(search);
	if (paused) params.set(BOTS_PAUSED_PARAM, "1");
	else params.delete(BOTS_PAUSED_PARAM);
	return params.toString();
}

/** The query of a bookmark for a table: the names, the creator's seat, the table rules and the bot seats. */
export function bookmarkQuery(config: TableConfig, host: Seat): string {
	const pairs = seatsOf(config).map((seat): [string, string] => [
		SEAT_PARAM[seat],
		config.names[seat] ?? "",
	]);
	pairs.push(
		["host", host],
		["rules", config.table.preset],
		["jokers", String(config.table.jokers)],
		["assist", config.table.assist ? "1" : "0"],
	);
	if (config.botSetup !== undefined)
		pairs.push(["bot_seats", config.botSetup.seats.join(",")]);
	return new URLSearchParams(pairs).toString();
}
