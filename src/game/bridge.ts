import { cryptoRandomBelow, dealCards, type RandomBelow } from "../bridge/deal";
import {
	type Action,
	applyAction,
	type Board,
	type BoardResult,
	boardStatus,
	createBoard,
	parseAction,
	parseBoard,
	parseBoardResult,
	rewindBoard,
	scoreBoard,
	scoreBoardAtDeclarerTricks,
	type UndoPosition,
	undoPosition,
} from "../bridge/engine";
import {
	applyCallRecord,
	type CallRecords,
	parseCallRecords,
} from "../call/record";
import { isCommandId } from "../ids";

// Bridge-only features. The bridge game is removed with its UI in a later step, and no
// peer advertises these features now, so undo, claim and reset stay unavailable.
export const APPLICATION_FEATURES = {
	bridgeUndo: "bridge-undo-v1",
	bridgeClaim: "bridge-claim-v1",
	bridgeReset: "bridge-reset-v1",
} as const;

import {
	isNonNegativeInteger,
	isObject,
	isSeat,
	type JsonObject,
	PROTOCOL_VERSION,
	SEAT_NAMES,
	SEATS,
	type Seat,
} from "../protocol";
import { checkMessageText } from "./chat";
import type { ApplyContext, ApplyResult, GameModule } from "./module";

/**
 * Milestone 2: one bridge table with duplicate scoring, plus the chat of milestone 1.
 *
 * The state holds the current board in full and the result of every finished board; earlier boards live
 * only in the accepted commands. Commands:
 * - `{type: "chat", text}`: a message, as in the chat module.
 * - `{type: "deal", board}`: the host deals the next board, whose dealer is fixed by its number.
 * - `{type: "call", board, at, call}` and `{type: "play", board, at, card}`: one action, where `at` is the
 *   number of calls and cards before it. A command chosen on an older view of the table is rejected, so a
 *   delayed command never lands in a later position.
 * - `{type: "media", version, prefs, form}`: the sender's call status (src/call/record.ts); the stored record
 *   also gets the holder of the sender's seat (`ApplyContext.holder`).
 * Events: `{fromName, text}` for chat, `{kind: "deal", board}` with the full new board,
 * `{kind: "call", board, call}` and `{kind: "play", board, hand, card}`, where `hand` is the seat that
 * held the card (dummy when declarer plays from dummy), and `{kind: "media", seat, version}`.
 *
 * A deal or a call needs all four players present (`ApplyContext.present`); a card needs all but dummy,
 * because declarer plays dummy's cards. A chat message or a call status needs nobody. The rules come first, so
 * an action that the rules reject keeps its own reason; an action that only waits for a player is marked
 * `waiting`.
 */

export type BridgeState = {
	readonly v: typeof PROTOCOL_VERSION;
	readonly roomId: string;
	readonly game: "bridge";
	readonly messages: number;
	readonly board: Board | null;
	readonly results: readonly BoardResult[];
	/** An undo request blocks new game actions until it is approved, rejected, or cancelled. */
	readonly undo: UndoRequest | null;
	/** A claim request blocks play until every required opponent accepts or one rejects it. */
	readonly claim: ClaimRequest | null;
	/** The accepted claim that ended the current board, if any. */
	readonly claimResult: AcceptedClaim | null;
	/** A reset request blocks game actions until every present player approves or one rejects it. */
	readonly reset?: ResetRequest | null;
	/** Each seat's latest call status. */
	readonly media: CallRecords;
};

export interface UndoRequest extends UndoPosition {
	readonly id: string;
	readonly board: number;
	readonly requester: Seat;
	readonly required: readonly Seat[];
	readonly approved: readonly Seat[];
}

export interface ClaimRequest {
	readonly id: string;
	readonly board: number;
	readonly requester: Seat;
	/** Number of remaining tricks the requester claims for their partnership. */
	readonly tricks: number;
	readonly required: readonly Seat[];
	readonly approved: readonly Seat[];
}

export interface AcceptedClaim {
	readonly id: string;
	readonly board: number;
	readonly requester: Seat;
	readonly tricks: number;
	readonly result: BoardResult;
}

export interface ResetRequest {
	readonly id: string;
	readonly requester: Seat;
	readonly required: readonly Seat[];
	readonly approved: readonly Seat[];
}

const TABLE_ACTIONS: readonly unknown[] = ["deal", "call", "play"];

/** Restores a stored table. Its board is replayed, and each finished board must have its result. */
export function parseBridgeState(
	state: JsonObject,
	roomId: string,
): BridgeState | undefined {
	if (
		state.v !== PROTOCOL_VERSION ||
		state.roomId !== roomId ||
		state.game !== "bridge"
	)
		return undefined;
	if (!isNonNegativeInteger(state.messages) || !Array.isArray(state.results))
		return undefined;
	const board = state.board === null ? null : parseBoard(state.board);
	if (board === undefined) return undefined;
	const results: BoardResult[] = [];
	for (const item of state.results) {
		const result = parseBoardResult(item);
		if (result === undefined || result.number !== results.length + 1)
			return undefined;
		results.push(result);
	}
	const undo = parseUndoRequest(state.undo, board);
	const claim = parseClaimRequest(state.claim, board);
	const claimResult = parseAcceptedClaim(state.claimResult, board);
	const reset = parseResetRequest(state.reset);
	if (
		undo === undefined ||
		claim === undefined ||
		claimResult === undefined ||
		reset === undefined
	)
		return undefined;
	if ([undo, claim, reset].filter((request) => request !== null).length > 1)
		return undefined;
	if (claimResult !== null && (undo !== null || claim !== null))
		return undefined;
	const finished =
		board === null
			? 0
			: boardStatus(board).phase === "complete" || claimResult !== null
				? board.number
				: board.number - 1;
	if (results.length !== finished) return undefined;
	if (claimResult && results.at(-1)?.number !== claimResult.board)
		return undefined;
	if (
		claimResult &&
		JSON.stringify(results.at(-1)) !== JSON.stringify(claimResult.result)
	)
		return undefined;
	const media = parseCallRecords(state.media);
	if (media === undefined) return undefined;
	return {
		v: PROTOCOL_VERSION,
		roomId,
		game: "bridge",
		messages: state.messages,
		board,
		results,
		undo,
		claim,
		claimResult,
		reset,
		media,
	};
}

function parseResetRequest(value: unknown): ResetRequest | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isObject(value)) return undefined;
	const { id, requester, required, approved } = value;
	if (
		!isCommandId(id) ||
		!isSeat(requester) ||
		!Array.isArray(required) ||
		required.length === 0 ||
		!required.every(isSeat) ||
		required.includes(requester) ||
		new Set(required).size !== required.length ||
		!Array.isArray(approved) ||
		!approved.every(isSeat) ||
		new Set(approved).size !== approved.length ||
		approved.some((seat) => !required.includes(seat))
	)
		return undefined;
	return { id, requester, required: [...required], approved: [...approved] };
}

function auctionOpen(board: Board): boolean {
	const status = boardStatus(board);
	return (
		status.phase === "auction" ||
		(status.phase === "complete" && status.contract === null)
	);
}

function samePartnership(a: Seat, b: Seat): boolean {
	return (a === "N" || a === "S") === (b === "N" || b === "S");
}

function claimApprovers(board: Board, requester: Seat): Seat[] | undefined {
	const status = boardStatus(board);
	if (
		status.phase !== "play" ||
		status.actor !== requester ||
		status.contract.declarer !== requester
	)
		return undefined;
	// The declarer controls both their own turn and dummy's turn; both defenders decide.
	return SEATS.filter((seat) => !samePartnership(seat, requester));
}

function claimedResult(
	board: Board,
	requester: Seat,
	tricks: number,
): BoardResult | undefined {
	const status = boardStatus(board);
	if (status.phase !== "play" || status.contract === null) return undefined;
	const remaining = 13 - status.tricks.length;
	if (!isNonNegativeInteger(tricks) || tricks < 1 || tricks > remaining)
		return undefined;
	const nsClaims = requester === "N" || requester === "S";
	const tricksNS = status.tricksNS + (nsClaims ? tricks : remaining - tricks);
	const declarerTricks =
		status.contract.declarer === "N" || status.contract.declarer === "S"
			? tricksNS
			: 13 - tricksNS;
	return scoreBoardAtDeclarerTricks(board, status.contract, declarerTricks);
}

function parseClaimRequest(
	value: unknown,
	board: Board | null,
): ClaimRequest | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isObject(value) || board === null) return undefined;
	const { id, board: number, requester, tricks, required, approved } = value;
	if (
		!isCommandId(id) ||
		number !== board.number ||
		!isSeat(requester) ||
		!isNonNegativeInteger(tricks) ||
		!Array.isArray(required) ||
		!required.every(isSeat) ||
		new Set(required).size !== required.length ||
		!Array.isArray(approved) ||
		!approved.every(isSeat) ||
		new Set(approved).size !== approved.length
	)
		return undefined;
	const approvers = claimApprovers(board, requester);
	if (
		!approvers ||
		!claimedResult(board, requester, tricks) ||
		JSON.stringify(required) !== JSON.stringify(approvers) ||
		approved.some((seat) => !approvers.includes(seat))
	)
		return undefined;
	return {
		id,
		board: number,
		requester,
		tricks,
		required: [...required],
		approved: [...approved],
	};
}

function parseAcceptedClaim(
	value: unknown,
	board: Board | null,
): AcceptedClaim | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isObject(value) || board === null) return undefined;
	const { id, board: number, requester, tricks, result: rawResult } = value;
	if (
		!isCommandId(id) ||
		number !== board.number ||
		!isSeat(requester) ||
		!isNonNegativeInteger(tricks)
	)
		return undefined;
	const result = claimedResult(board, requester, tricks);
	const parsed = parseBoardResult(rawResult);
	if (!result || !parsed || JSON.stringify(result) !== JSON.stringify(parsed))
		return undefined;
	return { id, board: number, requester, tricks, result };
}

function undoApprovers(board: Board, requester: Seat): Seat[] | undefined {
	if (auctionOpen(board))
		return SEATS.filter((seat) => !samePartnership(seat, requester));
	const status = boardStatus(board);
	if (status.contract === null || status.contract === undefined)
		return undefined;
	if (status.dummy === requester) return undefined;
	return SEATS.filter(
		(seat) => !samePartnership(seat, requester) && seat !== status.dummy,
	);
}

function parseUndoRequest(
	value: unknown,
	board: Board | null,
): UndoRequest | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isObject(value) || board === null) return undefined;
	const {
		id,
		board: number,
		requester,
		calls,
		cards,
		required,
		approved,
	} = value;
	if (
		!isCommandId(id) ||
		number !== board.number ||
		!isSeat(requester) ||
		!isNonNegativeInteger(calls) ||
		!isNonNegativeInteger(cards) ||
		!Array.isArray(required) ||
		!required.every(isSeat) ||
		new Set(required).size !== required.length ||
		!Array.isArray(approved) ||
		!approved.every(isSeat) ||
		new Set(approved).size !== approved.length
	)
		return undefined;
	const position = undoPosition(board, requester);
	const approvers = undoApprovers(board, requester);
	if (
		!position ||
		!approvers ||
		calls !== position.calls ||
		cards !== position.cards ||
		JSON.stringify(required) !== JSON.stringify(approvers) ||
		approved.some((seat) => !approvers.includes(seat))
	)
		return undefined;
	return {
		id,
		board: number,
		requester,
		calls,
		cards,
		required: [...required],
		approved: [...approved],
	};
}

export function dealPayload(roomId: string, board: number): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "deal", board };
}

/** A call or play at the current position of `board`. */
export function actionPayload(
	roomId: string,
	board: Board,
	action: Action,
): JsonObject {
	const position = {
		v: PROTOCOL_VERSION,
		roomId,
		board: board.number,
		at: board.calls.length + board.cards.length,
	};
	return action.type === "call"
		? { ...position, type: "call", call: action.call }
		: { ...position, type: "play", card: action.card };
}

export function undoRequestPayload(roomId: string, board: number): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "undo-request", board };
}

export function undoVotePayload(
	roomId: string,
	requestId: string,
	approve: boolean,
): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "undo-vote", requestId, approve };
}

export function undoCancelPayload(
	roomId: string,
	requestId: string,
): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "undo-cancel", requestId };
}

export function claimRequestPayload(
	roomId: string,
	board: number,
	tricks: number,
): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "claim-request", board, tricks };
}

export function claimVotePayload(
	roomId: string,
	requestId: string,
	approve: boolean,
): JsonObject {
	return {
		v: PROTOCOL_VERSION,
		roomId,
		type: "claim-vote",
		requestId,
		approve,
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

/** Deal, call and play commands, as opposed to chat. */
export function isTableCommand(payload: unknown): boolean {
	return isObject(payload) && TABLE_ACTIONS.includes(payload.type);
}

/** Chat commands, as opposed to table actions and call status. */
export function isChatCommand(payload: unknown): boolean {
	return isObject(payload) && payload.type === "chat";
}

/** Chat events (`{fromName, text}`): every other event has a `kind`. */
export function isChatEvent(event: JsonObject): boolean {
	return event.kind === undefined;
}

/** Points scored by each side: a positive board score goes to North-South, a negative one to East-West. */
export function totals(results: readonly BoardResult[]): {
	ns: number;
	ew: number;
} {
	let ns = 0;
	let ew = 0;
	for (const { scoreNS } of results) {
		if (scoreNS > 0) ns += scoreNS;
		else ew -= scoreNS;
	}
	return { ns, ew };
}

function reject(reason: string): ApplyResult {
	return { ok: false, reason };
}

function accept(event: JsonObject, state: BridgeState): ApplyResult {
	return { ok: true, event, state };
}

/**
 * "Waiting for East, South and West to come back" when seats of `needed` are not present; undefined when all
 * are. The table screen shows the same text before the host would refuse the action.
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

function applyChat(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const check = checkMessageText(payload.text);
	if (!check.ok) return check;
	return accept(
		{ fromName: context.config.names[context.seat], text: check.text },
		{ ...state, messages: state.messages + 1 },
	);
}

function applyMedia(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const { seat } = context;
	const applied = applyCallRecord(state.media, seat, context.holder, payload);
	if (!applied.ok) return reject(applied.reason);
	return accept(
		{ kind: "media", seat, version: applied.record.version },
		{ ...state, media: applied.records },
	);
}

function applyDeal(
	state: BridgeState,
	present: readonly Seat[],
	payload: JsonObject,
	randomBelow: RandomBelow,
): ApplyResult {
	const requested = payload.board;
	if (!isNonNegativeInteger(requested))
		return reject("deal command has no board number");
	const current = state.board;
	const next = (current?.number ?? 0) + 1;
	if (requested < next) return reject(`board ${requested} is already dealt`);
	if (
		current &&
		boardStatus(current).phase !== "complete" &&
		state.claimResult === null
	)
		return reject(`board ${current.number} is not over`);
	if (requested !== next) return reject(`the next board is board ${next}`);
	const waiting = absence(SEATS, present);
	if (waiting) return waiting;
	const board = createBoard(next, dealCards(randomBelow));
	return accept(
		{ kind: "deal", board },
		{ ...state, board, claimResult: null },
	);
}

function applyTableAction(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const board = state.board;
	if (!board) return reject("no board has been dealt");
	if (!isNonNegativeInteger(payload.board) || !isNonNegativeInteger(payload.at))
		return reject("command has no table position");
	if (
		payload.board !== board.number ||
		payload.at !== board.calls.length + board.cards.length
	)
		return reject("the table has moved on since this action was chosen");
	const action = parseAction(payload);
	if (!action)
		return reject(
			payload.type === "call" ? "not a valid call" : "not a valid card",
		);
	const { turn: hand, dummy } = boardStatus(board);
	const applied = applyAction(board, context.seat, action);
	if (!applied.ok) return reject(applied.reason);
	const needed = SEATS.filter((seat) => seat !== dummy);
	const waiting = absence(needed, context.present);
	if (waiting) return waiting;
	const next = applied.board;
	const result = scoreBoard(next);
	const event =
		action.type === "call"
			? { kind: "call", board: board.number, call: action.call }
			: { kind: "play", board: board.number, hand, card: action.card };
	return accept(event, {
		...state,
		board: next,
		results: result ? [...state.results, result] : state.results,
	});
}

function canUseUndo(context: ApplyContext, seats: readonly Seat[]): boolean {
	return seats.every((seat) =>
		context.features?.get(seat)?.includes(APPLICATION_FEATURES.bridgeUndo),
	);
}

function applyUndoRequest(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const board = state.board;
	if (!board) return reject("no board has been dealt");
	if (!isNonNegativeInteger(payload.board) || payload.board !== board.number)
		return reject("the board has changed since undo was chosen");
	if (state.undo || state.claim || state.reset)
		return reject("another game request is already waiting for answers");
	if (state.claimResult)
		return reject("the board ended with an accepted claim");
	const position = undoPosition(board, context.seat);
	const required = undoApprovers(board, context.seat);
	if (!position || !required)
		return reject("you have no bid or card to take back");
	const waiting = absence(required, context.present);
	if (waiting) return waiting;
	if (!canUseUndo(context, [context.seat, ...required]))
		return reject("all opponents must use a version that supports undo");
	const undo: UndoRequest = {
		id: context.commandId,
		board: board.number,
		requester: context.seat,
		...position,
		required,
		approved: [],
	};
	return accept(
		{ kind: "undo-requested", board: board.number, requester: context.seat },
		{ ...state, undo },
	);
}

function canUseClaim(context: ApplyContext, seats: readonly Seat[]): boolean {
	return seats.every((seat) =>
		context.features?.get(seat)?.includes(APPLICATION_FEATURES.bridgeClaim),
	);
}

function canUseReset(context: ApplyContext, seats: readonly Seat[]): boolean {
	return seats.every((seat) =>
		context.features?.get(seat)?.includes(APPLICATION_FEATURES.bridgeReset),
	);
}

function resetGame(state: BridgeState, randomBelow: RandomBelow): BridgeState {
	return {
		...state,
		board: createBoard(1, dealCards(randomBelow)),
		results: [],
		undo: null,
		claim: null,
		claimResult: null,
		reset: null,
	};
}

function applyResetRequest(
	state: BridgeState,
	context: ApplyContext,
	randomBelow: RandomBelow,
): ApplyResult {
	if (state.undo || state.claim || state.reset)
		return reject("another game request is already waiting for answers");
	const present = [...new Set(context.present)];
	if (!present.includes(context.seat))
		return reject("your seat is not present at the table");
	if (!canUseReset(context, present))
		return reject("all present players must use a version that supports reset");
	const required = present.filter((seat) => seat !== context.seat);
	if (required.length === 0) {
		const next = resetGame(state, randomBelow);
		return accept(
			{ kind: "reset-applied", requester: context.seat, board: next.board },
			next,
		);
	}
	const reset: ResetRequest = {
		id: context.commandId,
		requester: context.seat,
		required,
		approved: [],
	};
	return accept(
		{ kind: "reset-requested", requester: context.seat, required },
		{ ...state, reset },
	);
}

function applyResetVote(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
	randomBelow: RandomBelow,
): ApplyResult {
	const pending = state.reset;
	if (!pending || payload.requestId !== pending.id)
		return reject("there is no matching reset request");
	if (!pending.required.includes(context.seat))
		return reject("your seat is not asked to approve this reset");
	if (!canUseReset(context, [context.seat]))
		return reject("reload this page to decide reset requests");
	if (typeof payload.approve !== "boolean")
		return reject("reset decision must accept or reject");
	if (pending.approved.includes(context.seat))
		return reject("your seat has already approved this reset");
	if (!payload.approve)
		return accept(
			{ kind: "reset-rejected", by: context.seat },
			{ ...state, reset: null },
		);
	const approved = [...pending.approved, context.seat];
	if (pending.required.every((seat) => approved.includes(seat))) {
		const next = resetGame(state, randomBelow);
		return accept(
			{
				kind: "reset-applied",
				requester: pending.requester,
				board: next.board,
			},
			next,
		);
	}
	return accept(
		{ kind: "reset-approved", by: context.seat },
		{ ...state, reset: { ...pending, approved } },
	);
}

function applyResetCancel(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const pending = state.reset;
	if (!pending || payload.requestId !== pending.id)
		return reject("there is no matching reset request");
	if (pending.requester !== context.seat)
		return reject("only the requester can cancel this reset");
	return accept({ kind: "reset-cancelled" }, { ...state, reset: null });
}

function applyClaimRequest(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const board = state.board;
	if (!board) return reject("no board has been dealt");
	if (!isNonNegativeInteger(payload.board) || payload.board !== board.number)
		return reject("the board has changed since the claim was chosen");
	if (state.undo || state.claim || state.reset)
		return reject("another game request is already waiting for answers");
	if (state.claimResult)
		return reject("the board ended with an accepted claim");
	if (typeof payload.tricks !== "number")
		return reject("claim has no trick count");
	const required = claimApprovers(board, context.seat);
	if (!required)
		return reject("the declarer can claim only on their turn or dummy's turn");
	const result = claimedResult(board, context.seat, payload.tricks);
	if (!result) return reject("you cannot claim that many tricks now");
	const waiting = absence(required, context.present);
	if (waiting) return waiting;
	if (!canUseClaim(context, [context.seat, ...required]))
		return reject("all opponents must use a version that supports claims");
	const claim: ClaimRequest = {
		id: context.commandId,
		board: board.number,
		requester: context.seat,
		tricks: payload.tricks,
		required,
		approved: [],
	};
	return accept(
		{
			kind: "claim-requested",
			board: board.number,
			requester: context.seat,
			tricks: claim.tricks,
		},
		{ ...state, claim },
	);
}

function applyClaimVote(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const pending = state.claim;
	if (!pending || payload.requestId !== pending.id)
		return reject("there is no matching claim request");
	if (!pending.required.includes(context.seat))
		return reject("your seat is not asked to decide this claim");
	if (!canUseClaim(context, [context.seat]))
		return reject("reload this page to decide claim requests");
	if (typeof payload.approve !== "boolean")
		return reject("claim decision must accept or reject");
	if (pending.approved.includes(context.seat))
		return reject("your seat has already accepted this claim");
	if (!payload.approve)
		return accept(
			{ kind: "claim-rejected", board: pending.board, by: context.seat },
			{ ...state, claim: null },
		);
	const approved = [...pending.approved, context.seat];
	if (pending.required.every((seat) => approved.includes(seat))) {
		const board = state.board;
		if (!board || board.number !== pending.board)
			return reject("the board changed while the claim was waiting");
		const result = claimedResult(board, pending.requester, pending.tricks);
		if (!result) return reject("the game moved while the claim was waiting");
		const claimResult: AcceptedClaim = {
			id: pending.id,
			board: board.number,
			requester: pending.requester,
			tricks: pending.tricks,
			result,
		};
		return accept(
			{
				kind: "claim-accepted",
				board: board.number,
				requester: pending.requester,
				tricks: pending.tricks,
				result,
			},
			{
				...state,
				claim: null,
				claimResult,
				results: [...state.results, result],
			},
		);
	}
	return accept(
		{ kind: "claim-approved", board: pending.board, by: context.seat },
		{ ...state, claim: { ...pending, approved } },
	);
}

function applyUndoVote(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const pending = state.undo;
	if (!pending || payload.requestId !== pending.id)
		return reject("there is no matching undo request");
	if (!pending.required.includes(context.seat))
		return reject("your seat is not asked to approve this undo");
	if (!canUseUndo(context, [context.seat]))
		return reject("reload this page to approve undo requests");
	if (typeof payload.approve !== "boolean")
		return reject("undo vote must approve or reject");
	if (pending.approved.includes(context.seat))
		return reject("your seat has already approved this undo");
	if (!payload.approve)
		return accept(
			{ kind: "undo-rejected", board: pending.board, by: context.seat },
			{ ...state, undo: null },
		);
	const approved = [...pending.approved, context.seat];
	if (pending.required.every((seat) => approved.includes(seat))) {
		const board = state.board;
		if (!board || board.number !== pending.board)
			return reject("the board changed while undo was waiting");
		const position = undoPosition(board, pending.requester);
		if (
			!position ||
			position.calls !== pending.calls ||
			position.cards !== pending.cards
		)
			return reject("the game moved while undo was waiting");
		const rewound = rewindBoard(board, pending);
		return accept(
			{
				kind: "undo-applied",
				board: board.number,
				calls: pending.calls,
				cards: pending.cards,
			},
			{
				...state,
				board: rewound,
				results: state.results.filter((result) => result.number < board.number),
				undo: null,
			},
		);
	}
	return accept(
		{ kind: "undo-approved", board: pending.board, by: context.seat },
		{ ...state, undo: { ...pending, approved } },
	);
}

function applyUndoCancel(
	state: BridgeState,
	context: ApplyContext,
	payload: JsonObject,
): ApplyResult {
	const pending = state.undo;
	if (!pending || payload.requestId !== pending.id)
		return reject("there is no matching undo request");
	if (pending.requester !== context.seat)
		return reject("only the requester can cancel this undo");
	return accept(
		{ kind: "undo-cancelled", board: pending.board },
		{ ...state, undo: null },
	);
}

/** The table's rules. `randomBelow` shuffles each deal; it is the only source of randomness. */
export function createBridgeModule(randomBelow: RandomBelow): GameModule {
	return {
		initialState(roomId) {
			const state: BridgeState = {
				v: PROTOCOL_VERSION,
				roomId,
				game: "bridge",
				messages: 0,
				board: null,
				results: [],
				undo: null,
				claim: null,
				claimResult: null,
				reset: null,
				media: {},
			};
			return state;
		},

		isState(state, roomId) {
			return parseBridgeState(state, roomId) !== undefined;
		},

		apply(state, context, payload) {
			const table = parseBridgeState(state, context.roomId);
			if (!table) return reject("room state is not a bridge table");
			if (!isObject(payload)) return reject("command is not an object");
			if (payload.v !== PROTOCOL_VERSION)
				return reject("unsupported protocol version");
			if (payload.roomId !== context.roomId)
				return reject("command is for another room");
			if (
				(table.undo || table.claim || table.reset) &&
				["deal", "call", "play", "claim-request"].includes(String(payload.type))
			)
				return reject("a game request is waiting for answers");
			if (
				table.claimResult &&
				["call", "play", "claim-request"].includes(String(payload.type))
			)
				return reject("the board ended with an accepted claim");
			switch (payload.type) {
				case "chat":
					return applyChat(table, context, payload);
				case "deal":
					return applyDeal(table, context.present, payload, randomBelow);
				case "call":
				case "play":
					return applyTableAction(table, context, payload);
				case "undo-request":
					return applyUndoRequest(table, context, payload);
				case "undo-vote":
					return applyUndoVote(table, context, payload);
				case "undo-cancel":
					return applyUndoCancel(table, context, payload);
				case "claim-request":
					return applyClaimRequest(table, context, payload);
				case "claim-vote":
					return applyClaimVote(table, context, payload);
				case "reset-request":
					return applyResetRequest(table, context, randomBelow);
				case "reset-vote":
					return applyResetVote(table, context, payload, randomBelow);
				case "reset-cancel":
					return applyResetCancel(table, context, payload);
				case "media":
					return applyMedia(table, context, payload);
				default:
					return reject("unknown command type");
			}
		},
	};
}

export const bridgeModule: GameModule = createBridgeModule(cryptoRandomBelow);
