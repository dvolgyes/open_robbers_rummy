import type { Form } from "../call/device-class";
import type { Action } from "../canasta";
import { englishTranslator as english, type Translate } from "../i18n";
import { SEAT_NAMES, type Seat } from "../protocol";
import {
	type CallDisplay,
	type RemoteCallPresence,
	remoteCallStatus,
} from "./call-model";
import { type CallHandlers, callControls, retryButton } from "./call-panel";
import { button, type Child, el } from "./dom";
import { type HandOrder, sortHand } from "./hand-layout";
import { icon } from "./icons";
import { play } from "./remote-audio";
import { robotArtwork } from "./robot-artwork";
import {
	type ActionOption,
	type CardView,
	type Label,
	labelText,
	type MeldView,
	optionsFor,
	type Position,
	type SeatView,
	type SideView,
	type TableActionLine,
	type TableView,
} from "./table-model";

export interface TableHandlers {
	exit(): void;
	shareUrl(): Promise<void>;
	act(action: Action): void;
	setBotSeat?(seat: Seat, enabled: boolean): void;
	requestAutoplay?(enabled: boolean): void;
	readonly call: CallHandlers;
}

export interface TableSection {
	readonly element: HTMLElement;
	render(view: TableView): void;
	setCountdown(seconds: number | undefined): void;
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

/** A card in a line of text: its rank and suit symbol, red for hearts and diamonds, as on the hand's cards. */
function cardPip(card: CardView): HTMLElement {
	return el(
		"span",
		{
			className: `pip${isRed(card.suit) ? " red" : ""}${card.suit === null ? " joker" : ""}`,
		},
		card.text,
	);
}

/** The cards in a row of pips, separated by spaces so that the text reads as before. */
function cardPips(cards: readonly CardView[]): Child[] {
	return cards.flatMap((card, index) =>
		index === 0 ? [cardPip(card)] : [" ", cardPip(card)],
	);
}

/** A meld shows its cards in vertical columns of at most this many cards. */
const MELD_COLUMN = 8;

function labelNodes(label: Label): Child[] {
	return label.map((part) =>
		part.kind === "text" ? part.text : cardPip(part.card),
	);
}

/** The canasta table as the viewer sees it: the score strip, the partner and opponents around the stock and the discard pile, and the viewer's own hand with its actions at the bottom. */
export function tableSection(
	handlers: TableHandlers,
	t: Translate = english,
): TableSection {
	// Status and score.
	const heading = el("h3", { className: "table-heading" });
	const details = el("span", { className: "note" });
	const prompt = el("p", {
		className: "prompt",
		attrs: { role: "status", "data-testid": "table-prompt" },
	});
	const outcomeLine = el("p", { className: "outcome" });
	const countdownLine = el("p", {
		className: "countdown",
		attrs: { role: "status" },
	});
	const winnerLine = el("p", { className: "winner" });
	const commands = el("ul", {
		className: "commands",
		attrs: { "data-testid": "table-actions" },
	});
	const sideCell = () => {
		const label = el("span", { className: "side-label" });
		const score = el("span", { className: "side-score" });
		const node = el("div", { className: "side" }, label, score);
		return { node, label, score };
	};
	const sideCells = [sideCell(), sideCell()] as const;
	const target = el("span", { className: "target" });
	const scoreStrip = el(
		"div",
		{ className: "score-strip", attrs: { "data-testid": "score-strip" } },
		sideCells[0].node,
		el("div", { className: "meta" }, heading, details, target),
		sideCells[1].node,
	);
	const status = el(
		"div",
		{ className: "table-status" },
		prompt,
		outcomeLine,
		countdownLine,
		winnerLine,
		commands,
	);

	// Seats around the felt. The viewer's own place is the bottom.
	const places: Readonly<Record<Position, HTMLElement>> = {
		top: el("div", { className: "seat seat-top" }),
		left: el("div", { className: "seat seat-left" }),
		right: el("div", { className: "seat seat-right" }),
		bottom: el("div", { className: "seat seat-bottom" }),
	};

	// Stock, discard pile, and the melds and red threes of each side.
	const stockCount = el("span", { className: "stock-count" });
	const pileTop = el("span", { className: "pile-top" });
	const pileCount = el("span", { className: "pile-count" });
	const pileFrozen = el("span", { className: "pile-frozen" });
	const piles = el(
		"div",
		{ className: "piles" },
		el(
			"div",
			{ className: "stock" },
			el("span", { className: "label" }, t("Stock")),
			stockCount,
		),
		el(
			"div",
			{ className: "pile" },
			el("span", { className: "label" }, t("Discard pile")),
			pileTop,
			pileCount,
			pileFrozen,
		),
	);
	const sideBlock = () => {
		const title = el("h4", { className: "side-title" });
		const melds = el("div", { className: "melds" });
		const redThrees = el("p", { className: "red-threes" });
		const node = el(
			"section",
			{ className: "side-block" },
			title,
			melds,
			redThrees,
		);
		return { node, title, melds, redThrees };
	};
	const sideBlocks = [sideBlock(), sideBlock()] as const;
	const centre = el(
		"div",
		{ className: "centre", attrs: { "data-testid": "centre" } },
		piles,
		sideBlocks[0].node,
		sideBlocks[1].node,
	);

	// The viewer's hand, its sort control, its own actions, and the hint for choosing cards.
	const ownHand = el("div", {
		className: "own-hand",
		attrs: { role: "group", "aria-label": t("Your hand") },
	});
	const hint = el("p", { className: "hint" });
	const actionBar = el("div", {
		className: "action-bar",
		attrs: { "data-testid": "action-bar" },
	});
	const sortButton = button(
		"",
		() => {
			order = order === "rank" ? "suit" : "rank";
			paintHand();
		},
		{ className: "sort-toggle" },
	);
	const ownControls = el(
		"div",
		{ className: "own-bar" },
		el("div", { className: "own-tools" }, sortButton, hint),
		actionBar,
	);

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
		places.top,
		places.left,
		centre,
		places.right,
		places.bottom,
	);
	const element = el(
		"section",
		{
			className: "canasta-table",
			attrs: { "data-testid": "table" },
		},
		scoreStrip,
		status,
		felt,
		dock,
	);

	// Mutable state.
	let latestView: TableView | undefined;
	let order: HandOrder = "rank";
	let selectionKey: string | undefined;
	const selected = new Set<string>();
	const callSpots = new Map<Seat, CallSpot>();
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
	/** What the hand and the action bar show now; see paintHand. */
	let paintedKey = "";
	/** The viewer's own seat label and what it shows; see ownLabel. */
	let ownLabelCache: { key: string; node: HTMLElement } | undefined;

	function toggleCard(id: string): void {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
		paintHand();
	}

	function cardButton(card: CardView): HTMLButtonElement {
		const chosen = selected.has(card.id);
		const node = button(card.text, () => toggleCard(card.id), {
			className: `card${isRed(card.suit) ? " red" : ""}${card.suit === null ? " joker" : ""}${chosen ? " selected" : ""}`,
			attrs: {
				"data-card": card.id,
				"aria-pressed": String(chosen),
			},
		});
		return node;
	}

	/**
	 * The viewer's hand and the actions that the current selection can send. A view that shows the same cards and
	 * actions keeps the buttons, because a beat or a roster change renders often, and a button replaced between
	 * the press and the release of a tap loses that tap.
	 */
	function paintHand(): void {
		const view = latestView;
		if (view === undefined) return;
		const offered: readonly ActionOption[] = view.yourTurn
			? optionsFor(view.options, [...selected])
			: [];
		const key = JSON.stringify([
			order,
			view.own,
			[...selected],
			offered,
			view.yourTurn,
		]);
		if (key === paintedKey) return;
		paintedKey = key;
		ownHand.replaceChildren(
			...sortHand(view.own, order).map((card) => cardButton(card)),
		);
		sortButton.textContent = t(
			order === "rank" ? "Sort by suit" : "Sort by rank",
		);
		actionBar.replaceChildren(
			...offered.map((option) => {
				const node = button(
					"",
					() => {
						selected.clear();
						handlers.act(option.action);
						paintHand();
					},
					{
						className: "action",
						attrs: {
							"data-action": option.action.type,
							"data-testid": `action-${option.action.type}`,
							"aria-label": labelText(option.label),
						},
					},
				);
				node.append(...labelNodes(option.label));
				return node;
			}),
		);
		hint.textContent =
			view.yourTurn && offered.length === 0 && selected.size === 0
				? t("Select cards to meld, extend, take the pile or discard.")
				: "";
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
				t(seat),
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
	function seatLabel(seat: SeatView, callState?: HTMLElement): HTMLElement {
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
		if (seat.position === "bottom" && !seat.tags.includes("Host")) {
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

	/** The viewer's label keeps its node while it shows the same, so its autoplay button keeps a tap; see paintHand. */
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
			ownLabelCache = { key, node: seatLabel(seat) };
		return ownLabelCache.node;
	}

	function cardCount(count: number): string {
		return t(count === 1 ? "{count} card" : "{count} cards", { count });
	}

	function cardBacks(count: number): HTMLElement {
		return el(
			"div",
			{
				className: "backs",
				attrs: { "aria-label": cardCount(count) },
			},
			...Array.from({ length: count }, () =>
				el("span", {
					className: "card-back",
					attrs: { "aria-hidden": "true" },
				}),
			),
		);
	}

	/** A partner or opponent: the video tile, the name, and the number of cards held. */
	function renderOpponent(seat: SeatView): void {
		const spot = callSpot(seat.seat);
		spot.botOverlay.hidden = !seat.bot;
		spot.tile.dataset.bot = String(seat.bot);
		places[seat.position].replaceChildren(
			spot.tile,
			seatLabel(seat, spot.state),
			cardBacks(seat.handCount),
		);
	}

	function meldNode(meld: MeldView): HTMLElement {
		return el(
			"span",
			{
				className: meld.canasta ? "meld canasta" : "meld",
				attrs: { "data-meld": meld.id, "data-rank": meld.rank },
			},
			el(
				"span",
				{ className: "meld-cards" },
				...Array.from(
					{ length: Math.ceil(meld.cards.length / MELD_COLUMN) },
					(_, index) =>
						el(
							"span",
							{ className: "meld-column" },
							...meld.cards
								.slice(index * MELD_COLUMN, (index + 1) * MELD_COLUMN)
								.map((card) => cardPip(card)),
						),
				),
			),
			...(meld.canasta
				? [el("span", { className: "canasta-mark" }, t("canasta"))]
				: []),
		);
	}

	function renderSide(side: SideView, index: number): void {
		const cell = sideCells[index];
		const block = sideBlocks[index];
		if (cell === undefined || block === undefined) return;
		cell.node.dataset.mine = String(side.mine);
		block.node.dataset.mine = String(side.mine);
		cell.label.textContent = `${side.label} (${side.owner})`;
		cell.score.textContent = String(side.score);
		block.title.textContent = `${side.label} (${side.owner})`;
		block.melds.replaceChildren(
			...(side.melds.length === 0
				? [el("span", { className: "none" }, t("No melds yet"))]
				: side.melds.map((meld) => meldNode(meld))),
		);
		block.redThrees.replaceChildren(
			t("Red 3s: {count}", { count: side.redThrees.length }),
			...(side.redThrees.length === 0
				? []
				: [
						" ",
						el(
							"span",
							{ className: "red-three-cards" },
							...cardPips(side.redThrees),
						),
					]),
		);
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
			el("span", { className: "text" }, ...labelNodes(line.label)),
			el("span", { className: "status" }, status),
		);
	}

	function render(view: TableView): void {
		latestView = view;
		// A new position clears the selection: the cards chosen for one turn never carry into the next.
		const key = `${view.handNo}:${view.at}`;
		if (key !== selectionKey) {
			selectionKey = key;
			selected.clear();
		}
		element.dataset.phase = view.phase;
		element.dataset.hand = String(view.handNo);
		element.dataset.at = String(view.at);
		element.dataset.yourTurn = String(view.yourTurn);
		heading.textContent = view.heading;
		heading.hidden = view.heading === "";
		details.textContent = view.details;
		details.hidden = view.details === "";
		prompt.textContent = view.prompt;
		outcomeLine.textContent = view.scoring?.outcome ?? "";
		outcomeLine.hidden = view.scoring === undefined;
		winnerLine.textContent = view.winner;
		winnerLine.hidden = view.winner === "";
		target.textContent = t("Target {score}", { score: view.target });

		for (const [index, side] of view.sides.entries()) renderSide(side, index);
		// The opponents' melds sit above the viewer's own.
		const [first, second] = view.sides[0].mine
			? [sideBlocks[1], sideBlocks[0]]
			: sideBlocks;
		centre.append(first.node, second.node);
		stockCount.textContent = cardCount(view.stockCount);
		pileTop.replaceChildren(
			view.pile.top === undefined ? t("Empty") : cardPip(view.pile.top),
		);
		pileCount.textContent = cardCount(view.pile.count);
		pileFrozen.hidden = !view.pile.frozen || view.pile.count === 0;
		pileFrozen.textContent = t("Frozen for your side");
		centre.hidden = view.phase === "waiting";

		seatLabels = new Map(view.seats.map((seat) => [seat.seat, seat.label]));
		for (const seat of view.seats) {
			if (seat.position !== "bottom") renderOpponent(seat);
		}
		const own = view.seats.find((seat) => seat.position === "bottom");
		if (own !== undefined) {
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
			const current = places.bottom.childNodes;
			if (
				children.length !== current.length ||
				children.some((child, index) => child !== current[index])
			)
				places.bottom.replaceChildren(...children);
		}
		commands.replaceChildren(...view.lines.map((line) => actionItem(line)));
		commands.hidden = view.lines.length === 0;
		paintHand();
	}

	function setCountdown(seconds: number | undefined): void {
		countdownLine.hidden = seconds === undefined || seconds === 0;
		if (seconds === undefined) return;
		countdownLine.textContent =
			seconds > 0
				? t(
						seconds === 1
							? "Next hand in {seconds} second"
							: "Next hand in {seconds} seconds",
						{ seconds },
					)
				: "";
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
		setCountdown,
	};
}
