import { cardsById } from "../bot/canasta-text";
import {
	type Action,
	actionsWithCards,
	type Card,
	CLASSIC_RULES,
	type HandView,
	initialMeldMinimum,
	isBlack3,
	isCanasta,
	isRed3,
	isWild,
	legalActions,
	type MatchState,
	type Meld,
	type Outcome,
	type Suit,
	scoreHand,
	teamOf,
} from "../canasta";
import {
	type CanastaState,
	engineSeat,
	handViewFor,
	isTableCommand,
	parseAction,
	tableSeat,
	waitingText,
} from "../game/canasta";
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
} from "../protocol";
import { ownCommands, type RosterRow } from "./model";

/**
 * Pure view model of the canasta table: the DOM layer only renders what these functions return.
 *
 * The rules come from the engine (`legalActions`, `viewFor`). This module only shapes them for the
 * screen: it does not decide what is legal beyond asking the engine.
 */

export const SUIT_SYMBOLS: Readonly<Record<Suit, string>> = {
	C: "♣",
	D: "♦",
	H: "♥",
	S: "♠",
};

/** The two sides in engine team order: index 0 is North-South, index 1 is East-West. */
const SIDE_SEATS = [
	["N", "S"],
	["E", "W"],
] as const;

/** A side's name from the translated seat letters, such as "N-S" or, in Hungarian, "É-D". */
function sideLabel(team: 0 | 1, t: Translate): string {
	return SIDE_SEATS[team].map((seat) => t(seat)).join("-");
}

// ---------------------------------------------------------------------------------------------------------------
// Cards

export interface CardView {
	readonly id: string;
	/** "3" to "10", "J", "Q", "K", "A", "2", or "JK" for a joker. */
	readonly rank: string;
	/** Null for a joker. */
	readonly suit: Suit | null;
	/** For example "10♠", or "Joker". */
	readonly text: string;
}

/** A card as the screen names it: the rank and the suit symbol, or "Joker". */
export function cardText(
	card: Pick<Card, "rank" | "suit">,
	t: Translate = english,
): string {
	return card.suit === null
		? t("Joker")
		: `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
}

function cardView(card: Card, t: Translate): CardView {
	return {
		id: card.id,
		rank: card.rank,
		suit: card.suit,
		text: cardText(card, t),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Labels

/** A part of a label: text, or a card that the screen shows as a card. */
export type LabelPart =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "card"; readonly card: CardView };

export type Label = readonly LabelPart[];

/** The label as plain text, with each card as its rank and suit symbol. */
export function labelText(label: Label): string {
	return label
		.map((part) => (part.kind === "text" ? part.text : part.card.text))
		.join("");
}

/**
 * Fills the `{name}` placeholders of a translated template. A placeholder can stand for text or for cards; the
 * cards of one placeholder are separated by spaces.
 */
function labelOf(
	template: string,
	values: Readonly<Record<string, string | readonly CardView[]>> = {},
): Label {
	const parts: LabelPart[] = [];
	const text = (value: string): void => {
		const last = parts.at(-1);
		if (value === "") return;
		if (last?.kind === "text")
			parts[parts.length - 1] = { kind: "text", text: last.text + value };
		else parts.push({ kind: "text", text: value });
	};
	let rest = 0;
	for (const match of template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
		text(template.slice(rest, match.index));
		rest = match.index + match[0].length;
		const value = values[match[1] as string];
		if (value === undefined) text(match[0]);
		else if (typeof value === "string") text(value);
		else
			for (const [index, card] of value.entries()) {
				if (index > 0) text(" ");
				parts.push({ kind: "card", card });
			}
	}
	text(template.slice(rest));
	return parts;
}

// ---------------------------------------------------------------------------------------------------------------
// Sides and melds

export interface MeldView {
	readonly id: string;
	readonly rank: string;
	readonly cards: readonly CardView[];
	/** A canasta: seven cards or more. */
	readonly canasta: boolean;
}

export interface SideView {
	/** "N-S" or "E-W", with the translated seat letters. */
	readonly label: string;
	/** "ours" for the viewer's side, "theirs" for the opponents, translated. */
	readonly owner: string;
	/** The settled score of the match. */
	readonly score: number;
	/** The viewer's own side. */
	readonly mine: boolean;
	readonly melds: readonly MeldView[];
	/** Red threes stay on the table as a bonus; the count is `redThrees.length`. */
	readonly redThrees: readonly CardView[];
	/** The side has made its initial meld in this match, so the pile is no longer frozen by it. */
	readonly initialMade: boolean;
	/**
	 * Until the side melds: its minimum for the first meld, and the points melded in its current turn, translated.
	 * Empty once the side has melded.
	 */
	readonly initialMeld: string;
}

function meldView(meld: Meld, view: HandView, t: Translate): MeldView {
	return {
		id: meld.id,
		rank: meld.rank,
		cards: meld.cards.map((card) => cardView(card, t)),
		canasta: isCanasta(meld, view.rules),
	};
}

function sideViews(
	scores: readonly [number, number],
	viewer: Seat,
	view: HandView | undefined,
	t: Translate,
): readonly [SideView, SideView] {
	const side = (index: 0 | 1): SideView => {
		const team = view?.teams[index];
		const mine = teamOf(engineSeat(viewer)) === index;
		return {
			label: sideLabel(index, t),
			owner: mine ? t("ours") : t("theirs"),
			score: scores[index],
			mine,
			melds:
				view && team ? team.melds.map((meld) => meldView(meld, view, t)) : [],
			redThrees: team ? team.redThrees.map((card) => cardView(card, t)) : [],
			initialMade: team?.initialMade ?? false,
			initialMeld:
				view && team && !team.initialMade
					? initialMeldLine(view, index, t)
					: "",
		};
	};
	return [side(0), side(1)];
}

/** The side's first meld minimum comes from its score at the deal; only the side on turn has melded points. */
function initialMeldLine(view: HandView, side: 0 | 1, t: Translate): string {
	const minimum = initialMeldMinimum(
		view.rules.initialMeld,
		view.teamScores[side],
	);
	const points = teamOf(view.turn) === side ? view.turnMeldPoints : 0;
	return points > 0
		? t("First meld: {points} of {minimum} points", { points, minimum })
		: t("First meld: at least {minimum} points", { minimum });
}

// ---------------------------------------------------------------------------------------------------------------
// Seats

/** Places around the table, as the viewer sees it: the viewer always sits at the bottom. */
export type Position = "bottom" | "left" | "top" | "right";
const POSITIONS: readonly Position[] = ["bottom", "left", "top", "right"];

export function positionOf(viewer: Seat, seat: Seat): Position {
	const steps = (SEATS.indexOf(seat) - SEATS.indexOf(viewer) + 4) % 4;
	return POSITIONS[steps] as Position;
}

export interface SeatView {
	readonly seat: Seat;
	readonly position: Position;
	/** This seat is controlled by a host-managed bot, as reported in the shared roster. */
	readonly bot: boolean;
	/** The seat tag and the player name, such as "N - David"; the seat name alone while the seat is free. */
	readonly label: string;
	/** The player's name; empty while the seat is free. */
	readonly name: string;
	readonly tags: readonly string[];
	/** The seat to act in the current hand. */
	readonly turn: boolean;
	/** Cards in the seat's hand. The viewer's own count is its hand length. */
	readonly handCount: number;
	/** Whether a player holds the seat, and whether that player is connected. */
	readonly presence: RosterRow["state"];
	/** The viewer is not the host and the host is not connected yet. Only the lobby shows it. */
	readonly connecting: boolean;
}

function presenceOf(
	roster: readonly RosterRow[],
	owner: Seat,
): RosterRow["state"] {
	return roster.find((row) => row.seat === owner)?.state ?? "free";
}

function seatViews(
	input: TableViewInput,
	t: Translate,
	lobby: boolean,
	turn: Seat | undefined,
	handCount: (seat: Seat) => number,
): SeatView[] {
	const { seat, config, roster, hostSeat, present, bots } = input;
	const hostOnline = hostSeat !== null && present.has(hostSeat);
	return SEATS.map((owner): SeatView => {
		const presence = presenceOf(roster, owner);
		const joined = presence !== "free";
		const bot = bots?.has(owner) ?? false;
		return {
			seat: owner,
			position: positionOf(seat, owner),
			bot,
			label: joined
				? `${t(owner)} - ${config.names[owner]}`
				: t(SEAT_NAMES[owner]),
			name: joined ? config.names[owner] : "",
			tags: [...(owner === hostSeat ? ["Host"] : []), ...(bot ? ["Bot"] : [])],
			turn: owner === turn,
			handCount: handCount(owner),
			presence,
			connecting: lobby && owner === seat && hostSeat !== seat && !hostOnline,
		};
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Pile, stock and actions

export interface PileView {
	/** The top card of the discard pile; undefined when the pile is empty. */
	readonly top: CardView | undefined;
	readonly count: number;
	/** The viewer's side can take the pile only with a natural pair from the hand. */
	readonly frozen: boolean;
}

/** One legal action of the viewer, with its label in the viewer's language. */
export interface ActionOption {
	/** A stable key for the option, unique among the options of one position. */
	readonly key: string;
	readonly label: Label;
	readonly action: Action;
	/** The card ids the action uses from the viewer's hand. Empty for a draw and for a reset. */
	readonly cards: readonly string[];
	/** Offered also while no card is selected, although the action uses hand cards. */
	readonly ready?: boolean;
}

function cardIdsOf(action: Action): readonly string[] {
	switch (action.type) {
		case "draw":
		case "resetTurn":
			return [];
		case "discard":
			return [action.card];
		default:
			return action.cards;
	}
}

/**
 * A meld as an action names it: its rank, and its place among the side's melds of that rank when the side has
 * more than one.
 */
function meldName(view: HandView, meldId: string): string {
	for (const team of view.teams) {
		const meld = team.melds.find((item) => item.id === meldId);
		if (meld === undefined) continue;
		const same = team.melds.filter((item) => item.rank === meld.rank);
		return same.length > 1
			? `${meld.rank} #${same.indexOf(meld) + 1}`
			: meld.rank;
	}
	return meldId;
}

/** One action in the viewer's language, with the cards it uses as cards. */
function actionLabel(action: Action, view: HandView, t: Translate): Label {
	const known = cardsById(view);
	const cards = (ids: readonly string[]): CardView[] =>
		ids.flatMap((id) => {
			const card = known.get(id);
			return card === undefined ? [] : [cardView(card, t)];
		});
	switch (action.type) {
		case "draw":
			if (view.stockCount === 0)
				return labelOf(t("End the hand: the stock is empty"));
			return view.rules.drawCount === 1
				? labelOf(t("Draw a card from the stock"))
				: labelOf(t("Draw {count} cards from the stock"), {
						count: String(view.rules.drawCount),
					});
		case "takePile": {
			const top = view.pile.at(-1);
			const values = {
				top: top === undefined ? [] : [cardView(top, t)],
				cards: cards(action.cards),
			};
			if (action.extend === undefined)
				return labelOf(
					t("Take the pile ({top}) and meld it with {cards}"),
					values,
				);
			const meld = meldName(view, action.extend);
			// Onto an existing meld the top card can go alone, with no hand card.
			return action.cards.length === 0
				? labelOf(t("Take the pile ({top}) onto the {meld} meld"), {
						...values,
						meld,
					})
				: labelOf(
						t("Take the pile ({top}) with {cards} onto the {meld} meld"),
						{
							...values,
							meld,
						},
					);
		}
		case "meld":
			return labelOf(t("Lay down a meld: {cards}"), {
				cards: cards(action.cards),
			});
		case "extend":
			return labelOf(t("Add {cards} to the {meld} meld"), {
				cards: cards(action.cards),
				meld: meldName(view, action.meldId),
			});
		case "discard":
			return labelOf(t("Discard {card}"), { card: cards([action.card]) });
		case "resetTurn":
			return labelOf(t("Take back this turn's melds"));
	}
}

function optionOf(view: HandView, action: Action, t: Translate): ActionOption {
	return {
		key: JSON.stringify(action),
		label: actionLabel(action, view, t),
		action,
		cards: cardIdsOf(action),
	};
}

/** An action as a key that does not depend on the order of its cards. */
function actionKey(action: Action): string {
	return JSON.stringify(
		"cards" in action ? { ...action, cards: [...action.cards].sort() } : action,
	);
}

function sameIds(a: readonly string[], sortedB: readonly string[]): boolean {
	const sortedA = [...a].sort();
	return (
		sortedA.length === sortedB.length &&
		sortedA.every((id, index) => id === sortedB[index])
	);
}

/**
 * The pickups that need no selection: those with the fewest hand cards, and of those the fewest wild cards, one
 * per label. Without them, a player sees no way to take the pile until the selection names the cards of a pickup.
 */
function withReadyPickups(
	options: readonly ActionOption[],
	view: HandView,
): ActionOption[] {
	const known = cardsById(view);
	const wilds = (option: ActionOption): number =>
		option.cards.filter((id) => {
			const card = known.get(id);
			return card !== undefined && isWild(card);
		}).length;
	const pickups = options.filter((option) => option.action.type === "takePile");
	const fewest = Math.min(...pickups.map((option) => option.cards.length));
	const natural = Math.min(
		...pickups.filter((option) => option.cards.length === fewest).map(wilds),
	);
	const labels = new Set<string>();
	return options.map((option) => {
		if (
			option.action.type !== "takePile" ||
			option.cards.length !== fewest ||
			wilds(option) !== natural
		)
			return option;
		const text = labelText(option.label);
		if (labels.has(text)) return option;
		labels.add(text);
		return { ...option, ready: true };
	});
}

/**
 * The options that a selection of card ids can send: every option that names exactly the selected cards, and the
 * options that name no card (a draw, a reset). With no selection, the ready options also show. The selection is
 * any set of ids; the engine validated the options.
 */
export function optionsFor(
	options: readonly ActionOption[],
	selected: readonly string[],
): ActionOption[] {
	const chosen = [...selected].sort();
	return options.filter(
		(option) =>
			option.cards.length === 0 ||
			(chosen.length === 0 && option.ready === true) ||
			sameIds(option.cards, chosen),
	);
}

/**
 * The options that a selection of card ids can send in the given view: `optionsFor` its options, and the meld,
 * extension or pickup of exactly the selected cards when the options do not list it. The options list only small
 * card sets, so a meld of five cards or more, up to a canasta from the hand, comes from here.
 */
export function selectionOptions(
	input: TableViewInput,
	view: TableView,
	selected: readonly string[],
): ActionOption[] {
	const shown = optionsFor(view.options, selected);
	const match = input.state?.match;
	if (!view.yourTurn || match === undefined || match === null) return shown;
	const hand = handViewFor(match, input.seat);
	const t = input.t ?? english;
	const listed = new Set(shown.map((option) => actionKey(option.action)));
	const more = actionsWithCards(match.hand, engineSeat(input.seat), selected)
		.filter((action) => !listed.has(actionKey(action)))
		.map((action) => optionOf(hand, action, t));
	return [...shown, ...more];
}

// ---------------------------------------------------------------------------------------------------------------
// Commands and text

export type TableActionState =
	| "sending"
	| "pending"
	| "not-accepted"
	| "undone";

export interface TableActionLine {
	readonly id: string;
	readonly label: Label;
	readonly state: TableActionState;
	/** Why the host refused or holds the command, in the viewer's language. */
	readonly reason?: string;
}

/** Short label of a table command, for the list of this seat's commands in flight. */
export function commandLabel(
	payload: unknown,
	t: Translate = english,
	view?: HandView,
): Label {
	if (!isObject(payload)) return [];
	if (payload.type === "start") return labelOf(t("Deal the first hand"));
	if (payload.type === "next-hand") return labelOf(t("Deal the next hand"));
	if (payload.type === "action") {
		const action = parseAction(payload.action);
		return action && view ? actionLabel(action, view, t) : labelOf(t("Action"));
	}
	return [];
}

/** The host's reasons that name a card, a number or a player; each becomes a translated message with values. */
const REASON_PATTERNS: readonly {
	readonly pattern: RegExp;
	readonly message: string;
	readonly names?: readonly string[];
}[] = [
	{
		pattern: /^card \S+ is not in your hand$/,
		message: "a chosen card is not in your hand",
	},
	{
		pattern: /^a meld may hold at most (\d+) wild cards$/,
		message: "a meld may hold at most {count} wild cards",
		names: ["count"],
	},
	{
		pattern: /^the cards do not match the meld rank (\S+)$/,
		message: "the cards do not match the meld rank {rank}",
		names: ["rank"],
	},
];

/** A reason from the host or the engine, in the viewer's language. */
function translateReason(reason: string, t: Translate): string {
	if (reason.startsWith("Waiting for ")) return translateWait(reason, t);
	for (const { pattern, message, names = [] } of REASON_PATTERNS) {
		const match = pattern.exec(reason);
		if (match)
			return t(
				message,
				Object.fromEntries(
					names.map((name, index) => [name, match[index + 1] ?? ""]),
				),
			);
	}
	return t(reason);
}

/** This seat's table commands that still concern the table: in flight, refused, or undone by a host change. */
function commandLines(
	input: TableViewInput,
	handNo: number,
	view: HandView | undefined,
): TableActionLine[] {
	const t = input.t ?? english;
	const relevant = (payload: unknown): boolean =>
		isTableCommand(payload) &&
		(!isObject(payload) ||
			payload.type !== "action" ||
			payload.hand === handNo);
	return ownCommands(input)
		.filter((line) => relevant(line.payload))
		.map((line) => ({
			id: line.id,
			label: commandLabel(line.payload, t, view),
			state: line.state === "not-sent" ? "not-accepted" : line.state,
			...(line.reason === undefined
				? {}
				: { reason: translateReason(line.reason, t) }),
		}));
}

function outcomeText(
	outcome: Outcome,
	config: RoomConfig,
	t: Translate,
): string {
	if (outcome.kind === "stock")
		return t("The stock ran out. No side went out.");
	const values = {
		name: config.names[tableSeat(outcome.seat)],
		side: sideLabel(teamOf(outcome.seat), t),
	};
	return outcome.concealed
		? t("{name} ({side}) went out concealed.", values)
		: t("{name} ({side}) went out.", values);
}

/** The score of the finished hand, item by item for each side, then the hand total and the match total. */
function scoreRows(match: MatchState, t: Translate): readonly ScoreRow[] {
	const [first, second] = scoreHand(match.hand);
	const row = (
		label: string,
		item: (score: typeof first) => number,
	): ScoreRow => ({ label: t(label), values: [item(first), item(second)] });
	return [
		row("Melds", (score) => score.melds),
		row("Canasta bonuses", (score) => score.canastaBonus),
		row("Red 3s", (score) => score.redThrees),
		row("Going out", (score) => score.outBonus),
		row("Cards in hand", (score) => score.handPenalty),
		row("Hand score", (score) => score.total),
		{ label: t("Match score"), values: match.scores },
	];
}

/** The engine's waiting text names the absent players; this translates the names and the sentence. */
function translateWait(text: string, t: Translate): string {
	const waiting = /^Waiting for (.+) to come back$/.exec(text);
	if (!waiting) return t(text);
	const names = (waiting[1] as string).split(/, | and /).map((name) => t(name));
	const last = names.pop();
	const players =
		last === undefined
			? ""
			: names.length === 0
				? last
				: `${names.join(", ")} ${t("and")} ${last}`;
	return t("Waiting for {players} to come back", { players });
}

// ---------------------------------------------------------------------------------------------------------------
// The view

export type TablePhase =
	| "loading"
	| "unreadable"
	| "waiting"
	| "play"
	| "hand-over"
	| "complete";

export interface ScoreRow {
	readonly label: string;
	/** The value for N-S, then for E-W, in the order of `TableView.sides`. */
	readonly values: readonly [number, number];
}

export interface ScoringView {
	/** How the hand ended, for example "Ben (E-W) went out.". */
	readonly outcome: string;
	readonly rows: readonly ScoreRow[];
	/** Seconds until the host deals the next hand; undefined once the match is over. */
	readonly countdown: number | undefined;
}

export interface TableView {
	readonly phase: TablePhase;
	/** The hand on the table; 0 before the match starts. */
	readonly handNo: number;
	/** The number of accepted actions in the hand: the table position that actions are sent for. */
	readonly at: number;
	/** For example "Hand 3", empty before the match starts. */
	readonly heading: string;
	readonly details: string;
	readonly prompt: string;
	/** This player can act now. */
	readonly yourTurn: boolean;
	/** The score a side must reach to win the match. */
	readonly target: number;
	readonly sides: readonly [SideView, SideView];
	readonly seats: readonly SeatView[];
	/** The viewer's hand in engine order; the screen sorts it. */
	readonly own: readonly CardView[];
	/** The ids of the viewer's cards that this turn drew or took from the pile. */
	readonly taken: readonly string[];
	readonly stockCount: number;
	readonly pile: PileView;
	/** The legal actions of the viewer now; empty unless it is the viewer's turn and no command is in flight. */
	readonly options: readonly ActionOption[];
	/** Set once a hand is over and before the next hand is dealt. */
	readonly scoring: ScoringView | undefined;
	/** "N-S won the match." once the match is over; empty otherwise. */
	readonly winner: string;
	readonly lines: readonly TableActionLine[];
}

export interface TableViewInput {
	readonly config: RoomConfig;
	readonly seat: Seat;
	/** The parsed table; `undefined` while the room is loading, `null` when its state is not a canasta table. */
	readonly state: CanastaState | null | undefined;
	/** The tab can no longer act (superseded, expired or stopped). */
	readonly terminal: boolean;
	/** The host's seat and the seats whose peer is connected to the host. */
	readonly present: ReadonlySet<Seat>;
	/** Every seat with its holder's connection state; a seat missing here is free. */
	readonly roster: readonly RosterRow[];
	/** Bot-controlled seats from the shared table roster. */
	readonly bots?: ReadonlySet<Seat>;
	/** The host's seat, or null while the host is not known. */
	readonly hostSeat: Seat | null;
	/** Seconds until the next hand is dealt after scoring. */
	readonly scoringCountdown?: number;
	/** This seat's commands that are not in the log. */
	readonly outbox: readonly OutboxItem[];
	readonly failures: readonly CommandFailure[];
	readonly undone: readonly Entry[];
	readonly t?: Translate;
}

function emptyView(
	input: TableViewInput,
	phase: TablePhase,
	prompt: string,
): TableView {
	const target = CLASSIC_RULES.targetScore;
	return {
		phase,
		handNo: 0,
		at: 0,
		heading: "",
		details: "",
		prompt,
		yourTurn: false,
		target,
		sides: sideViews([0, 0], input.seat, undefined, input.t ?? english),
		seats: [],
		own: [],
		taken: [],
		stockCount: 0,
		pile: { top: undefined, count: 0, frozen: false },
		options: [],
		scoring: undefined,
		winner: "",
		lines: [],
	};
}

/** What the viewer on turn can do now; when the pile cannot be taken before the draw, the prompt says why. */
function turnPrompt(
	match: MatchState,
	seat: Seat,
	view: HandView,
	t: Translate,
): string {
	if (view.phase !== "draw") return playPrompt(view, t);
	const actions = legalActions(match.hand, engineSeat(seat));
	const canTake = actions.some((action) => action.type === "takePile");
	if (view.stockCount > 0 && canTake)
		return t("Your turn: draw from the stock, or take the pile.");
	if (canTake)
		return actions.some((action) => action.type === "draw")
			? t("Your turn: the stock is empty. Take the pile, or end the hand.")
			: t(
					"Your turn: the stock is empty, and the pile goes onto your meld: take it.",
				);
	const turn =
		view.stockCount > 0
			? t("Your turn: draw from the stock.")
			: t("Your turn: the stock is empty. End the hand.");
	const hint = pileHint(view, t);
	return hint === undefined ? turn : `${turn} ${hint}`;
}

/**
 * After the draw, a side that has not melded sees its progress towards the first meld minimum. A side below the
 * minimum can discard only after it takes back the melds of the turn.
 */
function playPrompt(view: HandView, t: Translate): string {
	const side = teamOf(view.turn);
	if (view.teams[side].initialMade)
		return t("Your turn: meld, extend, then discard.");
	const minimum = initialMeldMinimum(
		view.rules.initialMeld,
		view.teamScores[side],
	);
	const points = view.turnMeldPoints;
	if (points === 0)
		return t(
			"Your turn: your side's first meld needs at least {minimum} points. Meld, or discard.",
			{ minimum },
		);
	if (points < minimum)
		return t(
			"Your turn: your side's first meld has {points} of the {minimum} points. Meld {missing} more, or take back this turn's melds.",
			{ points, minimum, missing: minimum - points },
		);
	return t(
		"Your turn: your side's first meld has {points} points, enough for the {minimum}. Meld more, or discard.",
		{ points, minimum },
	);
}

/**
 * Why the viewer on turn cannot take the pile: its top card blocks it, or the hand lacks the cards that the top
 * card needs. A hand that holds those cards gets no reason, because another rule refuses the pickup.
 */
function pileHint(view: HandView, t: Translate): string | undefined {
	const top = view.pile.at(-1);
	if (top === undefined) return undefined;
	if (isBlack3(top))
		return t("A black 3 on top blocks the pile for this turn.");
	if (isWild(top))
		return t("A wild card on top blocks the pile for this turn.");
	const rank = top.rank;
	const naturals = view.own.filter((card) => card.rank === rank).length;
	if (view.pileFrozen) {
		if (naturals >= 2) return undefined;
		return view.pile.some((card) => isWild(card) || isRed3(card))
			? t("The pile is frozen: to take it, you need two natural {rank}s.", {
					rank,
				})
			: t(
					"Until your side melds, you need two natural {rank}s to take the pile.",
					{
						rank,
					},
				);
	}
	const wilds = view.own.filter(isWild).length;
	const melded = view.teams[teamOf(view.turn)].melds.some(
		(meld) => meld.rank === rank,
	);
	if (melded || naturals >= 2 || (naturals >= 1 && wilds >= 1))
		return undefined;
	return t(
		"To take the pile, you need two {rank}s, or a {rank} and a wild card.",
		{ rank },
	);
}

export function tableView(input: TableViewInput): TableView {
	const { state, seat, config } = input;
	const t = input.t ?? english;
	if (state === undefined)
		return emptyView(input, "loading", t("Loading the table…"));
	if (state === null)
		return emptyView(input, "unreadable", t("This room has no canasta table."));

	const match = state.match;
	const dealWait = waitingText(SEATS, [...input.present]);
	if (match === null) {
		const lines = commandLines(input, 0, undefined);
		return {
			...emptyView(input, "waiting", ""),
			heading: t("Lobby"),
			details: t("Room lobby"),
			prompt:
				dealWait === undefined
					? t("The first hand is dealt now.")
					: translateWait(dealWait, t),
			seats: seatViews(input, t, true, undefined, () => 0),
			lines,
		};
	}

	const view = handViewFor(match, seat);
	const turnSeat = tableSeat(view.turn);
	const lines = commandLines(input, match.handNo, view);
	const busy = lines.some(
		(line) => line.state === "sending" || line.state === "pending",
	);
	const localBot = input.bots?.has(seat) ?? false;
	const canAct = !input.terminal && !localBot && !busy;
	const phase: TablePhase =
		match.winner !== null
			? "complete"
			: view.outcome !== null
				? "hand-over"
				: "play";
	const yourTurn =
		phase === "play" && turnSeat === seat && canAct && dealWait === undefined;
	const options = yourTurn
		? withReadyPickups(
				legalActions(match.hand, engineSeat(seat)).map((action) =>
					optionOf(view, action, t),
				),
				view,
			)
		: [];

	let prompt: string;
	if (dealWait !== undefined) prompt = translateWait(dealWait, t);
	else if (phase === "complete") prompt = t("The match is over.");
	else if (phase === "hand-over") prompt = t("The hand is over.");
	else if (turnSeat === seat) prompt = turnPrompt(match, seat, view, t);
	else prompt = t("Waiting for {name}.", { name: config.names[turnSeat] });

	const top = view.pile.at(-1);
	const winner =
		match.winner === null
			? ""
			: t("{side} won the match.", { side: sideLabel(match.winner, t) });
	const scoring =
		view.outcome !== null && phase !== "play"
			? {
					outcome: outcomeText(view.outcome, config, t),
					rows: scoreRows(match, t),
					countdown:
						phase === "hand-over" ? (input.scoringCountdown ?? 10) : undefined,
				}
			: undefined;

	return {
		phase,
		handNo: match.handNo,
		at: state.actions,
		heading: t("Hand {number}", { number: match.handNo }),
		details: t("Dealer: {dealer}", {
			dealer: config.names[tableSeat(view.dealer)],
		}),
		prompt,
		yourTurn,
		target: match.rules.targetScore,
		sides: sideViews(match.scores, seat, view, t),
		seats: seatViews(
			input,
			t,
			false,
			phase === "play" ? turnSeat : undefined,
			(owner) => {
				return view.handCounts[engineSeat(owner)] ?? 0;
			},
		),
		own: view.own.map((card) => cardView(card, t)),
		taken: view.taken,
		stockCount: view.stockCount,
		pile: {
			top: top === undefined ? undefined : cardView(top, t),
			count: view.pile.length,
			frozen: view.pileFrozen,
		},
		options,
		scoring,
		winner,
		lines,
	};
}
