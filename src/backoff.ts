/** Retry delay after `attempt` consecutive failures: 1 s, doubling, at most 30 s. */
export function backoffMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** attempt);
}
