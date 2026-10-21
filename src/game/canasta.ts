import {
	applyCallRecord,
	type CallRecords,
	parseCallRecords,
} from "../call/record";
import {
	type Action,
	applyAction as applyHandAction,
	buildDecks,
	type Card,
	CLASSIC_RULES,
	type Seat as EngineSeat,
	type HandState,
	type MatchState,
	nextHand,
	settleHand,
	startMatch,
	viewFor,
} from "../canasta";
import {
	isObject as isJsonObject,
	isNonNegativeInteger,
	type JsonObject,
	PROTOCOL_VERSION,
	SEAT_NAMES,
	SEATS,
	type Seat,
} from "../protocol";
import { cryptoRandomBelow, type RandomBelow } from "../random";
import { checkMessageText } from "./chat";
import type { ApplyContext, ApplyResult, GameModule } from "./module";

/**
 * One classic four-player partnership canasta table with its chat and call status.
 *
 * The state holds the whole match: every hand's cards, the stock and the pile, because the host and any
 * follower that takes over as host need them. A player's own hand is shown only in `viewFor`; the other
 * hands and the stock are hidden in the table screen, not in the replicated state.
 *
 * Commands:
 * - `{type: "chat", text}` and `{type: "media", ...}`: as in every table.
 * - `{type: "start"}`: the host deals the first hand. All four seats must be present.
 * - `{type: "action", hand, at, action}`: one step of the current hand, where `hand` is the hand number and
 *   `at` is the number of accepted actions before it. A command chosen on an older view of the table is
 *   rejected, so a delayed command never lands in a later position. All four seats must be present.
 * - `{type: "next-hand"}`: after a hand is settled, deals the next one. All four seats must be present.
 *
 * When a hand ends, the host settles its score in the same command, so the table never shows an unsettled
 * finished hand.
 */

export type CanastaState = {
	readonly v: typeof PROTOCOL_VERSION;
	readonly roomId: string;
	readonly game: "canasta";
	readonly messages: number;
	readonly match: MatchState | null;
	/** Accepted actions in the current hand. */
	readonly actions: number;
	/** Each seat's latest call status. */
	readonly media: CallRecords;
};

/** Engine seats are numbered 0 to 3 in the order of `SEATS`, so partners N-S and E-W share a team. */
export function engineSeat(seat: Seat): EngineSeat {
	return SEATS.indexOf(seat) as EngineSeat;
}

export function tableSeat(seat: EngineSeat): Seat {
	const found = SEATS[seat];
	if (found === undefined) throw new Error(`no seat ${seat}`);
	return found;
}

const CARDS_BY_ID: ReadonlyMap<string, Card> = new Map(
	buildDecks().map((card) => [card.id, card]),
);

const TABLE_COMMANDS: readonly unknown[] = ["start", "action", "next-hand"];

const ACTION_TYPES: readonly unknown[] = [
	"draw",
	"takePile",
	"meld",
	"extend",
	"discard",
	"resetTurn",
];

function reject(reason: string): ApplyResult {
	return { ok: false, reason };
}

function accept(event: JsonObject, state: CanastaState): ApplyResult {
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

function parseCard(value: unknown): Card | undefined {
	if (!isJsonObject(value) || typeof value.id !== "string") return undefined;
	const card = CARDS_BY_ID.get(value.id);
	if (card === undefined) return undefined;
	return value.rank === card.rank && value.suit === card.suit
		? card
		: undefined;
}

function parseCards(value: unknown): Card[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const cards: Card[] = [];
	for (const item of value) {
		const card = parseCard(item);
		if (card === undefined) return undefined;
		cards.push(card);
	}
	return cards;
}

function isEngineSeat(value: unknown): value is EngineSeat {
	return value === 0 || value === 1 || value === 2 || value === 3;
}

/** The engine's hand fields, checked for shape and for one card of each of the 108. */
function parseHand(value: unknown): HandState | undefined {
	if (!isJsonObject(value)) return undefined;
	const { hands, stock, pile, teams, turn, dealer, phase, turnStart } = value;
	if (!Array.isArray(hands) || hands.length !== 4) return undefined;
	const handCards = hands.map(parseCards);
	const stockCards = parseCards(stock);
	const pileCards = parseCards(pile);
	if (handCards.some((cards) => cards === undefined)) return undefined;
	if (stockCards === undefined || pileCards === undefined) return undefined;
	if (!isEngineSeat(turn) || !isEngineSeat(dealer)) return undefined;
	if (phase !== "draw" && phase !== "play") return undefined;
	if (!Array.isArray(teams) || teams.length !== 2) return undefined;
	if (!isJsonObject(turnStart)) return undefined;
	const everyCard = [
		...handCards.flatMap((cards) => cards ?? []),
		...stockCards,
		...pileCards,
		...teams.flatMap((team) => {
			if (!isJsonObject(team) || !Array.isArray(team.redThrees)) return [];
			const red = parseCards(team.redThrees) ?? [];
			const melds = Array.isArray(team.melds) ? team.melds : [];
			const meldCards = melds.flatMap((meld) =>
				isJsonObject(meld) ? (parseCards(meld.cards) ?? []) : [],
			);
			return [...red, ...meldCards];
		}),
	];
	const distinct = new Set(everyCard.map((card) => card.id));
	if (everyCard.length !== 108 || distinct.size !== 108) return undefined;
	return value as unknown as HandState;
}

function parseMatch(value: unknown): MatchState | undefined {
	if (!isJsonObject(value)) return undefined;
	const { rules, seed, handNo, dealer, scores, hand, settled, winner } = value;
	if (!sameJson(rules, CLASSIC_RULES)) return undefined;
	if (!isNonNegativeInteger(seed) || !isNonNegativeInteger(handNo))
		return undefined;
	if (!isEngineSeat(dealer)) return undefined;
	if (!Array.isArray(scores) || scores.length !== 2) return undefined;
	if (!scores.every((score) => typeof score === "number")) return undefined;
	if (typeof settled !== "boolean") return undefined;
	if (winner !== null && winner !== 0 && winner !== 1) return undefined;
	const parsedHand = parseHand(hand);
	if (parsedHand === undefined) return undefined;
	return value as unknown as MatchState;
}

/** Returns the table state, or undefined when the value is not a canasta table of this room. */
export function parseCanastaState(
	value: unknown,
	roomId: string,
): CanastaState | undefined {
	if (!isJsonObject(value)) return undefined;
	const { v, game, messages, match, actions, media } = value;
	if (v !== PROTOCOL_VERSION || game !== "canasta") return undefined;
	if (value.roomId !== roomId) return undefined;
	if (!isNonNegativeInteger(messages) || !isNonNegativeInteger(actions))
		return undefined;
	const parsedMatch = match === null ? null : parseMatch(match);
	if (parsedMatch === undefined) return undefined;
	const parsedMedia = parseCallRecords(media);
	if (parsedMedia === undefined) return undefined;
	return {
		v: PROTOCOL_VERSION,
		roomId,
		game: "canasta",
		messages,
		match: parsedMatch,
		actions,
		media: parsedMedia,
	};
}

export function parseAction(value: unknown): Action | undefined {
	if (!isJsonObject(value)) return undefined;
	const { type } = value;
	if (!ACTION_TYPES.includes(type)) return undefined;
	const strings = (list: unknown): string[] | undefined =>
		Array.isArray(list) && list.every((id) => typeof id === "string")
			? (list as string[])
			: undefined;
	switch (type) {
		case "draw":
			return { type };
		case "resetTurn":
			return { type };
		case "takePile": {
			const cards = strings(value.cards);
			if (cards === undefined) return undefined;
			if (value.extend === undefined) return { type, cards };
			return typeof value.extend === "string"
				? { type, cards, extend: value.extend }
				: undefined;
		}
		case "meld": {
			const cards = strings(value.cards);
			return cards === undefined ? undefined : { type, cards };
		}
		case "extend": {
			const cards = strings(value.cards);
			return cards === undefined || typeof value.meldId !== "string"
				? undefined
				: { type, meldId: value.meldId, cards };
		}
		case "discard":
			return typeof value.card === "string"
				? { type, card: value.card }
				: undefined;
		default:
			return undefined;
	}
}

/** Settles a hand that just ended, so the score is added in the same command. */
function settleIfOver(match: MatchState): MatchState {
	if (match.hand.outcome === null) return match;
	const settled = settleHand(match);
	return settled.ok ? settled.match : match;
}

function applyStart(
	table: CanastaState,
	present: readonly Seat[],
	randomBelow: RandomBelow,
): ApplyResult {
	if (table.match !== null) return reject("the match has already started");
	const waiting = absence(SEATS, present);
	if (waiting) return waiting;
	const seed = randomBelow(2 ** 32);
	const match = startMatch(seed);
	return accept(
		{ kind: "start", handNo: match.handNo },
		{
			...table,
			match,
			actions: 0,
		},
	);
}

function applyTableAction(
	table: CanastaState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const match = table.match;
	if (match === null) return reject("the match has not started");
	if (match.settled || match.winner !== null)
		return reject("this hand is over; deal the next one");
	if (payload.hand !== match.handNo || payload.at !== table.actions)
		return reject("the table has moved on since this action was chosen");
	const action = parseAction(payload.action);
	if (!action) return reject("not a valid action");
	const applied = applyHandAction(match.hand, engineSeat(context.seat), action);
	if (!applied.ok) return reject(applied.reason);
	const waiting = absence(SEATS, context.present);
	if (waiting) return waiting;
	const next = settleIfOver({ ...match, hand: applied.hand });
	return accept(
		{
			kind: "action",
			handNo: match.handNo,
			action: action as unknown as JsonObject,
		},
		{ ...table, match: next, actions: table.actions + 1 },
	);
}

function applyNextHand(
	table: CanastaState,
	present: readonly Seat[],
): ApplyResult {
	const match = table.match;
	if (match === null) return reject("the match has not started");
	if (!match.settled) return reject("the hand is not over");
	if (match.winner !== null) return reject("the match is over");
	const waiting = absence(SEATS, present);
	if (waiting) return waiting;
	const step = nextHand(match);
	if (!step.ok) return reject(step.reason);
	return accept(
		{ kind: "next-hand", handNo: step.match.handNo },
		{ ...table, match: step.match, actions: 0 },
	);
}

function applyChat(
	table: CanastaState,
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
	table: CanastaState,
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

export function createCanastaModule(randomBelow: RandomBelow): GameModule {
	return {
		initialState(roomId) {
			const state: CanastaState = {
				v: PROTOCOL_VERSION,
				roomId,
				game: "canasta",
				messages: 0,
				match: null,
				actions: 0,
				media: {},
			};
			return state as unknown as JsonObject;
		},

		isState(state, roomId) {
			return parseCanastaState(state, roomId) !== undefined;
		},

		apply(state, context, payload) {
			const table = parseCanastaState(state, context.roomId);
			if (!table) return reject("room state is not a canasta table");
			if (!isJsonObject(payload)) return reject("command is not an object");
			if (payload.v !== PROTOCOL_VERSION)
				return reject("unsupported protocol version");
			if (payload.roomId !== context.roomId)
				return reject("command is for another room");
			switch (payload.type) {
				case "chat":
					return applyChat(table, context, payload);
				case "media":
					return applyMedia(table, context, payload);
				case "start":
					return applyStart(table, context.present, randomBelow);
				case "action":
					return applyTableAction(table, context, payload);
				case "next-hand":
					return applyNextHand(table, context.present);
				default:
					return reject("unknown command type");
			}
		},
	};
}

export const canastaModule: GameModule = createCanastaModule(cryptoRandomBelow);

export function startPayload(roomId: string): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "start" };
}

/** An action at the current position of `match`. */
export function actionPayload(
	roomId: string,
	match: MatchState,
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

export function nextHandPayload(roomId: string): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "next-hand" };
}

/** Start, action and next-hand commands, as opposed to chat and call status. */
export function isTableCommand(payload: unknown): boolean {
	return isJsonObject(payload) && TABLE_COMMANDS.includes(payload.type);
}

/** Chat commands, as opposed to table actions and call status. */
export function isChatCommand(payload: unknown): boolean {
	return isJsonObject(payload) && payload.type === "chat";
}

/** Chat events (`{fromName, text}`): every other event has a `kind`. */
export function isChatEvent(event: JsonObject): boolean {
	return event.kind === undefined;
}

/** The hand from one seat's point of view, for the table screen. */
export function handViewFor(match: MatchState, seat: Seat) {
	return viewFor(match.hand, engineSeat(seat));
}
