import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallView, RemoteStatus, RemoteView } from "../../src/call/call";
import {
	joinPresets,
	NOT_IN_CALL,
	type Prefs,
	presetById,
} from "../../src/call/policy";
import type { Seat } from "../../src/protocol";
import {
	type CallControlsView,
	callControlsView,
	remoteCallStatus,
} from "../../src/ui/call-model";

// The view holds real tracks from Chrome's test microphone and camera; the model only checks that a track is there.
let devices: MediaStream;
beforeAll(async () => {
	devices = await navigator.mediaDevices.getUserMedia({
		audio: true,
		video: true,
	});
});
afterAll(() => {
	for (const track of devices.getTracks()) track.stop();
});

function track(kind: "audio" | "video"): MediaStreamTrack {
	const [found] =
		kind === "audio" ? devices.getAudioTracks() : devices.getVideoTracks();
	if (found === undefined) throw new Error(`Chrome gave no ${kind} track`);
	return found;
}

const AUDIO_ONLY: Prefs = { inCall: true, ...presetById("audio").switches };

function remote(
	seat: Seat,
	status: RemoteStatus,
	extra: Partial<RemoteView> = {},
): RemoteView {
	return {
		seat,
		status,
		audio: undefined,
		video: undefined,
		peerSendsAudio: true,
		peerSendsVideo: false,
		fault: undefined,
		...extra,
	};
}

/** North's view: by default outside the call, holding its seat, on a desktop. */
function callView(extra: Partial<CallView> = {}): CallView {
	return {
		status: "outside",
		canJoin: true,
		form: "desktop",
		media: ["audio", "video"],
		presets: joinPresets("desktop"),
		requested: NOT_IN_CALL,
		mic: "off",
		camera: "off",
		problem: undefined,
		remotes: [remote("E", "unknown"), remote("S", "unknown")],
		...extra,
	};
}

/** The same on a phone: the controller offers only audio there. */
function compactView(extra: Partial<CallView> = {}): CallView {
	return callView({
		form: "compact",
		media: ["audio"],
		presets: joinPresets("compact"),
		...extra,
	});
}

const BOTH_WAYS: Prefs = { inCall: true, ...presetById("both").switches };
const camera = () => track("video");

function inCall(extra: Partial<CallView> = {}): CallView {
	return callView({
		status: "subscribed",
		canJoin: false,
		requested: AUDIO_ONLY,
		mic: "on",
		...extra,
	});
}

function controls(view: CallView, cameraAvailable?: boolean): CallControlsView {
	return callControlsView({ available: true, view, cameraAvailable });
}

/** The switches as `way medium` → [enabled, pressed]. */
function switchStates(view: CallControlsView) {
	return Object.fromEntries(
		view.switches.map((s) => [`${s.way} ${s.medium}`, [s.enabled, s.pressed]]),
	);
}

describe("call controls (handover §6, §7)", () => {
	it("offers only a disabled panel with the reason when this browser cannot make calls", () => {
		const view = callControlsView({
			available: false,
			reason: "This browser cannot make calls.",
		});
		expect(view.joinEnabled).toBe(false);
		expect(view.note).toBe("This browser cannot make calls.");
		expect(view.switches.every((s) => !s.enabled && !s.pressed)).toBe(true);
		expect(view.switches[0]?.disabledReason).toBe(
			"This browser cannot make calls.",
		);
	});

	it("outside the call the switches are enabled and show what Join starts with", () => {
		const view = controls(
			callView({
				requested: { inCall: false, ...presetById("audio").switches },
			}),
		);
		expect(view.inCall).toBe(false);
		expect(view.joinEnabled).toBe(true);
		expect(view.note).toBe("");
		expect(switchStates(view)).toEqual({
			"send audio": [true, true],
			"receive audio": [true, true],
			"send video": [true, false],
			"receive video": [true, false],
		});
		expect(view.switches.map((s) => s.disabledReason)).toEqual(
			Array(4).fill(undefined),
		);
	});

	it("outside the call Join waits until one switch is on", () => {
		const view = controls(callView());
		expect(view.inCall).toBe(false);
		expect(view.joinEnabled).toBe(false);
		expect(view.switches.every((s) => s.enabled && !s.pressed)).toBe(true);
	});

	it("disables camera sending when no camera exists, but keeps camera receiving available", () => {
		const view = controls(callView(), false);
		expect(view.joinEnabled).toBe(false);
		expect(switchStates(view)).toEqual({
			"send audio": [true, false],
			"receive audio": [true, false],
			"send video": [false, false],
			"receive video": [true, false],
		});
		expect(view.switches[2]?.disabledReason).toBe("No camera is available.");
	});

	it("lets a player turn off a saved video preference when its camera is gone", () => {
		const view = controls(
			callView({ requested: { ...BOTH_WAYS, inCall: false } }),
			false,
		);
		expect(switchStates(view)["send video"]).toEqual([true, true]);
		expect(view.joinEnabled).toBe(true);
	});

	it("keeps the video switches off on a compact device, in the call too, with the device as the reason", () => {
		const view = controls(
			compactView({ status: "subscribed", requested: AUDIO_ONLY, mic: "on" }),
		);
		expect(switchStates(view)).toEqual({
			"send audio": [true, true],
			"receive audio": [true, true],
			"send video": [false, false],
			"receive video": [false, false],
		});
		expect(view.switches.map((s) => s.disabledReason)).toEqual([
			undefined,
			undefined,
			"Video is not available on this device.",
			"Video is not available on this device.",
		]);
	});

	it("shows the camera's actual state beside the requested video switches", () => {
		const view = controls(
			inCall({
				requested: BOTH_WAYS,
				camera: "pending",
				remotes: [
					remote("E", "connected", { video: camera() }),
					remote("S", "connected"),
				],
			}),
		);
		expect(switchStates(view)).toEqual({
			"send audio": [true, true],
			"receive audio": [true, true],
			"send video": [true, true],
			"receive video": [true, true],
		});
		expect(view.switches.map((s) => s.actual)).toEqual([
			"on",
			"off",
			"pending",
			"on",
		]);
		expect(view.note).toBe("Asking for the camera… Connected to East, South.");
	});

	it("a tab without its seat cannot join and shows disabled controls without a warning", () => {
		const view = controls(callView({ canJoin: false }));
		expect(view.joinEnabled).toBe(false);
		expect(view.note).toBe("");
		expect(view.switches.every((item) => !item.enabled)).toBe(true);
		expect(
			view.switches.every((item) => item.disabledReason === undefined),
		).toBe(true);
	});

	it("in the call shows the requested switches next to what actually happens", () => {
		const listening = inCall({
			requested: { inCall: true, ...presetById("listen").switches },
			mic: "off",
			remotes: [remote("E", "connected", { audio: track("audio") })],
		});
		const view = controls(listening);
		expect(view.inCall).toBe(true);
		expect(view.joinEnabled).toBe(true);
		// On a desktop all four switches work in the call; Listen only has three of them off.
		expect(switchStates(view)).toEqual({
			"send audio": [true, false],
			"receive audio": [true, true],
			"send video": [true, false],
			"receive video": [true, false],
		});
		expect(view.switches.map((s) => s.actual)).toEqual([
			"off",
			"on",
			"off",
			"off",
		]);

		const silent = controls(inCall({ remotes: [remote("E", "connected")] }));
		expect(silent.switches[1]?.actual).toBe("off");
	});

	it("names the seat without a connection before any success, and never claims a global success", () => {
		const view = controls(
			inCall({
				remotes: [
					remote("E", "connected"),
					remote("S", "unavailable"),
					remote("W", "reconnecting"),
				],
			}),
		);
		expect(view.note).toBe(
			"No direct connection to South. Connecting to West. Connected to East.",
		);
		const alone = controls(
			inCall({ remotes: [remote("E", "out"), remote("S", "out")] }),
		);
		expect(alone.note).toBe("In the call; waiting for others to join.");
	});

	it("tells the joining and interrupted states apart", () => {
		expect(controls(inCall({ status: "joining" })).note).toBe(
			"Joining the call…",
		);
		expect(controls(inCall({ status: "lost" })).note).toBe(
			"Call messages are interrupted; reconnecting…",
		);
	});

	it("raises an alert for a blocked or missing microphone only while Send mic is on", () => {
		const denied = controls(inCall({ mic: "denied" }));
		expect(denied.alert).toBe(
			"The browser blocks the microphone: others cannot hear you.",
		);
		expect(denied.note.startsWith(denied.alert ?? "")).toBe(true);
		expect(controls(inCall({ mic: "failed" })).alert).toBe(
			"No working microphone: others cannot hear you.",
		);
		expect(controls(inCall({ mic: "pending" })).alert).toBeUndefined();
		const listening = inCall({
			requested: { inCall: true, ...presetById("listen").switches },
			mic: "denied",
		});
		expect(controls(listening).alert).toBeUndefined();
	});

	it("reports a blocked or missing camera only while Send camera is on, and keeps the audio state apart", () => {
		const blocked = controls(
			inCall({ requested: BOTH_WAYS, camera: "denied" }),
		);
		expect(blocked.alert).toBe(
			"The browser blocks the camera: others cannot see you.",
		);
		expect(blocked.note.startsWith(blocked.alert ?? "")).toBe(true);
		expect(blocked.switches.map((s) => s.actual)).toEqual([
			"on",
			"off",
			"denied",
			"off",
		]);
		expect(
			controls(inCall({ requested: BOTH_WAYS, camera: "failed" })).alert,
		).toBe("No working camera: others cannot see you.");
		expect(controls(inCall({ camera: "denied" })).alert).toBeUndefined();
		// The microphone comes first when both are blocked.
		expect(
			controls(
				inCall({ requested: BOTH_WAYS, mic: "denied", camera: "denied" }),
			).alert,
		).toBe("The browser blocks the microphone: others cannot hear you.");
	});

	it("names the Join button after what it does: Join, Leave, or Rejoin with the stored switches", () => {
		const outside = controls(callView());
		expect([outside.joinName, outside.rejoin]).toEqual([
			"Join call",
			undefined,
		]);
		expect(controls(inCall()).joinName).toBe("Leave call");
		const switches = presetById("audio").switches;
		const rejoin = callControlsView({
			available: true,
			view: callView(),
			rejoin: switches,
		});
		expect(rejoin.joinName).toBe("Rejoin the call");
		expect(rejoin.joinEnabled).toBe(true);
		expect(rejoin.rejoin).toEqual(switches);
		expect(rejoin.note).toBe(
			"You were in the call. Rejoin the call starts it again with the same switches.",
		);
		expect(rejoin.alert).toBe(rejoin.note);
	});

	it("offers Rejoin only while this tab can join, and tells a phone user to tap the call button", () => {
		const switches = presetById("audio").switches;
		const phone = callControlsView({
			available: true,
			view: compactView(),
			rejoin: switches,
		});
		expect(phone.alert).toBe(
			"You were in the call. Tap the call button to join again with the same switches.",
		);
		const noSeat = callControlsView({
			available: true,
			view: callView({ canJoin: false }),
			rejoin: switches,
		});
		expect([noSeat.joinName, noSeat.rejoin, noSeat.alert]).toEqual([
			"Join call",
			undefined,
			undefined,
		]);
		const joined = callControlsView({
			available: true,
			view: inCall(),
			rejoin: switches,
		});
		expect([joined.joinName, joined.rejoin]).toEqual(["Leave call", undefined]);
	});
});

describe("remote call status (handover §7)", () => {
	const status = (seat: RemoteView, view: CallView = inCall()) =>
		remoteCallStatus(seat, view);

	it("shows no status while the local user is outside the call", () => {
		expect(status(remote("E", "unknown"), callView())).toEqual({
			text: undefined,
			connected: false,
			retry: false,
		});
	});

	it("names each state, and offers Retry only for a failed connection", () => {
		const texts = (
			["waiting", "out", "connecting", "reconnecting", "unavailable"] as const
		).map((state) => {
			const result = status(remote("E", state));
			return [result.text, result.connected, result.retry];
		});
		expect(texts).toEqual([
			["Waiting", false, false],
			["Not in call", false, false],
			["Connecting", false, false],
			["Reconnecting", false, false],
			["Direct connection unavailable", false, true],
		]);
	});

	it("a connected seat says why no audio arrives", () => {
		expect(status(remote("E", "connected"))).toEqual({
			text: "Audio only",
			connected: true,
			retry: false,
		});
		expect(
			status(remote("E", "connected", { peerSendsAudio: false })).text,
		).toBe("Mic off");
		const deaf = inCall({
			requested: { ...AUDIO_ONLY, receive: { audio: false, video: false } },
		});
		expect(status(remote("E", "connected"), deaf).text).toBe(
			"Audio reception off",
		);
	});

	it("a seat with a picture names only its audio state", () => {
		const watching = inCall({ requested: BOTH_WAYS });
		const seen = { video: camera(), peerSendsVideo: true };
		expect(status(remote("E", "connected", seen), watching).text).toBe(
			"Audio + video",
		);
		expect(
			status(
				remote("E", "connected", { ...seen, peerSendsAudio: false }),
				watching,
			).text,
		).toBe("Mic off");
	});

	it("a seat whose camera this side does not receive says Video reception off", () => {
		const blind = inCall({ requested: AUDIO_ONLY });
		const sender = remote("E", "connected", { peerSendsVideo: true });
		expect(status(sender, blind).text).toBe("Video reception off");
		const deafAndBlind = inCall({
			requested: {
				inCall: true,
				...presetById("camera").switches,
				receive: { audio: false, video: false },
			},
		});
		expect(status(sender, deafAndBlind).text).toBe(
			"Video reception off; audio reception off",
		);
		// A seat without a camera is audio only, whatever this side receives.
		expect(status(remote("E", "connected"), blind).text).toBe("Audio only");
	});

	it("a compact viewer has no video choice, so a camera sender is audio only there", () => {
		const phone = compactView({
			status: "subscribed",
			requested: AUDIO_ONLY,
			mic: "on",
		});
		expect(
			status(remote("E", "connected", { peerSendsVideo: true }), phone).text,
		).toBe("Audio only");
	});
});
