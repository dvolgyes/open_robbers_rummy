import {
	type Card,
	rankOf,
	SUIT_SYMBOLS,
	type Suit,
	suitOf,
} from "../bridge/cards";
import {
	type Action,
	type BoardResult,
	boardStatus,
	type HandView,
	undoPosition,
	viewForPlayer,
} from "../bridge/engine";
import type { Call, Contract, Strain, Vulnerability } from "../bridge/rules";
import {
	type BridgeState,
	isTableCommand,
	totals,
	waitingText,
} from "../game/bridge";
import { englishTranslator as english, type Translate } from "../i18n";
import type { OutboxItem } from "../p2p/outbox";
import type { CommandFailure } from "../p2p/table";
import type { Entry } from "../p2p/wire";
import {
	isObject,
	type RoomConfig,
	SEAT_NAMES,
	SEATS,
	type Seat,
	seatAfter,
} from "../protocol";

import {
	AUCTION_SUIT_ORDER,
	miltonPoints,
	playSuitOrder,
	type TrickNeed,
	trickNeed,
} from "./hand-layout";
import { ownCommands, type RosterRow } from "./model";

/** Pure view model of the bridge table: the DOM layer only renders what these functions return. */

// ---------------------------------------------------------------------------------------------------------------
// Text

function strainText(strain: Strain): string {
	return strain === "NT" ? "NT" : SUIT_SYMBOLS[strain];
}

export function rankText(card: Card): string {
	const rank = rankOf(card);
	return rank === "T" ? "10" : rank;
}

export function cardText(card: Card): string {
	return `${SUIT_SYMBOLS[suitOf(card)]}${rankText(card)}`;
}

export function callText(call: Call): string {
	if (call === "P") return "Pass";
	if (call === "X") return "Double";
	if (call === "XX") return "Redouble";
	return `${call[0]}${strainText(call.slice(1) as Strain)}`;
}

/** For example "4♠X" or "3NT". */
export function contractText(contract: Contract): string {
	return `${contract.level}${strainText(contract.strain)}${contract.doubling}`;
}

const VULNERABILITY_TEXT: Readonly<Record<Vulnerability, string>> = {
	none: "Not vulnerable",
	NS: "North-South",
	EW: "East-West",
	both: "Both vulnerable",
};

/** "=", "+1" or "-2" against the contract; empty for a passed-out board. */
export function outcomeText(result: BoardResult): string {
	if (result.contract === null) return "";
	const over = result.declarerTricks - (result.contract.level + 6);
	return over === 0 ? "=" : over > 0 ? `+${over}` : `${over}`;
}

/** The side that scored, for example "N-S +420"; "No score" for 0. */
export function scoreText(scoreNS: number): string {
	if (scoreNS > 0) return `N-S +${scoreNS}`;
	if (scoreNS < 0) return `E-W +${-scoreNS}`;
	return "No score";
}

export function resultText(
	result: BoardResult,
	t: Translate = english,
): string {
	if (result.contract === null) return t("Passed out. No score.");
	const direction = t(SEAT_NAMES[result.contract.declarer]);
	return t("{contract}{outcome} by {direction}: {score}.", {
		contract: contractText(result.contract),
		outcome: outcomeText(result),
		direction,
		score: t(scoreText(result.scoreNS)),
	});
}

/** Short text of a table command, for the list of this seat's actions in flight. */
export function commandText(payload: unknown, t: Translate = english): string {
	if (!isObject(payload)) return "";
	if (payload.type === "deal")
		return t("Deal board {board}", { board: String(payload.board) });
	const action = payload.type === "call" ? payload.call : payload.card;
	if (typeof action !== "string") return "";
	if (payload.type === "call")
		return t("Call {call}", { call: callText(action as Call) });
	return t("Play {card}", { card: cardText(action as Card) });
}

// ---------------------------------------------------------------------------------------------------------------
// Table

/** Places around the table, as the viewer sees it: the viewer always sits at the bottom. */
export type Position = "bottom" | "left" | "top" | "right";
const POSITIONS: readonly Position[] = ["bottom", "left", "top", "right"];

export function positionOf(viewer: Seat, seat: Seat): Position {
	const steps = (SEATS.indexOf(seat) - SEATS.indexOf(viewer) + 4) % 4;
	return POSITIONS[steps] as Position;
}

export interface CardView {
	readonly card: Card;
	readonly rank: string;
	readonly suit: Suit;
	/** For example "♠10". */
	readonly text: string;
	/** The viewer may play this card now. */
	readonly playable: boolean;
}

export interface SuitRow {
	readonly suit: Suit;
	readonly symbol: string;
	readonly cards: readonly CardView[];
	/** The trump group of the declaring pair's hands; it gets the gold frame and label (layout spec §7). */
	readonly trump: boolean;
}

export type HandDisplay =
	| { readonly visible: true; readonly suits: readonly SuitRow[] }
	| { readonly visible: false; readonly count: number };

export interface SeatView {
	readonly seat: Seat;
	readonly position: Position;
	/** This seat is controlled by a host-managed bot, as reported in the shared roster. */
	readonly bot: boolean;
	/** The seat tag and the player name, such as "E - David"; the seat name alone while the seat is free. */
	readonly label: string;
	/** The player's name; empty while the seat is free. */
	readonly name: string;
	readonly tags: readonly string[];
	/** This seat's call or card is next. */
	readonly turn: boolean;
	readonly hand: HandDisplay;
	/** Whether a player holds the seat, and whether that player is connected. Only the lobby shows it. */
	readonly presence: RosterRow["state"];
	/** The viewer is not the host and the host is not connected yet (bridge-connection-room). */
	readonly connecting: boolean;
	/** This seat is the one to call during the auction. */
	readonly bidding: boolean;
	/** Milton Work points of a hand the viewer can see during the auction; undefined otherwise. */
	readonly points: number | undefined;
}

export interface PlayedCard {
	readonly seat: Seat;
	readonly position: Position;
	readonly card: Card;
	readonly text: string;
	/** The rank and the suit symbol, drawn as a full card. */
	readonly rank: string;
	readonly symbol: string;
}

export interface TrickView {
	readonly title: string;
	/** The second line, for example "Trick 1 · East won" (layout spec §8). */
	readonly detail: string;
	readonly cards: readonly PlayedCard[];
}

export interface AuctionView {
	readonly seats: readonly Seat[];
	/** Rows of four cells in `seats` order; empty cells before the dealer's first call. */
	readonly rows: readonly (readonly string[])[];
}

export interface BidView {
	readonly call: Call;
	readonly text: string;
}

export type TableActionState =
	| "sending"
	| "pending"
	| "not-accepted"
	| "undone";

export interface TableActionLine {
	readonly id: string;
	readonly text: string;
	readonly state: TableActionState;
	readonly reason?: string;
}

export interface ScoreRow {
	readonly number: number;
	readonly contract: string;
	readonly declarer: string;
	readonly outcome: string;
	readonly ns: string;
	readonly ew: string;
}

export interface NextBoard {
	readonly board: number;
	readonly ready: boolean;
}

/** Returns the next board to deal once, after scoring and only while this page hosts. */
export function autoDealBoard(
	hosting: boolean,
	currentBoard: number,
	countdown: number | undefined,
	nextBoard: NextBoard | undefined,
	alreadyDealtBoard: number | undefined,
): number | undefined {
	if (
		!hosting ||
		countdown !== 0 ||
		!nextBoard?.ready ||
		nextBoard.board === currentBoard ||
		nextBoard.board === alreadyDealtBoard
	)
		return undefined;
	return nextBoard.board;
}

export interface ScoringView {
	readonly contract:
		| Pick<Contract, "level" | "strain" | "doubling">
		| undefined;
	readonly compactOutcome: "WON" | "LOST" | "PASSED OUT";
	readonly compactDetail: string;
	readonly countdown: number;
}

export interface UndoPanelView {
	readonly canRequest: boolean;
	readonly message: string;
	readonly requestId: string | undefined;
	readonly canVote: boolean;
	readonly canCancel: boolean;
}

export interface ClaimPanelView {
	readonly canRequest: boolean;
	readonly maxTricks: number;
	readonly requestId: string | undefined;
	readonly requester: string;
	readonly tricks: number;
	readonly message: string;
	readonly canVote: boolean;
}

/** The contract shown in the sidebar header: "1♣ by North · Anna". Undefined until the auction has a contract. */
export interface ContractHeader {
	readonly level: number;
	readonly strain: Strain;
	/** The strain as text: a suit symbol, or "NT". */
	readonly symbol: string;
	readonly doubling: string;
	readonly declarer: Seat;
	/** The declarer's seat name, such as "North". */
	readonly direction: string;
	/** The declarer's player name; empty while the seat is free. */
	readonly name: string;
}

export interface TableView {
	readonly phase:
		| "loading"
		| "unreadable"
		| "waiting"
		| "auction"
		| "play"
		| "complete";
	/** The board on the table; 0 before the first deal. */
	readonly board: number;
	/** The number of calls and cards made on the board: the table position that actions are sent for. */
	readonly at: number;
	/** For example "Board 3", empty before the first deal. */
	readonly heading: string;
	readonly details: string;
	readonly prompt: string;
	/** This player can act now. */
	readonly yourTurn: boolean;
	readonly seats: readonly SeatView[];
	readonly auction: AuctionView | undefined;
	readonly bids: readonly BidView[];
	readonly contract: string;
	readonly header: ContractHeader | undefined;
	readonly tricks: string;
	readonly trick: TrickView | undefined;
	/** The viewer's partnership counts and target during play; undefined before play. */
	readonly need: TrickNeed | undefined;
	/** "Contract secured" or "Contract defeated" once decided; empty while open. */
	readonly trickStatus: string;
	readonly result: string;
	readonly scoring: ScoringView | undefined;
	readonly nextBoard: NextBoard | undefined;
	readonly actions: readonly TableActionLine[];
	readonly undo: UndoPanelView;
	readonly claim: ClaimPanelView;
	readonly scores: readonly ScoreRow[];
	readonly totals: { readonly ns: number; readonly ew: number };
	/** The "Previous game statistics" panel: the results of the boards played so far. */
	readonly statistics: { readonly ns: SideStats; readonly ew: SideStats };
}

/** One side's record over the boards played so far. A board is won by the side that scored on it. */
export interface SideStats {
	readonly won: number;
	readonly lost: number;
	readonly total: number;
}

export interface TableViewInput {
	readonly config: RoomConfig;
	readonly seat: Seat;
	/** The parsed table; `undefined` while the room is loading, `null` when its state is not a bridge table. */
	readonly state: BridgeState | null | undefined;
	/** The tab can no longer act (superseded, expired or stopped). */
	readonly terminal: boolean;
	/** The host's seat and the seats whose peer is connected to the host (plan §12 R4). */
	readonly present: ReadonlySet<Seat>;
	/** Every seat with its holder's connection state; a seat missing here is free. */
	readonly roster: readonly RosterRow[];
	/** Bot-controlled seats from the shared table roster. */
	readonly bots?: ReadonlySet<Seat>;
	/** The host's seat, or null while the host is not known. */
	readonly hostSeat: Seat | null;
	/** Seconds until the next board is dealt after scoring. */
	readonly scoringCountdown?: number;
	/** This seat's commands that are not in the log. */
	readonly outbox: readonly OutboxItem[];
	readonly failures: readonly CommandFailure[];
	readonly undone: readonly Entry[];
	readonly t?: Translate;
}

const EMPTY: Omit<TableView, "phase" | "prompt"> = {
	board: 0,
	at: 0,
	heading: "",
	details: "",
	yourTurn: false,
	seats: [],
	auction: undefined,
	bids: [],
	contract: "",
	header: undefined,
	tricks: "",
	trick: undefined,
	need: undefined,
	trickStatus: "",
	result: "",
	scoring: undefined,
	nextBoard: undefined,
	actions: [],
	undo: {
		canRequest: false,
		message: "",
		requestId: undefined,
		canVote: false,
		canCancel: false,
	},
	claim: {
		canRequest: false,
		maxTricks: 0,
		requestId: undefined,
		requester: "",
		tricks: 0,
		message: "",
		canVote: false,
	},
	scores: [],
	totals: { ns: 0, ew: 0 },
	statistics: {
		ns: { won: 0, lost: 0, total: 0 },
		ew: { won: 0, lost: 0, total: 0 },
	},
};

function sideStats(results: readonly BoardResult[]): {
	ns: SideStats;
	ew: SideStats;
} {
	const sums = totals(results);
	const count = (test: (scoreNS: number) => boolean): number =>
		results.filter((result) => test(result.scoreNS)).length;
	return {
		ns: {
			won: count((score) => score > 0),
			lost: count((score) => score < 0),
			total: sums.ns,
		},
		ew: {
			won: count((score) => score < 0),
			lost: count((score) => score > 0),
			total: sums.ew,
		},
	};
}

function presenceOf(
	roster: readonly RosterRow[],
	owner: Seat,
): RosterRow["state"] {
	return roster.find((row) => row.seat === owner)?.state ?? "free";
}

/**
 * The four seats of the lobby, before the first deal. A free seat shows no name and no cards; a joined seat
 * shows backs. The viewer's own backs appear only while the viewer waits for the host to connect.
 */
function lobbySeats(input: TableViewInput, t: Translate): SeatView[] {
	const { seat, config, roster, hostSeat, present, bots } = input;
	const hostOnline = hostSeat !== null && present.has(hostSeat);
	return SEATS.map((owner): SeatView => {
		const presence = presenceOf(roster, owner);
		const joined = presence !== "free";
		const connecting = owner === seat && hostSeat !== seat && !hostOnline;
		const backs = joined && (owner !== seat || connecting);
		return {
			seat: owner,
			position: positionOf(seat, owner),
			bot: bots?.has(owner) ?? false,
			label: joined
				? `${t(owner)} - ${config.names[owner]}${bots?.has(owner) ? " 🤖" : ""}`
				: t(SEAT_NAMES[owner]),
			name: joined ? config.names[owner] : "",
			tags: owner === hostSeat ? ["Host"] : [],
			turn: false,
			hand: { visible: false, count: backs ? 13 : 0 },
			presence,
			connecting,
			bidding: false,
			points: undefined,
		};
	});
}

function payloadBoard(payload: unknown): number {
	return isObject(payload) && typeof payload.board === "number"
		? payload.board
		: 0;
}

function isDealFor(payload: unknown, board: number): boolean {
	return (
		isObject(payload) && payload.type === "deal" && payload.board === board
	);
}

/**
 * This seat's table commands that still concern the table: in flight, refused with the reason, or undone by a
 * host change. Actions count for the current board, deals for a later board; a deal that lost the race to
 * another seat's deal is moot.
 */
function actionLines(
	input: TableViewInput,
	current: number,
): TableActionLine[] {
	const t = input.t ?? english;
	const relevant = (payload: unknown): boolean =>
		isTableCommand(payload) &&
		(isDealFor(payload, payloadBoard(payload))
			? payloadBoard(payload) > current
			: payloadBoard(payload) >= current);
	return ownCommands(input)
		.filter((line) => relevant(line.payload))
		.map((line) => ({
			id: line.id,
			text: commandText(line.payload, t),
			state: line.state === "not-sent" ? "not-accepted" : line.state,
			...(line.reason === undefined ? {} : { reason: line.reason }),
		}));
}

function suitRows(
	cards: readonly Card[],
	playable: ReadonlySet<Card>,
	order: readonly Suit[],
	trump: Suit | undefined,
): SuitRow[] {
	return order.map((suit) => ({
		suit,
		symbol: SUIT_SYMBOLS[suit],
		trump: suit === trump,
		cards: cards
			.filter((card) => suitOf(card) === suit)
			.map((card) => ({
				card,
				rank: rankText(card),
				text: cardText(card),
				suit,
				playable: playable.has(card),
			})),
	}));
}

function handDisplay(
	hand: HandView,
	playable: ReadonlySet<Card>,
	order: readonly Suit[],
	trump: Suit | undefined,
): HandDisplay {
	return hand.visible
		? { visible: true, suits: suitRows(hand.cards, playable, order, trump) }
		: { visible: false, count: hand.count };
}

/** The contract outcome, once decided. `status` is about the declarers, so it reads the same for every viewer. */
function contractHeader(
	contract: Contract | null | undefined,
	seats: readonly SeatView[],
	t: Translate,
): ContractHeader | undefined {
	if (!contract) return undefined;
	const declarer = seats.find((seat) => seat.seat === contract.declarer);
	return {
		level: contract.level,
		strain: contract.strain,
		symbol: strainText(contract.strain),
		doubling: contract.doubling,
		declarer: contract.declarer,
		direction: t(SEAT_NAMES[contract.declarer]),
		name: declarer?.name ?? "",
	};
}

function trickStatusText(status: TrickNeed["status"], t: Translate): string {
	if (status === "open") return "";
	return t(status === "secured" ? "Contract secured" : "Contract defeated");
}

function scoreRows(results: readonly BoardResult[]): ScoreRow[] {
	return results.map((result) => {
		const { contract, scoreNS } = result;
		return {
			number: result.number,
			contract: contract ? contractText(contract) : "Passed out",
			declarer: contract ? contract.declarer : "",
			outcome: outcomeText(result),
			ns: scoreNS > 0 ? String(scoreNS) : "",
			ew: scoreNS < 0 ? String(-scoreNS) : "",
		};
	});
}

function auctionView(dealer: Seat, calls: readonly Call[]): AuctionView {
	const cells = [
		...Array.from({ length: SEATS.indexOf(dealer) }, () => ""),
		...calls.map(callText),
	];
	const rows: string[][] = [];
	for (let i = 0; i < cells.length; i += 4) rows.push(cells.slice(i, i + 4));
	return { seats: SEATS, rows };
}

/** One action of this seat at a time: further clicks wait until the host has decided on the last one. */
function busy(lines: readonly TableActionLine[]): boolean {
	return lines.some(
		(line) => line.state === "sending" || line.state === "pending",
	);
}

function undoPanelView(
	state: BridgeState,
	seat: Seat,
	config: RoomConfig,
	terminal: boolean,
	declarerIsBot: boolean,
	outbox: readonly OutboxItem[],
	t: Translate,
): UndoPanelView {
	const pending = state.undo;
	const board = state.board;
	if (!pending) {
		const sending = outbox.some((item) => item.payload.type === "undo-request");
		return {
			canRequest:
				!terminal &&
				!declarerIsBot &&
				!sending &&
				state.claim === null &&
				state.claimResult === null &&
				state.undo === null &&
				board !== null &&
				undoPosition(board, seat) !== undefined,
			message: sending ? t("Undo request is being sent.") : "",
			requestId: undefined,
			canVote: false,
			canCancel: false,
		};
	}
	const waiting = pending.required.filter(
		(voter) => !pending.approved.includes(voter),
	);
	const waitingNames = waiting.map((voter) => config.names[voter]);
	const last = waitingNames.pop();
	const waitingText =
		last === undefined
			? ""
			: t("Waiting for {players} to approve.", {
					players: [...waitingNames, last].join(", "),
				});
	const requester = config.names[pending.requester];
	const action = t(
		pending.cards < (board?.cards.length ?? 0)
			? "last played card"
			: "last bid",
	);
	const voted = pending.approved.includes(seat);
	const voteSending = outbox.some(
		(item) =>
			item.payload.type === "undo-vote" &&
			item.payload.requestId === pending.id,
	);
	const cancelSending = outbox.some(
		(item) =>
			item.payload.type === "undo-cancel" &&
			item.payload.requestId === pending.id,
	);
	return {
		canRequest: false,
		message:
			pending.requester === seat
				? cancelSending
					? t(
							"You ask to undo your {action}. Your cancellation is being sent.",
							{ action },
						)
					: t("You ask to undo your {action}. {waiting}", {
							action,
							waiting: waitingText,
						})
				: voteSending
					? t(
							"{requester} asks to undo their {action}. Your vote is being sent.",
							{ requester, action },
						)
					: voted
						? t(
								"{requester} asks to undo their {action}. Your approval is recorded. {waiting}",
								{ requester, action, waiting: waitingText },
							)
						: t("{requester} asks to undo their {action}. {waiting}", {
								requester,
								action,
								waiting: waitingText,
							}),
		requestId: pending.id,
		canVote:
			!terminal && pending.required.includes(seat) && !voted && !voteSending,
		canCancel: !terminal && pending.requester === seat && !cancelSending,
	};
}

function claimPanelView(
	state: BridgeState,
	seat: Seat,
	config: RoomConfig,
	terminal: boolean,
	declarerIsBot: boolean,
	outbox: readonly OutboxItem[],
	t: Translate,
): ClaimPanelView {
	const pending = state.claim;
	const board = state.board;
	if (!pending) {
		const sending = outbox.some(
			(item) => item.payload.type === "claim-request",
		);
		const status = board ? boardStatus(board) : undefined;
		const maxTricks = status?.phase === "play" ? 13 - status.tricks.length : 0;
		return {
			canRequest:
				!terminal &&
				!declarerIsBot &&
				!sending &&
				state.undo === null &&
				state.claimResult === null &&
				status?.phase === "play" &&
				status.actor === seat &&
				status.contract.declarer === seat,
			maxTricks,
			requestId: undefined,
			requester: "",
			tricks: 0,
			message: sending ? t("Claim request is being sent.") : "",
			canVote: false,
		};
	}
	const waiting = pending.required.filter(
		(voter) => !pending.approved.includes(voter),
	);
	const names = waiting.map((voter) => config.names[voter]);
	const last = names.pop();
	const waitingText =
		last === undefined
			? ""
			: t("Waiting for {players} to decide.", {
					players: [...names, last].join(", "),
				});
	const requester = config.names[pending.requester];
	const voteSending = outbox.some(
		(item) =>
			item.payload.type === "claim-vote" &&
			item.payload.requestId === pending.id,
	);
	const approved = pending.approved.includes(seat);
	const tricks = t(pending.tricks === 1 ? "trick" : "tricks");
	return {
		canRequest: false,
		maxTricks: 0,
		requestId: pending.id,
		requester,
		tricks: pending.tricks,
		message:
			pending.requester === seat
				? t("Your claim for {count} {tricks} is waiting. {waiting}", {
						count: pending.tricks,
						tricks,
						waiting: waitingText,
					})
				: voteSending
					? t(
							"{requester} claims {count} {tricks}. Your decision is being sent.",
							{ requester, count: pending.tricks, tricks },
						)
					: approved
						? t(
								"{requester} claims {count} {tricks}. You accepted. {waiting}",
								{
									requester,
									count: pending.tricks,
									tricks,
									waiting: waitingText,
								},
							)
						: t(
								"{requester} claims {count} {tricks}. Your decision is needed.",
								{ requester, count: pending.tricks, tricks },
							),
		canVote:
			!terminal && pending.required.includes(seat) && !approved && !voteSending,
	};
}

export function tableView(input: TableViewInput): TableView {
	const { state, seat, config } = input;
	const t = input.t ?? english;
	if (state === undefined)
		return { ...EMPTY, phase: "loading", prompt: "Loading the table…" };
	if (state === null)
		return {
			...EMPTY,
			phase: "unreadable",
			prompt: "This room has no bridge table.",
		};
	const scores = scoreRows(state.results);
	const sums = totals(state.results);
	const board = state.board;
	const current = board?.number ?? 0;
	const actions = actionLines(input, current);
	const localBot = input.bots?.has(seat) ?? false;
	const localActionAllowed = !input.terminal && !localBot;
	const canStartAction =
		!input.terminal &&
		!busy(actions) &&
		state.undo === null &&
		state.claim === null;
	const canAct =
		localActionAllowed && canStartAction && state.claimResult === null;
	const currentStatus = board ? boardStatus(board) : undefined;
	const declarerIsBot =
		currentStatus !== undefined &&
		currentStatus.contract !== undefined &&
		currentStatus.contract !== null &&
		(input.bots?.has(currentStatus.contract.declarer) ?? false);
	const undo = undoPanelView(
		state,
		seat,
		config,
		!localActionAllowed,
		declarerIsBot,
		input.outbox,
		t,
	);
	const claim = claimPanelView(
		state,
		seat,
		config,
		!localActionAllowed,
		declarerIsBot,
		input.outbox,
		t,
	);
	// The host refuses a deal or a call unless all four seats are present (plan §12 R4).
	const allPresent = [...input.present];
	const dealWait = waitingText(SEATS, allPresent);
	const nextBoard = (): NextBoard => {
		const next = current + 1;
		return {
			board: next,
			ready: canStartAction && dealWait === undefined,
		};
	};
	if (!board)
		return {
			...EMPTY,
			phase: "waiting",
			heading: "ROOM CONNECTION",
			details: "Room lobby",
			prompt: dealWait ?? "The first board is dealt now.",
			seats: lobbySeats(input, t),
			nextBoard: nextBoard(),
			actions,
			undo,
			claim,
			scores,
			totals: sums,
		};

	const revealedSeats = state.claimResult
		? SEATS
		: state.claim
			? [state.claim.requester]
			: [];
	const rawView = viewForPlayer(board, seat, revealedSeats);
	const rawCompletedView = state.claimResult
		? (() => {
				const status = boardStatus(board);
				if (status.phase !== "play") return rawView;
				const remaining = 13 - status.tricks.length;
				const claimsNS =
					state.claimResult.requester === "N" ||
					state.claimResult.requester === "S";
				const tricksNS =
					status.tricksNS +
					(claimsNS
						? state.claimResult.tricks
						: remaining - state.claimResult.tricks);
				return {
					...rawView,
					phase: "complete" as const,
					turn: undefined,
					actor: undefined,
					tricksNS,
					tricksEW: 13 - tricksNS,
					result: state.claimResult.result,
				};
			})()
		: rawView;
	const view =
		rawCompletedView.phase === "complete"
			? {
					...rawCompletedView,
					hands: Object.fromEntries(
						SEATS.map((owner) => [
							owner,
							{ visible: true as const, cards: board.deal[owner] },
						]),
					) as typeof rawCompletedView.hands,
				}
			: rawCompletedView;
	// During play, declarer plays dummy's cards, so dummy may be away.
	const actionWait =
		view.phase === "play"
			? waitingText(
					SEATS.filter((owner) => owner !== view.dummy),
					allPresent,
				)
			: dealWait;
	const legal = canAct && actionWait === undefined ? view.legal : [];
	const playable = new Set(
		legal.flatMap((action: Action) =>
			action.type === "play" ? [action.card] : [],
		),
	);
	const { contract, dummy } = view;
	// Dealer, declarer and dummy are shown in the details and the contract line, not as panel badges (layout spec §4).
	// Every hand carries the trump suit first, or last on the right of the viewer (layout spec §7).
	const suitOrder = (owner: Seat): readonly Suit[] =>
		view.phase === "auction"
			? AUCTION_SUIT_ORDER
			: playSuitOrder(contract?.strain, positionOf(seat, owner));
	const trumpOf = (): Suit | undefined =>
		contract && contract.strain !== "NT" ? contract.strain : undefined;
	const need =
		contract && view.phase === "play"
			? trickNeed(seat, contract, view.tricksNS, view.tricksEW)
			: undefined;
	const seats = SEATS.map((owner): SeatView => {
		const tags = [
			...(owner === input.hostSeat ? ["Host"] : []),
			...(view.phase === "play" && owner === dummy ? ["Dummy"] : []),
			...(view.phase === "play" && owner === contract?.declarer
				? ["Declarer"]
				: []),
		];
		return {
			seat: owner,
			position: positionOf(seat, owner),
			bot: input.bots?.has(owner) ?? false,
			label: `${t(owner)} - ${config.names[owner]}${input.bots?.has(owner) ? " 🤖" : ""}`,
			name: config.names[owner],
			tags,
			turn: owner === view.turn,
			hand: handDisplay(
				view.hands[owner],
				playable,
				suitOrder(owner),
				trumpOf(),
			),
			presence: presenceOf(input.roster, owner),
			connecting: false,
			bidding: view.phase === "auction" && owner === view.turn,
			points:
				view.phase === "auction" && view.hands[owner].visible
					? miltonPoints(view.hands[owner].cards)
					: undefined,
		};
	});

	const lastTrick = view.tricks.at(-1);
	const showLast =
		view.current === undefined || view.current.cards.length === 0;
	const trickSource =
		showLast && lastTrick
			? {
					title: "Previous trick",
					detail: `Trick ${view.tricks.length} · ${SEAT_NAMES[lastTrick.winner]} won`,
					leader: lastTrick.leader,
					cards: lastTrick.cards,
				}
			: view.current && {
					title: "Current trick",
					detail: `Trick ${view.tricks.length + 1}`,
					leader: view.current.leader,
					cards: view.current.cards,
				};
	const trick: TrickView | undefined =
		view.phase === "complete"
			? undefined
			: trickSource && {
					title: trickSource.title,
					detail: trickSource.detail,
					cards: trickSource.cards.map((card, index) => {
						const player = seatAfter(trickSource.leader, index);
						return {
							seat: player,
							position: positionOf(seat, player),
							card,
							text: cardText(card),
							rank: rankText(card),
							symbol: SUIT_SYMBOLS[suitOf(card)],
						};
					}),
				};

	const common = {
		...EMPTY,
		board: board.number,
		at: board.calls.length + board.cards.length,
		heading: t("Board {number}", { number: board.number }),
		details: t("Dealer: {dealer} · Vulnerable: {vulnerable}", {
			dealer: t(SEAT_NAMES[view.dealer]),
			vulnerable: t(VULNERABILITY_TEXT[view.vulnerability]),
		}),
		seats,
		auction: auctionView(view.dealer, view.calls),
		contract: contract
			? `${contractText(contract)} by ${SEAT_NAMES[contract.declarer]}`
			: "",
		header: contractHeader(contract, seats, t),
		tricks: contract
			? t("Tricks: N-S {ns} · E-W {ew}", {
					ns: view.tricksNS,
					ew: view.tricksEW,
				})
			: "",
		trick,
		need,
		trickStatus: need ? trickStatusText(need.status, t) : "",
		actions,
		undo,
		claim,
		scores,
		totals: sums,
		statistics: sideStats(state.results),
	};

	if (view.phase === "complete") {
		const result = state.results.find((item) => item.number === board.number);
		const contract = result?.contract;
		const declarerMade =
			contract !== undefined &&
			contract !== null &&
			result !== undefined &&
			result.declarerTricks >= contract.level + 6;
		const viewerWon =
			contract !== undefined &&
			contract !== null &&
			result !== undefined &&
			((seat === "N" || seat === "S") ===
				(contract.declarer === "N" || contract.declarer === "S")) ===
				declarerMade;
		const margin =
			contract !== undefined && contract !== null && result !== undefined
				? Math.abs(result.declarerTricks - (contract.level + 6))
				: 0;
		const viewerIsDeclarerSide =
			contract !== undefined &&
			contract !== null &&
			(seat === "N" || seat === "S") ===
				(contract.declarer === "N" || contract.declarer === "S");
		const compactDetail = contract
			? viewerIsDeclarerSide
				? declarerMade
					? margin === 0
						? t("Made contract")
						: t("Made +{margin}", { margin })
					: t("Down {margin}", { margin })
				: declarerMade
					? margin === 0
						? t("Opponents made contract")
						: t("Opponents made +{margin}", { margin })
					: t("Opponents down {margin}", { margin })
			: "";
		return {
			...common,
			phase: "complete",
			prompt: dealWait ?? "",
			result: view.result
				? `${view.result.contract !== null && view.result.scoreNS !== 0 ? t("Winner: {side}. ", { side: view.result.scoreNS > 0 ? "N-S" : "E-W" }) : ""}${resultText(view.result, t)}`
				: "",
			scoring: {
				contract: contract ?? undefined,
				compactOutcome: contract ? (viewerWon ? "WON" : "LOST") : "PASSED OUT",
				compactDetail,
				countdown: input.scoringCountdown ?? 10,
			},
			nextBoard: nextBoard(),
		};
	}
	const turn = view.turn as Seat;
	const bids = legal.flatMap((action): BidView[] =>
		action.type === "call"
			? [{ call: action.call, text: callText(action.call) }]
			: [],
	);
	if (view.phase === "auction") {
		return {
			...common,
			phase: "auction",
			yourTurn: canAct && actionWait === undefined && turn === seat,
			heading: "AUCTION",
			bids,
			prompt: actionWait ?? `${SEAT_NAMES[turn]} to bid`,
		};
	}
	const actor = view.actor as Seat;
	const fromDummy = turn === dummy;
	let prompt: string;
	if (actionWait !== undefined) prompt = actionWait;
	else if (actor === seat)
		prompt = fromDummy
			? "Your turn: play a card from dummy."
			: "Your turn to play.";
	else if (fromDummy)
		prompt = `Waiting for ${SEAT_NAMES[actor]} to play from dummy.`;
	else prompt = `Waiting for ${SEAT_NAMES[turn]} to play.`;
	return {
		...common,
		phase: "play",
		yourTurn: canAct && actionWait === undefined && actor === seat,
		prompt,
	};
}
