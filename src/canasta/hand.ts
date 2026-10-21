import { buildDecks, type Card, isBlack3, isRed3, isWild } from "./cards";
import {
	isCanasta,
	type Meld,
	meldPoints,
	type TeamIndex,
	validateMeld,
} from "./melds";
import { mulberry32, shuffle } from "./random";
import { type CanastaRules, CLASSIC_RULES, initialMeldMinimum } from "./rules";

export type Seat = 0 | 1 | 2 | 3;
export type Teams = readonly [TeamState, TeamState];
export type Phase = "draw" | "play";

export interface TeamState {
	readonly melds: readonly Meld[];
	/** Red threes stay on the table as a bonus, so they are not part of any meld. */
	readonly redThrees: readonly Card[];
	readonly initialMade: boolean;
}

export type Outcome =
	| { readonly kind: "out"; readonly seat: Seat; readonly concealed: boolean }
	| { readonly kind: "stock" };

/** The hand's data without the turn-start copy. */
export interface HandSnapshot {
	readonly rules: CanastaRules;
	readonly teamScores: readonly [number, number];
	readonly dealer: Seat;
	readonly turn: Seat;
	readonly phase: Phase;
	readonly hands: readonly (readonly Card[])[];
	/** The top card is at index 0. */
	readonly stock: readonly Card[];
	/** The top card is the last element. */
	readonly pile: readonly Card[];
	readonly teams: Teams;
	/** Card points from the current player's hand placed in melds this turn. */
	readonly turnMeldPoints: number;
	readonly turnActions: number;
	readonly nextMeldNo: number;
	readonly outcome: Outcome | null;
}

export interface HandState extends HandSnapshot {
	/** Restored by `resetTurn`, which lets a player retract a turn before ending it. */
	readonly turnStart: HandSnapshot;
}

export type Action =
	| { readonly type: "draw" }
	| {
			readonly type: "takePile";
			readonly cards: readonly string[];
			readonly extend?: string;
	  }
	| { readonly type: "meld"; readonly cards: readonly string[] }
	| {
			readonly type: "extend";
			readonly meldId: string;
			readonly cards: readonly string[];
	  }
	| { readonly type: "discard"; readonly card: string }
	| { readonly type: "resetTurn" };

export type Step =
	| { readonly ok: true; readonly hand: HandState }
	| { readonly ok: false; readonly reason: string };

export interface NewHandInput {
	readonly rules?: CanastaRules;
	readonly teamScores: readonly [number, number];
	readonly dealer: Seat;
	readonly seed: number;
}

export const teamOf = (seat: Seat): TeamIndex => (seat % 2 === 0 ? 0 : 1);
const nextSeat = (seat: Seat): Seat => ((seat + 1) % 4) as Seat;
const fail = (reason: string): Step => ({ ok: false, reason });
const succeed = (hand: HandState): Step => ({ ok: true, hand });

/** Deals a shuffled deck: hands, a starter pile card, and the stock. Red threes are set aside and replaced. */
export function newHand(input: NewHandInput): HandState {
	const rules = input.rules ?? CLASSIC_RULES;
	let stock: readonly Card[] = shuffle(buildDecks(), mulberry32(input.seed));
	const hands: Card[][] = [[], [], [], []];
	const teamRed: [Card[], Card[]] = [[], []];
	for (let k = 1; k <= 4; k++) {
		const seat = ((input.dealer + k) % 4) as Seat;
		const dealt = drawFromStock(stock, rules.handSize);
		hands[seat] = dealt.drawn;
		teamRed[teamOf(seat)].push(...dealt.redThrees);
		stock = dealt.rest;
	}
	const starter = turnStarter(stock);
	const teams: Teams = [
		{ melds: [], redThrees: teamRed[0], initialMade: false },
		{ melds: [], redThrees: teamRed[1], initialMade: false },
	];
	const base: HandSnapshot = {
		rules,
		teamScores: input.teamScores,
		dealer: input.dealer,
		turn: nextSeat(input.dealer),
		phase: "draw",
		hands,
		stock: starter.rest,
		pile: [starter.card],
		teams,
		turnMeldPoints: 0,
		turnActions: 0,
		nextMeldNo: 1,
		outcome: null,
	};
	return { ...base, turnStart: base };
}

/** Draws `count` cards from the top of the stock, setting red threes aside and drawing replacements. */
function drawFromStock(
	stock: readonly Card[],
	count: number,
): { drawn: Card[]; redThrees: Card[]; rest: Card[] } {
	const drawn: Card[] = [];
	const redThrees: Card[] = [];
	let index = 0;
	while (drawn.length < count) {
		const card = stock[index];
		if (card === undefined) break;
		index++;
		if (isRed3(card)) redThrees.push(card);
		else drawn.push(card);
	}
	return { drawn, redThrees, rest: stock.slice(index) };
}

/** The starter becomes the first pile card. A red three is put back at the bottom of the stock. */
function turnStarter(stock: readonly Card[]): { card: Card; rest: Card[] } {
	let rest = [...stock];
	for (;;) {
		const [card, ...others] = rest;
		if (card === undefined)
			throw new Error("the stock ran out before a starter card was found");
		if (!isRed3(card)) return { card, rest: others };
		rest = [...others, card];
	}
}

export function applyAction(hand: HandState, seat: Seat, action: Action): Step {
	if (hand.outcome !== null) return fail("the hand is over");
	if (hand.turn !== seat) return fail("it is not this seat's turn");
	switch (action.type) {
		case "draw":
			return applyDraw(hand, seat);
		case "takePile":
			return applyTakePile(hand, seat, action.cards, action.extend);
		case "meld":
			return applyMeld(hand, seat, action.cards);
		case "extend":
			return applyExtend(hand, seat, action.meldId, action.cards);
		case "discard":
			return applyDiscard(hand, seat, action.card);
		case "resetTurn":
			return applyReset(hand);
	}
}

/** Every action that `applyAction` accepts now. The candidate set is bounded (small meld subsets), not exhaustive. */
export function legalActions(hand: HandState, seat: Seat): Action[] {
	if (hand.outcome !== null || hand.turn !== seat) return [];
	const candidates: Action[] = [];
	if (hand.phase === "draw") {
		candidates.push({ type: "draw" }, ...pickupCandidates(hand, seat));
	} else {
		candidates.push(
			...meldCandidates(hand, seat),
			...extendCandidates(hand, seat),
			...discardCandidates(hand, seat),
		);
	}
	if (hand.turnActions > 0) candidates.push({ type: "resetTurn" });
	return candidates.filter((action) => applyAction(hand, seat, action).ok);
}

function applyDraw(hand: HandState, seat: Seat): Step {
	if (hand.phase !== "draw") return fail("this turn has already drawn");
	if (hand.stock.length === 0) return fail("the stock is empty");
	const drawn = drawFromStock(hand.stock, hand.rules.drawCount);
	const team = teamOf(seat);
	const cards = [...(hand.hands[seat] ?? []), ...drawn.drawn];
	const last = hand.stock.at(-1);
	const endsOnRedThree =
		drawn.rest.length === 0 && last !== undefined && isRed3(last);
	const next: HandState = {
		...hand,
		stock: drawn.rest,
		hands: withHand(hand.hands, seat, cards),
		teams: withTeam(hand.teams, team, {
			...teamAt(hand.teams, team),
			redThrees: [...teamAt(hand.teams, team).redThrees, ...drawn.redThrees],
		}),
		phase: "play",
		turnActions: hand.turnActions + 1,
	};
	// The last stock card is a red three, or only red threes were left: the player may not meld or discard, so the hand ends.
	if (cards.length === 0 || endsOnRedThree)
		return succeed({ ...next, outcome: { kind: "stock" } });
	return succeed(next);
}

function applyTakePile(
	hand: HandState,
	seat: Seat,
	ids: readonly string[],
	extendId?: string,
): Step {
	if (hand.phase !== "draw")
		return fail("the pile can be taken only before drawing");
	const top = hand.pile.at(-1);
	if (top === undefined) return fail("the pile is empty");
	if (isWild(top) || isBlack3(top))
		return fail("the top card of the pile cannot be picked up");
	const team = teamOf(seat);
	// A pile with a wild card is frozen, and so is the pile of a side that has not made its initial meld.
	const frozen = hand.pile.some(isWild) || !initialSatisfied(hand, team);
	if (frozen && extendId !== undefined)
		return fail("a frozen pile cannot extend an existing meld");
	const taken = takeFromHand(hand.hands[seat] ?? [], ids);
	if (!taken.ok) return taken;
	if (frozen && (taken.picked.length < 2 || taken.picked.some(isWild)))
		return fail("a frozen pile needs two natural cards from your hand");
	const pileMeld = [top, ...taken.picked];
	let teams = hand.teams;
	let nextMeldNo = hand.nextMeldNo;
	if (extendId === undefined) {
		const check = validateMeld(pileMeld, hand.rules);
		if (!check.ok) return fail(check.reason);
		const meld: Meld = {
			id: `m${nextMeldNo}`,
			rank: check.rank,
			team,
			cards: pileMeld,
		};
		nextMeldNo++;
		teams = withTeam(teams, team, {
			...teamAt(teams, team),
			melds: [...teamAt(teams, team).melds, meld],
		});
	} else {
		const existing = findTeamMeld(hand.teams, team, extendId);
		if (existing === undefined)
			return fail("no such meld on your side of the table");
		const cards = [...existing.cards, ...pileMeld];
		const check = validateMeld(cards, hand.rules, existing.rank);
		if (!check.ok) return fail(check.reason);
		teams = replaceMeld(teams, team, { ...existing, cards });
	}
	const cards = [...taken.rest, ...hand.pile.slice(0, -1)];
	const next: HandState = {
		...hand,
		hands: withHand(hand.hands, seat, cards),
		pile: [],
		teams,
		nextMeldNo,
		turnMeldPoints: hand.turnMeldPoints + meldPoints(taken.picked),
		phase: "play",
		turnActions: hand.turnActions + 1,
	};
	return afterMove(next, seat);
}

function applyMeld(hand: HandState, seat: Seat, ids: readonly string[]): Step {
	if (hand.phase !== "play") return fail("draw before melding");
	const taken = takeFromHand(hand.hands[seat] ?? [], ids);
	if (!taken.ok) return taken;
	const check = validateMeld(taken.picked, hand.rules);
	if (!check.ok) return fail(check.reason);
	const team = teamOf(seat);
	const meld: Meld = {
		id: `m${hand.nextMeldNo}`,
		rank: check.rank,
		team,
		cards: taken.picked,
	};
	const next: HandState = {
		...hand,
		hands: withHand(hand.hands, seat, taken.rest),
		teams: withTeam(hand.teams, team, {
			...teamAt(hand.teams, team),
			melds: [...teamAt(hand.teams, team).melds, meld],
		}),
		nextMeldNo: hand.nextMeldNo + 1,
		turnMeldPoints: hand.turnMeldPoints + meldPoints(taken.picked),
		turnActions: hand.turnActions + 1,
	};
	return afterMove(next, seat);
}

function applyExtend(
	hand: HandState,
	seat: Seat,
	meldId: string,
	ids: readonly string[],
): Step {
	if (hand.phase !== "play") return fail("draw before melding");
	const team = teamOf(seat);
	const existing = findTeamMeld(hand.teams, team, meldId);
	if (existing === undefined)
		return fail("no such meld on your side of the table");
	const taken = takeFromHand(hand.hands[seat] ?? [], ids);
	if (!taken.ok) return taken;
	const cards = [...existing.cards, ...taken.picked];
	const check = validateMeld(cards, hand.rules, existing.rank);
	if (!check.ok) return fail(check.reason);
	const next: HandState = {
		...hand,
		hands: withHand(hand.hands, seat, taken.rest),
		teams: replaceMeld(hand.teams, team, { ...existing, cards }),
		turnMeldPoints: hand.turnMeldPoints + meldPoints(taken.picked),
		turnActions: hand.turnActions + 1,
	};
	return afterMove(next, seat);
}

function applyDiscard(hand: HandState, seat: Seat, id: string): Step {
	if (hand.phase !== "play") return fail("draw before discarding");
	const cards = hand.hands[seat] ?? [];
	const card = cards.find((candidate) => candidate.id === id);
	if (card === undefined) return fail(`card ${id} is not in your hand`);
	const rest = cards.filter((candidate) => candidate.id !== id);
	const team = teamOf(seat);
	const afterDiscard: HandState = {
		...hand,
		hands: withHand(hand.hands, seat, rest),
		pile: [...hand.pile, card],
	};
	if (rest.length === 0) return checkOut(afterDiscard, seat);
	// A side below its minimum may discard only when it has laid no partial meld this turn; resetTurn undoes one.
	if (!initialSatisfied(hand, team) && hand.turnMeldPoints > 0) {
		return fail(
			"the side has not made its initial meld; reset the turn to take back the partial meld",
		);
	}
	return succeed(passTurn(afterDiscard, seat));
}

/** Melds or pickups may empty the hand, which is a going-out attempt. */
function afterMove(hand: HandState, seat: Seat): Step {
	if ((hand.hands[seat] ?? []).length === 0) return checkOut(hand, seat);
	return succeed(hand);
}

function checkOut(hand: HandState, seat: Seat): Step {
	const team = teamOf(seat);
	if (
		hand.rules.goOutNeedsCanasta &&
		!teamAt(hand.teams, team).melds.some((meld) => isCanasta(meld, hand.rules))
	) {
		return fail("the side needs a canasta to go out");
	}
	if (!initialSatisfied(hand, team))
		return fail("the side has not made its initial meld");
	const concealed = teamAt(hand.turnStart.teams, team).melds.length === 0;
	return succeed({
		...hand,
		teams: withTeam(hand.teams, team, {
			...teamAt(hand.teams, team),
			initialMade: true,
		}),
		outcome: { kind: "out", seat, concealed },
	});
}

/**
 * Ends the turn. The next player starts with a draw. With the stock exhausted, that player must take the
 * discard pile instead, and the hand ends if they cannot.
 */
function passTurn(hand: HandState, seat: Seat): HandState {
	const team = teamOf(seat);
	const base: HandSnapshot = {
		...snapshotOf(hand),
		teams: withTeam(hand.teams, team, {
			...teamAt(hand.teams, team),
			initialMade: initialSatisfied(hand, team),
		}),
		turn: nextSeat(seat),
		phase: "draw",
		turnMeldPoints: 0,
		turnActions: 0,
	};
	const next: HandSnapshot =
		base.stock.length === 0 && !canTakePile({ ...base, turnStart: base })
			? { ...base, outcome: { kind: "stock" } }
			: base;
	return { ...next, turnStart: next };
}

function canTakePile(hand: HandState): boolean {
	return pickupCandidates(hand, hand.turn).some(
		(action) => applyAction(hand, hand.turn, action).ok,
	);
}

function applyReset(hand: HandState): Step {
	if (hand.turnActions === 0) return fail("nothing to reset this turn");
	return succeed({ ...hand.turnStart, turnStart: hand.turnStart });
}

/** A side's first meld: the points from its current player's hand this turn meet the threshold for its score. */
function initialSatisfied(hand: HandState, team: TeamIndex): boolean {
	if (teamAt(hand.teams, team).initialMade) return true;
	return (
		hand.turnMeldPoints >=
		initialMeldMinimum(hand.rules.initialMeld, hand.teamScores[team] ?? 0)
	);
}

function snapshotOf(hand: HandState): HandSnapshot {
	const { turnStart: _turnStart, ...snapshot } = hand;
	return snapshot;
}

function takeFromHand(
	hand: readonly Card[],
	ids: readonly string[],
): { ok: true; picked: Card[]; rest: Card[] } | { ok: false; reason: string } {
	if (new Set(ids).size !== ids.length)
		return { ok: false, reason: "a card was selected twice" };
	const picked: Card[] = [];
	for (const id of ids) {
		const card = hand.find((candidate) => candidate.id === id);
		if (card === undefined)
			return { ok: false, reason: `card ${id} is not in your hand` };
		picked.push(card);
	}
	return {
		ok: true,
		picked,
		rest: hand.filter((card) => !ids.includes(card.id)),
	};
}

function findTeamMeld(
	teams: Teams,
	team: TeamIndex,
	meldId: string,
): Meld | undefined {
	return teamAt(teams, team).melds.find((meld) => meld.id === meldId);
}

function replaceMeld(teams: Teams, team: TeamIndex, meld: Meld): Teams {
	const current = teamAt(teams, team);
	return withTeam(teams, team, {
		...current,
		melds: current.melds.map((m) => (m.id === meld.id ? meld : m)),
	});
}

function teamAt(teams: Teams, team: TeamIndex): TeamState {
	const state = teams[team];
	if (state === undefined) throw new Error(`no team ${team}`);
	return state;
}

function withTeam(teams: Teams, team: TeamIndex, state: TeamState): Teams {
	return team === 0 ? [state, teams[1]] : [teams[0], state];
}

function withHand(
	hands: HandState["hands"],
	seat: Seat,
	cards: readonly Card[],
): HandState["hands"] {
	return hands.map((hand, index) => (index === seat ? cards : hand));
}

function pickupCandidates(hand: HandState, seat: Seat): Action[] {
	const top = hand.pile.at(-1);
	if (top === undefined || isWild(top) || isBlack3(top)) return [];
	const pool = (hand.hands[seat] ?? []).filter(
		(card) => card.rank === top.rank || isWild(card),
	);
	const actions: Action[] = [];
	for (const subset of subsetsUpTo(pool, 3)) {
		const cards = subset.map((card) => card.id);
		actions.push({ type: "takePile", cards });
		for (const meld of hand.teams[teamOf(seat)].melds) {
			if (meld.rank === top.rank)
				actions.push({ type: "takePile", cards, extend: meld.id });
		}
	}
	return actions;
}

function meldCandidates(hand: HandState, seat: Seat): Action[] {
	const cards = hand.hands[seat] ?? [];
	const ranks = new Set(
		cards
			.filter((card) => !isWild(card) && card.rank !== "3")
			.map((card) => card.rank),
	);
	const actions: Action[] = [];
	for (const rank of ranks) {
		const pool = cards.filter((card) => card.rank === rank || isWild(card));
		for (const subset of subsetsUpTo(pool, 4)) {
			if (subset.length >= 3)
				actions.push({ type: "meld", cards: subset.map((card) => card.id) });
		}
	}
	return actions;
}

function extendCandidates(hand: HandState, seat: Seat): Action[] {
	const team = teamOf(seat);
	const cards = hand.hands[seat] ?? [];
	const actions: Action[] = [];
	for (const meld of teamAt(hand.teams, team).melds) {
		const pool = cards.filter(
			(card) => card.rank === meld.rank || isWild(card),
		);
		for (const subset of subsetsUpTo(pool, 2)) {
			if (subset.length >= 1)
				actions.push({
					type: "extend",
					meldId: meld.id,
					cards: subset.map((card) => card.id),
				});
		}
	}
	return actions;
}

function discardCandidates(hand: HandState, seat: Seat): Action[] {
	return (hand.hands[seat] ?? []).map((card) => ({
		type: "discard",
		card: card.id,
	}));
}

/** All subsets of `items` with at most `max` elements, the empty subset included. */
function subsetsUpTo<T>(items: readonly T[], max: number): T[][] {
	const [first, ...rest] = items;
	if (first === undefined || max === 0) return [[]];
	const without = subsetsUpTo(rest, max);
	const withFirst = subsetsUpTo(rest, max - 1).map((subset) => [
		first,
		...subset,
	]);
	return [...without, ...withFirst];
}
