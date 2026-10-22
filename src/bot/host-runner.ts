import {
	actionPayload,
	engineSeat,
	parseCanastaState,
	resetVotePayload,
} from "../game/canasta";
import type { TableController } from "../p2p/table";
import { type BotModel, type RoomConfig, SEATS, type Seat } from "../protocol";
import {
	BotRequestAbortedError,
	BrowserOpenRouterStrategy,
	botRequestFailureMessage,
	InsufficientBalanceError,
} from "./browser-openrouter";
import { loadBrowserPromptTemplates } from "./browser-prompts";
import { normalizeHostApiKey } from "./host-key";
import { actionPositionKey } from "./position";
import {
	BOT_FALLBACK_MODEL,
	BOT_MODEL,
	type Choice,
	type PromptTemplates,
} from "./strategy";
import { chooseTurn, turnKey, turnRequest } from "./turn";

export interface HostBotSettings {
	readonly apiKey: string;
	readonly model: BotModel;
	readonly fallbackModel: BotModel;
	readonly modelOrder: readonly BotModel[];
	readonly retries: number;
	readonly retryDelayMs: number;
}

export function configuredBotSeats(config: RoomConfig): Seat[] {
	return SEATS.filter((seat) => config.botSetup?.seats.includes(seat) === true);
}

/** Runs host-managed bot decisions in the page that currently owns the host. */
export class HostBotRunner {
	readonly #controller: TableController;
	#settings: HostBotSettings;
	readonly #onError: (
		kind: "balance" | "failed" | "rate-limit",
		detail?: string,
	) => void;
	readonly #onUsageCost: (cost: number) => void;
	readonly #onStatus: (message: string) => void;
	#requestAbort = new AbortController();
	readonly #processed = new Set<string>();
	#unsubscribe: (() => void) | undefined;
	#templates: PromptTemplates | undefined;
	#running = false;
	#rerun = false;
	#stopped = false;
	#paused = false;
	readonly #seatOverrides = new Map<Seat, boolean>();

	constructor(
		controller: TableController,
		settings: HostBotSettings,
		onError: (
			kind: "balance" | "failed" | "rate-limit",
			detail?: string,
		) => void = () => {},
		onUsageCost: (cost: number) => void = () => {},
		onStatus: (message: string) => void = () => {},
	) {
		const normalizedApiKey = normalizeHostApiKey(settings.apiKey);
		if (!normalizedApiKey) throw new Error("OpenRouter API key is required");
		this.#controller = controller;
		this.#settings = { ...settings, apiKey: normalizedApiKey };
		this.#onError = onError;
		this.#onUsageCost = onUsageCost;
		this.#onStatus = onStatus;
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
		this.#requestAbort.abort();
		this.#unsubscribe?.();
	}

	pause(): void {
		this.#paused = true;
		this.#requestAbort.abort();
	}

	resume(): void {
		if (this.#stopped || !this.#paused) return;
		this.#paused = false;
		this.#requestAbort = new AbortController();
		this.#schedule();
	}

	updateApiKey(apiKey: string): void {
		this.#settings = {
			...this.#settings,
			apiKey: normalizeHostApiKey(apiKey),
		};
	}

	updateSettings(settings: HostBotSettings): void {
		this.#settings = {
			...settings,
			apiKey: normalizeHostApiKey(settings.apiKey),
		};
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
			// The key and upstream response are private. The room remains playable and the host can retry.
			if (this.#stopped) return;
			if (this.#paused && error instanceof BotRequestAbortedError) return;
			if (error instanceof InsufficientBalanceError) {
				this.pause();
				this.#onError("balance");
				return;
			}
			this.stop();
			this.#onError("failed", botRequestFailureMessage(error));
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
		const state = parseCanastaState(view.table.state, this.#controller.tableId);
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
		if (!state || !match || match.settled || match.winner !== null) return;
		for (const seat of seats) {
			// Only the seat whose turn it is has legal actions, so other seats are skipped here.
			if (match.hand.turn !== engineSeat(seat)) continue;
			// The table changes on every tick and ping. The choices take a search on the page's only thread, so a
			// position that was already asked is skipped before they are computed again.
			if (this.#processed.has(turnKey(match, state.actions, seat))) continue;
			this.#templates ??= await loadBrowserPromptTemplates();
			const request = turnRequest(match, state.actions, seat, this.#templates);
			if (!request || this.#processed.has(request.key)) continue;
			this.#processed.add(request.key);
			const report = (message: string) =>
				this.#onStatus(`${config.names[seat]}: ${message}`);
			const strategy = new BrowserOpenRouterStrategy(
				this.#settings.apiKey,
				{
					model: this.#settings.model || BOT_MODEL,
					fallbackModel: this.#settings.fallbackModel || BOT_FALLBACK_MODEL,
					modelOrder: this.#settings.modelOrder,
					retries: this.#settings.retries,
					retryDelayMs: this.#settings.retryDelayMs,
				},
				this.#requestAbort.signal,
				() => this.#onError("rate-limit"),
				this.#onUsageCost,
				report,
			);
			let choice: Choice;
			try {
				choice = await chooseTurn(strategy, request, report);
			} catch (error) {
				this.#processed.delete(request.key);
				throw error;
			}
			if (this.#stopped) return;
			const current = this.#controller.view();
			const currentBots = current.roster?.bots ?? configuredBotSeats(config);
			if (!this.#activeSeats(currentBots).includes(seat)) return;
			const currentState = current.table
				? parseCanastaState(current.table.state, this.#controller.tableId)
				: undefined;
			const currentMatch = currentState?.match;
			if (
				!currentState ||
				!currentMatch ||
				actionPositionKey(currentMatch.handNo, currentState.actions) !==
					actionPositionKey(match.handNo, state.actions)
			)
				return;
			await this.#send(
				seat,
				actionPayload(
					this.#controller.tableId,
					match,
					state.actions,
					choice.action,
				),
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
