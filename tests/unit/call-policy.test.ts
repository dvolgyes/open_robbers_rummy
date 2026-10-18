import { describe, expect, it } from "vitest";
import type { Form } from "../../src/call/device-class";
import {
	allowed,
	changeForm,
	direction,
	join,
	joinPresets,
	leave,
	MEDIA,
	type Medium,
	mediaPlan,
	NOT_IN_CALL,
	type Party,
	PRESETS,
	type Prefs,
	presetById,
	type Switches,
	samePrefs,
	sendable,
	setSwitch,
} from "../../src/call/policy";

function prefs(
	sendAudio: boolean,
	receiveAudio: boolean,
	sendVideo: boolean,
	receiveVideo: boolean,
	inCall = true,
): Prefs {
	return {
		inCall,
		send: { audio: sendAudio, video: sendVideo },
		receive: { audio: receiveAudio, video: receiveVideo },
	};
}

const ALL_ON = prefs(true, true, true, true);

function party(value: Prefs, form: Form = "desktop"): Party {
	return { prefs: value, form };
}

function flat(value: Switches): [boolean, boolean, boolean, boolean] {
	return [
		value.send.audio,
		value.receive.audio,
		value.send.video,
		value.receive.video,
	];
}

describe("presets", () => {
	// Columns: Send audio, Receive audio, Send video, Receive video (handover §2 table).
	it.each([
		["out", "Not in call", [false, false, false, false]],
		["audio", "Audio only", [true, true, false, false]],
		["camera", "Send camera; hear others", [true, true, true, false]],
		["watch", "See cameras; send voice", [true, true, false, true]],
		["both", "Audio + video both ways", [true, true, true, true]],
		["listen", "Listen only", [false, true, false, false]],
	] as const)("%s maps to the handover switches", (id, label, expected) => {
		const preset = presetById(id);
		expect(preset.label).toBe(label);
		expect(flat(preset.switches)).toEqual(expected);
	});

	it("lists the six presets in the handover order", () => {
		expect(PRESETS.map((p) => p.id)).toEqual([
			"out",
			"audio",
			"camera",
			"watch",
			"both",
			"listen",
		]);
	});

	it("offers only the audio presets on a compact device", () => {
		expect(joinPresets("compact").map((p) => p.label)).toEqual([
			"Audio only",
			"Listen only",
		]);
		expect(joinPresets("desktop").map((p) => p.id)).toEqual([
			"audio",
			"camera",
			"watch",
			"both",
			"listen",
		]);
	});
});

describe("local preference changes", () => {
	it("joins with the selected switches", () => {
		expect(join(presetById("audio").switches, "desktop")).toEqual(
			prefs(true, true, false, false),
		);
	});

	it("treats a Join with every available switch off as staying outside", () => {
		expect(join(presetById("out").switches, "desktop").inCall).toBe(false);
		// Video only on a compact device leaves nothing available.
		expect(join(prefs(false, false, true, true), "compact")).toEqual(
			NOT_IN_CALL,
		);
	});

	it("never keeps a video switch on a compact device, even when the selection asks for it", () => {
		expect(join(presetById("both").switches, "compact")).toEqual(
			prefs(true, true, false, false),
		);
		expect(
			setSwitch(
				prefs(true, true, false, false),
				"compact",
				"send",
				"video",
				true,
			),
		).toEqual(prefs(true, true, false, false));
		expect(
			setSwitch(
				prefs(true, true, false, false),
				"compact",
				"receive",
				"video",
				true,
			),
		).toEqual(prefs(true, true, false, false));
	});

	it("keeps the other switches when the microphone goes off", () => {
		expect(
			setSwitch(
				prefs(true, true, false, false),
				"desktop",
				"send",
				"audio",
				false,
			),
		).toEqual(prefs(false, true, false, false));
	});

	it("keeps outgoing audio when incoming audio goes off", () => {
		expect(
			setSwitch(
				prefs(true, true, false, false),
				"desktop",
				"receive",
				"audio",
				false,
			),
		).toEqual(prefs(true, false, false, false));
	});

	it("leaves the call when the last available switch goes off", () => {
		const result = setSwitch(
			prefs(false, true, false, false),
			"desktop",
			"receive",
			"audio",
			false,
		);
		expect(result.inCall).toBe(false);
	});

	it("does not join when a switch goes on outside the call", () => {
		const result = setSwitch(NOT_IN_CALL, "desktop", "send", "audio", true);
		expect(result.inCall).toBe(false);
		expect(result.send.audio).toBe(true);
	});

	it("leave ends participation and keeps the switches for the next Join", () => {
		expect(leave(ALL_ON)).toEqual(prefs(true, true, true, true, false));
	});

	it("clears both video switches when a desktop becomes compact", () => {
		expect(changeForm(ALL_ON, "compact")).toEqual(
			prefs(true, true, false, false),
		);
	});

	it("leaves the call when a video-only desktop becomes compact", () => {
		expect(changeForm(prefs(false, false, true, true), "compact")).toEqual(
			prefs(false, false, false, false, false),
		);
	});

	it("keeps video off when a compact device becomes desktop again", () => {
		const compact = changeForm(ALL_ON, "compact");
		expect(changeForm(compact, "desktop")).toEqual(
			prefs(true, true, false, false),
		);
	});
});

describe("sendable (handover §2: a denied device disables that outgoing capability)", () => {
	it("announces a denied microphone as Send audio off and keeps the other switches", () => {
		expect(sendable(ALL_ON, ["audio"])).toEqual(prefs(false, true, true, true));
	});

	it("announces the switches unchanged when every device is available", () => {
		expect(sendable(ALL_ON, [])).toEqual(ALL_ON);
	});

	it("never turns a Send switch on, and keeps the call membership", () => {
		const listen = prefs(false, true, false, true);
		expect(sendable(listen, ["audio", "video"])).toEqual(listen);
		expect(sendable(prefs(true, true, true, true, false), ["video"])).toEqual(
			prefs(true, true, false, true, false),
		);
	});
});

describe("samePrefs", () => {
	it("compares the membership and every switch", () => {
		expect(samePrefs(ALL_ON, prefs(true, true, true, true))).toBe(true);
		expect(samePrefs(ALL_ON, leave(ALL_ON))).toBe(false);
		for (const changed of [
			prefs(false, true, true, true),
			prefs(true, false, true, true),
			prefs(true, true, false, true),
			prefs(true, true, true, false),
		])
			expect(samePrefs(ALL_ON, changed)).toBe(false);
	});
});

describe("allowed (handover §3)", () => {
	it("North sends video and South receives video: the picture may reach South", () => {
		const north = party(prefs(true, true, true, false));
		const south = party(prefs(true, true, false, true));
		expect(allowed(north, south, "video")).toBe(true);
	});

	it("East turns receive video off: North's video is not sent to East", () => {
		const north = party(prefs(true, true, true, false));
		const east = party(prefs(true, true, false, false));
		expect(allowed(north, east, "video")).toBe(false);
	});

	it("South turns send video off: no peer can get South's camera", () => {
		const south = party(prefs(true, true, false, true));
		for (const peer of [ALL_ON, prefs(false, false, false, true)]) {
			expect(allowed(south, party(peer), "video")).toBe(false);
		}
	});

	it("West turns receive audio off: no audio is allowed to West from any microphone", () => {
		const west = party(prefs(true, false, false, false));
		expect(allowed(party(ALL_ON), west, "audio")).toBe(false);
		// The reverse direction is decided separately.
		expect(allowed(west, party(ALL_ON), "audio")).toBe(true);
	});

	// Each row changes exactly one conjunct of an otherwise allowed pair (both desktop, every switch on).
	const conjuncts: readonly [string, Party, Party][] = [
		["sender not in call", party({ ...ALL_ON, inCall: false }), party(ALL_ON)],
		[
			"receiver not in call",
			party(ALL_ON),
			party({ ...ALL_ON, inCall: false }),
		],
		["sender switch off", party(prefs(true, true, false, true)), party(ALL_ON)],
		[
			"receiver switch off",
			party(ALL_ON),
			party(prefs(true, true, true, false)),
		],
		["sender compact", party(ALL_ON, "compact"), party(ALL_ON)],
		["receiver compact", party(ALL_ON), party(ALL_ON, "compact")],
	];

	it("allows video for the unchanged pair", () => {
		expect(allowed(party(ALL_ON), party(ALL_ON), "video")).toBe(true);
	});

	it.each(conjuncts)(
		"is false for video when only one conjunct fails: %s",
		(_name, from, to) => {
			expect(allowed(from, to, "video")).toBe(false);
		},
	);

	it("a compact side blocks video either way and leaves audio unchanged", () => {
		const phone = party(ALL_ON, "compact");
		const desktop = party(ALL_ON);
		expect(allowed(desktop, phone, "video")).toBe(false);
		expect(allowed(phone, desktop, "video")).toBe(false);
		expect(allowed(desktop, phone, "audio")).toBe(true);
		expect(allowed(phone, desktop, "audio")).toBe(true);
	});

	it("an unknown peer grants nothing", () => {
		for (const medium of MEDIA) {
			expect(allowed(party(ALL_ON), undefined, medium)).toBe(false);
			expect(allowed(undefined, party(ALL_ON), medium)).toBe(false);
		}
	});
});

describe("direction", () => {
	it.each([
		[true, true, "sendrecv"],
		[true, false, "sendonly"],
		[false, true, "recvonly"],
		[false, false, "inactive"],
	] as const)("send %s, receive %s → %s", (send, receive, expected) => {
		expect(direction(send, receive)).toBe(expected);
	});
});

describe("mediaPlan", () => {
	it("computes each medium and each way separately", () => {
		const local = party(prefs(true, false, false, true));
		const remote = party(prefs(true, true, true, false));
		const plan = mediaPlan(local, remote);
		const expected: Record<Medium, string> = {
			audio: "sendonly",
			video: "recvonly",
		};
		for (const medium of MEDIA) {
			expect(plan[medium].direction).toBe(expected[medium]);
		}
	});

	it("is inactive for every medium before the peer's preferences are known", () => {
		const plan = mediaPlan(party(ALL_ON), undefined);
		expect(plan.audio.direction).toBe("inactive");
		expect(plan.video.direction).toBe("inactive");
	});
});
