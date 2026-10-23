import {
	BOTS_PAUSED_PARAM,
	botSeatsQuery,
	botsPausedQuery,
	parseBotsPaused,
	SELECTED_PLAYER_PARAM,
} from "../bookmark";
import { configuredBotSeats, HostBotRunner } from "../bot/host-runner";
import type { Thinker } from "../bot/think";
import { workerThinker } from "../bot/worker-thinker";
import { CallController } from "../call/call";
import { classify, readSignals, watchDeviceClass } from "../call/device-class";
import { createCallSignaling } from "../call/signaling";
import { chatPayload, checkMessageText } from "../game/chat";
import {
	actionPayload,
	engineSeat,
	handViewFor,
	parseRummyState,
	type RummyState,
	resetCancelPayload,
	resetRequestPayload,
	resetVotePayload,
	startPayload,
} from "../game/rummy";
import { tableLink } from "../p2p/link";
import type { TableController, TableStatus } from "../p2p/table";
import {
	type JsonObject,
	SEAT_NAMES,
	SEATS,
	type Seat,
	seatsOf,
	type TableConfig,
} from "../protocol";
import { CallMemory } from "./call-memory";
import type { CallDisplay, RemoteCallPresence } from "./call-model";
import { cameraSetup } from "./camera-setup";
import type { AppDeps, Dispose, Navigation } from "./deps";
import { button, copyToClipboard, el } from "./dom";
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
	storageNotice,
	submitText,
	TEXT,
	type TranscriptLine,
	tablePageView,
} from "./model";
import { networkPanel } from "./network";
import { remoteAudio } from "./remote-audio";
import { tableSection } from "./table";
import { type TableViewInput, tableView } from "./table-model";
import type { TurnSound } from "./turn-sound";

export interface TablePageHandlers extends Navigation {
	/** Tries to claim this seat again after it becomes available. */
	retrySeat(): void;
	/** Shared by the lobby and the table page so a seat-selection gesture unlocks turn alerts. */
	turnSound: TurnSound;
}

const STATE_TEXT: Readonly<Record<RosterRow["state"], string>> = {
	online: "Online",
	offline: "Offline",
	free: "Free",
};

function tableShareLink(pageUrl: string, key: string): string {
	const page = new URL(pageUrl);
	page.searchParams.delete(SELECTED_PLAYER_PARAM);
	page.searchParams.delete(BOTS_PAUSED_PARAM);
	return tableLink(page.toString(), key);
}

/** After these, the table stays on the screen but can no longer act. */
const TERMINAL: ReadonlySet<TableStatus> = new Set([
	"expired",
	"superseded",
	"incompatible",
]);

/**
 * The table screen of the seat that this page holds. It renders the controller's view and sends through the
 * controller; the caller owns the controller and stops it.
 */
export function showTablePage(
	root: HTMLElement,
	deps: AppDeps,
	controller: TableController,
	key: string,
	seat: Seat,
	handlers: TablePageHandlers,
	fallbackConfig?: TableConfig,
	autoCopy?: Promise<string>,
	startBots = false,
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
	/** The solver behind the Suggest button; it starts with the first suggestion. */
	let suggester: Thinker | undefined;
	let remoteCallPresence: Partial<Record<Seat, RemoteCallPresence>> = {};
	const botSeatOverrides = new Map<Seat, boolean>();
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
		const enabledSeat = await controller.setBotSeat(targetSeat, true);
		if (!enabledSeat) return "failed";
		delegatedBotSeats.add(targetSeat);
		if (botRunner) {
			botRunner.setSeatEnabled(targetSeat, true);
			setBotsPaused(false);
			botRunner.resume();
			return "enabled";
		}
		const started = await startHostBots(targetSeat);
		if (!started) {
			delegatedBotSeats.delete(targetSeat);
			await controller.setBotSeat(targetSeat, false);
			return "failed";
		}
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
	const botStatus = el("p", { attrs: { role: "status" } });
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
	/** The browser's answer to the persistence request. */
	let persisted: boolean | undefined;
	/** The table as last rendered: an action is sent for the position the player saw. */
	let shownState: RummyState | undefined;
	/** The input of the table view as last built: the selected cards find their actions in it. */
	let tableInput: TableViewInput | undefined;
	/** The view models as last rendered. The controller notifies every tick; equal models keep their nodes. */
	let shownPage: string | undefined;
	let shownTable: string | undefined;
	/** The host command last sent for the table: the start, keyed by the match count. */
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
			: deps.t("Running {count} bot seat(s).", { count });
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
				await navigator.share({ url: tableShareLink(deps.pageUrl(), key) });
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
			suggest() {
				const match = shownState?.match;
				if (!match) return Promise.resolve(undefined);
				suggester ??= workerThinker();
				return suggester.choose(handViewFor(match, seat), engineSeat(seat));
			},
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
				"Send this link to the people who play at this table. Each one opens it and takes a free seat.",
			),
		),
		button(deps.t("Copy table link"), () => copyLink()),
	);
	const copyTableLink = button(deps.t("Copy link"), () => copyLink(), {
		attrs: { "data-testid": "copy-table-url" },
	});
	// A copy beeps when the link is on the clipboard; otherwise the action note says why.
	function showCopy(message: string): void {
		const copied = message === "Copied.";
		actionError = copied ? undefined : deps.t(message);
		if (copied) turnAlert.beep();
		render();
	}
	async function copyLink(): Promise<void> {
		showCopy(await copyToClipboard(tableShareLink(deps.pageUrl(), key)));
	}
	if (autoCopy) void autoCopy.then(showCopy);
	// A reset clears the scores and starts a new match once every other present player approves it. The new game
	// button after a finished match sends the same request.
	function requestReset(): void {
		actionError = undefined;
		submit(resetRequestPayload(tableId), (reason) => {
			actionError = deps.t("Reset not sent: {reason}", { reason });
		});
	}
	const reset = button(deps.t("Reset"), requestReset, {
		className: "reset-button",
		attrs: { "data-testid": "reset" },
	});
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
		className: "table-page-exit",
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
		botRunner.resume();
		setBotsPaused(false);
		botStatus.textContent = runningBotStatus();
		render();
	});
	const pageControls = el(
		"section",
		{
			className: "table-page-controls",
			attrs: { "data-testid": "table-page-controls" },
		},
		el(
			"div",
			{ className: "table-page-control-row table-page-primary-controls" },
			copyTableLink,
			reset,
			exit,
		),
		el(
			"div",
			{ className: "table-page-control-row table-page-bot-controls" },
			pauseBots,
			resumeBots,
		),
		// The table screen has its own language picker here; the page-wide one is hidden while a table shows.
		languageControl(deps),
		botStatus,
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
		{
			className: "table-page-drawer",
			attrs: { "data-testid": "table-page-drawer" },
		},
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
	const page = el(
		"section",
		{ className: "table-page" },
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
		el("footer", { className: "table-page-footer" }, pageControls, drawer),
	);
	// The table has one responsive layout; deviceForm remains the call policy for camera support.
	page.dataset.form = "desktop";
	table.setForm("desktop");
	// A wide landscape window shows the page as one 1920×1080 canvas (see style.css); this is its scale to fit.
	const updateCanvasScale = (): void => {
		const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
		root.style.setProperty("--table-page-scale", String(scale));
	};
	updateCanvasScale();
	window.addEventListener("resize", updateCanvasScale);
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
	root.replaceChildren(page);
	if (camera) root.append(camera.element);
	if (startBots) void startHostBots();

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
		botStarting = true;
		botAutoAttempted = true;
		const runner = new HostBotRunner(controller, workerThinker(), (detail) => {
			for (const delegatedSeat of delegatedBotSeats) {
				delegatedBotSeats.delete(delegatedSeat);
				void controller.setBotSeat(delegatedSeat, false);
			}
			botRunner = undefined;
			setBotsPaused(false);
			botStatus.textContent = deps.t("The bots stopped: {detail}", {
				detail,
			});
			render();
		});
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
			view.hosting
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
		copyTableLink.hidden = false;
		const model = tablePageView({
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
		const pageKey = JSON.stringify([model, confirming]);
		if (pageKey !== shownPage) {
			shownPage = pageKey;
			roster.replaceChildren(...model.roster.map(rosterItem));
			transcript.replaceChildren(...model.transcript.map(transcriptItem));
			pending.replaceChildren(...model.pending.map(pendingItem));
		}
		const state =
			view.table === null
				? undefined
				: (parseRummyState(view.table.state, tableId) ?? null);
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
			const requester = `${config.names[pendingReset.requester]} (${deps.t(SEAT_NAMES[pendingReset.requester])})`;
			const waitingFor = pendingReset.required
				.filter((player) => !pendingReset.approved.includes(player))
				.map(
					(player) => `${config.names[player]} (${deps.t(SEAT_NAMES[player])})`,
				);
			resetStatus.textContent =
				pendingReset.requester === seat
					? deps.t("Waiting for {players} to approve the reset.", {
							players: waitingFor.join(", "),
						})
					: deps.t("{requester} asks to reset the game.", { requester });
		}
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
			outbox: view.outbox,
			failures: view.failures,
			undone: view.undone,
			t: deps.t,
		};
		const tableModel = tableView(tableInput);
		table.setBotControls(view.hosting && !botRestorePending, activeBots);
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
		document.title = `${yourTurn ? "TURN - " : ""}Open Robber's Rummy: ${config.names[seat]} (${deps.t(SEAT_NAMES[seat])})`;
		checkTurnAlert();
		// The lobby uses the table layout, so it looks like the game; only the game controls differ while waiting.
		root.dataset.screen = "table";
		root.dataset.waiting = String(tableModel.phase === "waiting");
		const tableKey = JSON.stringify(tableModel);
		if (tableKey !== shownTable) {
			shownTable = tableKey;
			table.render(tableModel);
		}
		// The host starts the game once every playing seat is connected. The start key counts the games, so the host
		// starts again after a reset; nothing is dealt while a reset waits.
		const hostCommand =
			!view.hosting ||
			terminal ||
			state === undefined ||
			state === null ||
			state.reset !== null
				? undefined
				: state.match === null
					? seatsOf(config).every((player) => present.has(player))
						? {
								key: `start:${state.matches}`,
								payload: startPayload(tableId),
							}
						: undefined
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
	page.addEventListener("pointerdown", onGesture);
	page.addEventListener("keydown", onGesture);
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
		suggester?.close();
		stopWatching();
		window.removeEventListener("resize", updateCanvasScale);
		root.style.removeProperty("--table-page-scale");
		unsubscribe();
		unsubscribeCamera?.();
		camera?.dispose();
		document.removeEventListener("visibilitychange", onPageStateChange);
		page.removeEventListener("pointerdown", onGesture);
		page.removeEventListener("keydown", onGesture);
		memory?.stop();
		call?.dispose();
		audio.detach();
	};
}
