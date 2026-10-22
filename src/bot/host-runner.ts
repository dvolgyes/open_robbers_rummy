import {
	actionPayload,
	engineSeat,
	handViewFor,
	parseRummyState,
	resetVotePayload,
} from "../game/rummy";
import type { TableController } from "../p2p/table";
import { type RoomConfig, SEATS, type Seat } from "../protocol";
import { actionPositionKey } from "./position";
import type { Thinker } from "./think";

export function configuredBotSeats(config: RoomConfig): Seat[] {
	return SEATS.filter((seat) => config.botSetup?.seats.includes(seat) === true);
}

/** Runs host-managed bot decisions in the page that currently owns the host. */
export class HostBotRunner {
	readonly #controller: TableController;
	readonly #thinker: Thinker;
	readonly #onError: (detail: string) => void;
	readonly #processed = new Set<string>();
	#unsubscribe: (() => void) | undefined;
	#running = false;
	#rerun = false;
	#stopped = false;
	#paused = false;
	readonly #seatOverrides = new Map<Seat, boolean>();

	constructor(
		controller: TableController,
		thinker: Thinker,
		onError: (detail: string) => void = () => {},
	) {
		this.#controller = controller;
		this.#thinker = thinker;
		this.#onError = onError;
	}

	async start(requiredSeats: readonly Seat[] = []): Promise<boolean> {
		const view = this.#controller.view();
		const config = view.table?.config;
		if (!view.hosting || !view.ready || !config) return false;
		for (const seat of requiredSeats) this.#seatOverrides.set(seat, true);
		const seats = this.#activeSeats(
			view.roster?.bots ?? configuredBotSeats(config),
		).filter((seat) => seat !== view.seat && !requiredSeats.includes(seat));
		if (!(await this.#controller.activateBots(seats))) return false;
		this.#unsubscribe = this.#controller.onChange(() => this.#schedule());
		this.#schedule();
		return true;
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#unsubscribe?.();
		this.#thinker.close();
	}

	pause(): void {
		this.#paused = true;
	}

	resume(): void {
		if (this.#stopped || !this.#paused) return;
		this.#paused = false;
		this.#schedule();
	}

	setSeatEnabled(seat: Seat, enabled: boolean): void {
		this.#seatOverrides.set(seat, enabled);
		this.#schedule();
	}

	#activeSeats(seats: readonly Seat[]): Seat[] {
		const active = new Set(seats);
		for (const [seat, enabled] of this.#seatOverrides) {
			if (enabled) active.add(seat);
			else active.delete(seat);
		}
		return [...active];
	}

	#schedule(): void {
		if (this.#stopped || this.#paused) return;
		if (this.#running) {
			this.#rerun = true;
			return;
		}
		void this.#drive();
	}

	async #drive(): Promise<void> {
		this.#running = true;
		try {
			do {
				this.#rerun = false;
				await this.#step();
			} while (this.#rerun && !this.#stopped && !this.#paused);
		} catch (error) {
			// The room remains playable, and the host can start the bots again.
			if (this.#stopped) return;
			this.stop();
			this.#onError(error instanceof Error ? error.message : String(error));
		} finally {
			this.#running = false;
		}
	}

	async #step(): Promise<void> {
		const view = this.#controller.view();
		if (
			this.#stopped ||
			this.#paused ||
			!view.hosting ||
			!view.ready ||
			!view.table
		)
			return;
		const config = view.table.config;
		const seats = this.#activeSeats(
			view.roster?.bots ?? configuredBotSeats(config),
		);
		const state = parseRummyState(view.table.state, this.#controller.tableId);
		// A bot approves a reset that asks its seat; the game waits until every asked seat answers.
		const reset = state?.reset;
		if (reset)
			for (const seat of seats) {
				const voteKey = `reset:${reset.id}:${seat}`;
				if (
					!reset.required.includes(seat) ||
					reset.approved.includes(seat) ||
					this.#processed.has(voteKey)
				)
					continue;
				this.#processed.add(voteKey);
				await this.#send(
					seat,
					resetVotePayload(this.#controller.tableId, reset.id, true),
					view.seat,
				);
				return;
			}
		const match = state?.match;
		if (!state || !match || match.hand.outcome !== null) return;
		const position = actionPositionKey(match.handNo, state.actions);
		for (const seat of seats) {
			// Only the seat whose turn it is has legal actions, so other seats are skipped here.
			if (match.hand.turn !== engineSeat(seat)) continue;
			// The table changes on every tick and ping, so a position that was already asked is not searched again.
			const key = `${position}:${seat}`;
			if (this.#processed.has(key)) continue;
			this.#processed.add(key);
			let action: Awaited<ReturnType<Thinker["choose"]>>;
			try {
				action = await this.#thinker.choose(
					handViewFor(match, seat),
					engineSeat(seat),
				);
			} catch (error) {
				this.#processed.delete(key);
				throw error;
			}
			if (this.#stopped) return;
			if (this.#paused) {
				// The position is searched again after `resume`.
				this.#processed.delete(key);
				return;
			}
			if (action === undefined) return;
			const current = this.#controller.view();
			const currentBots = current.roster?.bots ?? configuredBotSeats(config);
			if (!this.#activeSeats(currentBots).includes(seat)) return;
			const currentState = current.table
				? parseRummyState(current.table.state, this.#controller.tableId)
				: undefined;
			const currentMatch = currentState?.match;
			if (
				!currentState ||
				!currentMatch ||
				actionPositionKey(currentMatch.handNo, currentState.actions) !==
					position
			)
				return;
			await this.#send(
				seat,
				actionPayload(this.#controller.tableId, match, state.actions, action),
				view.seat,
			);
			return;
		}
	}

	async #send(
		seat: Seat,
		payload: ReturnType<typeof actionPayload>,
		hostSeat: Seat | null,
	): Promise<void> {
		const result =
			seat === hostSeat
				? await this.#controller.send(payload)
				: await this.#controller.sendBot(seat, payload);
		if (!result.ok) throw new Error("host rejected local bot action");
		this.#rerun = true;
	}
}
