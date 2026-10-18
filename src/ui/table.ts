import { SUIT_SYMBOLS, suitOf } from "../bridge/cards";
import type { Action } from "../bridge/engine";
import type { Call } from "../bridge/rules";
import type { Form } from "../call/device-class";
import { englishTranslator, type Translate } from "../i18n";
import { SEAT_NAMES, type Seat } from "../protocol";
import cardBackBlue from "./assets/bridge-call-card-back-blue.svg?url";
import cardBackRed from "./assets/bridge-call-card-back-red.svg?url";
import {
	type CallDisplay,
	type RemoteCallPresence,
	remoteCallStatus,
} from "./call-model";
import { type CallHandlers, callControls, retryButton } from "./call-panel";
import { button, el } from "./dom";
import { icon } from "./icons";
import { play } from "./remote-audio";
import { robotArtwork } from "./robot-artwork";
import type {
	CardView,
	ContractHeader,
	HandDisplay,
	Position,
	SeatView,
	TableActionLine,
	TableView,
	TrickView,
} from "./table-model";

export interface TableHandlers {
	exit(): void;
	shareUrl(): Promise<void>;
	act(action: Action): void;
	undoRequest(board: number): void;
	undoVote(requestId: string, approve: boolean): void;
	undoCancel(requestId: string): void;
	claimRequest(board: number, tricks: number): void;
	claimVote(requestId: string, approve: boolean): void;
	setBotSeat?(seat: Seat, enabled: boolean): void;
	requestAutoplay?(enabled: boolean): void;
	readonly call: CallHandlers;
}

export interface TableSection {
	readonly element: HTMLElement;
	/** The score sheet. The room page places it after the table, so the table can fill the screen. */
	/** The right column: bidding history, Tricks, and the previous-game statistics. */
	readonly sidebar: HTMLElement;
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
	/** The device form changed: the desktop moves the band beside the statistics in the sidebar. */
	setForm(form: Form): void;
}

export type PlayedCardStyle =
	| "classic-large"
	| "corners-upright"
	| "corners-oriented";

// Change this one value to switch the played-card design.
const PLAYED_CARD_STYLE: PlayedCardStyle = "corners-oriented";

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

const EMPTY_BID = "—";

/** The strain that each suit mark or NT label stands for, as the bid box names it. */
const MARK_STRAIN: ReadonlyMap<string, string> = new Map([
	[SUIT_SYMBOLS.C, "C"],
	[SUIT_SYMBOLS.D, "D"],
	[SUIT_SYMBOLS.H, "H"],
	[SUIT_SYMBOLS.S, "S"],
	["NT", "NT"],
]);

/**
 * One cell of the bidding history. A bid such as "1♠" becomes a level and a suit mark, each large and in the strain's
 * colour; Double and Redouble get their own colours; anything else (Pass, a dash) stays plain text.
 */
function auctionCell(text: string): (string | HTMLElement)[] {
	if (text === "Double")
		return [el("span", { className: "call-double" }, text)];
	if (text === "Redouble") {
		return [el("span", { className: "call-redouble" }, text)];
	}
	const strain = MARK_STRAIN.get(text.slice(1));
	if (!/^[1-7]$/.test(text.slice(0, 1)) || strain === undefined) return [text];
	const className = `bid-mark strain strain-${strain}`;
	return [
		el("span", { className }, text.slice(0, 1)),
		el("span", { className }, text.slice(1)),
	];
}

const WAITING_TEXT = "WAITING";
const CONNECTING_TEXT = "CONNECTING TO HOST";

function translateLobbyPrompt(text: string, t: Translate): string {
	const waiting = /^Waiting for (.+) to come back$/.exec(text);
	if (!waiting) return t(text);
	const names = (waiting[1] as string).split(/, | and /).map((name) => t(name));
	const last = names.pop();
	const players =
		last === undefined
			? ""
			: names.length === 0
				? last
				: `${names.join(", ")} ${t("and")} ${last}`;
	return t("Waiting for {players} to come back", { players });
}

/** Left and right hands are vertical stacks; the top and bottom hands are horizontal fans. */
/** The card back of a board: red on odd boards and before the first deal, blue on even boards. */
function cardBackFor(board: number): string {
	return board >= 2 && board % 2 === 0 ? cardBackBlue : cardBackRed;
}

function handDirection(position: Position): "row" | "column" {
	return position === "left" || position === "right" ? "column" : "row";
}

/**
 * The bridge table as the viewer sees it: the own hand at the bottom, the partner at the top, the opponents
 * left and right, each remote seat with its video tile; the auction and the trick in the center; and a dock
 * with the call controls and the game controls.
 */
export function tableSection(
	handlers: TableHandlers,
	playedCardStyle: PlayedCardStyle = PLAYED_CARD_STYLE,
	t: Translate = englishTranslator,
): TableSection {
	const heading = el("h3", {});
	const details = el("p", { className: "note" });
	const prompt = el("p", {
		className: "table-prompt",
		attrs: { role: "status", "data-testid": "table-prompt" },
	});
	const contract = el("p", { className: "contract" });
	const result = el("p", {
		className: "result",
		attrs: { "data-testid": "result" },
	});
	const actions = el("ul", {
		className: "table-actions",
		attrs: { "data-testid": "table-actions" },
	});
	const auction = el("table", {
		className: "auction",
		attrs: { "data-testid": "auction" },
	});
	const trick = el("div", {
		className: "trick",
		attrs: { "data-testid": "trick" },
	});
	const scoringCountdown = el("p", {
		className: "scoring-countdown",
		attrs: { "data-testid": "scoring-countdown", "aria-live": "off" },
	});
	const scoring = el("section", {
		className: "scoring",
		attrs: { "data-testid": "scoring" },
	});
	const center = el("div", { className: "center" }, trick, scoring);
	// The history is the auction table beside the bid box while bidding, and a sidebar panel afterwards.
	const historyTitle = el(
		"h3",
		{ className: "panel-title" },
		t("Bidding history"),
	);
	const auctionScroll = el("div", { className: "auction-scroll" }, auction);
	const bidHistory = el(
		"section",
		{ className: "history-panel", attrs: { "data-testid": "bid-history" } },
		historyTitle,
		auctionScroll,
	);
	const places: Readonly<Record<Position, HTMLElement>> = {
		top: el("div", { className: "place place-top" }),
		left: el("div", { className: "place place-left" }),
		right: el("div", { className: "place place-right" }),
		bottom: el("div", { className: "place place-bottom" }),
	};
	/** The opponents' video tiles sit in the top row, above their columns. */
	const videoSlots: Readonly<Record<Exclude<Position, "bottom">, HTMLElement>> =
		{
			top: el("div", { className: "video-slot video-top" }),
			left: el("div", { className: "video-slot video-left" }),
			right: el("div", { className: "video-slot video-right" }),
		};
	const bidBox = el("div", {
		className: "bid-box",
		attrs: { "data-testid": "bid-box", "aria-label": "Your call" },
	});
	let latestView: TableView | undefined;
	let claimMode: "choose" | "all" | null = null;
	let claimCount = 1;
	const claim = button(t("Claim …"), () => {
		claimMode = "choose";
		claimCount = 1;
		if (latestView) renderClaimPanel(latestView);
	});
	const claimAll = button(t("Claim all"), () => {
		claimMode = "all";
		if (latestView) renderClaimPanel(latestView);
	});
	let undoBoard: number | undefined;
	let undoRequestId: string | undefined;
	let claimRequestId: string | undefined;
	const playUndo = button(
		t("Undo"),
		() => {
			if (undoBoard !== undefined) handlers.undoRequest(undoBoard);
		},
		{ className: "claim-undo", attrs: { "data-testid": "undo-request" } },
	);
	const playControls = el(
		"div",
		{ className: "play-controls" },
		claim,
		claimAll,
		playUndo,
	);
	const undoMessage = el("p", {
		className: "undo-message",
		attrs: { role: "status", "data-testid": "undo-message" },
	});
	const approveUndo = button(
		t("Approve undo"),
		() => {
			if (undoRequestId !== undefined) handlers.undoVote(undoRequestId, true);
		},
		{ attrs: { "data-testid": "undo-approve" } },
	);
	const rejectUndo = button(
		t("Reject undo"),
		() => {
			if (undoRequestId !== undefined) handlers.undoVote(undoRequestId, false);
		},
		{ attrs: { "data-testid": "undo-reject" } },
	);
	const cancelUndo = button(
		t("Cancel undo"),
		() => {
			if (undoRequestId !== undefined) handlers.undoCancel(undoRequestId);
		},
		{ attrs: { "data-testid": "undo-cancel" } },
	);
	const undoPanel = el(
		"section",
		{
			className: "side-panel undo-panel",
			attrs: { "data-testid": "undo-panel" },
		},
		el("h3", { className: "panel-title" }, t("Undo")),
		undoMessage,
		approveUndo,
		rejectUndo,
		cancelUndo,
	);
	const mobileUndoMessage = el("p", {
		attrs: { role: "status", "aria-live": "polite" },
	});
	const mobileUndoApprove = button(t("Approve"), () => {
		if (undoRequestId !== undefined) handlers.undoVote(undoRequestId, true);
	});
	const mobileUndoReject = button(t("Reject"), () => {
		if (undoRequestId !== undefined) handlers.undoVote(undoRequestId, false);
	});
	const mobileUndoCancel = button(t("Cancel undo"), () => {
		if (undoRequestId !== undefined) handlers.undoCancel(undoRequestId);
	});
	const mobileUndoDialog = el(
		"section",
		{
			className: "mobile-undo-overlay",
			attrs: {
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": "mobile-undo-title",
				"data-testid": "mobile-undo-overlay",
				tabindex: "-1",
			},
		},
		el(
			"div",
			{ className: "mobile-undo-dialog" },
			el("h2", { attrs: { id: "mobile-undo-title" } }, t("Undo request")),
			mobileUndoMessage,
			el(
				"div",
				{ className: "mobile-undo-actions" },
				mobileUndoApprove,
				mobileUndoReject,
				mobileUndoCancel,
			),
		),
	);
	const claimMessage = el("p", {
		className: "undo-message",
		attrs: { role: "status", "data-testid": "claim-message" },
	});
	const claimCountSelect = el("select", {
		attrs: {
			"aria-label": t("Number of tricks to claim"),
			"data-testid": "claim-count",
		},
	});
	const confirmClaim = button(
		t("Confirm claim"),
		() => {
			const view = latestView;
			if (!view?.claim.canRequest) return;
			const tricks = claimMode === "all" ? view.claim.maxTricks : claimCount;
			claimMode = null;
			handlers.claimRequest(view.board, tricks);
		},
		{ attrs: { "data-testid": "claim-confirm" } },
	);
	const cancelClaimChoice = button(t("Go back"), () => {
		claimMode = null;
		if (latestView) renderClaimPanel(latestView);
	});
	const approveClaim = button(t("Accept claim"), () => {
		if (claimRequestId !== undefined) handlers.claimVote(claimRequestId, true);
	});
	const rejectClaim = button(t("Reject claim"), () => {
		if (claimRequestId !== undefined) handlers.claimVote(claimRequestId, false);
	});
	const claimPanel = el(
		"section",
		{
			className: "side-panel claim-panel",
			attrs: { "data-testid": "claim-panel" },
		},
		el("h3", { className: "panel-title" }, t("Claim tricks")),
		claimMessage,
		claimCountSelect,
		confirmClaim,
		cancelClaimChoice,
		approveClaim,
		rejectClaim,
	);
	const compactUndo = button(
		"",
		() => {
			if (undoBoard !== undefined) handlers.undoRequest(undoBoard);
		},
		{
			className: "icon-button",
			attrs: {
				"aria-label": t("Undo"),
				title: t("Undo"),
				"data-testid": "undo-compact",
			},
		},
	);
	compactUndo.append(icon("undo"));
	compactUndo.disabled = true;
	const compactClaim = button(
		"",
		() => {
			claimMode = "choose";
			claimCount = 1;
			if (latestView) renderClaimPanel(latestView);
		},
		{
			className: "icon-button",
			attrs: {
				"aria-label": t("Claim tricks"),
				title: t("Claim tricks"),
				"data-testid": "claim-compact",
			},
		},
	);
	compactClaim.append(icon("flag"));
	compactClaim.disabled = true;
	const compactClaimAll = button(
		"",
		() => {
			claimMode = "all";
			if (latestView) renderClaimPanel(latestView);
		},
		{
			className: "icon-button",
			attrs: {
				"aria-label": t("Claim all remaining tricks"),
				title: t("Claim all remaining tricks"),
				"data-testid": "claim-all-compact",
			},
		},
	);
	compactClaimAll.append(icon("flag"));
	compactClaimAll.disabled = true;
	// During the auction the bidding history sits beside the bid box in this row; render() moves it.
	const bidRow = el("div", { className: "bid-row" }, bidBox);
	const gameSlot = el(
		"div",
		{ className: "game-slot", attrs: { "data-testid": "game-slot" } },
		bidRow,
	);
	const call = callControls(
		handlers.call,
		[compactClaim, compactClaimAll, compactUndo],
		t,
	);
	const audioGroup = (() => {
		const controls = call.row.querySelector<HTMLElement>(".icon-group");
		if (!controls) throw new Error("room call controls are missing");
		return controls;
	})();
	const mobileExit = button(t("Exit"), handlers.exit, {
		className: "mobile-auction-exit",
	});
	const mobileShareStatus = el("span", {
		className: "visually-hidden",
		attrs: { role: "status", "aria-live": "polite" },
	});
	const mobileShare = button(
		t("Share URL"),
		() => {
			void handlers.shareUrl().then(
				() => {
					mobileShareStatus.textContent = t("Share action completed.");
				},
				(error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					mobileShareStatus.textContent = t("Could not share the board URL.");
				},
			);
		},
		{ className: "mobile-auction-share" },
	);
	const mobileTopbar = el(
		"div",
		{ className: "mobile-auction-topbar" },
		audioGroup,
		mobileShare,
		mobileExit,
		mobileShareStatus,
	);
	const mobileRoundStatus = el("div", {
		className: "mobile-round-status",
		attrs: { "data-testid": "mobile-round-status", "aria-live": "polite" },
	});
	const mobileBids = el(
		"section",
		{ className: "mobile-auction-bids" },
		bidHistory,
	);
	const mobileBidControls = el(
		"section",
		{ className: "mobile-auction-controls" },
		bidBox,
	);
	const mobileHand = el("section", {
		className: "mobile-auction-hand",
		attrs: { "aria-label": t("Your hand") },
	});
	const mobileOpponentTop = el("div", {
		className: "mobile-board-top",
		attrs: { "aria-hidden": "true" },
	});
	const mobileOpponentLeft = el("div", {
		className: "mobile-board-left",
		attrs: { "aria-hidden": "true" },
	});
	const mobileOpponentRight = el("div", {
		className: "mobile-board-right",
		attrs: { "aria-hidden": "true" },
	});
	const mobileBoardCenter = el("div", {
		className: "mobile-board-center",
		attrs: { role: "group", "aria-label": t("Current trick") },
	});
	const mobileBoard = el(
		"section",
		{
			className: "mobile-auction-board",
			attrs: { "aria-label": t("Game board") },
		},
		mobileOpponentTop,
		mobileOpponentLeft,
		mobileBoardCenter,
		mobileOpponentRight,
		mobileHand,
	);
	const mobileTricks = el("section", {
		className: "mobile-tricks",
		attrs: {
			"aria-label": t("Trick count"),
			"data-testid": "mobile-tricks",
		},
	});
	const connectedPlayers = el("p", { className: "mobile-players-connected" });
	const mobileBotControls = el("div", { className: "mobile-bot-controls" });
	const mobilePlayers = el(
		"section",
		{
			className: "mobile-auction-players",
			attrs: { "aria-label": t("Other players") },
		},
		connectedPlayers,
		mobileBotControls,
	);
	const mobileAuction = el(
		"section",
		{
			className: "mobile-auction",
			attrs: { "data-testid": "mobile-auction" },
		},
		mobileTopbar,
		mobileRoundStatus,
		mobileBids,
		mobileBoard,
		mobileTricks,
		mobileBidControls,
		mobilePlayers,
	);
	let compact = false;
	let mobileUndoWasVisible = false;
	// The bid picker sits in the felt centre under the bids; the call panel sits in the felt corner (reference layout).
	center.append(gameSlot);
	const felt = el(
		"div",
		{ className: "felt" },
		el(
			"div",
			{ className: "video-row" },
			videoSlots.left,
			videoSlots.top,
			videoSlots.right,
			el("div", { className: "call-slot" }, call.panel),
		),
		el(
			"div",
			{ className: "body" },
			el("div", { className: "col col-left" }, places.left),
			el(
				"div",
				{ className: "col col-centre" },
				places.top,
				center,
				places.bottom,
			),
			el("div", { className: "col col-right" }, places.right),
		),
	);
	const dock = el("div", { className: "dock" }, call.alert, call.row);
	let callDisplay: CallDisplay | undefined;
	const callSpots = new Map<Seat, CallSpot>();
	let botControlHost = false;
	let botControlSeats: readonly Seat[] = [];
	let botModel: string | undefined;
	let playerAutoplayAvailable = false;
	let playerAutoplayEnabled = false;
	let playerAutoplayPending = false;
	let playerAutoplayStatus = "";
	let remoteCallPresence: Readonly<Partial<Record<Seat, RemoteCallPresence>>> =
		{};
	let hostAutoplayControl: HTMLButtonElement | undefined;
	/** The tag and player name of each seat, as the last table view gave them ("E - David"). */
	let seatLabels = new Map<Seat, string>();

	const scores = el("table", {
		className: "scores",
		attrs: { "data-testid": "scores" },
	});
	const contractHead = el("p", {
		className: "contract-head",
		attrs: { "data-testid": "contract-head" },
	});
	const contractPanel = el(
		"section",
		{ className: "side-panel", attrs: { "data-testid": "contract-panel" } },
		contractHead,
	);
	const tricksPanel = el("section", {
		className: "side-panel tricks-panel",
		attrs: { "data-testid": "tricks-panel" },
	});
	// render() fills the sidebar in order: contract, bidding history, tricks, statistics, claim controls.
	const sidebar = el("div", { className: "table-sidebar" });
	const status = el(
		"div",
		{ className: "table-status" },
		heading,
		details,
		prompt,
		contract,
		result,
		actions,
	);
	const element = el(
		"section",
		{
			className: "bridge-table",
			attrs: {
				"data-testid": "table",
				"data-played-card-style": playedCardStyle,
			},
		},
		status,
		mobileAuction,
		mobileUndoDialog,
		felt,
		dock,
	);
	let desktop = false;
	let phase: TableView["phase"] = "waiting";
	/** The desktop keeps board status in the sidebar; the lobby and compact layout show it above the felt. */
	function placeStatus(): void {
		const beside = desktop && phase !== "waiting";
		const hideDetails = beside && phase !== "auction";
		heading.hidden = hideDetails;
		details.hidden = hideDetails;
		prompt.hidden = hideDetails;
		if (beside) {
			const controls = sidebar.querySelector(".room-controls");
			if (controls) controls.after(status);
			else sidebar.prepend(status);
		} else {
			element.prepend(status);
		}
	}

	function cardButton(card: CardView, suitStart: boolean): HTMLButtonElement {
		const node = button(
			"",
			() => handlers.act({ type: "play", card: card.card }),
			{
				className: suitStart ? "card suit-start" : "card",
				attrs: {
					"data-card": card.card,
					"data-suit": card.suit,
					"aria-label": card.text,
				},
			},
		);
		node.append(
			el(
				"span",
				{ className: "face" },
				el("span", { className: "rank" }, card.rank),
				el("span", { className: "pip" }, SUIT_SYMBOLS[card.suit]),
			),
		);
		node.disabled = !card.playable;
		return node;
	}

	/** Cards overlap: each card shows a strip, and the last card shows its whole face. */
	function handElement(
		hand: HandDisplay,
		position: Position,
		back: string,
	): HTMLElement {
		const side = handDirection(position) === "column";
		// Visible side hands stack their suits, each suit a row of cards; hidden hands keep the back column.
		const node = el("div", {
			className:
				side && hand.visible
					? "hand hand-stack"
					: `hand hand-${handDirection(position)}`,
		});
		if (!hand.visible) {
			node.classList.add("backs");
			node.setAttribute("aria-hidden", "true");
			for (let index = 0; index < hand.count; index++)
				node.append(
					el(
						"span",
						{ className: "back" },
						el(
							"span",
							{ className: "face" },
							el("img", {
								className: "back-art",
								attrs: { src: back, alt: "" },
							}),
						),
					),
				);
			return node;
		}
		if (!side) {
			const visibleSuits = hand.suits.filter((row) => row.cards.length > 0);
			const trumpIsLast = visibleSuits.at(-1)?.trump === true;
			node.dataset.mobileCardLayout = `${visibleSuits.length}-${trumpIsLast ? 1 : 2}`;
		}
		if (side) {
			for (const row of hand.suits) {
				if (row.cards.length === 0) continue;
				// The trump label sits in the flow above its row, so the seat name above the hand is not covered.
				if (row.trump)
					node.append(
						el("span", { className: "trump-label" }, t("Trump suit")),
					);
				node.append(
					el(
						"span",
						{
							className: row.trump
								? "suit-row hand-row suit-group trump"
								: "suit-row hand-row",
							attrs: { "data-suit": row.suit },
						},
						...row.cards.map((card) => cardButton(card, false)),
					),
				);
			}
			return node;
		}
		let first = true;
		for (const row of hand.suits) {
			// The trump group is framed in its own wrapper, with its label above the frame; the wrapper takes the suit gap.
			if (row.trump && row.cards.length > 0) {
				const group = el(
					"span",
					{
						className: first
							? "suit-group trump"
							: "suit-group trump suit-start",
						attrs: { "data-suit": row.suit },
					},
					...row.cards.map((card) => cardButton(card, false)),
				);
				node.append(group);
			} else {
				node.append(
					...row.cards.map((card, index) =>
						cardButton(card, index === 0 && !first),
					),
				);
			}
			if (row.cards.length > 0) first = false;
		}
		return node;
	}

	/** The hand area of a free seat in the lobby: a label, rotated for the side seats. */
	function waitingLabel(position: Position): HTMLElement {
		return el(
			"div",
			{ className: `hand hand-${handDirection(position)} waiting` },
			el("span", { className: "waiting-text" }, t(WAITING_TEXT)),
		);
	}

	function seatElement(
		seat: SeatView,
		callState: HTMLElement | undefined,
		lobby: boolean,
		back: string,
	): HTMLElement {
		const label = el(
			"div",
			{ className: "seat-label" },
			el(
				"span",
				{ className: "name", attrs: { "data-bot": String(seat.bot) } },
				seat.label,
			),
			...seat.tags.map((tag) => el("span", { className: "tag" }, t(tag))),
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
			label.append(hostAutoplayControl);
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
			label.append(autoplay);
			if (playerAutoplayStatus) {
				label.append(
					el(
						"span",
						{ className: "player-autoplay-status", attrs: { role: "status" } },
						playerAutoplayStatus,
					),
				);
			}
		}
		if (callState !== undefined) label.append(callState);
		const banner = seat.connecting
			? [
					el(
						"p",
						{ className: "connecting", attrs: { role: "status" } },
						t(CONNECTING_TEXT),
					),
				]
			: [];
		const hand =
			lobby && seat.presence === "free"
				? waitingLabel(seat.position)
				: handElement(seat.hand, seat.position, back);
		// A top or bottom hand shows its trump label in the seat, between the name and the hand, so it is never covered.
		const trumpLabel =
			seat.hand.visible &&
			(seat.position === "top" || seat.position === "bottom") &&
			seat.hand.suits.some((row) => row.trump && row.cards.length > 0)
				? [el("span", { className: "trump-label" }, t("Trump suit"))]
				: [];
		// The HCP pill belongs to the viewer's own hand; the turn pill marks the seat to call.
		const pills = [
			...(seat.points === undefined
				? []
				: [el("span", { className: "hcp-pill" }, `${seat.points} HCP`)]),
			...(seat.bidding
				? [
						el(
							"span",
							{ className: "turn-pill", attrs: { "data-testid": "turn-pill" } },
							seat.hand.visible
								? t("YOUR TURN TO BID")
								: `${t(SEAT_NAMES[seat.seat])} TO BID`,
						),
					]
				: []),
		];
		return el(
			"div",
			{
				className: `seat pos-${seat.position}`,
				attrs: {
					"data-testid": `hand-${seat.seat}`,
					"data-visible": String(seat.hand.visible),
					"data-turn": String(seat.turn),
					"data-bidding": String(seat.bidding),
					"data-presence": seat.presence,
				},
			},
			...pills,
			label,
			...banner,
			...trumpLabel,
			hand,
		);
	}

	/** The video tile of a remote seat, reserved while video is off, and the compact call status. */
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
		const spot = {
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

	/** Each opponent is one column: the video tile above the hand, both on the same centre line. */
	function renderPlace(seat: SeatView, lobby: boolean, back: string): void {
		const place = places[seat.position];
		// The claim controls sit in the sidebar, and only while the viewer is about to play a card.
		if (seat.position === "bottom") {
			place.replaceChildren(seatElement(seat, undefined, lobby, back));
			return;
		}
		const spot = callSpot(seat.seat);
		spot.botOverlay.hidden = !seat.bot;
		spot.tile.dataset.bot = String(seat.bot);
		videoSlots[seat.position].replaceChildren(spot.tile);
		place.replaceChildren(seatElement(seat, spot.state, lobby, back));
	}

	/**
	 * A picture only while the call view gives the seat a camera track (handover §7): Receive off, the peer's Send
	 * off, Leave and the compact form all clear it at once, so no last frame stays. The avatar shows otherwise.
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
	 * The status of each remote seat (handover §4, §7): nothing while the local user is outside the call, else
	 * the link state; a failed link offers Retry.
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
			const label = seatLabels.get(seat) ?? SEAT_NAMES[seat];
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
				spot.state.append(retryButton(seat, handlers.call, false));
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
		if (latestView) renderMobilePlayers(latestView);
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

	/**
	 * The viewer's pending choice. A level and a strain build one bid; Pass, X and XX are chosen alone. Nothing is
	 * sent until Confirm. Undo clears a pending choice, or requests rollback when the choice is empty.
	 */
	let pick: { level?: string; strain?: string; call?: Call } = {};
	let shown: TableView | undefined;

	const STRAIN_BUTTONS: readonly {
		readonly strain: string;
		readonly label: string;
		readonly symbol: string;
	}[] = [
		{ strain: "C", label: "Clubs", symbol: SUIT_SYMBOLS.C },
		{ strain: "D", label: "Diamonds", symbol: SUIT_SYMBOLS.D },
		{ strain: "H", label: "Hearts", symbol: SUIT_SYMBOLS.H },
		{ strain: "S", label: "Spades", symbol: SUIT_SYMBOLS.S },
		{ strain: "NT", label: "No trump", symbol: "NT" },
	];

	const SPECIAL_CALLS: readonly {
		readonly call: Call;
		readonly label: string;
	}[] = [
		{ call: "X", label: "Double" },
		{ call: "XX", label: "Redouble" },
		{ call: "P", label: "Pass" },
	];

	function pickButton(
		text: string,
		name: string,
		enabled: boolean,
		pressed: boolean,
		onClick: () => void,
		className: string,
	): HTMLButtonElement {
		const node = button(text, onClick, {
			className,
			attrs: { "aria-label": name, "aria-pressed": String(pressed) },
		});
		node.disabled = !enabled;
		return node;
	}

	function renderBidBox(view: TableView): void {
		// A selection belongs to one call position; a new board or a new call clears it.
		if (
			shown?.board !== view.board ||
			shown.at !== view.at ||
			view.undo.requestId !== undefined
		)
			pick = {};
		shown = view;
		const legal = new Set<string>(view.bids.map((bid) => bid.call));
		const bidCall =
			pick.level !== undefined && pick.strain !== undefined
				? `${pick.level}${pick.strain}`
				: undefined;
		const chosen: Call | undefined =
			pick.call ??
			(bidCall !== undefined && legal.has(bidCall)
				? (bidCall as Call)
				: undefined);
		const redraw = (): void => {
			if (shown !== undefined) renderBidBox(shown);
		};
		const levels = el(
			"div",
			{ className: "bid-levels" },
			...[1, 2, 3, 4, 5, 6, 7].map((level) => {
				const text = String(level);
				return pickButton(
					text,
					`Level ${level}`,
					view.bids.some((bid) => bid.call.startsWith(text)),
					pick.level === text,
					() => {
						pick = { level: text, strain: pick.strain };
						redraw();
					},
					"level",
				);
			}),
		);
		const calls = el(
			"div",
			{ className: "bid-calls" },
			...STRAIN_BUTTONS.map(({ strain, label, symbol }) =>
				pickButton(
					symbol,
					label,
					pick.level === undefined
						? view.bids.some((bid) => bid.call.endsWith(strain))
						: legal.has(`${pick.level}${strain}`),
					pick.strain === strain,
					() => {
						pick = { level: pick.level, strain };
						redraw();
					},
					`strain strain-${strain}`,
				),
			),
			...SPECIAL_CALLS.map(({ call, label }) =>
				pickButton(
					call === "P" ? "PASS" : call,
					label,
					legal.has(call),
					pick.call === call,
					() => {
						pick = { call };
						redraw();
					},
					call === "P" ? "pass" : call === "X" ? "double" : "redouble",
				),
			),
		);
		const chosenText = view.bids.find((bid) => bid.call === chosen)?.text;
		const confirm = button(
			chosenText === undefined ? t("Confirm") : `${t("Confirm")} ${chosenText}`,
			() => {
				if (chosen !== undefined) handlers.act({ type: "call", call: chosen });
			},
			{ className: "confirm", attrs: { "data-call": chosen ?? "" } },
		);
		confirm.disabled = chosen === undefined || !legal.has(chosen);
		const undo = button(
			t("Undo"),
			() => {
				const hasPick =
					pick.level !== undefined ||
					pick.strain !== undefined ||
					pick.call !== undefined;
				if (hasPick) {
					pick = {};
					redraw();
				} else if (view.undo.canRequest) {
					handlers.undoRequest(view.board);
				}
			},
			{ className: "undo-call" },
		);
		const hasPick =
			pick.level === undefined &&
			pick.strain === undefined &&
			pick.call === undefined;
		undo.disabled =
			view.undo.requestId !== undefined || (!view.undo.canRequest && hasPick);
		const requestId = view.undo.requestId;
		const approve = button(t("Approve"), () => {
			if (requestId !== undefined) handlers.undoVote(requestId, true);
		});
		const reject = button(t("Reject"), () => {
			if (requestId !== undefined) handlers.undoVote(requestId, false);
		});
		const cancel = button(t("Cancel undo"), () => {
			if (requestId !== undefined) handlers.undoCancel(requestId);
		});
		approve.hidden = !view.undo.canVote || compact;
		reject.hidden = !view.undo.canVote || compact;
		cancel.hidden = !view.undo.canCancel || compact;
		const status = el("span", { className: "undo-message" }, view.undo.message);
		status.hidden = view.undo.message === "";
		bidBox.replaceChildren(
			levels,
			calls,
			el(
				"div",
				{ className: "bid-actions" },
				confirm,
				undo,
				approve,
				reject,
				cancel,
				status,
			),
		);
	}

	function renderClaimPanel(view: TableView): void {
		if (!view.claim.canRequest) claimMode = null;
		const choosing = claimMode === "choose" && view.claim.canRequest;
		const confirmingAll = claimMode === "all" && view.claim.canRequest;
		if (choosing) {
			const count = Math.max(1, Math.min(claimCount, view.claim.maxTricks));
			claimCount = count;
			claimCountSelect.replaceChildren(
				...Array.from({ length: view.claim.maxTricks }, (_, index) => {
					const value = index + 1;
					return el(
						"option",
						{ attrs: { value: String(value) } },
						String(value),
					);
				}),
			);
			claimCountSelect.value = String(count);
		}
		claimMessage.textContent = choosing
			? t("Choose how many of the {count} remaining tricks you claim.", {
					count: view.claim.maxTricks,
				})
			: confirmingAll
				? t("Confirm that you claim all {count} remaining tricks.", {
						count: view.claim.maxTricks,
					})
				: view.claim.message;
		claimCountSelect.hidden = !choosing;
		confirmClaim.hidden = !choosing && !confirmingAll;
		cancelClaimChoice.hidden = !choosing && !confirmingAll;
		approveClaim.hidden = !view.claim.canVote;
		rejectClaim.hidden = !view.claim.canVote;
		claimPanel.hidden =
			claimMessage.textContent === "" &&
			!choosing &&
			!confirmingAll &&
			!view.claim.canVote;
	}

	claimCountSelect.addEventListener("change", () => {
		claimCount = Number(claimCountSelect.value);
		if (latestView) renderClaimPanel(latestView);
	});

	/** The cards played to the current trick, each drawn with its long edge towards the player who played it. */
	function renderTrick(view: TrickView | undefined): void {
		trick.hidden = view === undefined;
		if (!view) {
			trick.replaceChildren();
			return;
		}
		trick.replaceChildren(
			...view.cards.map((played) =>
				el(
					"span",
					{
						className: `played pos-${played.position}`,
						attrs: {
							"data-seat": played.seat,
							"data-card": played.card,
							"data-suit": suitOf(played.card),
							"aria-label": played.text,
							title: t(SEAT_NAMES[played.seat]),
						},
					},
					el(
						"span",
						{ className: "played-legacy", attrs: { "aria-hidden": "true" } },
						el("span", { className: "rank" }, played.rank),
						el("span", { className: "suit" }, played.symbol),
					),
					el(
						"span",
						{ className: "played-corners", attrs: { "aria-hidden": "true" } },
						el("span", { className: "rank-corner top-left" }, played.rank),
						el("span", { className: "rank-corner top-right" }, played.rank),
						el("span", { className: "rank-corner bottom-left" }, played.rank),
						el("span", { className: "rank-corner bottom-right" }, played.rank),
					),
					el(
						"span",
						{
							className: "played-center-suit",
							attrs: { "aria-hidden": "true" },
						},
						played.symbol,
					),
				),
			),
		);
	}

	function setCountdown(seconds: number | undefined): void {
		scoringCountdown.hidden = seconds === undefined || seconds === 0;
		if (seconds === undefined) return;
		const board = latestView?.nextBoard?.board;
		scoringCountdown.textContent =
			board === undefined
				? ""
				: seconds > 0
					? t(
							seconds === 1
								? "Next board {board} in {seconds} second"
								: "Next board {board} in {seconds} seconds",
							{ board, seconds },
						)
					: "";
	}

	function renderScoring(view: TableView["scoring"]): void {
		scoring.hidden = view === undefined;
		if (!view) {
			scoring.replaceChildren();
			return;
		}
		if (compact) {
			scoring.replaceChildren(
				el(
					"strong",
					{
						className: "mobile-scoring-outcome",
						attrs: { "data-outcome": view.compactOutcome },
					},
					t(view.compactOutcome),
				),
				...(view.compactDetail === ""
					? []
					: [
							el(
								"p",
								{ className: "mobile-scoring-detail" },
								view.compactDetail,
							),
						]),
				scoringCountdown,
			);
			setCountdown(view.countdown);
			return;
		}
		const contract = view.contract;
		scoring.replaceChildren(
			...(contract
				? [
						el(
							"p",
							{ className: "scoring-contract" },
							`${t("Contract")} `,
							el(
								"strong",
								{},
								String(contract.level),
								el(
									"span",
									{ className: `strain strain-${contract.strain}` },
									contract.strain === "NT"
										? "NT"
										: SUIT_SYMBOLS[contract.strain],
								),
								contract.doubling,
							),
						),
					]
				: []),
			el(
				"p",
				{
					className: "scoring-result",
					attrs: { "data-outcome": view.compactOutcome },
				},
				el("strong", {}, `${t(view.compactOutcome)}:`),
				...(view.compactDetail === "" ? [] : [` ${view.compactDetail}`]),
			),
			scoringCountdown,
		);
		setCountdown(view.countdown);
	}

	function renderAuction(view: TableView): void {
		const grid = view.auction;
		auction.hidden = grid === undefined;
		if (!grid) {
			auction.replaceChildren();
			return;
		}
		const rows = grid.rows;
		const names = new Map(view.seats.map((seat) => [seat.seat, seat.name]));
		auction.replaceChildren(
			el(
				"thead",
				{},
				el(
					"tr",
					{},
					...grid.seats.map((seat) => {
						const player = `${names.get(seat) || t(seat)} (${t(seat)})`;
						return el("th", { attrs: { scope: "col", title: player } }, player);
					}),
				),
			),
			el(
				"tbody",
				{},
				...rows.map((row) =>
					el(
						"tr",
						{},
						...grid.seats.map((_, index) =>
							el("td", {}, ...auctionCell(row[index] ?? EMPTY_BID)),
						),
					),
				),
			),
		);
		auctionScroll.scrollTop = auctionScroll.scrollHeight;
	}

	function renderMobilePlayers(view: TableView): void {
		const own = view.seats.find((player) => player.position === "bottom")?.seat;
		mobileBotControls.hidden = !botControlHost && !playerAutoplayAvailable;
		const others = view.seats.filter(
			(player) =>
				player.seat !== own &&
				player.presence !== "free" &&
				!(botControlHost && player.tags.includes("Host")),
		);
		const connected = others
			.filter((player) => player.presence === "online")
			.map((player) => `${player.name || player.label} (${t(player.seat)})`);
		connectedPlayers.textContent = t("Connected: {players}", {
			players: connected.length > 0 ? connected.join("  ") : t("None"),
		});
		mobileBotControls.replaceChildren(
			...view.seats.map((player) => {
				const isBot = botControlSeats.includes(player.seat);
				const toggle = button(
					isBot ? `👱 ${t("Switch to player")}` : `🤖 ${t("Switch to bot")}`,
					() => handlers.setBotSeat?.(player.seat, !isBot),
				);
				toggle.hidden = !botControlHost;
				const autoplay = button(
					t(playerAutoplayEnabled ? "Stop autoplay" : "Enable autoplay (bot)"),
					() => handlers.requestAutoplay?.(!playerAutoplayEnabled),
					{
						className: "player-autoplay-toggle",
						attrs: { "data-testid": "mobile-player-autoplay-toggle" },
					},
				);
				autoplay.hidden =
					player.seat !== own || botControlHost || !playerAutoplayAvailable;
				autoplay.disabled = playerAutoplayPending;
				return el(
					"div",
					{
						className: "mobile-player-control",
						attrs: { "data-seat": player.seat },
					},
					el(
						"span",
						{},
						`${player.name || player.label}${player.bot ? " 🤖" : ""} (${t(player.seat)})`,
					),
					toggle,
					autoplay,
				);
			}),
		);
	}

	function renderMobileRoundStatus(view: TableView): void {
		const ownSeat = view.seats.find((player) => player.position === "bottom");
		const ownSide =
			ownSeat?.seat === "E" || ownSeat?.seat === "W" ? "ew" : "ns";
		const record = (side: "ew" | "ns", label: string): HTMLElement => {
			const stats = view.statistics[side];
			const net = stats.won - stats.lost;
			return el(
				"span",
				{
					className: "mobile-round-record",
					attrs: {
						"data-own-side": String(ownSide === side),
						"data-result": net > 0 ? "positive" : net < 0 ? "negative" : "zero",
					},
				},
				`${label}: `,
				el("strong", {}, net > 0 ? `+${net}` : String(net)),
			);
		};
		mobileRoundStatus.replaceChildren(
			el(
				"strong",
				{ className: "mobile-round-number" },
				`${t("Round")} ${view.board}`,
			),
			record("ew", "E-W"),
			record("ns", "N-S"),
		);
	}

	function opponentHand(
		position: "top" | "left" | "right",
	): HTMLElement | undefined {
		return (
			places[position].querySelector<HTMLElement>(".seat > .hand") ?? undefined
		);
	}

	/**
	 * The "Previous game statistics" panel. Its counters are per deal, so the rows say "Deals"; the product has not
	 * yet chosen a game unit (bridge-auction-screen, Previous game statistics).
	 */
	function renderScores(view: TableView): void {
		const { ns, ew } = view.statistics;
		const rows: readonly [string, number, number, boolean][] = [
			[t("Deals won"), ew.won, ns.won, false],
			[t("Deals lost"), ew.lost, ns.lost, false],
			[t("Total score"), ew.total, ns.total, true],
		];
		scores.replaceChildren(
			el("caption", {}, t("Previous game statistics")),
			el(
				"thead",
				{},
				el(
					"tr",
					{},
					el("th", {}, ""),
					el("th", { className: "num" }, "E-W"),
					el("th", { className: "num" }, "N-S"),
				),
			),
			el(
				"tbody",
				{},
				...rows.map(([label, eastWest, northSouth, total]) =>
					el(
						"tr",
						total ? { className: "total" } : {},
						el("th", {}, label),
						el("td", { className: "num" }, String(eastWest)),
						el("td", { className: "num" }, String(northSouth)),
					),
				),
			),
		);
	}

	function actionItem(line: TableActionLine): HTMLElement {
		// A pending action's reason says which players the host waits for.
		const status =
			line.state === "not-accepted"
				? `${t(ACTION_STATUS[line.state])}: ${t(line.reason ?? "rejected")}`
				: t(line.reason ?? ACTION_STATUS[line.state]);
		return el(
			"li",
			{ attrs: { "data-state": line.state } },
			el("span", { className: "text" }, line.text),
			el("span", { className: "status" }, status),
		);
	}

	function render(view: TableView): void {
		latestView = view;
		element.dataset.phase = view.phase;
		element.dataset.board = String(view.board);
		element.dataset.at = String(view.at);
		heading.textContent = t(view.heading || "Bridge table");
		details.textContent = t(view.details);
		prompt.textContent = translateLobbyPrompt(view.prompt, t);
		felt.hidden = view.seats.length === 0;
		for (const place of Object.values(places)) place.replaceChildren();
		for (const slot of Object.values(videoSlots)) slot.replaceChildren();
		phase = view.phase;
		placeStatus();
		const lobby = view.phase === "waiting";
		const back = cardBackFor(view.board);
		for (const seat of view.seats) renderPlace(seat, lobby, back);
		const mobileGameActive =
			compact && (view.phase === "auction" || view.phase === "play");
		mobileAuction.hidden = !mobileGameActive;
		if (mobileGameActive && view.phase === "play") {
			mobileBoardCenter.replaceChildren(trick);
		} else {
			mobileBoardCenter.replaceChildren();
			center.prepend(trick);
		}
		if (mobileGameActive) {
			mobileTopbar.prepend(audioGroup);
			const ownSeat = places.bottom.firstElementChild;
			if (ownSeat) mobileHand.replaceChildren(ownSeat);
			for (const [position, target] of [
				["top", mobileOpponentTop],
				["left", mobileOpponentLeft],
				["right", mobileOpponentRight],
			] as const) {
				const hand = opponentHand(position);
				target.replaceChildren(...(hand ? [hand] : []));
				target.setAttribute(
					"aria-hidden",
					String(
						view.phase !== "play" ||
							hand === undefined ||
							hand.classList.contains("backs"),
					),
				);
			}
			mobileBids.replaceChildren(bidHistory);
			mobileBidControls.replaceChildren(
				...(view.phase === "auction" ? [bidBox] : [playControls, claimPanel]),
			);
			renderMobileTricks(view);
			renderMobileRoundStatus(view);
		} else {
			call.row.prepend(audioGroup);
			mobileHand.replaceChildren();
			mobileOpponentTop.replaceChildren();
			mobileOpponentLeft.replaceChildren();
			mobileOpponentRight.replaceChildren();
			for (const target of [
				mobileOpponentTop,
				mobileOpponentLeft,
				mobileOpponentRight,
			])
				target.setAttribute("aria-hidden", "true");
			bidRow.replaceChildren(bidBox);
			if (view.phase === "auction") bidRow.prepend(bidHistory);
		}
		renderMobilePlayers(view);
		const mobileUndoVisible = compact && view.undo.requestId !== undefined;
		mobileUndoDialog.hidden = !mobileUndoVisible;
		mobileUndoMessage.textContent = view.undo.message;
		mobileUndoApprove.hidden = !view.undo.canVote;
		mobileUndoReject.hidden = !view.undo.canVote;
		mobileUndoCancel.hidden = !view.undo.canCancel;
		if (mobileUndoVisible && !mobileUndoWasVisible) mobileUndoDialog.focus();
		mobileUndoWasVisible = mobileUndoVisible;
		const bottom = view.seats.find((seat) => seat.position === "bottom");
		const ownTurn = bottom?.turn === true && !bottom.tags.includes("Dummy");
		const gameOver = view.phase === "complete";
		const playing = view.phase === "play";
		playControls.hidden =
			mobileGameActive && playing
				? false
				: (!playing && !gameOver) ||
					(!ownTurn &&
						!view.undo.canRequest &&
						!view.undo.canVote &&
						!view.undo.canCancel &&
						!view.claim.canRequest);
		claim.hidden = view.phase !== "play";
		claimAll.hidden = view.phase !== "play";
		claim.disabled = !view.claim.canRequest;
		claimAll.disabled = !view.claim.canRequest;
		compactClaim.hidden = view.phase !== "play";
		compactClaim.disabled = !view.claim.canRequest;
		compactClaimAll.hidden = view.phase !== "play";
		compactClaimAll.disabled = !view.claim.canRequest;
		seatLabels = new Map(view.seats.map((seat) => [seat.seat, seat.label]));
		renderCallStates();
		renderAuction(view);
		renderTrick(view.trick);
		contract.textContent = [view.contract, view.tricks]
			.filter((part) => part !== "")
			.join(" · ");
		// The sidebar header and tricks panel show the contract and the tricks once play starts.
		contract.hidden = contract.textContent === "" || view.header !== undefined;
		result.textContent = view.scoring ? "" : view.result;
		result.hidden = result.textContent === "";
		actions.replaceChildren(...view.actions.map(actionItem));
		actions.hidden = view.actions.length === 0;
		gameSlot.hidden = view.scoring !== undefined;
		renderScoring(view.scoring);
		// The bid box stays on screen for the whole auction; without legal calls it is grayed out.
		bidRow.hidden = view.phase !== "auction";
		bidBox.classList.toggle("not-turn", view.bids.length === 0);
		renderBidBox(view);
		renderScores(view);
		undoBoard = view.board;
		undoRequestId = view.undo.requestId;
		claimRequestId = view.claim.requestId;
		undoMessage.textContent = view.undo.message;
		undoMessage.hidden = view.undo.message === "";
		playUndo.hidden =
			!view.undo.canRequest || view.undo.requestId !== undefined;
		playUndo.disabled = !view.undo.canRequest;
		compactUndo.hidden = view.phase === "auction";
		compactUndo.disabled = !view.undo.canRequest;
		approveUndo.hidden = !view.undo.canVote || compact;
		rejectUndo.hidden = !view.undo.canVote || compact;
		cancelUndo.hidden = !view.undo.canCancel;
		renderClaimPanel(view);
		if (mobileGameActive)
			mobileBidControls.hidden =
				view.phase === "play" &&
				!Array.from(playControls.children).some(
					(control) => !control.hasAttribute("hidden"),
				) &&
				claimPanel.hidden;
		undoPanel.hidden =
			compact ||
			view.phase === "auction" ||
			(!view.undo.canRequest &&
				view.undo.requestId === undefined &&
				view.undo.message === "");
		bidHistory.hidden = view.auction === undefined;
		historyTitle.hidden = view.phase === "auction" && !mobileGameActive;
		renderContractHead(view.header);
		renderTricks(view);
		sidebar.append(
			contractPanel,
			...(mobileGameActive || view.phase === "auction" ? [] : [bidHistory]),
			tricksPanel,
			scores,
			undoPanel,
			...(mobileGameActive ? [] : [claimPanel, playControls]),
		);
	}

	/** The sidebar header: "1♣ by North · Anna", with the suit in red on hearts and diamonds. */
	function renderContractHead(header: ContractHeader | undefined): void {
		contractPanel.hidden = header === undefined;
		if (!header) {
			contractHead.replaceChildren();
			return;
		}
		const red = header.strain === "H" || header.strain === "D";
		contractHead.replaceChildren(
			el(
				"span",
				{ className: "bid" },
				String(header.level),
				el("span", { className: red ? "strain red" : "strain" }, header.symbol),
				header.doubling,
			),
			el("span", { className: "by" }, t("by")),
			el(
				"span",
				{ className: "declarer" },
				header.name ? `${header.direction} · ${header.name}` : header.direction,
			),
		);
	}

	/** Our tricks, the target and the opponents' tricks, and what the viewer's side still needs. */
	function renderTricks(view: TableView): void {
		const need = view.need;
		tricksPanel.hidden = need === undefined;
		if (!need) {
			tricksPanel.replaceChildren();
			return;
		}
		const count = (label: string, value: number): HTMLElement =>
			el(
				"div",
				{ className: "count" },
				el("span", { className: "count-label" }, label),
				el("strong", {}, String(value)),
			);
		tricksPanel.replaceChildren(
			el(
				"div",
				{ className: "tricks-counts" },
				count(t("Our tricks"), need.ours),
				count(t("Target"), need.target),
				count(t("Opponents'"), need.opponents),
			),
			el(
				"p",
				{
					className: "tricks-needed",
					attrs: {
						"data-status":
							need.status === "open" && need.needed === need.remaining
								? "at-risk"
								: need.status,
					},
				},
				t("Contract needs {needed} / {remaining}", {
					needed: need.needed,
					remaining: need.remaining,
				}),
			),
			...(view.trickStatus
				? [el("p", { className: "tricks-status" }, view.trickStatus)]
				: []),
		);
	}

	function renderMobileTricks(view: TableView): void {
		const need = view.need;
		mobileTricks.hidden = view.phase !== "play" || need === undefined;
		if (mobileTricks.hidden || !need) {
			mobileTricks.replaceChildren();
			return;
		}
		const count = (label: string, value: number): HTMLElement =>
			el(
				"div",
				{ className: "count" },
				el("span", { className: "count-label" }, label),
				el("strong", {}, String(value)),
			);
		mobileTricks.replaceChildren(
			el(
				"div",
				{ className: "tricks-counts" },
				count(t("Our tricks"), need.ours),
				count(t("Target"), need.target),
				count(t("Opponents'"), need.opponents),
			),
		);
	}

	function setForm(form: Form): void {
		desktop = form === "desktop";
		compact = form === "compact";
		placeStatus();
		if (latestView) render(latestView);
	}

	return {
		element,
		sidebar,
		render,
		renderCall,
		setBotControls,
		setPlayerAutoplay,
		setForm,
		setCountdown,
	};
}
