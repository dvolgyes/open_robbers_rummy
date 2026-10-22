import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallController } from "../../src/call/call";
import type { Form } from "../../src/call/device-class";
import type { CallRoomSnapshot } from "../../src/call/mesh";
import type { CallMessage } from "../../src/call/messages";
import { type Medium, type PresetId, presetById } from "../../src/call/policy";
import type {
	CallSignalingHandlers,
	OpenCallSignaling,
} from "../../src/call/signaling";
import { SEATS, type Seat } from "../../src/protocol";
import { session } from "./call-fakes";
import {
	asConnection,
	asTrack,
	FakePeerConnection,
	FakeTrack,
	fakeStream,
} from "./call-rtc-fakes";
import { ROOM_ID } from "./fixtures";

const SUBSCRIBE_MS = 60;
const DELIVERY_MS = 50;
/** Long enough for one join and one negotiation, shorter than the connect timeout. */
const SETTLE_MS = 2_000;

async function settle(ms = SETTLE_MS): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

interface Sent {
	readonly from: Seat;
	readonly to: Seat | null;
	readonly message: CallMessage;
}

/** Call signaling between the inboxes of one room: every message arrives after DELIVERY_MS, in order. */
class Wire {
	readonly sent: Sent[] = [];
	readonly #inboxes = new Map<Seat, CallSignalingHandlers>();

	readonly open: OpenCallSignaling = (inbox, handlers) => {
		this.#inboxes.set(inbox.seat, handlers);
		setTimeout(() => handlers.onStatus("subscribed"), SUBSCRIBE_MS);
		const send = (to: Seat | null, message: CallMessage): void => {
			this.sent.push({ from: inbox.seat, to, message });
			for (const seat of SEATS) {
				if (seat === inbox.seat || (to !== null && seat !== to)) continue;
				const target = this.#inboxes.get(seat);
				setTimeout(() => {
					if (this.#inboxes.get(seat) !== target) return;
					target?.onEnvelope({
						from: inbox.seat,
						fromGen: inbox.generation,
						message: structuredClone(message),
					});
				}, DELIVERY_MS);
			}
		};
		return {
			send,
			close: async (farewell) => {
				if (farewell !== undefined) send(null, farewell);
				if (this.#inboxes.get(inbox.seat) === handlers) {
					this.#inboxes.delete(inbox.seat);
				}
			},
		};
	};

	/** The database refused this holder: it no longer holds the seat. */
	end(seat: Seat): void {
		this.#inboxes.get(seat)?.onEnd("superseded");
	}

	types(from: Seat): CallMessage["type"][] {
		return this.sent
			.filter((item) => item.from === from)
			.map((item) => item.message.type);
	}

	last(from: Seat, type: CallMessage["type"]): CallMessage | undefined {
		return this.sent
			.filter((item) => item.from === from && item.message.type === type)
			.at(-1)?.message;
	}
}

interface MicRequest {
	readonly constraints: MediaStreamConstraints;
	resolve(stream: MediaStream): void;
	reject(error: unknown): void;
}

class Player {
	readonly connections: FakePeerConnection[] = [];
	readonly requests: MicRequest[] = [];
	readonly changes = vi.fn();
	readonly call: CallController;
	#preparedCamera: FakeTrack | undefined;
	#sessions = 0;

	constructor(
		readonly seat: Seat,
		wire: Wire,
		form: Form = "desktop",
	) {
		this.call = new CallController(
			{
				openSignaling: wire.open,
				getUserMedia: (constraints) =>
					new Promise((resolve, reject) => {
						this.requests.push({ constraints, resolve, reject });
					}),
				createConnection: () => {
					const pc = new FakePeerConnection();
					this.connections.push(pc);
					return asConnection(pc);
				},
				newSession: () => session(++this.#sessions),
			},
			form,
		);
		this.call.onChange(this.changes);
	}

	remote(seat: Seat) {
		return this.call.view.remotes.find((remote) => remote.seat === seat);
	}

	/** Confirms Join with the switches of one preset. */
	join(preset: PresetId): void {
		if (
			presetById(preset).switches.send.video &&
			this.call.view.form === "desktop"
		)
			this.prepareCamera();
		this.call.join(presetById(preset).switches);
	}

	/** Models a camera track that the player saw and confirmed in the local preview. */
	prepareCamera(): FakeTrack {
		const track = new FakeTrack("video");
		if (!this.call.prepareVideo(asTrack(track))) {
			throw new Error("Could not prepare the test camera");
		}
		this.#preparedCamera = track;
		return track;
	}

	get preparedCamera(): FakeTrack | undefined {
		return this.#preparedCamera;
	}

	/** The capture requests of one device. */
	asked(medium: Medium): MicRequest[] {
		return this.requests.filter(
			(request) =>
				(request.constraints.video !== false) === (medium === "video"),
		);
	}

	/** Gives the last request of the device a live track. */
	grant(medium: Medium = "audio"): FakeTrack {
		const track = new FakeTrack(medium);
		this.asked(medium).at(-1)?.resolve(fakeStream(track));
		return track;
	}

	/** The sending track of the one audio section of the open connection. */
	get sending(): MediaStreamTrack | null | undefined {
		return this.open?.getTransceivers()[0]?.sender.track;
	}

	/** The section kinds of the open connection, in order. */
	get sections(): string[] | undefined {
		return this.open?.getTransceivers().map((t) => t.receiver.track.kind);
	}

	/** The sending track of the open connection's video section, if it has one. */
	get sendingVideo(): MediaStreamTrack | null | undefined {
		return this.open
			?.getTransceivers()
			.find((t) => t.receiver.track.kind === "video")?.sender.track;
	}

	get open(): FakePeerConnection | undefined {
		return this.connections.find((pc) => !pc.closed);
	}
}

/** Both seats held at generation 1 and present. */
function snapshot(self: Seat | null): CallRoomSnapshot {
	return {
		roomId: ROOM_ID,
		self: self === null ? null : { seat: self, generation: 1 },
		holders: { N: 1, E: 1 },
		online: new Set<Seat>(["N", "E"]),
	};
}

let wire: Wire;
let north: Player;
let east: Player;

/** Joins both seats and lets ICE connect. */
async function connected(
	northPreset: PresetId = "audio",
	eastPreset: PresetId = "audio",
): Promise<void> {
	north.join(northPreset);
	east.join(eastPreset);
	await settle();
	for (const player of [north, east]) player.open?.setConnection("connected");
}

beforeEach(() => {
	vi.useFakeTimers();
	wire = new Wire();
	north = new Player("N", wire);
	east = new Player("E", wire);
	north.call.update(snapshot("N"));
	east.call.update(snapshot("E"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CallController (call/layout plan §4.5)", () => {
	it("starts outside the call, with the other seats unknown, and offers every desktop preset", () => {
		const view = north.call.view;
		expect(view.status).toBe("outside");
		expect(view.canJoin).toBe(true);
		expect(view.requested.inCall).toBe(false);
		expect(view.requested).toMatchObject({
			send: { audio: true, video: false },
			receive: { audio: true, video: true },
		});
		expect([view.mic, view.camera]).toEqual(["off", "off"]);
		expect(view.media).toEqual(["audio", "video"]);
		expect(view.presets.map((preset) => preset.id)).toEqual([
			"audio",
			"camera",
			"watch",
			"both",
			"listen",
		]);
		expect(view.remotes.map((r) => [r.seat, r.status])).toEqual([
			["E", "unknown"],
			["S", "unknown"],
			["W", "unknown"],
		]);

		north.call.setForm("compact");
		expect(north.call.view.media).toEqual(["audio"]);
		expect(north.call.view.presets.map((preset) => preset.id)).toEqual([
			"audio",
			"listen",
		]);
	});

	it("does not send video until a preview track is explicitly prepared", () => {
		north.call.join({
			send: { audio: false, video: true },
			receive: { audio: false, video: true },
		});
		expect(north.call.view.status).toBe("joining");
		expect(north.asked("video")).toEqual([]);
		expect(north.call.view.requested.send.video).toBe(false);
		expect(north.call.view.camera).toBe("off");
		const camera = north.prepareCamera();
		north.call.setSwitch("send", "video", true);
		expect(north.asked("video")).toEqual([]);
		expect(north.call.view.camera).toBe("on");
		expect(north.call.view.requested.send.video).toBe(true);
		north.call.setSwitch("send", "video", false);
		expect(camera.stops).toBe(1);
	});

	it("never asks a compact device for the camera: not for restored video switches, not for a video switch", async () => {
		north.call.dispose();
		north = new Player("N", wire, "compact");
		north.call.update(snapshot("N"));
		// The switches of a desktop session, as a restored preference would give them.
		north.join("both");
		expect(north.call.view.requested).toEqual({
			inCall: true,
			...presetById("audio").switches,
		});
		north.call.setSwitch("send", "video", true);
		north.call.setSwitch("receive", "video", true);
		east.join("both");
		await settle();
		expect(north.asked("video")).toEqual([]);
		expect(north.call.view.requested.send.video).toBe(false);
		// Audio only on both sides of the pair: neither side has a video section.
		expect(north.sections).toEqual(["audio"]);
		expect(east.sections).toEqual(["audio"]);
		expect(east.remote("N")?.peerSendsVideo).toBe(false);
	});

	it("accepts the confirmed camera when Send camera was turned on before Join", async () => {
		north.call.setSwitch("send", "video", true);
		north.call.setSwitch("receive", "video", true);
		expect(north.call.view.requested.inCall).toBe(false);
		const camera = north.prepareCamera();
		north.call.join(presetById("both").switches);
		east.join("both");
		await settle();
		for (const player of [north, east]) player.open?.setConnection("connected");
		north.grant("audio");
		await settle(10);
		expect(north.call.view.requested.send.video).toBe(true);
		expect(north.call.view.camera).toBe("on");
		expect(north.sendingVideo).toBe(asTrack(camera));
	});

	it("sends the camera to a desktop that receives video, and stops it at once on Send camera off", async () => {
		await connected("both", "both");
		const mic = north.grant("audio");
		const camera = north.preparedCamera;
		expect(camera).toBeDefined();
		await settle(10);
		expect(north.call.view.camera).toBe("on");
		expect(north.sendingVideo).toBe(asTrack(camera as FakeTrack));
		expect(east.remote("N")?.video).toBeDefined();
		expect(east.remote("N")?.peerSendsVideo).toBe(true);

		north.call.setSwitch("send", "video", false);
		expect(camera?.stops).toBe(1);
		expect(mic.stops).toBe(0);
		expect(north.call.view.camera).toBe("off");
		await settle(1);
		expect(north.sendingVideo).toBeNull();
		// The peer clears the picture when the new prefs arrive; its audio stays.
		await settle();
		expect(east.remote("N")?.peerSendsVideo).toBe(false);
		expect(east.remote("N")?.video).toBeUndefined();
		expect(east.remote("N")?.audio).toBeDefined();
	});

	it("clears the picture at once when See cameras goes off", async () => {
		await connected("both", "both");
		await settle(10);
		expect(east.remote("N")?.video).toBeDefined();
		east.call.setSwitch("receive", "video", false);
		expect(east.remote("N")?.video).toBeUndefined();
		expect(east.remote("N")?.audio).toBeDefined();
		expect(east.call.view.status).toBe("subscribed");
	});

	it("stops the camera at once when a desktop call becomes compact, keeps audio, and does not restore video after", async () => {
		await connected("both", "both");
		const mic = north.grant("audio");
		const camera = north.preparedCamera;
		await settle(10);
		north.call.setForm("compact");
		expect(camera?.stops).toBe(1);
		expect(mic.stops).toBe(0);
		expect(north.call.view.requested).toEqual({
			inCall: true,
			...presetById("audio").switches,
		});
		expect(north.remote("E")?.video).toBeUndefined();
		await settle();
		expect(north.sendingVideo).toBeNull();
		expect(east.remote("N")?.video).toBeUndefined();
		expect(east.remote("N")?.audio).toBeDefined();
		const video = (pc: FakePeerConnection | undefined) =>
			pc?.getTransceivers().find((t) => t.receiver.track.kind === "video");
		expect(video(north.open)?.currentDirection).toBe("inactive");
		expect(video(east.open)?.currentDirection).toBe("inactive");

		north.call.setForm("desktop");
		await settle();
		expect(north.call.view.requested.send.video).toBe(false);
		expect(north.call.view.requested.receive.video).toBe(false);
		expect(north.asked("video")).toHaveLength(0);
	});

	it("keeps audio when the user cancels the camera preview", async () => {
		await connected("audio", "both");
		const mic = north.grant("audio");
		north.call.setSwitch("send", "video", true);
		await settle(10);
		expect([north.call.view.mic, north.call.view.camera]).toEqual([
			"on",
			"off",
		]);
		expect(north.call.view.requested.send.video).toBe(false);
		expect(north.asked("video")).toEqual([]);
		expect(north.sending).toBe(asTrack(mic));
		expect(north.sendingVideo ?? null).toBeNull();
		expect(east.remote("N")?.audio).toBeDefined();
	});

	it("asks for the microphone only after Join, and never for Listen only", async () => {
		north.join("audio");
		east.join("listen");
		expect(north.requests.map((r) => r.constraints)).toEqual([
			{ audio: true, video: false },
		]);
		expect(east.requests).toEqual([]);
		expect(north.call.view.mic).toBe("pending");
		expect(east.call.view.mic).toBe("off");
		expect(north.remote("E")?.status).toBe("waiting");
		await settle();
		expect(north.remote("S")?.status).toBe("out");
		expect(north.remote("E")?.status).toBe("connecting");
		expect(east.remote("N")?.peerSendsAudio).toBe(true);
	});

	it("sends a microphone captured after the link exists, and gives a new link the live microphone", async () => {
		await connected();
		expect(north.sending).toBeNull();
		const mic = north.grant();
		await settle(10);
		expect(north.call.view.mic).toBe("on");
		expect(north.sending).toBe(asTrack(mic));

		const south = new Player("S", wire);
		const three = (self: Seat): CallRoomSnapshot => ({
			...snapshot(self),
			holders: { N: 1, E: 1, S: 1 },
			online: new Set<Seat>(["N", "E", "S"]),
		});
		north.call.update(three("N"));
		east.call.update(three("E"));
		south.call.update(three("S"));
		south.join("listen");
		await settle();
		const toSouth = north.connections.at(-1);
		expect(north.connections).toHaveLength(2);
		expect(toSouth?.getTransceivers()[0]?.sender.track).toBe(asTrack(mic));
	});

	it("stops the microphone at once when Send mic goes off, then tells the peers", async () => {
		await connected();
		const mic = north.grant();
		await settle(10);
		north.call.setSwitch("send", "audio", false);
		expect(mic.stops).toBe(1);
		expect(north.call.view.mic).toBe("off");
		expect(north.call.view.status).toBe("subscribed");
		await settle();
		const prefs = wire.last("N", "prefs");
		expect(prefs?.type === "prefs" && prefs.prefs.send.audio).toBe(false);
		expect(north.sending).toBeNull();
		expect(east.remote("N")?.peerSendsAudio).toBe(false);
	});

	it("detaches remote audio at once when Hear others goes off", async () => {
		await connected();
		expect(east.remote("N")?.status).toBe("connected");
		expect(east.remote("N")?.audio).toBeDefined();
		east.call.setSwitch("receive", "audio", false);
		expect(east.remote("N")?.audio).toBeUndefined();
		expect(east.call.view.status).toBe("subscribed");
	});

	it("leaves the call when the last switch goes off, and when the seat is lost", async () => {
		await connected("listen", "audio");
		north.call.setSwitch("receive", "audio", false);
		expect(north.call.view.status).toBe("outside");
		expect(north.call.view.requested.inCall).toBe(false);
		expect(north.connections.every((pc) => pc.closed)).toBe(true);
		await settle();
		expect(wire.types("N").at(-1)).toBe("leave");
		expect(east.remote("N")?.status).toBe("out");

		const mic = east.grant();
		await settle(10);
		east.call.update(snapshot(null));
		expect(east.call.view.status).toBe("outside");
		expect(east.call.view.canJoin).toBe(false);
		expect(mic.stops).toBe(1);
		east.join("audio");
		expect(east.call.view.status).toBe("outside");
	});

	it("ends the call when signaling ends, and stops the microphone", async () => {
		await connected();
		const mic = north.grant();
		await settle(10);
		wire.end("N");
		expect(north.call.view.status).toBe("outside");
		expect(north.call.view.requested.inCall).toBe(false);
		expect(mic.stops).toBe(1);
		expect(north.connections.every((pc) => pc.closed)).toBe(true);
	});

	it("stays in the call with a refused microphone", async () => {
		north.join("audio");
		north.requests[0]?.reject(new DOMException("no", "NotAllowedError"));
		await settle();
		expect(north.call.view.mic).toBe("denied");
		expect(north.call.view.status).toBe("subscribed");
		expect(north.call.view.requested.send.audio).toBe(true);
	});

	it("announces a device class change in the call, and only re-renders outside it", async () => {
		north.changes.mockClear();
		north.call.setForm("compact");
		expect(north.changes).toHaveBeenCalledTimes(1);
		expect(wire.sent).toEqual([]);
		expect(north.call.view.form).toBe("compact");

		await connected();
		north.call.setForm("desktop");
		await settle();
		const prefs = wire.last("N", "prefs");
		expect(prefs?.type === "prefs" && prefs.form).toBe("desktop");
		expect(north.call.view.status).toBe("subscribed");
	});

	it("dispose leaves, closes the links and stops notifying", async () => {
		await connected();
		const mic = north.grant();
		await settle(10);
		north.changes.mockClear();
		north.call.dispose();
		expect(mic.stops).toBe(1);
		expect(north.connections.every((pc) => pc.closed)).toBe(true);
		expect(north.changes).not.toHaveBeenCalled();
		await settle();
		expect(wire.types("N").at(-1)).toBe("leave");
	});
});
