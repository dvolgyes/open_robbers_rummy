import type { Medium, Switches } from "../call/policy";
import { englishTranslator, type Translate } from "../i18n";
import { SEAT_NAMES, type Seat } from "../protocol";
import {
	type CallControlsView,
	type CallDisplay,
	callControlsView,
	remoteCallStatus,
	type SwitchView,
	type Way,
} from "./call-model";
import { button, el } from "./dom";
import { type IconName, icon } from "./icons";

/**
 * The local call controls (handover §2, §6, §7): a panel at the bottom-left of the desktop table, and one icon row on
 * compact devices. The switches are the choice that Join starts the call with, so Join needs no second step. The
 * stylesheet shows the copy that fits the device class, so each control has one accessible name in both forms. The
 * controls only call the handlers; the call controller owns every rule.
 */

export interface CallHandlers {
	/** The local user confirmed Join with these switches. */
	join(selection: Switches): void;
	leave(): void;
	setSwitch(way: Way, medium: Medium, on: boolean): void;
	retry(seat: Seat): void;
}

export interface CallControls {
	/** Desktop: the panel at the bottom-left of the table. */
	readonly panel: HTMLElement;
	/** Compact: a temporary message about a local problem, above the icon row. */
	readonly alert: HTMLElement;
	/** Compact: the one row of call icons and game actions. */
	readonly row: HTMLElement;
	render(display: CallDisplay): void;
}

interface Toggle {
	readonly way: Way;
	readonly medium: Medium;
	readonly icon: IconName;
	/** Short visible text on the desktop panel and in the chooser. */
	readonly label: string;
	/** Spells out the way and the medium; starts with the visible text. */
	readonly name: string;
}

const SEND_AUDIO: Toggle = {
	way: "send",
	medium: "audio",
	icon: "mic",
	label: "Send mic",
	name: "Send mic audio",
};
const RECEIVE_AUDIO: Toggle = {
	way: "receive",
	medium: "audio",
	icon: "speaker",
	label: "Hear others",
	name: "Hear others: receive audio",
};
const SEND_VIDEO: Toggle = {
	way: "send",
	medium: "video",
	icon: "camera",
	label: "Send camera",
	name: "Send camera video",
};
const RECEIVE_VIDEO: Toggle = {
	way: "receive",
	medium: "video",
	icon: "eye",
	label: "See cameras",
	name: "See cameras: receive video",
};
const TOGGLES = [SEND_AUDIO, RECEIVE_AUDIO, SEND_VIDEO, RECEIVE_VIDEO] as const;

/** How long the compact message about a local problem stays. */
const ALERT_MS = 6_000;

interface ToggleNode {
	readonly toggle: Toggle;
	readonly node: HTMLButtonElement;
	readonly withLabel: boolean;
}

/** The icon is the first child; replacing it keeps the focus on the button. */
function setIcon(node: HTMLElement, name: IconName, off: boolean): void {
	const next = icon(name, off);
	const current = node.firstElementChild;
	if (current === null) node.prepend(next);
	else current.replaceWith(next);
}

function setTitle(node: HTMLElement, title: string): void {
	if (title === "") node.removeAttribute("title");
	else node.title = title;
}

/** The switches that are pressed now: what Join starts the call with. */
function pressedSwitches(switches: readonly SwitchView[]): Switches {
	const on = (way: Way, medium: Medium): boolean =>
		switches.some((s) => s.way === way && s.medium === medium && s.pressed);
	return {
		send: { audio: on("send", "audio"), video: on("send", "video") },
		receive: { audio: on("receive", "audio"), video: on("receive", "video") },
	};
}

export function callControls(
	handlers: CallHandlers,
	gameActions: readonly HTMLElement[],
	t: Translate = englishTranslator,
): CallControls {
	const toggles: ToggleNode[] = [];
	const joins: HTMLButtonElement[] = [];
	let last: CallControlsView | undefined;
	let display: CallDisplay | undefined;
	let shownAlert: string | undefined;
	let alertTimer: ReturnType<typeof setTimeout> | undefined;

	function toggleButton(toggle: Toggle, withLabel: boolean): HTMLButtonElement {
		const node = el("button", {
			className: "call-toggle",
			attrs: {
				type: "button",
				"aria-label": t(toggle.name),
				"aria-pressed": "false",
				"data-way": toggle.way,
				"data-medium": toggle.medium,
			},
		});
		setIcon(node, toggle.icon, true);
		if (withLabel) node.append(el("span", {}, t(toggle.label)));
		node.disabled = true;
		node.addEventListener("click", () =>
			handlers.setSwitch(
				toggle.way,
				toggle.medium,
				node.getAttribute("aria-pressed") !== "true",
			),
		);
		toggles.push({ toggle, node, withLabel });
		return node;
	}

	function joinButton(withLabel: boolean): HTMLButtonElement {
		const node = el("button", {
			className: "call-join",
			attrs: { type: "button", "aria-label": t("Join call") },
		});
		setIcon(node, "phone", false);
		if (withLabel) node.append(el("span", {}, t("Join call")));
		node.disabled = true;
		node.addEventListener("click", () => {
			if (last?.inCall) handlers.leave();
			else if (last?.rejoin !== undefined) handlers.join(last.rejoin);
			else if (last !== undefined)
				handlers.join(pressedSwitches(last.switches));
		});
		joins.push(node);
		return node;
	}

	const note = el("p", {
		className: "note visually-hidden",
		attrs: { role: "status", "data-testid": "call-note" },
	});
	const retries = el("div", { className: "call-retries" });
	const panel = el(
		"section",
		{
			className: "call-panel",
			attrs: { "aria-label": t("Room call"), "data-testid": "call-panel" },
		},
		el("h4", {}, t("Optional"), el("br", {}), t("room call")),
		joinButton(true),
		el(
			"div",
			{ className: "call-switches" },
			...TOGGLES.map((toggle) => toggleButton(toggle, true)),
		),
		note,
		retries,
	);

	const alert = el("p", {
		className: "call-alert visually-hidden",
		attrs: { role: "status", "data-testid": "call-alert" },
	});
	alert.hidden = true;

	const row = el(
		"div",
		{ className: "icon-row", attrs: { "data-testid": "call-row" } },
		el(
			"div",
			{
				className: "icon-group",
				attrs: { role: "group", "aria-label": t("Room call") },
			},
			joinButton(false),
			// Compact devices are audio only: no camera controls.
			toggleButton(SEND_AUDIO, false),
			toggleButton(RECEIVE_AUDIO, false),
		),
		el("span", {
			className: "icon-separator",
			attrs: { "aria-hidden": "true" },
		}),
		el(
			"div",
			{
				className: "icon-group game-group",
				attrs: { role: "group", "aria-label": t("Game actions") },
			},
			...gameActions,
		),
	);

	function renderJoins(): void {
		const view = last;
		if (view === undefined) return;
		const name = view.joinName;
		for (const node of joins) {
			node.disabled = !view.joinEnabled;
			node.setAttribute("aria-label", name);
			node.dataset.inCall = String(view.inCall);
			setTitle(node, view.joinEnabled ? name : view.note);
			const label = node.querySelector("span");
			if (label !== null) label.textContent = name;
		}
	}

	function renderToggle(item: ToggleNode, view: SwitchView): void {
		const { node, toggle, withLabel } = item;
		node.disabled = !view.enabled;
		node.setAttribute("aria-pressed", String(view.pressed));
		node.dataset.actual = view.actual;
		const reason = view.disabledReason;
		setTitle(
			node,
			reason === undefined
				? withLabel
					? ""
					: t(toggle.name)
				: withLabel
					? t(reason)
					: `${t(toggle.name)}. ${t(reason)}`,
		);
		setIcon(node, toggle.icon, !view.pressed);
	}

	/** Desktop: one Retry per seat whose direct connection failed (handover §4, §6). */
	function renderRetries(): void {
		const view = display?.available ? display.view : undefined;
		const failed =
			view?.remotes.filter(
				(remote) => remoteCallStatus(remote, view, t).retry,
			) ?? [];
		const key = failed.map((remote) => remote.seat).join("");
		if (retries.dataset.seats === key) return;
		retries.dataset.seats = key;
		retries.replaceChildren(
			...failed.map((remote) => retryButton(remote.seat, handlers, true, t)),
		);
	}

	/** Compact: the message appears when a problem starts and goes away after ALERT_MS. */
	function renderAlert(text: string | undefined): void {
		if (text === shownAlert) return;
		shownAlert = text;
		clearTimeout(alertTimer);
		alert.textContent = text ?? "";
		alert.hidden = text === undefined;
		if (text !== undefined) {
			alertTimer = setTimeout(() => {
				alert.hidden = true;
			}, ALERT_MS);
		}
	}

	function render(next: CallDisplay): void {
		display = next;
		const view = callControlsView(next, t);
		last = view;
		panel.dataset.status = next.available ? next.view.status : "unavailable";
		for (const item of toggles) {
			const state = view.switches.find(
				(s) => s.way === item.toggle.way && s.medium === item.toggle.medium,
			);
			if (state !== undefined) renderToggle(item, state);
		}
		renderJoins();
		note.textContent = t(view.note);
		renderRetries();
		renderAlert(view.alert === undefined ? undefined : t(view.alert));
	}

	return { panel, alert, row, render };
}

/**
 * Asks for a new connection attempt to one seat. Only local: it never changes the other player's call. The panel
 * names the seat; the compact seat label already does.
 */
export function retryButton(
	seat: Seat,
	handlers: CallHandlers,
	inPanel: boolean,
	t: Translate = (message) => message,
): HTMLButtonElement {
	const name = SEAT_NAMES[seat];
	return button(
		inPanel ? t("Retry {name}", { name }) : t("Retry"),
		() => handlers.retry(seat),
		{
			className: "call-retry",
			attrs: {
				"aria-label": t("Retry call connection to {name}", { name }),
				"data-testid": `${inPanel ? "call" : "seat"}-retry-${seat}`,
			},
		},
	);
}
