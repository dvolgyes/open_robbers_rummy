import type { CtlMessage, LogMessage } from "./wire";

/**
 * What the replication components (host engine, follower, outbox) need from the page. They never set timers:
 * the page calls their `tick` at least every TICK_MS, and they read the time from a `Clock`.
 */

/** Outgoing messages, unframed; the page frames them. `to` is a peer id, or null for every other peer. */
export interface Send {
	ctl(to: string | null, message: CtlMessage): void;
	log(to: string | null, message: LogMessage): void;
}

export interface Clock {
	/** Milliseconds for in-page timers (`performance.now()`). */
	monotonic(): number;
	/** `Date.now()`; used only for `lastActivityAt` and expiry. */
	wall(): number;
}
