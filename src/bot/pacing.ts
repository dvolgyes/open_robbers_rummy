import type { RummyMatch } from "../game/rummy";

/** Every viewer sees the gold frames of a play for at least this long before a bot sends a command. */
export const SHOW_PLAY_MS = 5000;
/** The least time between two commands of one bot runner, so that a draw and an end do not flash past. */
export const COMMAND_GAP_MS = 1000;

/** The earliest time of the next bot command: 5 s after the last play, and 1 s after the previous bot command. */
export function sendAt(
	lastPlayAt: number,
	lastCommandAt: number | undefined,
): number {
	const play = lastPlayAt + SHOW_PLAY_MS;
	return lastCommandAt === undefined
		? play
		: Math.max(play, lastCommandAt + COMMAND_GAP_MS);
}

/** The clock and the timer of a bot runner; tests pass fake time. */
export interface BotTime {
	now(): number;
	wait(ms: number): Promise<void>;
}

export const realTime: BotTime = {
	now: () => performance.now(),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Remembers when a runner saw the last play and when it sent its last command. A hand that the runner sees for the
 * first time counts as a play at that moment, so a runner that starts in the middle of a hand, or after a host change,
 * also waits.
 */
export class BotPacer {
	readonly #time: BotTime;
	#playKey: string | undefined;
	#lastPlayAt = 0;
	#lastCommandAt: number | undefined;

	constructor(time: BotTime) {
		this.#time = time;
	}

	/** Notes the last play of `match`; only a new play starts the 5 s again. */
	observe(match: RummyMatch): void {
		// Table cards never go back to a hand, so each play in a hand puts different cards down.
		const key = `${match.handNo}:${match.hand.lastPlay?.cards.join(",") ?? ""}`;
		if (key === this.#playKey) return;
		this.#playKey = key;
		this.#lastPlayAt = this.#time.now();
	}

	/** The milliseconds until a command may go; 0 when it may go now. */
	delay(): number {
		return Math.max(
			0,
			sendAt(this.#lastPlayAt, this.#lastCommandAt) - this.#time.now(),
		);
	}

	/** Waits until a command may go. A timer ends the wait, so it does not depend on a later change of the table. */
	async ready(): Promise<void> {
		const delay = this.delay();
		if (delay > 0) await this.#time.wait(delay);
	}

	/** Notes a command that was just sent. */
	sent(): void {
		this.#lastCommandAt = this.#time.now();
	}
}
