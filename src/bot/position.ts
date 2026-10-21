/**
 * Stable key for the position whose action the bot is choosing: the hand and the number of its accepted actions.
 * A key that has changed when the bot answers means the table moved on, so the answer is dropped.
 */
export function actionPositionKey(handNo: number, accepted: number): string {
	return `action:${handNo}:${accepted}`;
}
