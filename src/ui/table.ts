import type { Form } from "../call/device-class";
import { englishTranslator as english, type Translate } from "../i18n";
import { SEAT_NAMES, type Seat } from "../protocol";
import type { Action } from "../rummy";
import {
	type CallDisplay,
	type RemoteCallPresence,
	remoteCallStatus,
} from "./call-model";
import { type CallHandlers, callControls, retryButton } from "./call-panel";
import { button, type Child, el } from "./dom";
import {
	type Draft,
	type DraftMove,
	type DraftTarget,
	loadPlay,
	moveCards,
	newDraft,
	returnToHand,
} from "./draft";
import { type HandOrder, sortHand } from "./hand-layout";
import { icon } from "./icons";
import { play } from "./remote-audio";
import { robotArtwork } from "./robot-artwork";
import {
	type CardView,
	type DraftView,
	draftView,
	type MeldCardView,
	type MeldView,
	type ResultView,
	type SeatView,
	type TableActionLine,
	type TableView,
	translateReason,
} from "./table-model";

export interface TableHandlers {
	exit(): void;
	shareUrl(): Promise<void>;
	act(action: Action): void;
	/**
	 * The solver's action for the viewer's turn. The screen offers it only while the table rules allow assist; a
	 * play loads into the draft, and any other action means that the solver found no play.
	 */
	suggest?(view: TableView): Promise<Action | undefined>;
	setBotSeat?(seat: Seat, enabled: boolean): void;
	requestAutoplay?(enabled: boolean): void;
	/** Asks the other players for a new game after the last one ended. */
	newGame?(): void;
	readonly call: CallHandlers;
}

export interface TableSection {
	readonly element: HTMLElement;
	render(view: TableView): void;
	/** The call changed: updates only the call controls and the call status of each remote seat. */
	renderCall(
		display: CallDisplay,
		presence?: Readonly<Partial<Record<Seat, RemoteCallPresence>>>,
	): void;
	setBotControls(hosting: boolean, bots: readonly Seat[], model?: string): void;
	setPlayerAutoplay(
		available: boolean,
		enabled: boolean,
		pending: boolean,
		status: string,
	): void;
	/** The device form changed; the layout itself is done by the stylesheet. */
	setForm(form: Form): void;
}

/**
 * The call nodes of one remote seat. They outlive the table's re-rendering and only move with their place, so
 * a picture never restarts because the game changed.
 */
interface CallSpot {
	readonly tile: HTMLElement;
	readonly caption: HTMLElement;
	/** Muted: the seat's sound plays only through its audio element. */
	readonly video: HTMLVideoElement;
	readonly botOverlay: HTMLElement;
	readonly botArtwork: HTMLImageElement;
	readonly botFallback: HTMLElement;
	readonly callPresence: HTMLElement;
	readonly botControl: HTMLButtonElement;
	/** Compact: the status beside the seat's name. */
	readonly state: HTMLElement;
	/** The status last shown, so an unchanged status keeps its nodes (and the focus on Retry). */
	shown: string | undefined;
	/** The remote camera track on the video element. */
	track: MediaStreamTrack | undefined;
}

const ACTION_STATUS: Readonly<Record<TableActionLine["state"], string>> = {
	sending: "Sending",
	pending: "Waiting for the host",
	"not-accepted": "Not accepted",
	undone: "Undone after a host change",
};

const CONNECTING_TEXT = "CONNECTING TO HOST";

function isRed(suit: CardView["suit"]): boolean {
	return suit === "H" || suit === "D";
}

function suitClasses(card: CardView): string {
	return `${isRed(card.suit) ? " red" : ""}${card.suit === null ? " joker" : ""}`;
}

/** A card in a line of text: its rank and suit symbol, red for hearts and diamonds, as on the hand's cards. */
function cardPip(card: CardView): HTMLElement {
	return el("span", { className: `pip${suitClasses(card)}` }, card.text);
}

/**
 * The rummy table as the viewer sees it: the other players in a row at the top, the melds on the table in the
 * middle, and the viewer's own hand with its actions at the bottom. On the viewer's turn, the melds and the hand
 * are a draft that the viewer edits and then plays.
 */
export function tableSection(
	handlers: TableHandlers,
	t: Translate = english,
): TableSection {
	// Status.
	const heading = el("h3", { className: "table-heading" });
	const details = el("span", { className: "note" });
	const prompt = el("p", {
		className: "prompt",
		attrs: { role: "status", "data-testid": "table-prompt" },
	});
	const commands = el("ul", {
		className: "commands",
		attrs: { "data-testid": "table-actions" },
	});
	const head = el(
		"div",
		{ className: "table-head", attrs: { "data-testid": "table-head" } },
		el("div", { className: "meta" }, heading, details),
		prompt,
		commands,
	);

	// After the game, the result covers the middle of the felt: who went out, each player's penalty, and the offer
	// of a new game.
	const winnerLine = el("h2", { className: "winner" });
	const outcomeLine = el("h3", { className: "outcome" });
	const resultTable = el("table", { className: "score-table" });
	const newGameButton = button(t("New game"), () => handlers.newGame?.(), {
		className: "new-game",
		attrs: { "data-testid": "new-game" },
	});
	const summary = el(
		"section",
		{
			className: "hand-summary",
			attrs: { "data-testid": "hand-summary", "aria-live": "polite" },
		},
		winnerLine,
		outcomeLine,
		resultTable,
		newGameButton,
	);

	// The other players in turn order after the viewer, at most five.
	const opponents = el("div", {
		className: "opponents",
		attrs: { "data-testid": "opponents" },
	});

	// The stock and the melds on the table.
	const stockCount = el("span", { className: "stock-count" });
	const stock = el(
		"div",
		{ className: "stock", attrs: { "data-testid": "stock" } },
		el("span", { className: "label" }, t("Stock")),
		stockCount,
	);
	const melds = el("div", {
		className: "melds",
		attrs: { "data-testid": "melds" },
	});
	const centre = el(
		"div",
		{ className: "centre", attrs: { "data-testid": "centre" } },
		stock,
		melds,
	);

	// The viewer's hand, its sort control, the hint, and the actions.
	const ownHand = el("div", {
		className: "own-hand",
		attrs: { role: "group", "aria-label": t("Your hand") },
	});
	const hint = el("p", {
		className: "hint",
		attrs: { role: "status", "data-testid": "draft-hint" },
	});
	const actionBar = el("div", {
		className: "action-bar",
		attrs: { "data-testid": "action-bar" },
	});
	const sortButton = button(
		"",
		() => {
			order = order === "rank" ? "suit" : "rank";
			paintPlay();
		},
		{ className: "sort-toggle" },
	);
	const ownControls = el(
		"div",
		{ className: "own-bar" },
		el("div", { className: "own-tools" }, sortButton, hint),
		actionBar,
	);
	const bottom = el("div", {
		className: "seat seat-bottom",
		attrs: { "data-testid": "own-seat" },
	});

	// The call controls: the call row, the alert, and the table's exit and share actions.
	const exitButton = button(t("Exit"), handlers.exit, {
		className: "table-exit",
	});
	const shareStatus = el("span", {
		className: "visually-hidden",
		attrs: { role: "status", "aria-live": "polite" },
	});
	const shareButton = button(
		t("Share URL"),
		() => {
			void handlers.shareUrl().then(
				() => {
					shareStatus.textContent = t("Share action completed.");
				},
				(error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					shareStatus.textContent = t("Could not share the board URL.");
				},
			);
		},
		{ className: "table-share" },
	);
	const call = callControls(handlers.call, [exitButton, shareButton], t);
	const dock = el(
		"div",
		{ className: "dock" },
		call.panel,
		call.alert,
		call.row,
		shareStatus,
	);

	const felt = el(
		"div",
		{ className: "felt", attrs: { "data-testid": "felt" } },
		opponents,
		centre,
		bottom,
		summary,
	);
	const element = el(
		"section",
		{
			className: "rummy-table",
			attrs: { "data-testid": "table" },
		},
		head,
		felt,
		dock,
	);

	// Mutable state.
	let latestView: TableView | undefined;
	let order: HandOrder = "rank";
	/** The table position that the draft and the selection belong to. */
	let positionKey: string | undefined;
	/** The viewer's working copy of the table on the viewer's turn. */
	let draft: Draft | undefined;
	const selected = new Set<string>();
	/** Why the last move in the draft was refused, or what the solver answered; translated. */
	let notice = "";
	let suggesting = false;
	const callSpots = new Map<Seat, CallSpot>();
	const opponentNodes = new Map<Seat, HTMLElement>();
	let callDisplay: CallDisplay | undefined;
	let remoteCallPresence: Readonly<Partial<Record<Seat, RemoteCallPresence>>> =
		{};
	let botControlHost = false;
	let botControlSeats: readonly Seat[] = [];
	let botModel: string | undefined;
	let playerAutoplayAvailable = false;
	let playerAutoplayEnabled = false;
	let playerAutoplayPending = false;
	let playerAutoplayStatus = "";
	let hostAutoplayControl: HTMLButtonElement | undefined;
	let seatLabels = new Map<Seat, string>();
	/** What the melds, the hand and the action bar show now; see paintPlay. */
	let paintedKey = "";
	/** The viewer's own seat label and what it shows; see ownLabel. */
	let ownLabelCache: { key: string; node: HTMLElement } | undefined;

	/** The viewer is the last seat of the view. */
	function viewerSeat(view: TableView): Seat | undefined {
		return view.seats.at(-1)?.seat;
	}

	function toggleCard(id: string): void {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
		notice = "";
		paintPlay();
	}

	function applyMove(move: DraftMove): void {
		if (move.ok) {
			draft = move.draft;
			selected.clear();
			notice = "";
		} else notice = translateReason(move.reason, t);
		paintPlay();
	}

	function moveTo(target: DraftTarget): void {
		if (draft !== undefined) applyMove(moveCards(draft, [...selected], target));
	}

	function suggest(): void {
		const view = latestView;
		const current = draft;
		if (view === undefined || current === undefined || !handlers.suggest)
			return;
		const key = positionKey;
		suggesting = true;
		notice = "";
		paintPlay();
		const settle = (apply: () => void): void => {
			// The table moved on while the solver was thinking: its answer is for an old position.
			if (positionKey !== key) return;
			suggesting = false;
			apply();
			paintPlay();
		};
		void handlers.suggest(view).then(
			(action) =>
				settle(() => {
					if (action?.type !== "play" || draft === undefined) {
						notice = t("The solver found no play.");
						return;
					}
					const loaded = loadPlay(draft, action.melds);
					if (loaded.ok) {
						draft = loaded.draft;
						selected.clear();
					} else notice = translateReason(loaded.reason, t);
				}),
			() =>
				settle(() => {
					notice = t("The solver stopped with an error.");
				}),
		);
	}

	/** A hand card: a button on the viewer's turn, a plain card otherwise. */
	function handCard(card: CardView, interactive: boolean): HTMLElement {
		const chosen = selected.has(card.id);
		const className = `card${suitClasses(card)}${chosen ? " selected" : ""}`;
		if (!interactive)
			return el(
				"span",
				{ className, attrs: { "data-card": card.id } },
				card.text,
			);
		return button(card.text, () => toggleCard(card.id), {
			className,
			attrs: { "data-card": card.id, "aria-pressed": String(chosen) },
		});
	}

	/** A card in a meld: a joker shows the card it stands for after a star. */
	function meldCard(card: MeldCardView, interactive: boolean): HTMLElement {
		const chosen = selected.has(card.id);
		const className = `pip${suitClasses(card)}${card.gold ? " gold" : ""}${card.placed ? " placed" : ""}${chosen ? " selected" : ""}`;
		const text = card.as === undefined ? card.text : `★${card.as}`;
		const title =
			card.as === undefined
				? card.gold
					? t("New on the table")
					: undefined
				: t("Joker as {card}", { card: card.as });
		const attrs: Record<string, string> = {
			"data-card": card.id,
			...(title === undefined ? {} : { title }),
		};
		if (!interactive) return el("span", { className, attrs }, text);
		return button(text, () => toggleCard(card.id), {
			className,
			attrs: { ...attrs, "aria-pressed": String(chosen) },
		});
	}

	function meldNode(meld: MeldView, interactive: boolean): HTMLElement {
		const node = el(
			"div",
			{
				className: meld.problem === null ? "meld" : "meld invalid",
				attrs: {
					"data-meld": String(meld.index),
					"data-testid": "meld",
					...(meld.problem === null ? {} : { title: meld.problem }),
				},
			},
			el(
				"span",
				{ className: "meld-cards" },
				...meld.cards.map((card) => meldCard(card, interactive)),
			),
		);
		if (interactive) {
			const add = button("+", () => moveTo(meld.index), {
				className: "meld-add",
				attrs: {
					"aria-label": t("Add the selected cards to this meld"),
					"data-testid": "meld-add",
				},
			});
			add.disabled = selected.size === 0;
			node.append(add);
		}
		if (meld.problem !== null)
			node.append(el("span", { className: "meld-problem" }, meld.problem));
		return node;
	}

	function draftButtons(view: TableView, shown: DraftView): HTMLElement[] {
		const playButton = button(
			t("Play"),
			() => {
				if (shown.play === undefined) return;
				handlers.act(shown.play);
				selected.clear();
				notice = "";
			},
			{
				className: "action primary",
				attrs: { "data-testid": "action-play", "data-action": "play" },
			},
		);
		playButton.disabled = shown.play === undefined;
		const nodes = [playButton];
		if (shown.changed)
			nodes.push(
				button(
					t("Undo changes"),
					() => {
						if (draft === undefined) return;
						draft = newDraft(draft.start.melds, draft.start.hand, draft.locked);
						selected.clear();
						notice = "";
						paintPlay();
					},
					{ className: "action", attrs: { "data-testid": "action-reset" } },
				),
			);
		if (selected.size > 0)
			nodes.push(
				button(
					t("To hand"),
					() => {
						if (draft !== undefined)
							applyMove(returnToHand(draft, [...selected]));
					},
					{ className: "action", attrs: { "data-testid": "action-to-hand" } },
				),
			);
		if (view.assist && handlers.suggest) {
			const suggestButton = button(
				t(suggesting ? "Thinking…" : "Suggest"),
				suggest,
				{ className: "action", attrs: { "data-testid": "action-suggest" } },
			);
			suggestButton.disabled = suggesting;
			nodes.push(suggestButton);
		}
		return nodes;
	}

	/**
	 * The melds, the viewer's hand and the actions. A view that shows the same keeps the buttons, because a beat or
	 * a roster change renders often, and a button replaced between the press and the release of a tap loses that tap.
	 */
	function paintPlay(): void {
		const view = latestView;
		if (view === undefined) return;
		const seat = viewerSeat(view);
		const shown =
			view.canPlay && draft !== undefined && seat !== undefined
				? draftView(view, seat, draft, t)
				: undefined;
		const tableMelds = shown?.melds ?? view.table;
		const hand = shown?.hand ?? view.own;
		const key = JSON.stringify([
			order,
			tableMelds,
			hand,
			[...selected],
			notice,
			suggesting,
			shown === undefined
				? null
				: [shown.changed, shown.play !== undefined, shown.problem],
			view.actions.map((action) => action.key),
			view.assist,
		]);
		if (key === paintedKey) return;
		paintedKey = key;
		const interactive = shown !== undefined;

		const newMeld = button(t("New meld"), () => moveTo("new"), {
			className: "meld new-meld",
			attrs: { "data-testid": "new-meld" },
		});
		newMeld.disabled = selected.size === 0;
		melds.replaceChildren(
			...(tableMelds.length === 0 && !interactive
				? [el("p", { className: "none" }, t("No melds yet"))]
				: tableMelds.map((meld) => meldNode(meld, interactive))),
			...(interactive ? [newMeld] : []),
		);
		ownHand.replaceChildren(
			...sortHand(hand, order).map((card) => handCard(card, interactive)),
		);
		sortButton.textContent = t(
			order === "rank" ? "Sort by suit" : "Sort by rank",
		);
		actionBar.replaceChildren(
			...(shown === undefined ? [] : draftButtons(view, shown)),
			...view.actions.map((item) =>
				button(item.label, () => handlers.act(item.action), {
					className: "action",
					attrs: {
						"data-action": item.key,
						"data-testid": `action-${item.key}`,
					},
				}),
			),
		);
		hint.textContent =
			notice ||
			(shown === undefined
				? ""
				: shown.changed && shown.play === undefined && shown.problem !== null
					? shown.problem
					: selected.size === 0
						? t("Select cards, then choose where they go.")
						: t("Choose a meld with +, or New meld."));
	}

	function callSpot(seat: Seat): CallSpot {
		const known = callSpots.get(seat);
		if (known !== undefined) return known;
		const caption = el(
			"span",
			{ className: "tile-caption" },
			t(SEAT_NAMES[seat]),
		);
		const video = el("video", {
			attrs: { "aria-hidden": "true", "data-testid": `video-${seat}` },
		});
		const botArtworkImage = el("img", {
			className: "bot-artwork",
			attrs: { alt: "", "aria-hidden": "true" },
		});
		botArtworkImage.hidden = true;
		const botFallback = el("span", { className: "bot-overlay-fallback" }, "🤖");
		const botOverlay = el(
			"span",
			{ className: "bot-overlay", attrs: { "aria-hidden": "true" } },
			botArtworkImage,
			botFallback,
		);
		botOverlay.hidden = true;
		video.muted = true;
		video.playsInline = true;
		video.autoplay = true;
		video.hidden = true;
		video.dataset.play = "off";
		const botControl = button(`🤖 ${t("Switch to bot")}`, () => {
			handlers.setBotSeat?.(seat, !botControlSeats.includes(seat));
		});
		botControl.className = "tile-bot-control";
		botControl.hidden = !botControlHost;
		const isBot = botControlSeats.includes(seat);
		const artworkUrl = robotArtwork(botModel);
		if (artworkUrl !== undefined) botArtworkImage.src = artworkUrl;
		botArtworkImage.hidden = !isBot || artworkUrl === undefined;
		botFallback.hidden = artworkUrl !== undefined;
		botControl.textContent = isBot
			? `👱 ${t("Switch to player")}`
			: `🤖 ${t("Switch to bot")}`;
		botControl.dataset.bot = String(isBot);
		const callPresence = el("span", {
			className: "tile-call-presence",
			attrs: { role: "img", "data-testid": `call-presence-${seat}` },
		});
		callPresence.hidden = true;
		const tile = el(
			"div",
			{
				className: "tile",
				attrs: {
					"data-seat": seat,
					"data-testid": `tile-${seat}`,
					"data-video": "off",
				},
			},
			el(
				"span",
				{ className: "avatar", attrs: { "aria-hidden": "true" } },
				seat,
			),
			video,
			botOverlay,
			callPresence,
			caption,
			botControl,
		);
		const state = el("span", {
			className: "call-state",
			attrs: { "data-testid": `call-state-${seat}` },
		});
		state.hidden = true;
		const spot: CallSpot = {
			tile,
			caption,
			video,
			botOverlay,
			botArtwork: botArtworkImage,
			botFallback,
			callPresence,
			botControl,
			state,
			shown: undefined,
			track: undefined,
		};
		callSpots.set(seat, spot);
		return spot;
	}

	/**
	 * A picture only while the call view gives the seat a camera track: Receive off, the peer's Send off, Leave and
	 * the compact form all clear it at once, so no last frame stays. The avatar shows otherwise.
	 */
	function renderVideo(
		spot: CallSpot,
		track: MediaStreamTrack | undefined,
	): void {
		if (spot.track !== track) {
			spot.track = track;
			spot.video.srcObject =
				track === undefined ? null : new MediaStream([track]);
			spot.video.hidden = track === undefined;
			spot.video.dataset.play = "off";
			spot.tile.dataset.video = track === undefined ? "off" : "on";
		}
		// A tile that left the page for a moment was paused by the browser.
		if (track !== undefined && spot.video.paused) play(spot.video);
	}

	/**
	 * The status of each remote seat: nothing while the local user is outside the call, else the link state; a
	 * failed link offers Retry.
	 */
	function renderCallStates(): void {
		const view = callDisplay?.available ? callDisplay.view : undefined;
		for (const [seat, spot] of callSpots) {
			const remote = view?.remotes.find((item) => item.seat === seat);
			renderVideo(spot, remote?.video);
			const status =
				view !== undefined && remote !== undefined
					? remoteCallStatus(remote, view, t)
					: undefined;
			spot.tile.dataset.call = remote?.status ?? "unknown";
			const presence = remoteCallPresence[seat];
			const showPresence = presence !== undefined && !view?.requested.inCall;
			spot.callPresence.hidden = !showPresence;
			spot.callPresence.replaceChildren(
				icon("mic", !presence?.sendsAudio),
				icon("camera", !presence?.sendsVideo),
			);
			spot.callPresence.setAttribute(
				"aria-label",
				showPresence ? t("In call") : "",
			);
			spot.callPresence.title =
				presence !== undefined && showPresence ? t("In call") : "";
			const label = seatLabels.get(seat) ?? t(SEAT_NAMES[seat]);
			const shown = `${label}|${
				status?.text === undefined
					? ""
					: `${status.text}|${status.connected}|${status.retry}`
			}`;
			if (shown === spot.shown) continue;
			spot.shown = shown;
			spot.caption.textContent =
				status?.text === undefined ? label : `${label} · ${status.text}`;
			spot.state.hidden = status?.text === undefined;
			spot.state.replaceChildren(
				icon("phone", !status?.connected),
				status?.text ?? "",
			);
			if (status?.retry)
				spot.state.append(retryButton(seat, handlers.call, false, t));
		}
	}

	function renderCall(
		display: CallDisplay,
		presence: Readonly<Partial<Record<Seat, RemoteCallPresence>>> = {},
	): void {
		callDisplay = display;
		remoteCallPresence = presence;
		call.render(display);
		renderCallStates();
	}

	function setBotControls(
		hosting: boolean,
		bots: readonly Seat[],
		model?: string,
	): void {
		botControlHost = hosting;
		botControlSeats = bots;
		botModel = model;
		const artworkUrl = robotArtwork(botModel);
		const hostSeat = latestView?.seats.find((seat) =>
			seat.tags.includes("Host"),
		)?.seat;
		if (hostAutoplayControl) {
			const isBot = hostSeat !== undefined && bots.includes(hostSeat);
			hostAutoplayControl.hidden = !hosting;
			hostAutoplayControl.textContent = isBot
				? `👱 ${t("Disable autoplay")}`
				: `🤖 ${t("Enable autoplay (bot)")}`;
		}
		for (const [seat, spot] of callSpots) {
			const isBot = bots.includes(seat);
			if (artworkUrl !== undefined) spot.botArtwork.src = artworkUrl;
			spot.botArtwork.hidden = !isBot || artworkUrl === undefined;
			spot.botFallback.hidden = artworkUrl !== undefined;
			spot.botOverlay.hidden = !isBot;
			spot.botControl.hidden = !hosting;
			spot.botControl.textContent = isBot
				? `👱 ${t("Switch to player")}`
				: `🤖 ${t("Switch to bot")}`;
			spot.botControl.dataset.bot = String(isBot);
		}
		// The host's autoplay control is part of the seat label, so the labels render again.
		if (latestView) render(latestView);
	}

	function setPlayerAutoplay(
		available: boolean,
		enabled: boolean,
		pending: boolean,
		status: string,
	): void {
		playerAutoplayAvailable = available;
		playerAutoplayEnabled = enabled;
		playerAutoplayPending = pending;
		playerAutoplayStatus = status;
		if (latestView) render(latestView);
	}

	/** The seat's name and tags; the host's bot control; the viewer's own autoplay control. */
	function seatLabel(
		seat: SeatView,
		own: boolean,
		callState?: HTMLElement,
	): HTMLElement {
		const children: Child[] = [
			el(
				"span",
				{ className: "name", attrs: { "data-bot": String(seat.bot) } },
				seat.label,
			),
			...seat.tags.map((tag) => el("span", { className: "tag" }, t(tag))),
		];
		if (seat.turn)
			children.push(
				el(
					"span",
					{ className: "turn-pill", attrs: { "data-testid": "turn-pill" } },
					t("Turn"),
				),
			);
		if (seat.tags.includes("Host") && botControlHost) {
			const isBot = botControlSeats.includes(seat.seat);
			hostAutoplayControl = button(
				`${isBot ? "👱" : "🤖"} ${t(isBot ? "Disable autoplay" : "Enable autoplay (bot)")}`,
				() =>
					handlers.setBotSeat?.(
						seat.seat,
						!botControlSeats.includes(seat.seat),
					),
				{
					className: "host-autoplay-toggle",
					attrs: { "data-testid": "host-autoplay-toggle" },
				},
			);
			children.push(hostAutoplayControl);
		}
		if (own && !seat.tags.includes("Host")) {
			const autoplay = button(
				t(playerAutoplayEnabled ? "Stop autoplay" : "Enable autoplay (bot)"),
				() => handlers.requestAutoplay?.(!playerAutoplayEnabled),
				{
					className: "player-autoplay-toggle",
					attrs: { "data-testid": "player-autoplay-toggle" },
				},
			);
			autoplay.hidden = !playerAutoplayAvailable;
			autoplay.disabled = playerAutoplayPending;
			children.push(autoplay);
			if (playerAutoplayStatus)
				children.push(
					el(
						"span",
						{ className: "player-autoplay-status", attrs: { role: "status" } },
						playerAutoplayStatus,
					),
				);
		}
		if (callState !== undefined) children.push(callState);
		return el("div", { className: "seat-label" }, ...children);
	}

	/** The viewer's label keeps its node while it shows the same, so its autoplay button keeps a tap; see paintPlay. */
	function ownLabel(seat: SeatView): HTMLElement {
		const key = JSON.stringify([
			seat,
			botControlHost,
			botControlSeats,
			playerAutoplayAvailable,
			playerAutoplayEnabled,
			playerAutoplayPending,
			playerAutoplayStatus,
		]);
		if (ownLabelCache?.key !== key)
			ownLabelCache = { key, node: seatLabel(seat, true) };
		return ownLabelCache.node;
	}

	function cardCount(count: number): string {
		return t(count === 1 ? "{count} card" : "{count} cards", { count });
	}

	/** The number of cards in a hand: a dense strip of thin card backs and the number. */
	function countStrip(count: number): HTMLElement {
		return el(
			"div",
			{
				className: "count-strip",
				attrs: {
					"aria-label": cardCount(count),
					"data-testid": "card-count",
					"data-count": String(count),
				},
			},
			el(
				"span",
				{ className: "count-backs", attrs: { "aria-hidden": "true" } },
				...Array.from({ length: count }, () =>
					el("span", { className: "count-back" }),
				),
			),
			el(
				"span",
				{ className: "count-number", attrs: { "aria-hidden": "true" } },
				String(count),
			),
		);
	}

	/** Another player: the video tile, the name, and the number of cards held. */
	function opponentNode(seat: SeatView): HTMLElement {
		const spot = callSpot(seat.seat);
		spot.botOverlay.hidden = !seat.bot;
		spot.tile.dataset.bot = String(seat.bot);
		let node = opponentNodes.get(seat.seat);
		if (node === undefined) {
			node = el("div", {
				className: "seat opponent",
				attrs: { "data-testid": `seat-${seat.seat}` },
			});
			opponentNodes.set(seat.seat, node);
		}
		node.dataset.turn = String(seat.turn);
		node.dataset.presence = seat.presence;
		node.replaceChildren(
			spot.tile,
			seatLabel(seat, false, spot.state),
			countStrip(seat.handCount),
		);
		return node;
	}

	function actionItem(line: TableActionLine): HTMLElement {
		// A pending action's reason says which players the host waits for. The model translated the reason.
		const label = t(ACTION_STATUS[line.state]);
		const status =
			line.state === "not-accepted"
				? `${label}: ${line.reason ?? t("rejected")}`
				: (line.reason ?? label);
		return el(
			"li",
			{ attrs: { "data-state": line.state } },
			el("span", { className: "text" }, line.label),
			el("span", { className: "status" }, status),
		);
	}

	function renderResult(result: ResultView | undefined): void {
		summary.hidden = result === undefined;
		newGameButton.hidden =
			result === undefined || handlers.newGame === undefined;
		if (result === undefined) return;
		winnerLine.textContent = result.winner;
		outcomeLine.textContent = result.outcome;
		resultTable.replaceChildren(
			el(
				"thead",
				{},
				el(
					"tr",
					{},
					el("th", { attrs: { scope: "col" } }, t("Player")),
					el("th", { attrs: { scope: "col" } }, t("Cards left")),
					el("th", { attrs: { scope: "col" } }, t("Penalty")),
				),
			),
			el(
				"tbody",
				{},
				...result.rows.map((row) =>
					el(
						"tr",
						{ attrs: { "data-winner": String(row.winner) } },
						el("th", { attrs: { scope: "row" } }, row.name),
						el(
							"td",
							{ className: "cards-left" },
							...row.cards.flatMap((card, index) =>
								index === 0 ? [cardPip(card)] : [" ", cardPip(card)],
							),
						),
						el("td", {}, String(row.penalty)),
					),
				),
			),
		);
	}

	function render(view: TableView): void {
		latestView = view;
		// A new position starts a new draft: the cards chosen for one position never carry into the next.
		const key = `${view.handNo}:${view.at}`;
		if (key !== positionKey) {
			positionKey = key;
			draft = undefined;
			selected.clear();
			notice = "";
			suggesting = false;
		}
		if (!view.canPlay) draft = undefined;
		else
			draft ??= newDraft(
				view.table.map((meld) => meld.cards.map((card) => card.id)),
				view.own.map((card) => card.id),
				view.locked,
			);
		element.dataset.phase = view.phase;
		element.dataset.hand = String(view.handNo);
		element.dataset.at = String(view.at);
		element.dataset.yourTurn = String(view.yourTurn);
		heading.textContent = view.heading;
		heading.hidden = view.heading === "";
		details.textContent = view.details;
		details.hidden = view.details === "";
		prompt.textContent = view.prompt;
		renderResult(view.result);
		stockCount.textContent = cardCount(view.stockCount);
		centre.hidden = view.phase !== "play" && view.phase !== "over";

		seatLabels = new Map(view.seats.map((seat) => [seat.seat, seat.label]));
		const others = view.seats.slice(0, -1).map((seat) => opponentNode(seat));
		const current = opponents.childNodes;
		if (
			others.length !== current.length ||
			others.some((node, index) => node !== current[index])
		)
			opponents.replaceChildren(...others);
		opponents.dataset.count = String(others.length);

		const own = view.seats.at(-1);
		if (own !== undefined) {
			bottom.dataset.turn = String(own.turn);
			bottom.dataset.presence = own.presence;
			const banner = own.connecting
				? [
						el(
							"p",
							{ className: "connecting", attrs: { role: "status" } },
							t(CONNECTING_TEXT),
						),
					]
				: [];
			const children = [...banner, ownLabel(own), ownHand, ownControls];
			const shown = bottom.childNodes;
			if (
				children.length !== shown.length ||
				children.some((child, index) => child !== shown[index])
			)
				bottom.replaceChildren(...children);
		}
		commands.replaceChildren(...view.lines.map((line) => actionItem(line)));
		commands.hidden = view.lines.length === 0;
		paintPlay();
	}

	function setForm(form: Form): void {
		element.dataset.form = form;
	}

	return {
		element,
		render,
		renderCall,
		setBotControls,
		setPlayerAutoplay,
		setForm,
	};
}
