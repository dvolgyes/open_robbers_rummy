import type { Board } from "../bridge/engine";

/** Stable key for the bidding or play position whose action the bot is considering. */
export function actionPositionKey(board: Board): string {
	return `action:${board.number}:${board.calls.join(",")}:${board.cards.join(",")}`;
}

/** Confirms the board has not changed while the bot selected an action. */
export function matchesActionPosition(board: Board, key: string): boolean {
	return actionPositionKey(board) === key;
}
