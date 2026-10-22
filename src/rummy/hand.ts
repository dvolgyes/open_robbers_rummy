import { buildDeck, type Card, parseCardId } from "./cards";
import { analyzeMeld } from "./melds";
import { mulberry32, shuffle } from "./random";
import type { RummyRules } from "./rules";

/** Seats are numbered from 0 in turn order. */
export type Seat = number;
/**
 * "start": nothing done yet this turn. "played": the player laid cards and may draw or end the turn.
 * "drew": the player drew a card and may play or end the turn.
 */
export type Phase = "start" | "played" | "drew";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** A meld on the shared table; the cards are in display order. */
export interface TableMeld {
	readonly id: string;
	readonly cards: readonly string[];
}

/** The latest play: the hand cards it put on the table, and the melds that it changed or made. */
export interface LastPlay {
	readonly seat: Seat;
	readonly cards: readonly string[];
	readonly meldIds: readonly string[];
}

export type Outcome =
	| { readonly kind: "out"; readonly seat: Seat }
	/** Every player passed in a row at an empty stock. */
	| { readonly kind: "blocked" };

export interface HandState {
	readonly rules: RummyRules;
	readonly players: number;
	readonly dealer: Seat;
	readonly turn: Seat;
	readonly phase: Phase;
	/** Card ids by seat; a drawn card goes to the end. */
	readonly hands: readonly (readonly string[])[];
	/** The top card is at index 0. */
	readonly stock: readonly string[];
	readonly table: readonly TableMeld[];
	/** A seat has met the opening rule; every seat starts open when the rules have no opening rule. */
	readonly opened: readonly boolean[];
	readonly lastPlay: LastPlay | null;
	/** Passes in a row since the last play. */
	readonly passes: number;
	readonly nextMeldNo: number;
	readonly outcome: Outcome | null;
}

/** A play gives the complete new table: every table card, and at least one card from the player's hand. */
export type Action =
	| { readonly type: "play"; readonly melds: readonly (readonly string[])[] }
	| { readonly type: "draw" }
	| { readonly type: "end" }
	/** Only at an empty stock, instead of a draw. */
	| { readonly type: "pass" };

export type Step =
	| { readonly ok: true; readonly hand: HandState }
	| { readonly ok: false; readonly reason: string };

export interface NewHandInput {
	readonly rules: RummyRules;
	readonly players: number;
	readonly dealer: Seat;
	readonly seed: number;
}

const fail = (reason: string): Step => ({ ok: false, reason });
const succeed = (hand: HandState): Step => ({ ok: true, hand });

/** Deals a shuffled deck; the player after the dealer starts. */
export function newHand(input: NewHandInput): HandState {
	const { rules, players, dealer } = input;
	if (
		!Number.isInteger(players) ||
		players < MIN_PLAYERS ||
		players > MAX_PLAYERS
	)
		throw new Error(
			`a hand needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players, not ${players}`,
		);
	if (!Number.isInteger(dealer) || dealer < 0 || dealer >= players)
		throw new Error(`no seat ${dealer} among ${players} players`);
	const deck = shuffle(buildDeck(rules.jokers), mulberry32(input.seed)).map(
		(card) => card.id,
	);
	const hands = Array.from({ length: players }, (_, seat) =>
		deck.slice(seat * rules.handSize, (seat + 1) * rules.handSize),
	);
	return {
		rules,
		players,
		dealer,
		turn: (dealer + 1) % players,
		phase: "start",
		hands,
		stock: deck.slice(players * rules.handSize),
		table: [],
		opened: hands.map(() => rules.openingPoints === 0),
		lastPlay: null,
		passes: 0,
		nextMeldNo: 1,
		outcome: null,
	};
}

/** True when the seat may lay cards now. */
export function playAllowed(hand: HandState, seat: Seat): boolean {
	return (
		hand.outcome === null &&
		seat === hand.turn &&
		(hand.phase === "start" || hand.phase === "drew")
	);
}

/** The legal draw, end and pass actions; a play is legal when `playAllowed` is true and `applyAction` accepts the melds. */
export function legalActions(hand: HandState, seat: Seat): Action[] {
	if (hand.outcome !== null || seat !== hand.turn) return [];
	const stocked = hand.stock.length > 0;
	switch (hand.phase) {
		case "start":
			return [stocked ? { type: "draw" } : { type: "pass" }];
		case "played":
			return stocked ? [{ type: "draw" }, { type: "end" }] : [{ type: "end" }];
		case "drew":
			return [{ type: "end" }];
	}
}

/** The only authority on the rules: every accepted action goes through here. */
export function applyAction(hand: HandState, seat: Seat, action: Action): Step {
	if (hand.outcome !== null) return fail("the hand is over");
	if (seat !== hand.turn) return fail("it is not your turn");
	switch (action.type) {
		case "play":
			return applyPlay(hand, seat, action.melds);
		case "draw":
			return applyDraw(hand, seat);
		case "end":
			if (hand.phase === "start")
				return fail("draw a card or play before you end the turn");
			return succeed(endTurn(hand));
		case "pass":
			if (hand.phase !== "start")
				return fail("you can pass only at the start of your turn");
			if (hand.stock.length > 0)
				return fail("you can pass only when the stock is empty");
			return succeed(pass(hand));
	}
}

function endTurn(hand: HandState): HandState {
	return { ...hand, turn: (hand.turn + 1) % hand.players, phase: "start" };
}

function pass(hand: HandState): HandState {
	const passes = hand.passes + 1;
	if (passes >= hand.players)
		return { ...hand, passes, outcome: { kind: "blocked" } };
	return endTurn({ ...hand, passes });
}

function applyDraw(hand: HandState, seat: Seat): Step {
	if (hand.phase === "drew") return fail("you have already drawn this turn");
	const [card, ...stock] = hand.stock;
	if (card === undefined) return fail("the stock is empty; pass instead");
	const hands = hand.hands.map((cards, at) =>
		at === seat ? [...cards, card] : cards,
	);
	const drawn: HandState = { ...hand, hands, stock };
	const turnEnds =
		hand.rules.turn === "play-or-draw" || hand.phase === "played";
	return succeed(turnEnds ? endTurn(drawn) : { ...drawn, phase: "drew" });
}

/** The deck's cards of this hand, or a reason naming the first id that is not one. */
function cardsOf(
	ids: readonly string[],
	rules: RummyRules,
): Card[] | { readonly reason: string } {
	const cards: Card[] = [];
	for (const id of ids) {
		const card = typeof id === "string" ? parseCardId(id) : null;
		const inDeck =
			card !== null && (!card.joker || Number(id.slice(2)) < rules.jokers);
		if (!inDeck || card === null)
			return { reason: `${String(id)} is not a card of this game` };
		cards.push(card);
	}
	return cards;
}

const sameCards = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && [...a].sort().join() === [...b].sort().join();

function applyPlay(
	hand: HandState,
	seat: Seat,
	melds: readonly (readonly string[])[],
): Step {
	if (hand.phase === "played") return fail("you have already played this turn");
	const own = hand.hands[seat] ?? [];
	const tableCards = new Set(hand.table.flatMap((meld) => meld.cards));
	const ownCards = new Set(own);
	const seen = new Set<string>();
	const shaped: { cards: readonly string[]; points: number }[] = [];
	for (const meld of melds) {
		const cards = cardsOf(meld, hand.rules);
		if (!Array.isArray(cards)) return fail(cards.reason);
		for (const id of meld) {
			if (seen.has(id)) return fail(`${id} is used twice`);
			seen.add(id);
			if (!tableCards.has(id) && !ownCards.has(id))
				return fail(`${id} is not in your hand`);
		}
		const shape = analyzeMeld(cards, hand.rules);
		if (!shape.ok) return fail(`${meld.join(" ")}: ${shape.reason}`);
		shaped.push({ cards: shape.order, points: shape.points });
	}
	for (const id of tableCards)
		if (!seen.has(id)) return fail(`the table card ${id} is missing`);
	const added = own.filter((id) => seen.has(id));
	if (added.length === 0) return fail("a play needs at least one hand card");
	if (hand.rules.openingPoints > 0 && !hand.opened[seat]) {
		const opening = openingCheck(hand, shaped);
		if (opening !== null) return fail(opening);
	}
	let nextMeldNo = hand.nextMeldNo;
	const meldIds: string[] = [];
	const table = shaped.map(({ cards }) => {
		const kept = hand.table.find((meld) => sameCards(meld.cards, cards));
		if (kept !== undefined) return { id: kept.id, cards };
		const id = `m${nextMeldNo++}`;
		meldIds.push(id);
		return { id, cards };
	});
	const left = own.filter((id) => !seen.has(id));
	const played: HandState = {
		...hand,
		hands: hand.hands.map((cards, at) => (at === seat ? left : cards)),
		table,
		opened: hand.opened.map((open, at) => open || at === seat),
		lastPlay: { seat, cards: added, meldIds },
		passes: 0,
		nextMeldNo,
	};
	if (left.length === 0)
		return succeed({ ...played, outcome: { kind: "out", seat } });
	const turnEnds = hand.rules.turn === "play-or-draw" || hand.phase === "drew";
	return succeed(turnEnds ? endTurn(played) : { ...played, phase: "played" });
}

/** The opening leaves the table as it is and adds melds of hand cards only, worth the rule's points. */
function openingCheck(
	hand: HandState,
	shaped: readonly { cards: readonly string[]; points: number }[],
): string | null {
	const tableCards = new Set(hand.table.flatMap((meld) => meld.cards));
	let points = 0;
	for (const meld of shaped) {
		const fromTable = meld.cards.filter((id) => tableCards.has(id));
		if (fromTable.length === 0) {
			points += meld.points;
			continue;
		}
		if (!hand.table.some((old) => sameCards(old.cards, meld.cards)))
			return "your opening cannot change the table; lay new melds from your hand";
	}
	const minimum = hand.rules.openingPoints;
	if (points < minimum)
		return `your opening needs ${minimum} points in new melds, not ${points}`;
	return null;
}
