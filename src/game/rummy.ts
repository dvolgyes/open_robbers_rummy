import {
	applyCallRecord,
	type CallRecords,
	parseCallRecords,
} from "../call/record";
import { isCommandId } from "../ids";
import {
	isObject as isJsonObject,
	isNonNegativeInteger,
	isSeat,
	type JsonObject,
	PROTOCOL_VERSION,
	type RoomConfig,
	SEAT_NAMES,
	SEATS,
	type Seat,
	seatsOf,
} from "../protocol";
import { cryptoRandomBelow, type RandomBelow } from "../random";
import {
	type Action,
	applyAction as applyHandAction,
	buildDeck,
	type Seat as EngineSeat,
	type HandState,
	type HandView,
	isRulePreset,
	MAX_PLAYERS,
	MIN_PLAYERS,
	newHand,
	type RummyRules,
	rulesFor,
	viewFor,
} from "../rummy";
import { checkMessageText } from "./chat";
import type { ApplyContext, ApplyResult, GameModule } from "./module";

/**
 * One Robber's Rummy table with its chat and call status.
 *
 * The state holds the whole hand: every player's cards and the stock, because the host and any follower that takes
 * over as host need them. A player's own hand is shown only in `viewFor`; the other hands and the stock are hidden in
 * the table screen, not in the replicated state.
 *
 * Commands:
 * - `{type: "chat", text}` and `{type: "media", ...}`: as in every table.
 * - `{type: "start"}`: the host deals a hand. Every seated player must be present. The first dealer is random; each
 *   later game moves the deal to the next seat.
 * - `{type: "action", hand, at, action}`: one step of the current hand, where `hand` is the game number and `at` is
 *   the number of accepted actions before it. A command chosen on an older view of the table is rejected, so a
 *   delayed command never lands in a later position. Every seated player must be present.
 * - `{type: "reset-request"}`, `{type: "reset-vote", requestId, approve}` and `{type: "reset-cancel", requestId}`:
 *   a reset ends the game once every other present player approves it. The host then deals a new game. While a
 *   reset waits for answers, the game is blocked. After a hand is over, the "New game" button sends the same request.
 *
 * A game is one hand: the first player who empties the hand wins, and the others count the penalty of their cards.
 */

export type RummyState = {
	readonly v: typeof PROTOCOL_VERSION;
	readonly roomId: string;
	readonly game: "rummy";
	readonly messages: number;
	readonly match: RummyMatch | null;
	/** Games started at this table. The host keys its start command by this count. */
	readonly matches: number;
	/** The dealer of the last game, so the next game is dealt by the next seat; null before the first game. */
	readonly lastDealer: EngineSeat | null;
	/** Accepted actions in the current hand. */
	readonly actions: number;
	/** A reset request that waits for answers. */
	readonly reset: ResetRequest | null;
	/** Each seat's latest call status. */
	readonly media: CallRecords;
};

export interface RummyMatch {
	/** The game number: the value of `matches` when the game was dealt. */
	readonly handNo: number;
	readonly hand: HandState;
}

/** A request to end the game and deal a new one. Every seat in `required` must approve it. */
export interface ResetRequest {
	readonly id: string;
	readonly requester: Seat;
	readonly required: readonly Seat[];
	readonly approved: readonly Seat[];
}

/** The table's rules; every peer reads them from the room configuration. */
export function rulesOf(config: RoomConfig): RummyRules {
	return rulesFor(
		config.table.preset,
		config.table.jokers,
		config.table.assist,
	);
}

/** Engine seats are numbered from 0 in the order of `SEATS`. */
export function engineSeat(seat: Seat): EngineSeat {
	return SEATS.indexOf(seat);
}

export function tableSeat(seat: EngineSeat): Seat {
	const found = SEATS[seat];
	if (found === undefined) throw new Error(`no seat ${seat}`);
	return found;
}

const TABLE_COMMANDS: readonly unknown[] = ["start", "action"];

/** A play lists every table meld; two full decks and six jokers make at most this many melds. */
const MAX_PLAY_MELDS = 40;

function reject(reason: string): ApplyResult {
	return { ok: false, reason };
}

function accept(event: JsonObject, state: RummyState): ApplyResult {
	return { ok: true, event, state };
}

/**
 * "Waiting for East, South and West to come back" when seats are not present; undefined when all are.
 * The table screen shows the same text before the host would refuse the command.
 */
export function waitingText(
	needed: readonly Seat[],
	present: readonly Seat[],
): string | undefined {
	const names = needed
		.filter((seat) => !present.includes(seat))
		.map((seat) => SEAT_NAMES[seat]);
	const last = names.pop();
	if (last === undefined) return undefined;
	const list = names.length > 0 ? `${names.join(", ")} and ${last}` : last;
	return `Waiting for ${list} to come back`;
}

function absence(
	needed: readonly Seat[],
	present: readonly Seat[],
): ApplyResult | undefined {
	const reason = waitingText(needed, present);
	return reason === undefined
		? undefined
		: { ok: false, reason, waiting: true };
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function isIdList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((id) => typeof id === "string");
}

function parseRules(value: unknown): RummyRules | undefined {
	if (!isJsonObject(value)) return undefined;
	const { preset, jokers, assist } = value;
	if (!isRulePreset(preset) || typeof assist !== "boolean") return undefined;
	if (!Number.isInteger(jokers)) return undefined;
	let rules: RummyRules;
	try {
		rules = rulesFor(preset, jokers as number, assist);
	} catch {
		return undefined;
	}
	return sameJson(value, rules) ? rules : undefined;
}

function isSeatIndex(value: unknown, players: number): value is EngineSeat {
	return (
		Number.isInteger(value) &&
		(value as number) >= 0 &&
		(value as number) < players
	);
}

function parseOutcome(value: unknown, players: number): boolean {
	if (value === null) return true;
	if (!isJsonObject(value)) return false;
	if (value.kind === "blocked") return true;
	return value.kind === "out" && isSeatIndex(value.seat, players);
}

/** The engine's hand fields, checked for shape and for one card of each in the deck of its rules. */
function parseHand(value: unknown): HandState | undefined {
	if (!isJsonObject(value)) return undefined;
	const {
		rules,
		players,
		dealer,
		turn,
		phase,
		hands,
		stock,
		table,
		opened,
		lastPlay,
		passes,
		nextMeldNo,
		outcome,
	} = value;
	const parsedRules = parseRules(rules);
	if (parsedRules === undefined) return undefined;
	if (
		!Number.isInteger(players) ||
		(players as number) < MIN_PLAYERS ||
		(players as number) > MAX_PLAYERS
	)
		return undefined;
	const count = players as number;
	if (!isSeatIndex(dealer, count) || !isSeatIndex(turn, count))
		return undefined;
	if (phase !== "start" && phase !== "played" && phase !== "drew")
		return undefined;
	if (!Array.isArray(hands) || hands.length !== count || !hands.every(isIdList))
		return undefined;
	if (!isIdList(stock)) return undefined;
	if (!Array.isArray(table)) return undefined;
	const meldIds = new Set<string>();
	for (const meld of table) {
		if (!isJsonObject(meld) || typeof meld.id !== "string") return undefined;
		if (!isIdList(meld.cards) || meld.cards.length === 0) return undefined;
		if (meldIds.has(meld.id)) return undefined;
		meldIds.add(meld.id);
	}
	if (
		!Array.isArray(opened) ||
		opened.length !== count ||
		!opened.every((open) => typeof open === "boolean")
	)
		return undefined;
	if (lastPlay !== null) {
		if (!isJsonObject(lastPlay) || !isSeatIndex(lastPlay.seat, count))
			return undefined;
		if (!isIdList(lastPlay.cards) || !isIdList(lastPlay.meldIds))
			return undefined;
	}
	if (!isNonNegativeInteger(passes) || passes > count) return undefined;
	if (!isNonNegativeInteger(nextMeldNo)) return undefined;
	if (!parseOutcome(outcome, count)) return undefined;
	const everyCard = [
		...(hands as string[][]).flat(),
		...stock,
		...(table as { cards: string[] }[]).flatMap((meld) => meld.cards),
	];
	const deck = buildDeck(parsedRules.jokers).map((card) => card.id);
	const deckIds = new Set(deck);
	const distinct = new Set(everyCard);
	if (everyCard.length !== deck.length || distinct.size !== deck.length)
		return undefined;
	if (!everyCard.every((id) => deckIds.has(id))) return undefined;
	return value as unknown as HandState;
}

function parseMatch(value: unknown): RummyMatch | undefined {
	if (!isJsonObject(value)) return undefined;
	const { handNo, hand } = value;
	if (!isNonNegativeInteger(handNo)) return undefined;
	const parsedHand = parseHand(hand);
	if (parsedHand === undefined) return undefined;
	return { handNo, hand: parsedHand };
}

function isSeatList(value: unknown): value is Seat[] {
	return (
		Array.isArray(value) &&
		value.every(isSeat) &&
		new Set(value).size === value.length
	);
}

function parseResetRequest(value: unknown): ResetRequest | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isJsonObject(value)) return undefined;
	const { id, requester, required, approved } = value;
	if (!isCommandId(id) || !isSeat(requester)) return undefined;
	if (!isSeatList(required) || required.length === 0) return undefined;
	if (required.includes(requester) || !isSeatList(approved)) return undefined;
	if (!approved.every((seat) => required.includes(seat))) return undefined;
	if (approved.length === required.length) return undefined;
	return { id, requester, required, approved };
}

/** Returns the table state, or undefined when the value is not a rummy table of this room. */
export function parseRummyState(
	value: unknown,
	roomId: string,
): RummyState | undefined {
	if (!isJsonObject(value)) return undefined;
	const {
		v,
		game,
		messages,
		matches,
		match,
		lastDealer,
		actions,
		reset,
		media,
	} = value;
	if (v !== PROTOCOL_VERSION || game !== "rummy") return undefined;
	if (value.roomId !== roomId) return undefined;
	if (!isNonNegativeInteger(messages) || !isNonNegativeInteger(actions))
		return undefined;
	if (!isNonNegativeInteger(matches)) return undefined;
	if (lastDealer !== null && !isSeatIndex(lastDealer, MAX_PLAYERS))
		return undefined;
	const parsedMatch = match === null ? null : parseMatch(match);
	if (parsedMatch === undefined) return undefined;
	const parsedReset = parseResetRequest(reset);
	if (parsedReset === undefined) return undefined;
	if (parsedReset !== null && parsedMatch === null) return undefined;
	const parsedMedia = parseCallRecords(media);
	if (parsedMedia === undefined) return undefined;
	return {
		v: PROTOCOL_VERSION,
		roomId,
		game: "rummy",
		messages,
		matches,
		match: parsedMatch,
		lastDealer,
		actions,
		reset: parsedReset,
		media: parsedMedia,
	};
}

export function parseAction(value: unknown): Action | undefined {
	if (!isJsonObject(value)) return undefined;
	switch (value.type) {
		case "draw":
		case "end":
		case "pass":
			return { type: value.type };
		case "play": {
			const { melds } = value;
			if (
				!Array.isArray(melds) ||
				melds.length > MAX_PLAY_MELDS ||
				!melds.every(isIdList)
			)
				return undefined;
			return { type: "play", melds };
		}
		default:
			return undefined;
	}
}

function applyStart(
	table: RummyState,
	context: ApplyContext,
	randomBelow: RandomBelow,
): ApplyResult {
	if (table.match !== null && table.match.hand.outcome === null)
		return reject("the game has already started");
	if (table.match !== null)
		return reject("the game is over; ask for a new game");
	if (table.reset) return RESET_WAITING;
	const seats = seatsOf(context.config);
	const waiting = absence(seats, context.present);
	if (waiting) return waiting;
	const players = seats.length;
	const dealer =
		table.lastDealer === null
			? randomBelow(players)
			: (table.lastDealer + 1) % players;
	const seed = randomBelow(2 ** 32);
	const hand = newHand({
		rules: rulesOf(context.config),
		players,
		dealer,
		seed,
	});
	const handNo = table.matches + 1;
	return accept(
		{ kind: "start", handNo },
		{
			...table,
			matches: handNo,
			match: { handNo, hand },
			lastDealer: dealer,
			actions: 0,
		},
	);
}

function applyTableAction(
	table: RummyState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const match = table.match;
	if (match === null) return reject("the game has not started");
	if (table.reset) return RESET_WAITING;
	if (match.hand.outcome !== null) return reject("this game is over");
	if (payload.hand !== match.handNo || payload.at !== table.actions)
		return reject("the table has moved on since this action was chosen");
	const action = parseAction(payload.action);
	if (!action) return reject("not a valid action");
	const applied = applyHandAction(match.hand, engineSeat(context.seat), action);
	if (!applied.ok) return reject(applied.reason);
	const waiting = absence(seatsOf(context.config), context.present);
	if (waiting) return waiting;
	return accept(
		{
			kind: "action",
			handNo: match.handNo,
			action: action as unknown as JsonObject,
		},
		{
			...table,
			match: { ...match, hand: applied.hand },
			actions: table.actions + 1,
		},
	);
}

const RESET_WAITING: ApplyResult = {
	ok: false,
	reason: "a reset request is waiting for answers",
};

/** Ends the game; the chat, the call status and the last dealer stay. */
function resetMatch(table: RummyState): RummyState {
	return { ...table, match: null, actions: 0, reset: null };
}

function applyResetRequest(
	table: RummyState,
	context: ApplyContext,
): ApplyResult {
	if (table.reset) return RESET_WAITING;
	if (table.match === null) return reject("the game has not started");
	const present = [...new Set(context.present)];
	if (!present.includes(context.seat))
		return reject("your seat is not present at the table");
	const required = seatsOf(context.config).filter(
		(seat) => seat !== context.seat && present.includes(seat),
	);
	if (required.length === 0)
		return accept(
			{ kind: "reset-applied", requester: context.seat },
			resetMatch(table),
		);
	const reset: ResetRequest = {
		id: context.commandId,
		requester: context.seat,
		required,
		approved: [],
	};
	return accept(
		{ kind: "reset-requested", requester: context.seat, required },
		{ ...table, reset },
	);
}

function applyResetVote(
	table: RummyState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const pending = table.reset;
	if (!pending || payload.requestId !== pending.id)
		return reject("there is no matching reset request");
	if (!pending.required.includes(context.seat))
		return reject("your seat is not asked to approve this reset");
	if (typeof payload.approve !== "boolean")
		return reject("reset decision must accept or reject");
	if (pending.approved.includes(context.seat))
		return reject("your seat has already approved this reset");
	if (!payload.approve)
		return accept(
			{ kind: "reset-rejected", by: context.seat },
			{ ...table, reset: null },
		);
	const approved = [...pending.approved, context.seat];
	if (pending.required.every((seat) => approved.includes(seat)))
		return accept(
			{ kind: "reset-applied", requester: pending.requester },
			resetMatch(table),
		);
	return accept(
		{ kind: "reset-approved", by: context.seat },
		{ ...table, reset: { ...pending, approved } },
	);
}

function applyResetCancel(
	table: RummyState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const pending = table.reset;
	if (!pending || payload.requestId !== pending.id)
		return reject("there is no matching reset request");
	if (pending.requester !== context.seat)
		return reject("only the requester can cancel this reset");
	return accept({ kind: "reset-cancelled" }, { ...table, reset: null });
}

function applyChat(
	table: RummyState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const check = checkMessageText(payload.text);
	if (!check.ok) return check;
	return accept(
		{ fromName: context.config.names[context.seat], text: check.text },
		{ ...table, messages: table.messages + 1 },
	);
}

function applyMedia(
	table: RummyState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const applied = applyCallRecord(
		table.media,
		context.seat,
		context.holder,
		payload,
	);
	if (!applied.ok) return reject(applied.reason);
	return accept(
		{ kind: "media", seat: context.seat, version: applied.record.version },
		{ ...table, media: applied.records },
	);
}

export function createRummyModule(randomBelow: RandomBelow): GameModule {
	return {
		initialState(roomId) {
			const state: RummyState = {
				v: PROTOCOL_VERSION,
				roomId,
				game: "rummy",
				messages: 0,
				matches: 0,
				match: null,
				lastDealer: null,
				actions: 0,
				reset: null,
				media: {},
			};
			return state as unknown as JsonObject;
		},

		isState(state, roomId) {
			return parseRummyState(state, roomId) !== undefined;
		},

		apply(state, context, payload) {
			const table = parseRummyState(state, context.roomId);
			if (!table) return reject("room state is not a rummy table");
			if (!isJsonObject(payload)) return reject("command is not an object");
			if (payload.v !== PROTOCOL_VERSION)
				return reject("unsupported protocol version");
			if (payload.roomId !== context.roomId)
				return reject("command is for another room");
			if (!seatsOf(context.config).includes(context.seat))
				return reject("your seat does not play at this table");
			switch (payload.type) {
				case "chat":
					return applyChat(table, context, payload);
				case "media":
					return applyMedia(table, context, payload);
				case "start":
					return applyStart(table, context, randomBelow);
				case "action":
					return applyTableAction(table, context, payload);
				case "reset-request":
					return applyResetRequest(table, context);
				case "reset-vote":
					return applyResetVote(table, context, payload);
				case "reset-cancel":
					return applyResetCancel(table, context, payload);
				default:
					return reject("unknown command type");
			}
		},
		isRandomCommand(payload) {
			return isJsonObject(payload) && payload.type === "start";
		},
	};
}

export const rummyModule: GameModule = createRummyModule(cryptoRandomBelow);

export function startPayload(roomId: string): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "start" };
}

/** An action at the current position of `match`. */
export function actionPayload(
	roomId: string,
	match: RummyMatch,
	accepted: number,
	action: Action,
): JsonObject {
	return {
		v: PROTOCOL_VERSION,
		roomId,
		type: "action",
		hand: match.handNo,
		at: accepted,
		action: action as unknown as JsonObject,
	};
}

export function resetRequestPayload(roomId: string): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "reset-request" };
}

export function resetVotePayload(
	roomId: string,
	requestId: string,
	approve: boolean,
): JsonObject {
	return {
		v: PROTOCOL_VERSION,
		roomId,
		type: "reset-vote",
		requestId,
		approve,
	};
}

export function resetCancelPayload(
	roomId: string,
	requestId: string,
): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "reset-cancel", requestId };
}

/** Start and action commands, as opposed to chat and call status. */
export function isTableCommand(payload: unknown): boolean {
	return isJsonObject(payload) && TABLE_COMMANDS.includes(payload.type);
}

/** The hand from one seat's point of view, for the table screen. */
export function handViewFor(match: RummyMatch, seat: Seat): HandView {
	return viewFor(match.hand, engineSeat(seat));
}
