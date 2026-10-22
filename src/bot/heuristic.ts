import {
	type Action,
	applyAction,
	cardPoints,
	type HandState,
	isCanasta,
	isWild,
	legalActions,
	type Seat,
	teamOf,
} from "../canasta";

const GOING_OUT = 1000;

/**
 * The cost of each wild card that an action puts on the table. It ranks a natural meld above the same meld with a
 * wild card, and a discard above a lone wild card added to a meld that it does not make a canasta.
 */
const WILD_COST = 25;

/**
 * What putting `cards` on the table is worth beyond their count: a tenth of the bonus of each canasta that the
 * action makes, so a natural canasta ranks above a mixed one, less the cost of the wild cards.
 */
function tableValue(
	hand: HandState,
	seat: Seat,
	cards: readonly string[],
	after: HandState | undefined,
): number {
	const own = hand.hands[seat] ?? [];
	const wilds = own.filter(
		(card) => cards.includes(card.id) && isWild(card),
	).length;
	const team = teamOf(seat);
	const before = new Set(
		(hand.teams[team]?.melds ?? [])
			.filter((meld) => isCanasta(meld, hand.rules))
			.map((meld) => meld.id),
	);
	const made = (after?.teams[team]?.melds ?? []).filter(
		(meld) => isCanasta(meld, hand.rules) && !before.has(meld.id),
	);
	const bonus = made.reduce(
		(sum, meld) =>
			sum +
			(meld.cards.some(isWild)
				? hand.rules.mixedCanastaBonus
				: hand.rules.naturalCanastaBonus) /
				10,
		0,
	);
	return bonus - wilds * WILD_COST;
}

/**
 * A rough value for one legal action, used to order the choices offered to a model and as the fallback when
 * no model answers. It reads only the seat's own cards and the public pile and melds, and it applies the action
 * only to learn whether it goes out or makes a canasta.
 */
export function scoreAction(
	hand: HandState,
	seat: Seat,
	action: Action,
): number {
	const step = applyAction(hand, seat, action);
	if (step.ok && step.hand.outcome?.kind === "out") return GOING_OUT;
	const after = step.ok ? step.hand : undefined;
	switch (action.type) {
		case "draw":
			return 10;
		case "takePile":
			return (
				30 + hand.pile.length + tableValue(hand, seat, action.cards, after)
			);
		case "meld":
			return (
				40 +
				action.cards.length * 3 +
				tableValue(hand, seat, action.cards, after)
			);
		case "extend":
			return (
				35 +
				action.cards.length * 3 +
				tableValue(hand, seat, action.cards, after)
			);
		case "discard": {
			const own = hand.hands[seat] ?? [];
			const card = own.find((item) => item.id === action.card);
			if (!card) return Number.NEGATIVE_INFINITY;
			const sameRank = own.filter((item) => item.rank === card.rank).length;
			return (
				20 -
				cardPoints(card) / 10 -
				(isWild(card) ? 40 : 0) +
				(sameRank === 1 ? 3 : 0)
			);
		}
		case "resetTurn":
			return -50;
	}
}

/** How many more melds a finishing path may need after an offered action. */
const LOOKAHEAD = 4;

/**
 * Whether the seat can still end its turn without resetTurn: by a discard, by going out, or by up to `depth`
 * more melds first. A partial meld below the initial minimum, or a meld that leaves a last card that may not go
 * out, has no such way; only resetTurn is then legal, and a bot that took the same path again would never end
 * the hand.
 */
function canEndTurn(
	hand: HandState,
	seat: Seat,
	depth: number,
	seen: Map<string, boolean>,
): boolean {
	if (hand.outcome !== null || hand.turn !== seat) return true;
	const cards = hand.hands[seat] ?? [];
	if (
		cards.some(
			(card) => applyAction(hand, seat, { type: "discard", card: card.id }).ok,
		)
	)
		return true;
	// A last card that may not be discarded cannot be melded either: that would go out as well.
	if (depth === 0 || cards.length < 2) return false;
	// Within one turn, the cards left in the hand and the side's melds decide what the later melds and the discard
	// can do, so the same position reached by melds in another order has the same answer. Meld ids follow the
	// order of the melds, so the key uses their cards.
	const ids = (list: readonly { readonly id: string }[]) =>
		list
			.map((card) => card.id)
			.toSorted()
			.join(",");
	const melds = (hand.teams[teamOf(seat)]?.melds ?? [])
		.map((meld) => ids(meld.cards))
		.toSorted()
		.join("|");
	const key = `${ids(cards)}/${melds}/${depth}`;
	const known = seen.get(key);
	if (known !== undefined) return known;
	const result = legalActions(hand, seat).some((action) => {
		if (action.type !== "meld" && action.type !== "extend") return false;
		const step = applyAction(hand, seat, action);
		return step.ok && canEndTurn(step.hand, seat, depth - 1, seen);
	});
	seen.set(key, result);
	return result;
}

/**
 * The actions a bot may take, best first: the legal actions after which the turn can still end. resetTurn is
 * offered only when nothing else is, so a bot never repeats a turn that it had to take back.
 */
export function botActions(hand: HandState, seat: Seat): Action[] {
	const legal = legalActions(hand, seat);
	const seen = new Map<string, boolean>();
	const finishing = legal.filter((action) => {
		if (action.type === "resetTurn") return false;
		const step = applyAction(hand, seat, action);
		return step.ok && canEndTurn(step.hand, seat, LOOKAHEAD, seen);
	});
	return rankActions(hand, seat, finishing.length > 0 ? finishing : legal);
}

/**
 * The legal actions ordered from the most to the least promising. Ties keep the order of `legal`, so the same
 * position always gives the same order.
 */
export function rankActions(
	hand: HandState,
	seat: Seat,
	legal: readonly Action[],
): Action[] {
	return legal
		.map((action, index) => ({
			action,
			index,
			score: scoreAction(hand, seat, action),
		}))
		.toSorted((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.action);
}
