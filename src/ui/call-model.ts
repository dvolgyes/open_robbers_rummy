import type { CallView, RemoteView } from "../call/call";
import type { Form } from "../call/device-class";
import type { CaptureState } from "../call/media";
import type { Medium, Switches } from "../call/policy";
import { englishTranslator as english, type Translate } from "../i18n";
import { SEAT_NAMES, type Seat } from "../protocol";

/**
 * The call controls and the call status of each seat as text and flags. Pure, so the
 * rules are unit-tested without a DOM; call-panel.ts and table.ts only copy these values into elements.
 */

/** The call as the room screen sees it: a live view, or the reason why this browser cannot make calls. */
export type CallDisplay =
	| {
			readonly available: true;
			readonly view: CallView;
			/** False only after device enumeration or capture confirms that no camera is available. */
			readonly cameraAvailable?: boolean;
			/**
			 * The stored call status says this person was in the call, but the browser would ask for a device
			 * again: Join becomes "Rejoin the call" with these switches.
			 */
			readonly rejoin?: Switches;
	  }
	| { readonly available: false; readonly reason: string };

export type Way = "send" | "receive";

export interface SwitchView {
	readonly way: Way;
	readonly medium: Medium;
	/** The local user is in the call and the medium is available. */
	readonly enabled: boolean;
	/** The requested switch, for `aria-pressed` and the icon slash. False outside the call. */
	readonly pressed: boolean;
	/** What happens now: the capture state for sending; `on` while remote media plays for receiving. */
	readonly actual: CaptureState;
	/** Why the control does not work, for its tooltip. */
	readonly disabledReason: string | undefined;
}

export interface CallControlsView {
	readonly inCall: boolean;
	/** Join works outside the call, Leave works inside it. */
	readonly joinEnabled: boolean;
	/** The accessible name of the Join buttons. */
	readonly joinName: string;
	/** Rejoin starts the call with these stored switches at once. */
	readonly rejoin: Switches | undefined;
	/** Send audio, receive audio, send video, receive video. */
	readonly switches: readonly SwitchView[];
	/** The state line of the desktop panel. */
	readonly note: string;
	/** A local problem for the temporary message on compact devices. */
	readonly alert: string | undefined;
}

export interface RemoteCallStatus {
	/** Undefined while the local user is outside the call: nobody knows who is in it. */
	readonly text: string | undefined;
	readonly connected: boolean;
	/** The direct connection to this seat failed: offer Retry. */
	readonly retry: boolean;
}

/** A current seat holder's saved call membership and outgoing media switches. */
export interface RemoteCallPresence {
	readonly sendsAudio: boolean;
	readonly sendsVideo: boolean;
}

const SWITCH_ORDER = [
	["send", "audio"],
	["receive", "audio"],
	["send", "video"],
	["receive", "video"],
] as const satisfies readonly (readonly [Way, Medium])[];

const MIC_TEXT: Partial<Record<CaptureState, string>> = {
	pending: "Asking for the microphone…",
	denied: "The browser blocks the microphone: others cannot hear you.",
	failed: "No working microphone: others cannot hear you.",
};

const CAMERA_TEXT: Partial<Record<CaptureState, string>> = {
	pending: "Asking for the camera…",
	denied: "The browser blocks the camera: others cannot see you.",
	failed: "No working camera: others cannot see you.",
};

const REJOIN_TEXT: Record<Form, string> = {
	desktop:
		"You were in the call. Rejoin the call starts it again with the same switches.",
	compact:
		"You were in the call. Tap the call button to join again with the same switches.",
};
const NO_VIDEO_HERE = "Video is not available on this device.";

function names(seats: readonly Seat[]): string {
	return seats.map((seat) => SEAT_NAMES[seat]).join(", ");
}

function actualOf(view: CallView, way: Way, medium: Medium): CaptureState {
	if (way === "send") return medium === "audio" ? view.mic : view.camera;
	return view.remotes.some((remote) => remote[medium] !== undefined)
		? "on"
		: "off";
}

/** A device problem while its Send switch is on: blocked or missing, for the alert. */
function deviceProblem(
	view: CallView,
	medium: Medium,
	t: Translate,
): string | undefined {
	if (!view.requested.inCall || !view.requested.send[medium]) return undefined;
	const state = medium === "audio" ? view.mic : view.camera;
	const texts = medium === "audio" ? MIC_TEXT : CAMERA_TEXT;
	return state === "denied" || state === "failed"
		? t(texts[state] ?? "")
		: undefined;
}

function switchView(
	view: CallView,
	way: Way,
	medium: Medium,
	t: Translate,
	cameraAvailable: boolean | undefined,
): SwitchView {
	const inCall = view.requested.inCall;
	const available = view.media.includes(medium);
	const requested = view.requested[way][medium];
	const cameraMissing =
		way === "send" && medium === "video" && cameraAvailable === false;
	// Outside the call the switches choose what Join starts with, so they work for any seated tab.
	const enabled =
		available && (inCall || view.canJoin) && (!cameraMissing || requested);
	return {
		way,
		medium,
		enabled,
		pressed: enabled && requested,
		actual: inCall ? actualOf(view, way, medium) : "off",
		disabledReason: cameraMissing
			? t("No camera is available.")
			: !enabled && !available
				? t(NO_VIDEO_HERE)
				: undefined,
	};
}

/** Never a global success while one pair has no connection. */
function peersText(remotes: readonly RemoteView[], t: Translate): string {
	const having = (...states: RemoteView["status"][]): Seat[] =>
		remotes
			.filter((remote) => states.includes(remote.status))
			.map((remote) => remote.seat);
	const failed = having("unavailable");
	const connecting = having("connecting", "reconnecting");
	const connected = having("connected");
	const parts = [
		failed.length > 0
			? t("No direct connection to {names}.", { names: names(failed) })
			: "",
		connecting.length > 0
			? t("Connecting to {names}.", { names: names(connecting) })
			: "",
		connected.length > 0
			? t("Connected to {names}.", { names: names(connected) })
			: "",
	].filter((part) => part !== "");
	return parts.length > 0
		? parts.join(" ")
		: t("In the call; waiting for others to join.");
}

function noteOf(view: CallView, t: Translate): string {
	switch (view.status) {
		case "outside":
			return "";
		case "joining":
			return t("Joining the call…");
		case "lost":
			return t("Call messages are interrupted; reconnecting…");
		case "subscribed":
			return [
				MIC_TEXT[view.mic] === undefined ? "" : t(MIC_TEXT[view.mic] as string),
				CAMERA_TEXT[view.camera] === undefined
					? ""
					: t(CAMERA_TEXT[view.camera] as string),
				peersText(view.remotes, t),
			]
				.filter((part) => part !== "")
				.join(" ");
	}
}

export function callControlsView(
	display: CallDisplay,
	t: Translate = english,
): CallControlsView {
	if (!display.available) {
		return {
			inCall: false,
			joinEnabled: false,
			joinName: t("Join call"),
			rejoin: undefined,
			switches: SWITCH_ORDER.map(([way, medium]) => ({
				way,
				medium,
				enabled: false,
				pressed: false,
				actual: "off",
				disabledReason: display.reason,
			})),
			note: t(display.reason),
			alert: undefined,
		};
	}
	const { view } = display;
	const cameraAvailable = display.cameraAvailable;
	const inCall = view.requested.inCall;
	const rejoin = view.canJoin ? display.rejoin : undefined;
	const rejoinText =
		rejoin === undefined ? undefined : t(REJOIN_TEXT[view.form]);
	return {
		inCall,
		// Join needs a switch on, or a stored call to rejoin; with all of them off the user simply stays outside.
		joinEnabled:
			inCall ||
			(view.canJoin &&
				(rejoin !== undefined ||
					view.media.some((medium) =>
						medium === "video" && cameraAvailable === false
							? view.requested.receive.video
							: view.requested.send[medium] || view.requested.receive[medium],
					))),
		joinName: inCall
			? t("Leave call")
			: rejoin === undefined
				? t("Join call")
				: t("Rejoin the call"),
		rejoin,
		switches: SWITCH_ORDER.map(([way, medium]) =>
			switchView(view, way, medium, t, cameraAvailable),
		),
		note: rejoinText ?? noteOf(view, t),
		alert:
			deviceProblem(view, "audio", t) ??
			deviceProblem(view, "video", t) ??
			rejoinText,
	};
}

/**
 * The caption of a connected seat. A playing picture needs no video word, so the caption names
 * the audio state; without a picture it says why: this side's Video reception is off, or the seat is audio only.
 */
function connectedText(
	remote: RemoteView,
	view: CallView,
	t: Translate,
): string {
	const audio = !view.requested.receive.audio
		? t("Audio reception off")
		: !remote.peerSendsAudio
			? t("Mic off")
			: undefined;
	if (remote.video !== undefined) return audio ?? t("Audio + video");
	const videoOff =
		view.media.includes("video") &&
		remote.peerSendsVideo &&
		!view.requested.receive.video;
	if (!videoOff) return audio ?? t("Audio only");
	return audio === undefined
		? t("Video reception off")
		: t("Video reception off; {audio}", { audio: audio.toLowerCase() });
}

export function remoteCallStatus(
	remote: RemoteView,
	view: CallView,
	t: Translate = english,
): RemoteCallStatus {
	const status = (text: string | undefined, retry = false) => ({
		text,
		connected: false,
		retry,
	});
	switch (remote.status) {
		case "unknown":
			return status(undefined);
		case "waiting":
			return status(t("Waiting"));
		case "out":
			return status(t("Not in call"));
		case "connecting":
			return status(t("Connecting"));
		case "reconnecting":
			return status(t("Reconnecting"));
		case "unavailable":
			return status(t("Direct connection unavailable"), true);
		case "connected":
			return {
				text: connectedText(remote, view, t),
				connected: true,
				retry: false,
			};
	}
}
