import {
	isObject,
	isSeat,
	SEAT_NAMES,
	SEATS,
	type Seat,
	seatAfter,
} from "../protocol";
import { type Card, type Deal, isCard, isDeal, sortCards } from "./cards";
import {
	boardSetup,
	CALLS,
	type Call,
	type Contract,
	finalContract,
	isAuctionOver,
	isCall,
	isLegalCall,
	LEVELS,
	type Level,
	playableCards,
	STRAINS,
	type Strain,
	scoreContract,
	trickWinner,
	type Vulnerability,
} from "./rules";

/**
 * One board as plain JSON: the deal and the calls and cards in the order they were made. Everything else
 * (turn, contract, tricks) is derived by replay. A Board comes only from createBoard, applyAction or
 * parseBoard, so its calls and cards are always legal.
 */
export interface Board {
	readonly number: number;
	readonly dealer: Seat;
	readonly vulnerability: Vulnerability;
	readonly deal: Deal;
	readonly calls: readonly Call[];
	readonly cards: readonly Card[];
}

export type Action =
	| { readonly type: "call"; readonly call: Call }
	| { readonly type: "play"; readonly card: Card };

export type ActionResult =
	| { readonly ok: true; readonly board: Board }
	| { readonly ok: false; readonly reason: string };

export interface CurrentTrick {
	readonly leader: Seat;
	readonly cards: readonly Card[];
}

export interface CompletedTrick extends CurrentTrick {
	readonly winner: Seat;
}

interface StatusBase {
	readonly tricks: readonly CompletedTrick[];
	readonly tricksNS: number;
	readonly tricksEW: number;
	/** Cards not yet played, each hand in display order. */
	readonly remaining: Readonly<Record<Seat, readonly Card[]>>;
}

/**
 * `turn` is the seat whose call or card is next; `actor` is the seat that may act, which is declarer when it
 * is dummy's turn. `contract` is undefined while the auction runs and null for a passed-out board.
 */
export type BoardStatus = StatusBase &
	(
		| {
				readonly phase: "auction";
				readonly turn: Seat;
				readonly actor: Seat;
				readonly contract: undefined;
				readonly dummy: undefined;
				readonly current: undefined;
		  }
		| {
				readonly phase: "play";
				readonly turn: Seat;
				readonly actor: Seat;
				readonly contract: Contract;
				readonly dummy: Seat;
				readonly current: CurrentTrick;
		  }
		| {
				readonly phase: "complete";
				readonly turn: undefined;
				readonly actor: undefined;
				readonly contract: Contract | null;
				readonly dummy: Seat | undefined;
				readonly current: CurrentTrick | undefined;
		  }
	);

export interface BoardResult {
	readonly number: number;
	readonly contract: Contract | null;
	readonly declarerTricks: number;
	readonly scoreNS: number;
}

export interface UndoPosition {
	/** Number of calls to keep. */
	readonly calls: number;
	/** Number of played cards to keep. */
	readonly cards: number;
}

function isNorthSouth(seat: Seat): boolean {
	return seat === "N" || seat === "S";
}

/** Starts a board. Throws on an invalid board number or deal; hands are stored in display order. */
export function createBoard(number: number, deal: Deal): Board {
	const { dealer, vulnerability } = boardSetup(number);
	if (!isDeal(deal))
		throw new Error("a deal needs four hands of 13 different cards");
	const sorted: Partial<Record<Seat, Card[]>> = {};
	for (const seat of SEATS) sorted[seat] = sortCards(deal[seat]);
	return {
		number,
		dealer,
		vulnerability,
		deal: sorted as Record<Seat, Card[]>,
		calls: [],
		cards: [],
	};
}

export function boardStatus(board: Board): BoardStatus {
	const remaining: Record<Seat, Card[]> = {
		N: [...board.deal.N],
		E: [...board.deal.E],
		S: [...board.deal.S],
		W: [...board.deal.W],
	};
	const empty = { tricks: [], tricksNS: 0, tricksEW: 0, remaining };
	if (!isAuctionOver(board.calls)) {
		const turn = seatAfter(board.dealer, board.calls.length);
		return {
			...empty,
			phase: "auction",
			turn,
			actor: turn,
			contract: undefined,
			dummy: undefined,
			current: undefined,
		};
	}
	const contract = finalContract(board.calls, board.dealer);
	if (contract === null) {
		return {
			...empty,
			phase: "complete",
			turn: undefined,
			actor: undefined,
			contract: null,
			dummy: undefined,
			current: undefined,
		};
	}
	const dummy = seatAfter(contract.declarer, 2);
	const tricks: CompletedTrick[] = [];
	let leader = seatAfter(contract.declarer, 1);
	let cards: Card[] = [];
	for (const card of board.cards) {
		const seat = seatAfter(leader, cards.length);
		remaining[seat] = remaining[seat].filter((held) => held !== card);
		cards.push(card);
		if (cards.length === 4) {
			const winner = trickWinner(cards, leader, contract.strain);
			tricks.push({ leader, cards, winner });
			leader = winner;
			cards = [];
		}
	}
	const tricksNS = tricks.filter((trick) => isNorthSouth(trick.winner)).length;
	const counts = { tricks, tricksNS, tricksEW: tricks.length - tricksNS };
	const current = { leader, cards };
	if (tricks.length === 13) {
		return {
			...counts,
			remaining,
			phase: "complete",
			turn: undefined,
			actor: undefined,
			contract,
			dummy,
			current,
		};
	}
	const turn = seatAfter(leader, cards.length);
	return {
		...counts,
		remaining,
		phase: "play",
		turn,
		actor: turn === dummy ? contract.declarer : turn,
		contract,
		dummy,
		current,
	};
}

/** The position just before this seat's latest action in the current phase. */
export function undoPosition(
	board: Board,
	seat: Seat,
): UndoPosition | undefined {
	const status = boardStatus(board);
	if (
		status.phase === "auction" ||
		(status.phase === "complete" && status.contract === null)
	) {
		for (let index = board.calls.length - 1; index >= 0; index--) {
			if (seatAfter(board.dealer, index) === seat)
				return { calls: index, cards: 0 };
		}
		return undefined;
	}
	if (
		status.contract === null ||
		status.dummy === seat ||
		status.contract === undefined
	)
		return undefined;
	let replay: Board = { ...board, cards: [] };
	let target: number | undefined;
	for (const [index, card] of board.cards.entries()) {
		const before = boardStatus(replay);
		if (before.phase !== "play") return undefined;
		if (before.actor === seat) target = index;
		const applied = applyAction(replay, before.actor, { type: "play", card });
		if (!applied.ok) return undefined;
		replay = applied.board;
	}
	return target === undefined
		? undefined
		: { calls: board.calls.length, cards: target };
}

/** Returns the board with every action from `position` onward removed. */
export function rewindBoard(board: Board, position: UndoPosition): Board {
	return {
		...board,
		calls: board.calls.slice(0, position.calls),
		cards: board.cards.slice(0, position.cards),
	};
}

function reject(reason: string): ActionResult {
	return { ok: false, reason };
}

/** Checks one action by `seat` and returns the next board, or the reason the action is not allowed. */
export function applyAction(
	board: Board,
	seat: Seat,
	action: Action,
): ActionResult {
	const status = boardStatus(board);
	if (status.phase === "complete") return reject("the board is over");
	if (action.type === "call") {
		if (status.phase !== "auction") return reject("the auction is over");
		if (seat !== status.turn) return reject("it is not your turn");
		if (!isLegalCall(board.calls, action.call))
			return reject(`${action.call} is not a legal call now`);
		return {
			ok: true,
			board: { ...board, calls: [...board.calls, action.call] },
		};
	}
	if (status.phase !== "play") return reject("the auction is not over");
	if (seat !== status.actor) {
		return reject(
			seat === status.dummy && seat === status.turn
				? "dummy's cards are played by declarer"
				: "it is not your turn",
		);
	}
	const hand = status.remaining[status.turn];
	if (!hand.includes(action.card))
		return reject(`${action.card} is not in ${SEAT_NAMES[status.turn]}'s hand`);
	if (!playableCards(status.current.cards, hand).includes(action.card))
		return reject(`${action.card} does not follow suit`);
	return {
		ok: true,
		board: { ...board, cards: [...board.cards, action.card] },
	};
}

/** The actions `seat` may take now, in bid-box or display order; empty when it is not that seat's move. */
export function legalActions(board: Board, seat: Seat): Action[] {
	const status = boardStatus(board);
	if (status.phase === "auction" && seat === status.actor) {
		return CALLS.filter((call) => isLegalCall(board.calls, call)).map(
			(call) => ({ type: "call", call }),
		);
	}
	if (status.phase === "play" && seat === status.actor) {
		return playableCards(
			status.current.cards,
			status.remaining[status.turn],
		).map((card) => ({ type: "play", card }));
	}
	return [];
}

/** The result of a finished board, or undefined while it is still being bid or played. */
export function scoreBoard(board: Board): BoardResult | undefined {
	const status = boardStatus(board);
	if (status.phase !== "complete") return undefined;
	const { contract } = status;
	if (contract === null)
		return {
			number: board.number,
			contract: null,
			declarerTricks: 0,
			scoreNS: scoreContract(null, board.vulnerability, 0),
		};
	const declarerTricks = isNorthSouth(contract.declarer)
		? status.tricksNS
		: status.tricksEW;
	return scoreBoardAtDeclarerTricks(board, contract, declarerTricks);
}

/** Scores a finished or claimed board for the declarer's final trick count. */
export function scoreBoardAtDeclarerTricks(
	board: Board,
	contract: Contract,
	declarerTricks: number,
): BoardResult {
	return {
		number: board.number,
		contract,
		declarerTricks,
		scoreNS: scoreContract(contract, board.vulnerability, declarerTricks),
	};
}

export type HandView =
	| { readonly visible: true; readonly cards: readonly Card[] }
	| { readonly visible: false; readonly count: number };

export interface PlayerView {
	readonly seat: Seat;
	readonly number: number;
	readonly dealer: Seat;
	readonly vulnerability: Vulnerability;
	readonly phase: BoardStatus["phase"];
	readonly calls: readonly Call[];
	readonly turn: Seat | undefined;
	readonly actor: Seat | undefined;
	readonly contract: Contract | null | undefined;
	readonly dummy: Seat | undefined;
	readonly hands: Readonly<Record<Seat, HandView>>;
	readonly current: CurrentTrick | undefined;
	readonly tricks: readonly CompletedTrick[];
	readonly tricksNS: number;
	readonly tricksEW: number;
	readonly legal: readonly Action[];
	readonly result: BoardResult | undefined;
}

/**
 * What one player may see: their own hand, dummy after the opening lead, and every hand once the board is
 * over. Players are trusted not to read the full board from the room state; this view is what the table shows.
 */
export function viewForPlayer(
	board: Board,
	seat: Seat,
	revealedSeats: readonly Seat[] = [],
): PlayerView {
	const status = boardStatus(board);
	const dummyExposed = status.phase === "play" && board.cards.length > 0;
	const hand = (owner: Seat): HandView => {
		if (status.phase === "complete")
			return { visible: true, cards: board.deal[owner] };
		const cards = status.remaining[owner];
		return owner === seat ||
			revealedSeats.includes(owner) ||
			(dummyExposed && owner === status.dummy)
			? { visible: true, cards }
			: { visible: false, count: cards.length };
	};
	return {
		seat,
		number: board.number,
		dealer: board.dealer,
		vulnerability: board.vulnerability,
		phase: status.phase,
		calls: board.calls,
		turn: status.turn,
		actor: status.actor,
		contract: status.contract,
		dummy: status.dummy,
		hands: { N: hand("N"), E: hand("E"), S: hand("S"), W: hand("W") },
		current: status.current,
		tricks: status.tricks,
		tricksNS: status.tricksNS,
		tricksEW: status.tricksEW,
		legal: legalActions(board, seat),
		result: scoreBoard(board),
	};
}

/** Accepts `{type: "call", call}` or `{type: "play", card}` with a known call or card. */
export function parseAction(value: unknown): Action | undefined {
	if (!isObject(value)) return undefined;
	if (value.type === "call" && isCall(value.call))
		return { type: "call", call: value.call };
	if (value.type === "play" && isCard(value.card))
		return { type: "play", card: value.card };
	return undefined;
}

/**
 * Restores a board from stored JSON by replaying its calls and cards from the deal, so a stored board with an
 * illegal call or card, or with a dealer or vulnerability that does not match its number, is refused.
 */
export function parseBoard(value: unknown): Board | undefined {
	if (!isObject(value)) return undefined;
	const { number, dealer, vulnerability, deal, calls, cards } = value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
		return undefined;
	if (!isDeal(deal) || !Array.isArray(calls) || !Array.isArray(cards))
		return undefined;
	let board = createBoard(number, deal);
	if (board.dealer !== dealer || board.vulnerability !== vulnerability)
		return undefined;
	const actions: unknown[] = [
		...calls.map((call: unknown) => ({ type: "call", call })),
		...cards.map((card: unknown) => ({ type: "play", card })),
	];
	for (const item of actions) {
		const action = parseAction(item);
		const actor = boardStatus(board).actor;
		if (action === undefined || actor === undefined) return undefined;
		const result = applyAction(board, actor, action);
		if (!result.ok) return undefined;
		board = result.board;
	}
	return board;
}

const DOUBLINGS: readonly Contract["doubling"][] = ["", "X", "XX"];

function parseContract(value: unknown): Contract | undefined {
	if (!isObject(value)) return undefined;
	const { level, strain, declarer, doubling } = value;
	const levels: readonly unknown[] = LEVELS;
	const strains: readonly unknown[] = STRAINS;
	const doublings: readonly unknown[] = DOUBLINGS;
	if (!levels.includes(level) || !strains.includes(strain)) return undefined;
	if (!isSeat(declarer) || !doublings.includes(doubling)) return undefined;
	return {
		level: level as Level,
		strain: strain as Strain,
		declarer,
		doubling: doubling as Contract["doubling"],
	};
}

/** Restores a stored result. Its score must be the duplicate score of its contract, tricks and board number. */
export function parseBoardResult(value: unknown): BoardResult | undefined {
	if (!isObject(value)) return undefined;
	const { number, contract, declarerTricks, scoreNS } = value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
		return undefined;
	if (
		typeof declarerTricks !== "number" ||
		!Number.isInteger(declarerTricks) ||
		declarerTricks < 0 ||
		declarerTricks > 13
	)
		return undefined;
	const parsed = contract === null ? null : parseContract(contract);
	if (parsed === undefined || (parsed === null && declarerTricks !== 0))
		return undefined;
	const { vulnerability } = boardSetup(number);
	const score = scoreContract(parsed, vulnerability, declarerTricks);
	if (scoreNS !== score) return undefined;
	return { number, contract: parsed, declarerTricks, scoreNS: score };
}
