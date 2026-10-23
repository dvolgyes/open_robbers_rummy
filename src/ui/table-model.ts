import {
	engineSeat,
	handViewFor,
	isTableCommand,
	parseAction,
	type RummyState,
	tableSeat,
	waitingText,
} from "../game/rummy";
import { englishTranslator as english, type Translate } from "../i18n";
import type { OutboxItem } from "../p2p/outbox";
import type { CommandFailure } from "../p2p/table";
import type { Entry } from "../p2p/wire";
import {
	isObject,
	SEAT_NAMES,
	type Seat,
	seatsOf,
	type TableConfig,
} from "../protocol";
import {
	type Action,
	applyAction,
	cardOf,
	type HandState,
	type HandView,
	legalActions,
	playAllowed,
	type RulePreset,
	type RummyRules,
	rankLabel,
	type Suit,
	settle,
} from "../rummy";
import { changed, type Draft, meldStatus, placedCards } from "./draft";
import { ownCommands, type RosterRow } from "./model";

/**
 * Pure view model of the rummy table: the DOM layer only renders what these functions return.
 *
 * The rules come from the engine (`applyAction`, `legalActions`, `viewFor`). This module only shapes them for the
 * screen: it does not decide what is legal beyond asking the engine.
 */

export const SUIT_SYMBOLS: Readonly<Record<Suit, string>> = {
	C: "♣",
	D: "♦",
	H: "♥",
	S: "♠",
};

export const PRESET_LABELS: Readonly<Record<RulePreset, string>> = {
	gamerules: "gamerules.com",
	wikipedia: "Wikipedia",
	machiavelli: "Machiavelli",
};

// ---------------------------------------------------------------------------------------------------------------
// Cards and melds

export interface CardView {
	readonly id: string;
	/** "A", "2" to "10", "J", "Q", "K", or "JK" for a joker. */
	readonly rank: string;
	/** Null for a joker. */
	readonly suit: Suit | null;
	/** For example "10♠", or "Joker". */
	readonly text: string;
}

/** A card in a meld. */
export interface MeldCardView extends CardView {
	/** The latest play put this card from a hand on the table: the screen gives it a gold frame. */
	readonly gold: boolean;
	/** The viewer's draft puts this card from the viewer's hand on the table. */
	readonly placed: boolean;
	/** For a joker in a valid meld, the card it stands for, such as "6♥". */
	readonly as?: string;
}

export interface MeldView {
	/** The meld's index in the table or the draft. */
	readonly index: number;
	readonly cards: readonly MeldCardView[];
	/** Null for a valid meld; otherwise why it is not a meld, translated. */
	readonly problem: string | null;
}

export function cardView(id: string, t: Translate = english): CardView {
	const card = cardOf(id);
	if (card.joker) return { id, rank: "JK", suit: null, text: t("Joker") };
	const rank = rankLabel(card.rank);
	return {
		id,
		rank,
		suit: card.suit,
		text: `${rank}${SUIT_SYMBOLS[card.suit]}`,
	};
}

function meldView(
	cards: readonly string[],
	index: number,
	rules: RummyRules,
	gold: ReadonlySet<string>,
	placed: ReadonlySet<string>,
	t: Translate,
): MeldView {
	const status = meldStatus(cards, rules);
	const order = status.ok ? status.order : cards;
	return {
		index,
		problem: status.ok ? null : translateReason(status.reason, t),
		cards: order.map((id) => {
			const role = status.ok ? status.jokerAs[id] : undefined;
			return {
				...cardView(id, t),
				gold: gold.has(id),
				placed: placed.has(id),
				...(role === undefined
					? {}
					: {
							as: `${rankLabel(role.rank)}${SUIT_SYMBOLS[role.suit]}`,
						}),
			};
		}),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Seats

export interface SeatView {
	readonly seat: Seat;
	/** This seat is controlled by a host-managed bot, as reported in the shared roster. */
	readonly bot: boolean;
	/** The player name; the seat name while the seat is free. */
	readonly label: string;
	/** The player's name; empty while the seat is free. */
	readonly name: string;
	readonly tags: readonly string[];
	/** The seat to act in the current game. */
	readonly turn: boolean;
	/** Cards in the seat's hand. */
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

/** The playing seats in turn order, starting with the seat after the viewer and ending with the viewer. */
export function seatsAfter(seats: readonly Seat[], viewer: Seat): Seat[] {
	const at = seats.indexOf(viewer);
	if (at === -1) return [...seats];
	return [...seats.slice(at + 1), ...seats.slice(0, at + 1)];
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
	return seatsAfter(seatsOf(config), seat).map((owner): SeatView => {
		const presence = presenceOf(roster, owner);
		const joined = presence !== "free";
		const bot = bots?.has(owner) ?? false;
		const name = config.names[owner] ?? "";
		return {
			seat: owner,
			bot,
			label: joined ? name : t(SEAT_NAMES[owner]),
			name: joined ? name : "",
			tags: [...(owner === hostSeat ? ["Host"] : []), ...(bot ? ["Bot"] : [])],
			turn: owner === turn,
			handCount: handCount(owner),
			presence,
			connecting: lobby && owner === seat && hostSeat !== seat && !hostOnline,
		};
	});
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
	readonly label: string;
	readonly state: TableActionState;
	/** Why the host refused or holds the command, in the viewer's language. */
	readonly reason?: string;
}

/** One of the viewer's draw, end and pass actions. */
export interface ActionButton {
	readonly key: Action["type"];
	readonly label: string;
	readonly action: Action;
}

function actionLabel(
	action: Action,
	t: Translate,
	view: HandView | undefined,
): string {
	switch (action.type) {
		case "draw":
			return t("Draw a card");
		case "end":
			return t("End the turn");
		case "pass":
			return t("Pass");
		case "play": {
			const table = new Set(view?.table.flatMap((meld) => meld.cards) ?? []);
			const count = action.melds.flat().filter((id) => !table.has(id)).length;
			return t("Play {count} cards", { count });
		}
	}
}

/** Short label of a table command, for the list of this seat's commands in flight. */
export function commandLabel(
	payload: unknown,
	t: Translate = english,
	view?: HandView,
): string {
	if (!isObject(payload)) return "";
	if (payload.type === "start") return t("Deal the cards");
	if (payload.type === "action") {
		const action = parseAction(payload.action);
		return action ? actionLabel(action, t, view) : t("Action");
	}
	return "";
}

/** The engine's and the host's reasons that name a card or a number; each becomes a translated message with values. */
const REASON_PATTERNS: readonly {
	readonly pattern: RegExp;
	readonly message: string;
	readonly names?: readonly string[];
}[] = [
	{
		pattern: /^\S+ is not in your hand$/,
		message: "a chosen card is not in your hand",
	},
	{ pattern: /^\S+ is used twice$/, message: "a card is used twice" },
	{
		pattern: /^the table card \S+ is missing$/,
		message: "a table card is missing",
	},
	{
		pattern: /^\S+ is not a card of this game$/,
		message: "a card is not a card of this game",
	},
	{
		pattern: /^your opening needs (\d+) points in new melds, not (\d+)$/,
		message: "your opening needs {minimum} points in new melds, not {points}",
		names: ["minimum", "points"],
	},
	{
		pattern: /^a meld may hold at most (\d+) jokers$/,
		message: "a meld may hold at most {count} jokers",
		names: ["count"],
	},
];

/** A reason from the host or the engine, in the viewer's language. */
export function translateReason(
	reason: string,
	t: Translate = english,
): string {
	if (reason.startsWith("Waiting for ")) return translateWait(reason, t);
	// The engine names an invalid meld by its card ids before the reason.
	const meld = /^(?:\S+ )*\S+: (.+)$/.exec(reason);
	if (meld) return translateReason(meld[1] as string, t);
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

/** The rule preset, the jokers and the opening, for the table heading. */
export function rulesText(rules: RummyRules, t: Translate = english): string {
	const parts = [
		t("{preset} rules", { preset: PRESET_LABELS[rules.preset] }),
		t("{count} jokers", { count: rules.jokers }),
		rules.openingPoints > 0
			? t("opening {points} points", { points: rules.openingPoints })
			: t("no opening minimum"),
		rules.maxJokersPerMeld === 1
			? t("one joker per meld")
			: t("any jokers per meld"),
	];
	if (rules.aceWraps) parts.push(t("runs go around the corner"));
	if (rules.turn === "play-or-draw") parts.push(t("play or draw"));
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------------------------
// The view

export type TablePhase = "loading" | "unreadable" | "waiting" | "play" | "over";

export interface ResultRow {
	readonly seat: Seat;
	readonly name: string;
	readonly penalty: number;
	readonly winner: boolean;
	/** The cards left in the hand. */
	readonly cards: readonly CardView[];
}

export interface ResultView {
	/** How the game ended, for example "Ben went out.". */
	readonly outcome: string;
	/** "You won." or "Ben won.", or the names of every winner at a blocked end. */
	readonly winner: string;
	readonly rows: readonly ResultRow[];
}

export interface TableView {
	readonly phase: TablePhase;
	/** The game on the table; 0 before the first game. */
	readonly handNo: number;
	/** The number of accepted actions in the game: the table position that actions are sent for. */
	readonly at: number;
	/** For example "Game 3", empty before the first game. */
	readonly heading: string;
	readonly details: string;
	readonly prompt: string;
	/** This player is on turn and can act now. */
	readonly yourTurn: boolean;
	/** The playing seats in turn order: the seats after the viewer, then the viewer. */
	readonly seats: readonly SeatView[];
	/** The viewer's hand in engine order; the screen sorts it. */
	readonly own: readonly CardView[];
	/** The table melds, with gold frames on the cards of the latest play. */
	readonly table: readonly MeldView[];
	readonly stockCount: number;
	/** The draw, end and pass actions of the viewer now; empty unless the viewer can act. */
	readonly actions: readonly ActionButton[];
	/** The viewer can lay cards now: the screen shows the draft editor. */
	readonly canPlay: boolean;
	/** The viewer has not met the opening rule, so the draft keeps the table as it is. */
	readonly locked: boolean;
	/** The table offers the solver's suggestion now. */
	readonly assist: boolean;
	/** The engine hand, so that `draftView` can ask the engine about a draft; undefined outside a game. */
	readonly hand: HandState | undefined;
	readonly rules: RummyRules | undefined;
	/** Set once the game is over. */
	readonly result: ResultView | undefined;
	readonly lines: readonly TableActionLine[];
}

export interface TableViewInput {
	readonly config: TableConfig;
	readonly seat: Seat;
	/** The parsed table; `undefined` while the table is loading, `null` when its state is not a rummy table. */
	readonly state: RummyState | null | undefined;
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
	/** This seat's commands that are not in the log. */
	readonly outbox: readonly OutboxItem[];
	readonly failures: readonly CommandFailure[];
	readonly undone: readonly Entry[];
	readonly t?: Translate;
}

function emptyView(phase: TablePhase, prompt: string): TableView {
	return {
		phase,
		handNo: 0,
		at: 0,
		heading: "",
		details: "",
		prompt,
		yourTurn: false,
		seats: [],
		own: [],
		table: [],
		stockCount: 0,
		actions: [],
		canPlay: false,
		locked: false,
		assist: false,
		hand: undefined,
		rules: undefined,
		result: undefined,
		lines: [],
	};
}

/** What the viewer on turn can do now. */
function turnPrompt(view: HandView, seat: number, t: Translate): string {
	const stocked = view.stockCount > 0;
	const locked = view.rules.openingPoints > 0 && !view.opened[seat];
	switch (view.phase) {
		case "start":
			if (locked)
				return stocked
					? t(
							"Your turn: open with {points} points of new melds from your hand, or draw a card.",
							{ points: view.rules.openingPoints },
						)
					: t(
							"Your turn: open with {points} points of new melds from your hand, or pass.",
							{ points: view.rules.openingPoints },
						);
			return stocked
				? t("Your turn: lay cards on the table, or draw a card.")
				: t("Your turn: lay cards on the table, or pass.");
		case "played":
			return stocked
				? t("Draw a card, or end your turn.")
				: t("End your turn.");
		case "drew":
			return locked
				? t(
						"Open with {points} points of new melds from your hand, or end your turn.",
						{ points: view.rules.openingPoints },
					)
				: t("Lay cards on the table, or end your turn.");
	}
}

function resultView(
	hand: HandState,
	config: TableConfig,
	viewer: Seat,
	t: Translate,
): ResultView {
	const { penalties, winners } = settle(hand);
	const nameOf = (engine: number): string =>
		config.names[tableSeat(engine)] ?? "";
	const outcome =
		hand.outcome?.kind === "out"
			? t("{name} went out.", { name: nameOf(hand.outcome.seat) })
			: t("Every player passed at an empty stock. The lowest penalty wins.");
	const names = winners.map(nameOf);
	const winner = winners.includes(engineSeat(viewer))
		? names.length === 1
			? t("You won.")
			: t("You share the win with {names}.", {
					names: names
						.filter((_, at) => winners[at] !== engineSeat(viewer))
						.join(", "),
				})
		: t("{names} won.", { names: names.join(", ") });
	const rows = hand.hands.map(
		(cards, engine): ResultRow => ({
			seat: tableSeat(engine),
			name: nameOf(engine),
			penalty: penalties[engine] ?? 0,
			winner: winners.includes(engine),
			cards: cards.map((id) => cardView(id, t)),
		}),
	);
	return {
		outcome,
		winner,
		rows: [...rows].sort((a, b) => a.penalty - b.penalty),
	};
}

export function tableView(input: TableViewInput): TableView {
	const { state, seat, config } = input;
	const t = input.t ?? english;
	if (state === undefined) return emptyView("loading", t("Loading the table…"));
	if (state === null)
		return emptyView("unreadable", t("This table has no rummy game."));

	const match = state.match;
	const dealWait = waitingText(seatsOf(config), [...input.present]);
	if (match === null) {
		return {
			...emptyView("waiting", ""),
			heading: t("Lobby"),
			details: t("Table lobby"),
			prompt:
				dealWait === undefined
					? t("The cards are dealt now.")
					: translateWait(dealWait, t),
			seats: seatViews(input, t, true, undefined, () => 0),
			lines: commandLines(input, 0, undefined),
		};
	}

	const view = handViewFor(match, seat);
	const own = engineSeat(seat);
	const turnSeat = tableSeat(view.turn);
	const lines = commandLines(input, match.handNo, view);
	const busy = lines.some(
		(line) => line.state === "sending" || line.state === "pending",
	);
	const localBot = input.bots?.has(seat) ?? false;
	const over = view.outcome !== null;
	const yourTurn =
		!over &&
		turnSeat === seat &&
		!input.terminal &&
		!localBot &&
		!busy &&
		dealWait === undefined;
	const canPlay = yourTurn && playAllowed(match.hand, own);

	let prompt: string;
	if (dealWait !== undefined) prompt = translateWait(dealWait, t);
	else if (over) prompt = t("The game is over.");
	else if (turnSeat === seat) prompt = turnPrompt(view, own, t);
	else
		prompt = t("Waiting for {name}.", { name: config.names[turnSeat] ?? "" });

	const gold = new Set(view.lastPlay?.cards ?? []);
	const none = new Set<string>();
	return {
		phase: over ? "over" : "play",
		handNo: match.handNo,
		at: state.actions,
		heading: t("Game {number}", { number: match.handNo }),
		details: `${rulesText(view.rules, t)} · ${t("Dealer: {dealer}", {
			dealer: config.names[tableSeat(view.dealer)] ?? "",
		})}`,
		prompt,
		yourTurn,
		seats: seatViews(
			input,
			t,
			false,
			over ? undefined : turnSeat,
			(owner) => view.handCounts[engineSeat(owner)] ?? 0,
		),
		own: view.own.map((id) => cardView(id, t)),
		table: view.table.map((meld, index) =>
			meldView(meld.cards, index, view.rules, gold, none, t),
		),
		stockCount: view.stockCount,
		actions: yourTurn
			? legalActions(match.hand, own).map((action) => ({
					key: action.type,
					label: actionLabel(action, t, view),
					action,
				}))
			: [],
		canPlay,
		locked: view.rules.openingPoints > 0 && !view.opened[own],
		assist: canPlay && view.rules.assist,
		hand: match.hand,
		rules: view.rules,
		result: over ? resultView(match.hand, config, seat, t) : undefined,
		lines,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The draft

export interface DraftView {
	/** The draft's melds; a meld that is not valid names its problem. */
	readonly melds: readonly MeldView[];
	/** The hand cards that the draft keeps in the hand. */
	readonly hand: readonly CardView[];
	/** The draft differs from the table. */
	readonly changed: boolean;
	/** The play that the draft makes, when the engine accepts it. */
	readonly play: Action | undefined;
	/** Why the engine refuses the draft as a play, translated; null when it accepts it or nothing changed. */
	readonly problem: string | null;
}

/** The draft as the screen shows it, and whether the engine accepts it as the viewer's play. */
export function draftView(
	view: TableView,
	seat: Seat,
	draft: Draft,
	t: Translate = english,
): DraftView {
	const rules = view.rules;
	const hand = view.hand;
	const placed = new Set(placedCards(draft));
	const gold = new Set(
		view.table.flatMap((meld) =>
			meld.cards.filter((card) => card.gold).map((card) => card.id),
		),
	);
	const melds =
		rules === undefined
			? []
			: draft.melds.map((meld, index) =>
					meldView(meld, index, rules, gold, placed, t),
				);
	const isChanged = changed(draft);
	const action: Action = { type: "play", melds: draft.melds };
	const step =
		isChanged && hand !== undefined
			? applyAction(hand, engineSeat(seat), action)
			: undefined;
	return {
		melds,
		hand: draft.hand.map((id) => cardView(id, t)),
		changed: isChanged,
		play: step?.ok === true ? action : undefined,
		problem:
			step === undefined || step.ok ? null : translateReason(step.reason, t),
	};
}
