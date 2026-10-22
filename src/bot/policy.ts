import { type Action, cardOf, type HandView, type Seat } from "../rummy";
import { type SolveBudget, type SolveResult, solve } from "./solver";

/** An opponent with this many cards or fewer can go out soon, so the bot stops keeping its jokers. */
export const ENDGAME_CARDS = 3;

/** The solver, injected so that a caller can run it elsewhere (a worker) or count its calls. */
export type Solve = typeof solve;

/** A solver that never finds a play: with it the bot only draws, ends and passes. */
export const neverPlay: Solve = () => ({
	melds: null,
	placed: [],
	aborted: false,
	nodes: 0,
});

/**
 * One step of the bot's turn, or undefined when the seat is not on turn.
 *
 * The bot plays the arrangement that puts the most cards from its hand on the table, then ends the turn: a draw after
 * a play only adds a card. Without a play it draws, and tries again with the drawn card. It keeps its jokers in the
 * hand for later, except in three cases: the opening (the rules let the first melds use them), a play that empties the
 * hand, and the endgame, when an opponent holds `ENDGAME_CARDS` or fewer and a joker left in the hand costs 25 points.
 */
export function chooseAction(
	view: HandView,
	seat: Seat,
	budget: SolveBudget,
	solver: Solve = solve,
): Action | undefined {
	if (view.outcome !== null || view.turn !== seat) return undefined;
	if (view.phase === "played") return { type: "end" };
	const melds = bestPlay(view, seat, budget, solver);
	if (melds !== null) return { type: "play", melds };
	if (view.phase === "drew") return { type: "end" };
	return view.stockCount > 0 ? { type: "draw" } : { type: "pass" };
}

/** The new table of the best play, or null when the bot does not play. */
export function bestPlay(
	view: HandView,
	seat: Seat,
	budget: SolveBudget,
	solver: Solve = solve,
): string[][] | null {
	const table = view.table.map((meld) => meld.cards);
	const base = { rules: view.rules, table, hand: view.own };
	if (view.rules.openingPoints > 0 && !view.opened[seat])
		return solver({
			...base,
			useHandJokers: true,
			openingPoints: view.rules.openingPoints,
			budget,
		}).melds;
	const holdsJoker = view.own.some((id) => cardOf(id).joker);
	const endgame = view.handCounts.some(
		(count, at) => at !== seat && count <= ENDGAME_CARDS,
	);
	if (!holdsJoker || endgame)
		return solver({ ...base, useHandJokers: true, budget }).melds;
	const [first, second] = splitBudget(budget);
	const kept = solver({ ...base, useHandJokers: false, budget: first });
	const free: SolveResult = solver({
		...base,
		useHandJokers: true,
		budget: second,
	});
	if (free.placed.length === view.own.length) return free.melds;
	return kept.melds;
}

/** Two budgets that together use `budget`: half of the nodes each, and the first ends halfway to the deadline. */
function splitBudget(budget: SolveBudget): [SolveBudget, SolveBudget] {
	const maxNodes = Math.ceil(budget.maxNodes / 2);
	if (budget.deadline === undefined)
		return [
			{ ...budget, maxNodes },
			{ ...budget, maxNodes },
		];
	const now = (budget.now ?? Date.now)();
	const halfway = now + Math.max(0, budget.deadline - now) / 2;
	return [
		{ ...budget, maxNodes, deadline: halfway },
		{ ...budget, maxNodes },
	];
}
