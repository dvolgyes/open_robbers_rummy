import {
	BOTS_PAUSED_PARAM,
	botSeatsQuery,
	botsPausedQuery,
	parseBookmark,
	parseBotsPaused,
	SELECTED_PLAYER_PARAM,
} from "../bookmark";
import {
	normalizeHostApiKey,
	readHostApiKey,
	writeHostApiKey,
} from "../bot/host-key";
import {
	configuredBotSeats,
	HostBotRunner,
	type HostBotSettings,
} from "../bot/host-runner";
import { CallController } from "../call/call";
import { classify, readSignals, watchDeviceClass } from "../call/device-class";
import { createCallSignaling } from "../call/signaling";
import {
	actionPayload,
	type CanastaState,
	nextHandPayload,
	parseCanastaState,
	resetCancelPayload,
	resetRequestPayload,
	resetVotePayload,
	startPayload,
} from "../game/canasta";
import { chatPayload, checkMessageText } from "../game/chat";
import { tableLink } from "../p2p/link";
import type { TableController, TableStatus } from "../p2p/table";
import {
	type BotModel,
	botModelLabel,
	botModelOrder,
	DEFAULT_BOT_SETUP,
	type JsonObject,
	type RoomConfig,
	SEATS,
	type Seat,
} from "../protocol";
import { CallMemory } from "./call-memory";
import type { CallDisplay, RemoteCallPresence } from "./call-model";
import { cameraSetup } from "./camera-setup";
import type { AppDeps, Dispose, Navigation } from "./deps";
import { button, el } from "./dom";
import { languageControl } from "./language-control";
import {
	type Banner,
	bannerFor,
	bannerText,
	chatRefusalText,
	draftFor,
	heldSeats,
	networkLines,
	type PendingLine,
	presentSeats,
	type RosterRow,
	releaseText,
	roomView,
	storageNotice,
	submitText,
	TEXT,
	type TranscriptLine,
} from "./model";
import { modelPriorityControl } from "./model-priority";
import { networkPanel } from "./network";
import { remoteAudio } from "./remote-audio";
import { tableSection } from "./table";
import {
	selectionOptions,
	type TableViewInput,
	tableView,
} from "./table-model";
import type { TurnSound } from "./turn-sound";

export interface RoomScreenHandlers extends Navigation {
	/** Tries to claim this seat again after it becomes available. */
	retrySeat(): void;
	/** Shared by the lobby and room so a seat-selection gesture unlocks turn alerts. */
	turnSound: TurnSound;
}

const STATE_TEXT: Readonly<Record<RosterRow["state"], string>> = {
	online: "Online",
	offline: "Offline",
	free: "Free",
};

function roomShareLink(pageUrl: string, key: string): string {
	const page = new URL(pageUrl);
	page.searchParams.delete(SELECTED_PLAYER_PARAM);
	page.searchParams.delete(BOTS_PAUSED_PARAM);
	return tableLink(page.toString(), key);
}

function settingsFor(
	config: RoomConfig | undefined,
	apiKey: string,
	modelOrderOverride?: readonly BotModel[],
): HostBotSettings {
	const setup = config?.botSetup ?? DEFAULT_BOT_SETUP;
	const modelOrder = modelOrderOverride ?? botModelOrder(setup);
	return {
		apiKey,
		...setup,
		model: modelOrder[0] as BotModel,
		fallbackModel: modelOrder[1] as BotModel,
		modelOrder,
	};
}

/** After these, the room stays on the screen but can no longer act. */
const TERMINAL: ReadonlySet<TableStatus> = new Set([
	"expired",
	"superseded",
	"incompatible",
]);

const BOT_SPEND_STORAGE_KEY = "open-canasta.openrouter-spend-usd";

/**
 * The room screen of the seat that this page holds. It renders the controller's view and sends through the
 * controller; the caller owns the controller and stops it.
 */
export function showRoom(
	root: HTMLElement,
	deps: AppDeps,
	controller: TableController,
	key: string,
	seat: Seat,
	handlers: RoomScreenHandlers,
	fallbackConfig?: RoomConfig,
	autoCopy?: Promise<string>,
	initialBotSettings?: HostBotSettings,
): Dispose {
	const tableId = controller.tableId;
	let disposed = false;

	// The call is optional and separate from the game: it reads the table, and its actions never send a command.
	const deviceForm = classify(readSignals(window));
	const support = deps.call;
	const camera = support.available
		? cameraSetup({
				devices: support.cameras,
				getUserMedia: support.getUserMedia,
				t: deps.t,
			})
		: undefined;
	const call = support.available
		? new CallController(
				{
					openSignaling: (inbox, callHandlers) =>
						createCallSignaling(controller.callTransport, inbox, callHandlers),
					getUserMedia: support.getUserMedia,
					createConnection: support.createConnection,
					newSession: support.newSession,
				},
				deviceForm,
			)
		: undefined;
	const memory =
		support.available && call !== undefined
			? new CallMemory({
					call,
					tableId,
					seat,
					holder: controller.holder,
					granted: support.granted,
					send: (payload) => controller.send(payload).then((sent) => sent.ok),
					changed: () => renderCall(),
				})
			: undefined;
	const unsubscribeCamera = camera?.onChange(() => renderCall());
	const audio = remoteAudio();
	const { turnSound: turnAlert } = handlers;
	let yourTurn = false;
	let currentTurnKey: string | undefined;
	let alertedTurn: string | undefined;
	let botRunner: HostBotRunner | undefined;
	const delegatedBotSeats = new Set<Seat>();
	let botStarting = false;
	let botAutoAttempted = false;
	let botRestoreStarted = false;
	let botRestorePending = false;
	// A reload keeps paused bots paused: the host's URL carries the pause.
	let botsPaused = parseBotsPaused(location.search);
	let botBalancePaused = false;
	let rateLimitTimer: number | undefined;
	let botSpendUsd = readBotSpend();
	let pendingBotSeat: Seat | undefined;
	let remoteCallPresence: Partial<Record<Seat, RemoteCallPresence>> = {};
	const botSeatOverrides = new Map<Seat, boolean>();
	let botSettings = initialBotSettings;
	let playerAutoplayPending = false;
	let playerAutoplayStatus = "";
	let playerAutoplayWasEnabled = false;
	let playerAutoplayConfirmedRoster = false;
	let playerAutoplayHost = "";

	controller.setAutoplayHandler(async (targetSeat, enabled) => {
		if (!controller.view().hosting) return "failed";
		if (!enabled) {
			if (!delegatedBotSeats.has(targetSeat)) return "disabled";
			const ok = await controller.setBotSeat(targetSeat, false);
			if (!ok) return "failed";
			delegatedBotSeats.delete(targetSeat);
			botRunner?.setSeatEnabled(targetSeat, false);
			return "disabled";
		}
		const apiKey = readHostApiKey(deps.browser);
		if (!apiKey.trim()) return "unavailable";
		botSettings ??= settingsFor(
			controller.view().table?.config,
			apiKey,
			modelOrderFromUrl(),
		);
		if (!botSettings.apiKey.trim()) botSettings = { ...botSettings, apiKey };
		const enabledSeat = await controller.setBotSeat(targetSeat, true);
		if (!enabledSeat) return "failed";
		delegatedBotSeats.add(targetSeat);
		if (botRunner) {
			botRunner.setSeatEnabled(targetSeat, true);
			setBotsPaused(false);
			botBalancePaused = false;
			botRunner.resume();
			botStatus.textContent = deps.t(
				"Autoplay is using this host's OpenRouter key.",
			);
			return "enabled";
		}
		const started = await startHostBots(targetSeat);
		if (!started) {
			delegatedBotSeats.delete(targetSeat);
			await controller.setBotSeat(targetSeat, false);
			return "failed";
		}
		botStatus.textContent = deps.t(
			"Autoplay is using this host's OpenRouter key.",
		);
		return "enabled";
	});

	const you = el("p", { className: "you", attrs: { "data-testid": "you" } });
	const bannerLine = el("span", {});
	const becomeHost = button(deps.t(TEXT.becomeHost), () => controller.click(), {
		attrs: { "data-testid": "become-host" },
	});
	const bannerHint = el("span", { className: "note" });
	const retrySeat = button(deps.t("Try seat again"), handlers.retrySeat, {
		attrs: { "data-testid": "retry-seat" },
	});
	const createNew = button(deps.t("Create new game"), handlers.createNew);
	const botKey = el("input", {
		attrs: {
			type: "password",
			autocomplete: "new-password",
			"aria-label": deps.t("OpenRouter API key"),
		},
	});
	botKey.addEventListener("input", () => {
		botKey.value = normalizeHostApiKey(botKey.value);
	});
	const modelPriority = modelPriorityControl(
		botModelOrder(
			botSettings ??
				settingsFor(
					controller.view().table?.config ?? fallbackConfig,
					readHostApiKey(deps.browser),
					modelOrderFromUrl(),
				),
		),
		deps.t,
	);
	const botStatus = el("p", { attrs: { role: "status" } });
	const botSpendCounter = el("span", {
		className: "bot-spend-counter",
		attrs: {
			"aria-label": deps.t("OpenRouter spending total"),
			"data-testid": "bot-spend",
		},
	});
	updateBotSpendCounter();
	const rateLimitReminder = el(
		"div",
		{
			className: "rate-limit-reminder",
			attrs: { role: "status", "data-testid": "rate-limit-reminder" },
		},
		deps.t("Openrouter rate limit - I will retry in a moment"),
	);
	rateLimitReminder.hidden = true;
	const showRateLimitReminder = (): void => {
		rateLimitReminder.hidden = false;
		if (rateLimitTimer !== undefined) window.clearTimeout(rateLimitTimer);
		rateLimitTimer = window.setTimeout(() => {
			rateLimitReminder.hidden = true;
			rateLimitTimer = undefined;
		}, 1000);
	};
	const keyDialog = el("dialog", {
		attrs: {
			"aria-labelledby": "api-key-title",
			"data-testid": "api-key-dialog",
		},
	});
	const modelDialog = el("dialog", {
		attrs: {
			"aria-labelledby": "bot-model-title",
			"data-testid": "bot-model-dialog",
		},
	});
	modelDialog.append(
		el("h2", { attrs: { id: "bot-model-title" } }, deps.t("Choose bot model")),
		el(
			"p",
			{},
			deps.t(
				"After a server error, the bot tries the next model in this order.",
			),
		),
		modelPriority.element,
		button(deps.t("Use model"), () => {
			const modelOrder = modelPriority.value();
			const current =
				botSettings ??
				settingsFor(
					controller.view().table?.config ?? fallbackConfig,
					readHostApiKey(deps.browser),
					modelOrderFromUrl(),
				);
			botSettings = {
				...current,
				modelOrder,
				model: modelOrder[0] as BotModel,
				fallbackModel: modelOrder[1] as BotModel,
			};
			rememberBotModels(modelOrder);
			botRunner?.updateSettings(botSettings);
			botStatus.textContent = runningBotStatus();
			modelDialog.close();
			render();
		}),
		button(deps.t("Cancel"), () => modelDialog.close()),
	);
	keyDialog.append(
		el(
			"h2",
			{ attrs: { id: "api-key-title" } },
			deps.t("Set OpenRouter API key"),
		),
		el("label", {}, `${deps.t("OpenRouter API key")} `, botKey),
		button(deps.t("Save key"), () => {
			try {
				const normalizedApiKey = normalizeHostApiKey(botKey.value);
				botKey.value = normalizedApiKey;
				writeHostApiKey(deps.browser, normalizedApiKey);
				botSettings = settingsFor(
					controller.view().table?.config ?? fallbackConfig,
					normalizedApiKey,
					botSettings?.modelOrder ?? modelOrderFromUrl(),
				);
				botRunner?.updateApiKey(normalizedApiKey);
				if (botBalancePaused) {
					botBalancePaused = false;
					setBotsPaused(false);
					botRunner?.resume();
				}
				keyDialog.close();
				botStatus.textContent = "";
				if (pendingBotSeat !== undefined) {
					const target = pendingBotSeat;
					pendingBotSeat = undefined;
					manageBotSeat(target, true);
				} else if (!botRunner) void startHostBots();
			} catch {
				botStatus.textContent = deps.t(
					"This browser could not store the OpenRouter API key.",
				);
			}
		}),
		button(deps.t("Cancel"), () => keyDialog.close()),
	);
	const banner = el(
		"div",
		{ className: "banner", attrs: { role: "status", "data-testid": "banner" } },
		bannerLine,
		becomeHost,
		bannerHint,
		retrySeat,
		createNew,
	);
	const actionNote = el("p", {
		className: "note",
		attrs: { role: "status", "data-testid": "action-note" },
	});
	const roster = el("ul", {
		className: "roster",
		attrs: { "data-testid": "roster" },
	});
	const rosterNote = el("p", { className: "note", attrs: { role: "status" } });
	const allConnected = el(
		"p",
		{ className: "note", attrs: { "data-testid": "all-connected" } },
		deps.t("All players connected"),
	);
	const transcript = el("ol", {
		className: "transcript",
		attrs: { "data-testid": "transcript" },
	});
	const pending = el("ul", {
		className: "pending",
		attrs: { "data-testid": "pending" },
	});
	const draft = el("textarea", {
		attrs: {
			rows: "2",
			"aria-label": deps.t("Message"),
			"data-testid": "draft",
		},
	});
	draft.value = draftFor(seat);
	const send = el("button", {
		attrs: { type: "submit", "data-testid": "send" },
	});
	const sendNote = el("p", { className: "note", attrs: { role: "status" } });
	const form = el("form", { className: "send" }, draft, send, sendNote);
	const network = networkPanel(deps.t);

	let sendError: string | undefined;
	let actionError: string | undefined;
	let releaseError: string | undefined;
	let confirming: Seat | undefined;
	/** The browser's answer to the persistence request (plan §4.3). */
	let persisted: boolean | undefined;
	/** The table as last rendered: an action is sent for the position the player saw. */
	let shownState: CanastaState | undefined;
	/** The input of the table view as last built: the selected cards find their actions in it. */
	let tableInput: TableViewInput | undefined;
	/** The view models as last rendered. The controller notifies every tick; equal models keep their nodes. */
	let shownRoom: string | undefined;
	let shownTable: string | undefined;
	let scoringHand: number | undefined;
	let scoringStartedAt: number | undefined;
	let scoringTimer: number | undefined;
	/** The host command last sent for the table: the start, or the next hand by its number. */
	let hostCommandSent: string | undefined;
	/** The reset request that the decision buttons answer. */
	let resetRequestId: string | undefined;

	/** Stores the command for sending; `onFail` gets the reason when this browser could not store it. */
	const submit = (
		payload: JsonObject,
		onFail: (reason: string) => void,
	): void => {
		void controller.send(payload).then((result) => {
			if (disposed) return;
			if (!result.ok) onFail(submitText(result, deps.t));
			render();
		});
	};

	function manageBotSeat(targetSeat: Seat, enabled: boolean): void {
		if (enabled && !readHostApiKey(deps.browser)) {
			pendingBotSeat = targetSeat;
			botStatus.textContent = deps.t(
				"Set an OpenRouter API key before switching a seat to a bot.",
			);
			if (!keyDialog.open) keyDialog.showModal();
			return;
		}
		void controller.setBotSeat(targetSeat, enabled).then((ok) => {
			if (!ok) {
				botStatus.textContent = deps.t("The host could not change that seat.");
				return;
			}
			botSeatOverrides.set(targetSeat, enabled);
			const currentView = controller.view();
			const currentBots = new Set(currentView.roster?.bots ?? []);
			if (enabled) currentBots.add(targetSeat);
			else currentBots.delete(targetSeat);
			rememberBotSeats([...currentBots]);
			if (enabled) {
				botRunner?.setSeatEnabled(targetSeat, true);
				if (botRunner) {
					setBotsPaused(false);
					botBalancePaused = false;
					botRunner.resume();
				} else {
					void startHostBots(targetSeat);
				}
			} else {
				botRunner?.setSeatEnabled(targetSeat, false);
			}
			if (botRunner)
				botStatus.textContent = botsPaused
					? deps.t("Bots paused.")
					: runningBotStatus();
			render();
		});
	}

	function readBotSpend(): number {
		try {
			const stored = deps.browser?.getItem(BOT_SPEND_STORAGE_KEY);
			if (stored === null || stored === undefined || stored.trim() === "")
				return 0;
			const amount = Number(stored);
			return Number.isFinite(amount) &&
				amount >= 0 &&
				amount <= Number.MAX_SAFE_INTEGER
				? amount
				: 0;
		} catch {
			return 0;
		}
	}

	function updateBotSpendCounter(): void {
		botSpendCounter.textContent = `$${botSpendUsd.toFixed(5)}`;
		botSpendCounter.title = `Five-decimal display. Exact total reported by OpenRouter: $${botSpendUsd.toFixed(10)} USD.`;
	}

	function recordBotSpend(cost: number): void {
		const next = botSpendUsd + cost;
		if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) return;
		botSpendUsd = next;
		try {
			deps.browser?.setItem(BOT_SPEND_STORAGE_KEY, String(botSpendUsd));
		} catch {
			// The counter remains available until this page closes if storage is unavailable.
		}
		updateBotSpendCounter();
	}

	function resetBotSpend(): void {
		botSpendUsd = 0;
		try {
			deps.browser?.removeItem(BOT_SPEND_STORAGE_KEY);
		} catch {
			// Clearing this reminder does not depend on persistent storage.
		}
		updateBotSpendCounter();
	}

	function effectiveBotSeats(): Seat[] {
		const view = controller.view();
		const config = view.table?.config ?? fallbackConfig;
		const active = new Set(
			view.roster?.bots ?? (config ? configuredBotSeats(config) : []),
		);
		for (const [targetSeat, enabled] of botSeatOverrides) {
			if (enabled) active.add(targetSeat);
			else active.delete(targetSeat);
		}
		return SEATS.filter((targetSeat) => active.has(targetSeat));
	}

	function runningBotStatus(): string {
		const count = effectiveBotSeats().length;
		return count === 0
			? deps.t("No bot seats are active.")
			: deps.t("Running {count} bot seat(s) with {model}.", {
					count,
					model: botModelLabel(botSettings?.model ?? DEFAULT_BOT_SETUP.model),
				});
	}

	function modelOrderFromUrl(): BotModel[] | undefined {
		const setup = parseBookmark(location.search).botSetup;
		return setup === undefined ? undefined : botModelOrder(setup);
	}

	function rememberBotModels(modelOrder: readonly BotModel[]): void {
		const params = new URLSearchParams(location.search);
		params.set("bot_model", modelOrder[0] as BotModel);
		params.set("bot_fallback", modelOrder[1] as BotModel);
		params.set("bot_models", modelOrder.join(","));
		history.replaceState(
			null,
			"",
			`${location.pathname}?${params.toString()}${location.hash}`,
		);
	}

	function setBotsPaused(paused: boolean): void {
		botsPaused = paused;
		if (parseBotsPaused(location.search) === paused) return;
		history.replaceState(
			null,
			"",
			`${location.pathname}?${botsPausedQuery(location.search, paused)}${location.hash}`,
		);
	}

	function rememberBotSeats(bots: readonly Seat[]): void {
		const query = botSeatsQuery(location.search, bots);
		history.replaceState(
			null,
			"",
			`${location.pathname}?${query}${location.hash}`,
		);
	}

	async function restoreBotSeats(bots: readonly Seat[]): Promise<void> {
		const desired = new Set(bots);
		for (const targetSeat of SEATS) {
			const current =
				controller.view().roster?.bots.includes(targetSeat) ?? false;
			if (current === desired.has(targetSeat)) continue;
			const ok = await controller.setBotSeat(
				targetSeat,
				desired.has(targetSeat),
			);
			if (!ok) {
				botStatus.textContent = deps.t(
					"The host could not restore the saved bot seats.",
				);
				break;
			}
			botSeatOverrides.set(targetSeat, desired.has(targetSeat));
		}
		botRestorePending = false;
		render();
	}

	const table = tableSection(
		{
			exit: handlers.createNew,
			async shareUrl() {
				if (navigator.share === undefined)
					throw new Error("Web Share API is unavailable");
				await navigator.share({ url: roomShareLink(deps.pageUrl(), key) });
			},
			act(action) {
				if (!shownState?.match) return;
				actionError = undefined;
				const { match, actions } = shownState;
				submit(actionPayload(tableId, match, actions, action), (reason) => {
					actionError = deps.t("Not sent: {reason}", { reason });
				});
				render();
			},
			selectionOptions: (shown, selected) =>
				tableInput === undefined
					? []
					: selectionOptions(tableInput, shown, selected),
			setBotSeat(targetSeat, enabled) {
				manageBotSeat(targetSeat, enabled);
			},
			newGame() {
				requestReset();
			},
			requestAutoplay(enabled) {
				playerAutoplayPending = true;
				playerAutoplayStatus = deps.t("Sending autoplay request…");
				render();
				void controller.requestAutoplay(enabled).then((status) => {
					playerAutoplayPending = false;
					if (status === "enabled") {
						playerAutoplayWasEnabled = true;
						playerAutoplayStatus = deps.t("The host is playing your seat.");
					} else if (status === "disabled") {
						playerAutoplayWasEnabled = false;
						playerAutoplayStatus = deps.t("Autoplay stopped.");
					} else if (status === "unavailable") {
						playerAutoplayWasEnabled = false;
						playerAutoplayStatus = deps.t(
							"Autoplay is unavailable on this host.",
						);
					} else {
						playerAutoplayStatus = deps.t("Autoplay request failed.");
					}
					render();
				});
			},
			// Only these explicit actions change the stored call status.
			call: {
				join: (selection) => {
					if (selection.send.video && camera?.available !== false) {
						void camera?.open().then((chosen) => {
							if (chosen === undefined || call === undefined) return;
							call.setVideoDevice(chosen.deviceId);
							if (!call.prepareVideo(chosen.track)) {
								chosen.track.stop();
								return;
							}
							call.join(selection);
							memory?.acted();
						});
						return;
					}
					const effective =
						selection.send.video && camera?.available === false
							? { ...selection, send: { ...selection.send, video: false } }
							: selection;
					call?.join(effective);
					memory?.acted();
				},
				leave: () => {
					call?.leave();
					memory?.acted();
				},
				setSwitch: (way, medium, on) => {
					if (
						way === "send" &&
						medium === "video" &&
						on &&
						call?.view.requested.inCall
					) {
						if (camera?.available === false) return;
						void camera?.open().then((chosen) => {
							if (chosen === undefined || call === undefined) return;
							call.setVideoDevice(chosen.deviceId);
							if (!call.prepareVideo(chosen.track)) {
								chosen.track.stop();
								return;
							}
							call.setSwitch(way, medium, true);
							memory?.acted();
						});
						return;
					}
					call?.setSwitch(way, medium, on);
					memory?.acted();
				},
				retry: (target) => call?.retry(target),
			},
		},
		deps.t,
	);

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const check = checkMessageText(draft.value);
		if (!check.ok) {
			sendError = deps.t("Not sent: {reason}.", {
				reason: chatRefusalText(check.reason, deps.t),
			});
			render();
			return;
		}
		const text = draft.value;
		draft.value = "";
		sendError = undefined;
		submit(chatPayload(tableId, check.text), (reason) => {
			sendError = deps.t("Not sent: {reason}", { reason });
			if (draft.value === "") draft.value = text;
		});
		render();
	});

	const release = (target: Seat): void => {
		confirming = undefined;
		releaseError = controller.release(target)
			? undefined
			: deps.t("Release failed: no host is connected. Try again later.");
		render();
	};

	const links = el(
		"section",
		{ className: "links" },
		el(
			"p",
			{},
			deps.t(
				"Send this link to the three other players. Each one opens it and takes a seat.",
			),
		),
		button(deps.t("Copy table link"), async () => {
			try {
				await navigator.clipboard.writeText(roomShareLink(deps.pageUrl(), key));
			} catch {
				// This secondary link control has no status text.
			}
		}),
	);
	const copyRoomLink = button(
		deps.t("Copy link"),
		async () => {
			try {
				await navigator.clipboard.writeText(roomShareLink(deps.pageUrl(), key));
				turnAlert.beep();
			} catch {
				// Clipboard failure stays silent, and does not signal success.
			}
		},
		{ attrs: { "data-testid": "copy-board-url" } },
	);
	if (autoCopy)
		void autoCopy.then(
			(message) => {
				if (message === "Copied.") turnAlert.beep();
			},
			() => undefined,
		);
	const setApiKey = button(deps.t("Set API key"), () => {
		botKey.value = readHostApiKey(deps.browser);
		if (!keyDialog.open) keyDialog.showModal();
	});
	const chooseModel = button(deps.t("Model"), () => {
		const config = controller.view().table?.config ?? fallbackConfig;
		botSettings ??= settingsFor(
			config,
			readHostApiKey(deps.browser),
			modelOrderFromUrl(),
		);
		modelPriority.setValue(botSettings.modelOrder);
		if (!modelDialog.open) modelDialog.showModal();
	});
	// A reset clears the scores and starts a new match once every other present player approves it. The new game
	// button after a finished match sends the same request but keeps the bot cost counter.
	function requestReset(): void {
		actionError = undefined;
		submit(resetRequestPayload(tableId), (reason) => {
			actionError = deps.t("Reset not sent: {reason}", { reason });
		});
	}
	const reset = button(
		deps.t("Reset"),
		() => {
			resetBotSpend();
			requestReset();
		},
		{ className: "reset-button", attrs: { "data-testid": "reset" } },
	);
	const resetStatus = el("p", { className: "note", attrs: { role: "status" } });
	const resetApprove = button(deps.t("Approve reset"), () => {
		if (resetRequestId !== undefined)
			submit(resetVotePayload(tableId, resetRequestId, true), (reason) => {
				actionError = deps.t("Reset approval not sent: {reason}", { reason });
			});
	});
	const resetReject = button(deps.t("Reject reset"), () => {
		if (resetRequestId !== undefined)
			submit(resetVotePayload(tableId, resetRequestId, false), (reason) => {
				actionError = deps.t("Reset decision not sent: {reason}", { reason });
			});
	});
	const resetCancel = button(deps.t("Cancel reset"), () => {
		if (resetRequestId !== undefined)
			submit(resetCancelPayload(tableId, resetRequestId), (reason) => {
				actionError = deps.t("Reset cancellation not sent: {reason}", {
					reason,
				});
			});
	});
	const resetDecision = el(
		"div",
		{ className: "reset-decision", attrs: { "data-testid": "reset-decision" } },
		resetStatus,
		resetApprove,
		resetReject,
		resetCancel,
	);
	resetDecision.hidden = true;
	const exit = button(deps.t("Exit"), handlers.createNew, {
		className: "room-exit",
	});
	const pauseBots = button(deps.t("Pause bots"), () => {
		if (!botRunner) return;
		botRunner.pause();
		setBotsPaused(true);
		botStatus.textContent = deps.t("Bots paused.");
		render();
	});
	const resumeBots = button(deps.t("Resume bots"), () => {
		if (!botRunner) {
			void startHostBots();
			return;
		}
		botBalancePaused = false;
		botRunner.resume();
		setBotsPaused(false);
		botStatus.textContent = runningBotStatus();
		render();
	});
	const roomControls = el(
		"section",
		{ className: "room-controls", attrs: { "data-testid": "room-controls" } },
		el(
			"div",
			{ className: "room-control-row room-primary-controls" },
			copyRoomLink,
			reset,
			exit,
		),
		el(
			"div",
			{ className: "room-control-row room-bot-controls" },
			setApiKey,
			chooseModel,
			pauseBots,
			resumeBots,
			botSpendCounter,
		),
		// The table screen has its own language picker here; the page-wide one is hidden while a table shows.
		languageControl(deps),
		botStatus,
		keyDialog,
		modelDialog,
	);

	// A storage warning stays visible on every screen, so it sits in the stage, not in the drawer.
	const storageNotices =
		deps.storageProblem === undefined
			? []
			: [
					el(
						"p",
						{ className: "notice" },
						storageNotice(deps.storageProblem, deps.t),
					),
				];

	// The stage holds what a player needs during play; on a compact device it fills the screen.
	// The players, invite link, network panel and messages sit in a drawer under the table, closed by default.
	const drawer = el(
		"details",
		{ className: "room-drawer", attrs: { "data-testid": "room-drawer" } },
		el("summary", {}, deps.t("Players and messages")),
		el("h2", {}, deps.t("Players")),
		roster,
		rosterNote,
		allConnected,
		links,
		network.element,
		el("h2", {}, deps.t("Messages")),
		transcript,
		pending,
		form,
	);
	const room = el(
		"section",
		{ className: "room" },
		el(
			"div",
			{ className: "stage" },
			you,
			banner,
			resetDecision,
			actionNote,
			...storageNotices,
			table.element,
		),
		audio.element,
		el("footer", { className: "room-footer" }, roomControls, drawer),
	);
	// The room has one responsive layout; deviceForm remains the call policy for camera support.
	room.dataset.form = "desktop";
	table.setForm("desktop");
	// A wide landscape window shows the room as one 1920×1080 canvas (see style.css); this is its scale to fit.
	const updateRoomCanvasScale = (): void => {
		const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
		root.style.setProperty("--room-canvas-scale", String(scale));
	};
	updateRoomCanvasScale();
	window.addEventListener("resize", updateRoomCanvasScale);
	const pageIsVisible = (): boolean => document.visibilityState === "visible";
	const checkTurnAlert = (): void => {
		if (
			yourTurn &&
			currentTurnKey !== undefined &&
			!pageIsVisible() &&
			alertedTurn !== currentTurnKey
		) {
			alertedTurn = currentTurnKey;
			turnAlert.beep();
		}
	};
	const onPageStateChange = (): void => {
		checkTurnAlert();
		render();
	};
	const stopWatching = watchDeviceClass(window, (form) => {
		call?.setForm(form);
	});
	root.replaceChildren(room);
	root.append(keyDialog);
	root.append(rateLimitReminder);
	if (camera) root.append(camera.element);
	if (initialBotSettings) void startHostBots();

	async function startHostBots(requiredSeat?: Seat): Promise<boolean> {
		if (botRunner) return true;
		if (botStarting) return false;
		const view = controller.view();
		const config = view.table?.config;
		if (!config) return false;
		const configured = view.roster?.bots ?? configuredBotSeats(config);
		if (configured.length === 0 && requiredSeat === undefined) return false;
		if (!view.hosting) {
			botStatus.textContent = deps.t(
				"Only the current host can run bots in this browser.",
			);
			return false;
		}
		botSettings ??= settingsFor(
			config,
			readHostApiKey(deps.browser),
			modelOrderFromUrl(),
		);
		if (!botSettings.apiKey.trim()) {
			botStatus.textContent = deps.t(
				"Set an OpenRouter API key to run the bots.",
			);
			return false;
		}
		botStarting = true;
		botAutoAttempted = true;
		const runner = new HostBotRunner(
			controller,
			botSettings,
			(kind, detail) => {
				if (kind === "rate-limit") {
					showRateLimitReminder();
					return;
				}
				for (const delegatedSeat of delegatedBotSeats) {
					delegatedBotSeats.delete(delegatedSeat);
					botRunner?.setSeatEnabled(delegatedSeat, false);
					void controller.setBotSeat(delegatedSeat, false);
				}
				if (kind === "balance") {
					setBotsPaused(true);
					botBalancePaused = true;
					botStatus.textContent = deps.t(
						"Insufficient OpenRouter balance. Bots are paused until you update the API key or balance.",
					);
				} else {
					botRunner = undefined;
					setBotsPaused(false);
					botStatus.textContent =
						detail ??
						deps.t(
							detail ??
								"The bot request failed. Check the model and resume bots.",
						);
				}
				render();
			},
			recordBotSpend,
			(message) => {
				botStatus.textContent = deps.t(message);
			},
		);
		if (
			!(await runner.start(requiredSeat === undefined ? [] : [requiredSeat]))
		) {
			runner.stop();
			botStarting = false;
			botStatus.textContent = deps.t(
				"Bots could not start. Check that this page is the ready host.",
			);
			return false;
		}
		botStarting = false;
		botRunner = runner;
		setBotsPaused(false);
		botStatus.textContent = runningBotStatus();
		return true;
	}

	function renderCall(): void {
		const display: CallDisplay =
			call === undefined
				? { available: false, reason: support.available ? "" : support.reason }
				: {
						available: true,
						view: call.view,
						rejoin: memory?.rejoin,
						cameraAvailable: camera?.available,
					};
		table.renderCall(display, remoteCallPresence);
		audio.render(display.available ? display.view.remotes : []);
	}

	function renderBanner(shown: Banner | undefined): void {
		banner.hidden = shown === undefined;
		banner.dataset.kind = shown?.kind ?? "";
		bannerLine.textContent =
			shown === undefined ? "" : bannerText(shown, deps.t);
		const host = shown?.kind === "waiting-for-host" ? shown.button : undefined;
		becomeHost.hidden = host === undefined;
		becomeHost.disabled = host?.enabled !== true;
		bannerHint.hidden = host?.hint === undefined;
		bannerHint.textContent = host?.hint === undefined ? "" : deps.t(host.hint);
		retrySeat.hidden = shown?.kind !== "superseded";
		createNew.hidden = shown?.kind !== "expired";
	}

	function rosterItem(row: RosterRow): HTMLElement {
		const item = el(
			"li",
			{ attrs: { "data-seat": row.seat, "data-state": row.state } },
			el("span", { className: "dot", attrs: { "aria-hidden": "true" } }),
			el("span", { className: "label" }, row.label),
		);
		if (row.host) item.append(el("span", { className: "tag" }, deps.t("Host")));
		if (row.you) item.append(el("span", { className: "tag" }, deps.t("You")));
		item.append(
			el("span", { className: "state" }, deps.t(STATE_TEXT[row.state])),
		);
		if (!row.releasable) return item;
		if (confirming === row.seat) {
			item.append(
				button(deps.t("Confirm release"), () => release(row.seat), {
					attrs: { "data-testid": `confirm-release-${row.seat}` },
				}),
				button(deps.t("Cancel"), () => {
					confirming = undefined;
					render();
				}),
			);
		} else {
			item.append(
				button(
					deps.t("Release"),
					() => {
						confirming = row.seat;
						render();
					},
					{ attrs: { "data-testid": `release-${row.seat}` } },
				),
			);
		}
		return item;
	}

	function transcriptItem(line: TranscriptLine): HTMLElement {
		return el(
			"li",
			{ attrs: { "data-seq": String(line.seq) } },
			el("span", { className: "from" }, line.from),
			el("span", { className: "text" }, line.text),
			el(
				"span",
				{ className: "receipt" },
				deps.t("Received by {receivedBy} of {of}", {
					receivedBy: line.receivedBy,
					of: line.of,
				}),
			),
		);
	}

	function pendingItem(line: PendingLine): HTMLElement {
		const status =
			line.state === "sending"
				? deps.t("Sending")
				: line.state === "pending"
					? (line.reason ?? deps.t("Pending — waiting for the host"))
					: line.state === "undone"
						? deps.t(TEXT.undone)
						: deps.t("Not sent: {reason}", {
								reason: line.reason ?? deps.t("failed"),
							});
		return el(
			"li",
			{ attrs: { "data-state": line.state } },
			el("span", { className: "text" }, line.text),
			el("span", { className: "status" }, status),
		);
	}

	function render(): void {
		if (disposed) return;
		const view = controller.view();
		const botConfig = view.table?.config ?? fallbackConfig;
		if (!view.hosting) {
			botSeatOverrides.clear();
			botRestoreStarted = false;
			botRestorePending = false;
		} else if (!botRestoreStarted && fallbackConfig?.botSetup !== undefined) {
			botRestoreStarted = true;
			botRestorePending = true;
			void restoreBotSeats(fallbackConfig.botSetup.seats);
		}
		const activeBotSet = new Set(
			view.roster?.bots ?? (botConfig ? configuredBotSeats(botConfig) : []),
		);
		for (const [targetSeat, enabled] of botSeatOverrides) {
			if (enabled) activeBotSet.add(targetSeat);
			else activeBotSet.delete(targetSeat);
		}
		const activeBots = [...activeBotSet];
		if (
			view.roster !== null &&
			!botRestorePending &&
			(view.hosting || (view.hostSeat !== null && view.hostSeat !== seat)) &&
			new URLSearchParams(location.search).get("bot_seats") !==
				SEATS.filter((targetSeat) => activeBotSet.has(targetSeat)).join(",")
		)
			rememberBotSeats(activeBots);
		setApiKey.hidden = !view.hosting;
		chooseModel.hidden = !view.hosting;
		pauseBots.hidden =
			!view.hosting || activeBots.length === 0 || botsPaused || !botRunner;
		resumeBots.hidden =
			!view.hosting ||
			activeBots.length === 0 ||
			(!botsPaused && botRunner !== undefined);
		if (botRunner && !view.hosting) {
			botRunner.stop();
			botRunner = undefined;
			setBotsPaused(false);
			botStatus.textContent = deps.t("Host changed. Bots stopped.");
		}
		if (
			!botAutoAttempted &&
			!botsPaused &&
			!botRestorePending &&
			activeBots.length > 0 &&
			view.hosting &&
			readHostApiKey(deps.browser)
		)
			void startHostBots();
		const terminal = view.seat !== seat || TERMINAL.has(view.status);
		call?.update(controller.callSnapshot());
		renderBanner(bannerFor(view));
		actionNote.textContent = actionError ?? "";
		actionNote.hidden = actionError === undefined;
		allConnected.hidden = !view.allConnected;
		rosterNote.textContent =
			releaseError ??
			(view.release?.ok === false
				? deps.t("Release failed: {reason}", {
						reason: releaseText(view.release.code, deps.t),
					})
				: "");
		network.render(
			networkLines({
				network: view.network,
				peers: view.peers,
				publicAddress: view.publicAddress,
				persistent: view.persistent,
				persisted,
				t: deps.t,
			}),
		);
		send.disabled = terminal;
		draft.disabled = terminal;
		// A new visitor learns the config from the host's lobby, or from the first copy of the table.
		const config = view.table?.config ?? view.lobby?.config ?? fallbackConfig;
		if (config === undefined) {
			root.dataset.screen = "table";
			root.dataset.waiting = "true";
			you.hidden = false;
			you.textContent = deps.t(TEXT.connecting);
			send.textContent = deps.t(TEXT.send);
			sendNote.textContent = sendError ?? "";
			return;
		}
		const present = presentSeats(view.hostSeat, view.roster);
		copyRoomLink.hidden = false;
		const model = roomView({
			config,
			seat,
			terminal,
			ready: view.ready,
			held: heldSeats(view.table?.seats ?? view.roster?.seats ?? []),
			online: present,
			hostSeat: view.hostSeat,
			acked: Object.fromEntries(
				(view.roster?.seats ?? []).map((row) => [row.seat, row.acked]),
			),
			entries: controller.entries(),
			outbox: view.outbox,
			failures: view.failures,
			undone: view.undone,
		});
		// The table shows the viewer's seat in the layout, so no "You are …" line is needed here.
		you.hidden = true;
		const roomKey = JSON.stringify([model, confirming]);
		if (roomKey !== shownRoom) {
			shownRoom = roomKey;
			roster.replaceChildren(...model.roster.map(rosterItem));
			transcript.replaceChildren(...model.transcript.map(transcriptItem));
			pending.replaceChildren(...model.pending.map(pendingItem));
		}
		const state =
			view.table === null
				? undefined
				: (parseCanastaState(view.table.state, tableId) ?? null);
		remoteCallPresence = {};
		for (const targetSeat of SEATS) {
			const record = state?.media[targetSeat];
			const currentHolder = view.roster?.seats.find(
				(row) => row.seat === targetSeat,
			);
			if (
				record === undefined ||
				!record.prefs.inCall ||
				record.holder !== currentHolder?.holder ||
				!present.has(targetSeat)
			) {
				continue;
			}
			remoteCallPresence[targetSeat] = {
				sendsAudio: record.prefs.send.audio,
				sendsVideo: record.prefs.send.video,
			};
		}
		renderCall();
		shownState = state ?? undefined;
		const pendingReset = state?.reset ?? null;
		resetRequestId = pendingReset?.id;
		reset.disabled =
			terminal || pendingReset !== null || (state?.match ?? null) === null;
		resetDecision.hidden = pendingReset === null;
		resetApprove.hidden =
			pendingReset === null ||
			!pendingReset.required.includes(seat) ||
			pendingReset.approved.includes(seat);
		resetReject.hidden = resetApprove.hidden;
		resetCancel.hidden = pendingReset?.requester !== seat;
		if (pendingReset) {
			const requester = `${config.names[pendingReset.requester]} (${deps.t(pendingReset.requester)})`;
			const waitingFor = pendingReset.required
				.filter((player) => !pendingReset.approved.includes(player))
				.map((player) => `${config.names[player]} (${deps.t(player)})`);
			resetStatus.textContent =
				pendingReset.requester === seat
					? deps.t("Waiting for {players} to approve the reset.", {
							players: waitingFor.join(", "),
						})
					: deps.t("{requester} asks to reset the game.", { requester });
		}
		// A settled hand with no winner waits for its countdown, then the host deals the next hand.
		const settledHand =
			state?.match?.settled && state.match.winner === null
				? state.match.handNo
				: undefined;
		if (settledHand !== scoringHand) {
			if (scoringTimer !== undefined) window.clearInterval(scoringTimer);
			scoringHand = settledHand;
			scoringStartedAt =
				settledHand === undefined
					? undefined
					: (view.table?.lastActivityAt ?? Date.now());
			scoringTimer =
				settledHand === undefined
					? undefined
					: window.setInterval(render, 1000);
		}
		const scoringCountdown =
			scoringStartedAt === undefined
				? 10
				: Math.max(
						0,
						Math.ceil((scoringStartedAt + 10_000 - Date.now()) / 1000),
					);
		memory?.update({
			records: state?.media,
			outbox: view.outbox.map((item) => item.payload),
		});
		tableInput = {
			config,
			seat,
			state,
			terminal,
			present,
			roster: model.roster,
			bots: new Set(activeBots),
			hostSeat: view.hostSeat,
			scoringCountdown,
			outbox: view.outbox,
			failures: view.failures,
			undone: view.undone,
			t: deps.t,
		};
		const tableModel = tableView(tableInput);
		const displayBotModel = view.hosting
			? (botSettings?.model ??
				config.botSetup?.model ??
				DEFAULT_BOT_SETUP.model)
			: (config.botSetup?.model ??
				modelOrderFromUrl()?.[0] ??
				DEFAULT_BOT_SETUP.model);
		table.setBotControls(
			view.hosting && !botRestorePending,
			activeBots,
			displayBotModel,
		);
		if (!view.hosting) delegatedBotSeats.clear();
		const rosterHost = JSON.stringify(view.roster?.auth ?? null);
		if (rosterHost !== playerAutoplayHost) {
			playerAutoplayHost = rosterHost;
			playerAutoplayWasEnabled = false;
			playerAutoplayConfirmedRoster = false;
		}
		const rosterAutoplay = view.roster?.bots.includes(seat) ?? false;
		if (rosterAutoplay) playerAutoplayConfirmedRoster = true;
		if (playerAutoplayConfirmedRoster && !rosterAutoplay) {
			playerAutoplayConfirmedRoster = false;
			playerAutoplayWasEnabled = false;
			playerAutoplayStatus = deps.t("Autoplay stopped by the host.");
		}
		table.setPlayerAutoplay(
			!view.hosting && view.roster?.autoplay === true,
			playerAutoplayWasEnabled || rosterAutoplay,
			playerAutoplayPending,
			playerAutoplayStatus,
		);
		yourTurn = tableModel.yourTurn;
		currentTurnKey = yourTurn
			? `${tableModel.handNo}:${tableModel.at}:${seat}`
			: undefined;
		document.title = `${yourTurn ? "TURN - " : ""}Open Canasta: ${config.names[seat]} (${deps.t(seat)})`;
		checkTurnAlert();
		// The lobby uses the table layout, so it looks like the game; only the game controls differ while waiting.
		root.dataset.screen = "table";
		root.dataset.waiting = String(tableModel.phase === "waiting");
		const tableKey = JSON.stringify(
			tableModel.scoring
				? {
						...tableModel,
						scoring: { ...tableModel.scoring, countdown: undefined },
					}
				: tableModel,
		);
		if (tableKey !== shownTable) {
			shownTable = tableKey;
			table.render(tableModel);
		}
		table.setCountdown(tableModel.scoring?.countdown);
		// The host starts the match once all four seats are connected, and deals each next hand after the countdown.
		// The start key counts the matches, so the host starts again after a reset; nothing is dealt while a reset waits.
		const hostCommand =
			!view.hosting ||
			terminal ||
			state === undefined ||
			state === null ||
			state.reset !== null
				? undefined
				: state.match === null
					? present.size === SEATS.length
						? {
								key: `start:${state.matches}`,
								payload: startPayload(tableId),
							}
						: undefined
					: settledHand !== undefined && scoringCountdown === 0
						? {
								key: `next:${settledHand}`,
								payload: nextHandPayload(tableId),
							}
						: undefined;
		if (hostCommand !== undefined && hostCommand.key !== hostCommandSent) {
			hostCommandSent = hostCommand.key;
			submit(hostCommand.payload, () => {
				hostCommandSent = undefined;
			});
		}
		send.textContent = deps.t(model.send.label);
		send.disabled = !model.send.enabled;
		sendNote.textContent =
			sendError ??
			(model.send.hint === undefined ? "" : deps.t(model.send.hint));
	}

	// A gesture lets the browser start remote audio that its autoplay rule blocked.
	const onGesture = (): void => {
		audio.resume();
	};
	room.addEventListener("pointerdown", onGesture);
	room.addEventListener("keydown", onGesture);
	document.addEventListener("visibilitychange", onPageStateChange);
	const unsubscribe = controller.onChange(render);
	call?.onChange(renderCall);
	if (deps.storage.persistent) {
		void deps.persist().then((answer) => {
			persisted = answer;
			render();
		});
	}
	render();
	renderCall();

	return () => {
		disposed = true;
		botRunner?.stop();
		if (rateLimitTimer !== undefined) window.clearTimeout(rateLimitTimer);
		if (scoringTimer !== undefined) window.clearInterval(scoringTimer);
		stopWatching();
		window.removeEventListener("resize", updateRoomCanvasScale);
		root.style.removeProperty("--room-canvas-scale");
		unsubscribe();
		unsubscribeCamera?.();
		camera?.dispose();
		document.removeEventListener("visibilitychange", onPageStateChange);
		room.removeEventListener("pointerdown", onGesture);
		room.removeEventListener("keydown", onGesture);
		memory?.stop();
		call?.dispose();
		audio.detach();
	};
}
