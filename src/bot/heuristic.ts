import {
	type Action,
	applyAction,
	cardPoints,
	type HandState,
	initialMeldMinimum,
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
 * The value of making the side's first meld. It ranks a first meld that needs two wild cards above a discard and
 * above a part of it, while the wild card cost still ranks the first meld with fewer wild cards first.
 */
const FIRST_MELD = 40;

/**
 * What putting `cards` on the table is worth beyond their count: a tenth of the bonus of each canasta that the
 * action makes, so a natural canasta ranks above a mixed one, and the value of the side's first meld when the
 * action makes it, less the cost of the wild cards.
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
	const first =
		after !== undefined &&
		!hand.teams[team]?.initialMade &&
		after.turnMeldPoints >=
			initialMeldMinimum(hand.rules.initialMeld, hand.teamScores[team] ?? 0)
			? FIRST_MELD
			: 0;
	return bonus + first - wilds * WILD_COST;
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
	const side = hand.teams[teamOf(seat)];
	const melds = (side?.melds ?? [])
		.map((meld) => ids(meld.cards))
		.toSorted()
		.join("|");
	const key = `${ids(cards)}/${melds}/${depth}`;
	const known = seen.get(key);
	if (known !== undefined) return known;
	const steps = legalActions(hand, seat).flatMap((action) => {
		if (action.type !== "meld" && action.type !== "extend") return [];
		const step = applyAction(hand, seat, action);
		return step.ok ? [step.hand] : [];
	});
	// Below the first meld minimum, only a meld that adds points can reach it, and the melds that add the most reach
	// it soonest. Cards taken with the pile add none, and with a large pile the search would otherwise try every
	// combination of them for seconds.
	const result = (
		side?.initialMade
			? steps
			: steps
					.filter((after) => after.turnMeldPoints > hand.turnMeldPoints)
					.toSorted((a, b) => b.turnMeldPoints - a.turnMeldPoints)
	).some((after) => canEndTurn(after, seat, depth - 1, seen));
	seen.set(key, result);
	return result;
}

/**
 * Whether the action adds wild cards to a meld that the side already has, without making it a canasta and
 * without leaving the seat at most one card to go out with. Before the side's first meld, the wild cards add
 * points toward the minimum, so they are not counted here.
 */
function spendsWildOnMeld(
	hand: HandState,
	seat: Seat,
	action: Action,
	after: HandState,
): boolean {
	const target =
		action.type === "extend"
			? { meldId: action.meldId, cards: action.cards }
			: action.type === "takePile" && action.extend !== undefined
				? { meldId: action.extend, cards: action.cards }
				: undefined;
	const team = teamOf(seat);
	if (target === undefined || !hand.teams[team]?.initialMade) return false;
	const { meldId, cards } = target;
	const own = hand.hands[seat] ?? [];
	if (!own.some((card) => cards.includes(card.id) && isWild(card)))
		return false;
	if (after.outcome !== null || (after.hands[seat]?.length ?? 0) <= 1)
		return false;
	const canasta = (state: HandState) => {
		const meld = state.teams[team]?.melds.find((item) => item.id === meldId);
		return meld !== undefined && isCanasta(meld, hand.rules);
	};
	return canasta(hand) || !canasta(after);
}

/**
 * The actions a bot may take, best first: the legal actions after which the turn can still end. A wild card
 * added to a meld that it does not make a canasta is offered only when nothing else ends the turn, and resetTurn
 * only when nothing else is legal, so a bot never repeats a turn that it had to take back.
 */
export function botActions(hand: HandState, seat: Seat): Action[] {
	const legal = legalActions(hand, seat);
	const seen = new Map<string, boolean>();
	const finishing = legal.flatMap((action) => {
		if (action.type === "resetTurn") return [];
		const step = applyAction(hand, seat, action);
		return step.ok && canEndTurn(step.hand, seat, LOOKAHEAD, seen)
			? [{ action, after: step.hand }]
			: [];
	});
	const kept = finishing.filter(
		({ action, after }) => !spendsWildOnMeld(hand, seat, action, after),
	);
	const offered = (kept.length > 0 ? kept : finishing).map(
		({ action }) => action,
	);
	return rankActions(hand, seat, offered.length > 0 ? offered : legal);
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
