import { expect } from "vitest";
import { type Card, type Deal, isCard } from "../../src/bridge/cards";
import {
	type Action,
	applyAction,
	type Board,
	boardStatus,
} from "../../src/bridge/engine";
import { type Call, isCall } from "../../src/bridge/rules";

export function cards(text: string): Card[] {
	const list = text.split(" ");
	for (const card of list)
		if (!isCard(card)) throw new Error(`not a card: ${card}`);
	return list as Card[];
}

/**
 * West is void in spades, so a spade lead lets dummy ruff when West is dummy in a heart contract.
 * North holds the top spades, so a no-trump spade lead shows that a discard never wins.
 */
export const DEAL: Deal = {
	N: cards("SA SK SQ SJ ST S9 S8 HA HK HQ DA DK CA"),
	E: cards("S7 S6 S5 HJ HT H9 H8 H7 DQ DJ DT CK CQ"),
	S: cards("S4 S3 S2 H6 H5 H4 D9 D8 D7 D6 CJ CT C9"),
	W: cards("H3 H2 D5 D4 D3 D2 C8 C7 C6 C5 C4 C3 C2"),
};

export function call(text: string): Action {
	if (!isCall(text)) throw new Error(`not a call: ${text}`);
	return { type: "call", call: text as Call };
}

export function play(text: string): Action {
	const [card] = cards(text);
	return { type: "play", card: card as Card };
}

/** Applies each action for the seat that must act now, and fails the test on the first rejection. */
function run(board: Board, actions: Action[]): Board {
	let current = board;
	for (const action of actions) {
		const seat = boardStatus(current).actor;
		if (seat === undefined) throw new Error("nobody can act");
		const result = applyAction(current, seat, action);
		expect(result, `${seat} ${JSON.stringify(action)}`).toMatchObject({
			ok: true,
		});
		if (result.ok) current = result.board;
	}
	return current;
}

export function bidding(board: Board, text: string): Board {
	return text === "" ? board : run(board, text.split(" ").map(call));
}

export function playing(board: Board, text: string): Board {
	return run(
		board,
		cards(text).map((card) => ({ type: "play", card })),
	);
}
