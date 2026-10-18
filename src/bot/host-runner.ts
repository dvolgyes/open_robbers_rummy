import { legalActions } from "../bridge/engine";
import {
	actionPayload,
	claimVotePayload,
	parseBridgeState,
	resetVotePayload,
	undoVotePayload,
} from "../game/bridge";
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
import type { Decision } from "./strategy";
import {
	BOT_FALLBACK_MODEL,
	BOT_MODEL,
	decisionState,
	renderBidPrompt,
	renderPlayPrompt,
} from "./strategy";

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
	#templates:
		| Awaited<ReturnType<typeof loadBrowserPromptTemplates>>
		| undefined;
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
		const state = parseBridgeState(view.table.state, this.#controller.tableId);
		if (!state) return;
		for (const seat of seats) {
			const voteKey =
				state.claim?.required.includes(seat) &&
				!state.claim.approved.includes(seat)
					? `claim:${state.claim.id}:${seat}`
					: state.undo?.required.includes(seat) &&
							!state.undo.approved.includes(seat)
						? `undo:${state.undo.id}:${seat}`
						: state.reset?.required.includes(seat) &&
								!state.reset.approved.includes(seat)
							? `reset:${state.reset.id}:${seat}`
							: undefined;
			if (voteKey && !this.#processed.has(voteKey)) {
				this.#processed.add(voteKey);
				const payload = state.claim
					? claimVotePayload(this.#controller.tableId, state.claim.id, false)
					: state.undo
						? undoVotePayload(this.#controller.tableId, state.undo.id, true)
						: resetVotePayload(
								this.#controller.tableId,
								state.reset?.id ?? "",
								true,
							);
				await this.#send(seat, payload, view.seat);
				return;
			}
		}
		if (state.claim || state.undo || state.reset || !state.board) return;
		for (const seat of seats) {
			// legalActions assigns dummy's turn to declarer, so only declarer can choose a dummy card.
			const actions = legalActions(state.board, seat);
			if (actions.length === 0) continue;
			const key = `${state.board.number}:${actionPositionKey(state.board)}:${seat}`;
			if (this.#processed.has(key)) continue;
			this.#processed.add(key);
			const kind = actions[0]?.type;
			if (!kind) return;
			this.#templates ??= await loadBrowserPromptTemplates();
			const prompt =
				kind === "call"
					? renderBidPrompt(state.board, seat, actions, this.#templates)
					: renderPlayPrompt(state.board, seat, actions, this.#templates);
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
				(message) => this.#onStatus(`${config.names[seat]}: ${message}`),
			);
			let decision: Decision;
			try {
				decision = await strategy.choose(
					kind,
					prompt,
					actions,
					decisionState(state.board, seat, kind),
				);
			} catch (error) {
				this.#processed.delete(key);
				throw error;
			}
			if (this.#stopped) return;
			const current = this.#controller.view();
			const currentBots = current.roster?.bots ?? configuredBotSeats(config);
			if (!this.#activeSeats(currentBots).includes(seat)) return;
			const currentState = current.table
				? parseBridgeState(current.table.state, this.#controller.tableId)
				: undefined;
			if (
				!currentState?.board ||
				actionPositionKey(currentState.board) !== actionPositionKey(state.board)
			)
				return;
			const action = actions.find((item) =>
				decision.type === "call"
					? item.type === "call" && item.call === decision.call
					: item.type === "play" && item.card === decision.card,
			);
			if (!action) return;
			await this.#send(
				seat,
				actionPayload(this.#controller.tableId, state.board, action),
				view.seat,
			);
			return;
		}
	}

	async #send(
		seat: Seat,
		payload:
			| ReturnType<typeof actionPayload>
			| ReturnType<typeof undoVotePayload>
			| ReturnType<typeof claimVotePayload>
			| ReturnType<typeof resetVotePayload>,
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
