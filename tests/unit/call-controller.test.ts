import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallController } from "../../src/call/call";
import type { Form } from "../../src/call/device-class";
import type { CallTableSnapshot } from "../../src/call/mesh";
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
import { TABLE_ID } from "./fixtures";

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

/** Call signaling between the inboxes of one table: every message arrives after DELIVERY_MS, in order. */
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

/** A four-player table; seats 1 and 2 are held at generation 1 and present. */
function snapshot(self: Seat | null): CallTableSnapshot {
	return {
		tableId: TABLE_ID,
		self: self === null ? null : { seat: self, generation: 1 },
		seats: ["1", "2", "3", "4"],
		holders: { "1": 1, "2": 1 },
		online: new Set<Seat>(["1", "2"]),
	};
}

let wire: Wire;
let player1: Player;
let player2: Player;

/** Joins both seats and lets ICE connect. */
async function connected(
	player1Preset: PresetId = "audio",
	player2Preset: PresetId = "audio",
): Promise<void> {
	player1.join(player1Preset);
	player2.join(player2Preset);
	await settle();
	for (const player of [player1, player2])
		player.open?.setConnection("connected");
}

beforeEach(() => {
	vi.useFakeTimers();
	wire = new Wire();
	player1 = new Player("1", wire);
	player2 = new Player("2", wire);
	player1.call.update(snapshot("1"));
	player2.call.update(snapshot("2"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CallController", () => {
	it("starts outside the call, with the other seats unknown, and offers every desktop preset", () => {
		const view = player1.call.view;
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
			["2", "unknown"],
			["3", "unknown"],
			["4", "unknown"],
		]);

		player1.call.setForm("compact");
		expect(player1.call.view.media).toEqual(["audio"]);
		expect(player1.call.view.presets.map((preset) => preset.id)).toEqual([
			"audio",
			"listen",
		]);
	});

	it("does not send video until a preview track is explicitly prepared", () => {
		player1.call.join({
			send: { audio: false, video: true },
			receive: { audio: false, video: true },
		});
		expect(player1.call.view.status).toBe("joining");
		expect(player1.asked("video")).toEqual([]);
		expect(player1.call.view.requested.send.video).toBe(false);
		expect(player1.call.view.camera).toBe("off");
		const camera = player1.prepareCamera();
		player1.call.setSwitch("send", "video", true);
		expect(player1.asked("video")).toEqual([]);
		expect(player1.call.view.camera).toBe("on");
		expect(player1.call.view.requested.send.video).toBe(true);
		player1.call.setSwitch("send", "video", false);
		expect(camera.stops).toBe(1);
	});

	it("never asks a compact device for the camera: not for restored video switches, not for a video switch", async () => {
		player1.call.dispose();
		player1 = new Player("1", wire, "compact");
		player1.call.update(snapshot("1"));
		// The switches of a desktop session, as a restored preference would give them.
		player1.join("both");
		expect(player1.call.view.requested).toEqual({
			inCall: true,
			...presetById("audio").switches,
		});
		player1.call.setSwitch("send", "video", true);
		player1.call.setSwitch("receive", "video", true);
		player2.join("both");
		await settle();
		expect(player1.asked("video")).toEqual([]);
		expect(player1.call.view.requested.send.video).toBe(false);
		// Audio only on both sides of the pair: neither side has a video section.
		expect(player1.sections).toEqual(["audio"]);
		expect(player2.sections).toEqual(["audio"]);
		expect(player2.remote("1")?.peerSendsVideo).toBe(false);
	});

	it("accepts the confirmed camera when Send camera was turned on before Join", async () => {
		player1.call.setSwitch("send", "video", true);
		player1.call.setSwitch("receive", "video", true);
		expect(player1.call.view.requested.inCall).toBe(false);
		const camera = player1.prepareCamera();
		player1.call.join(presetById("both").switches);
		player2.join("both");
		await settle();
		for (const player of [player1, player2])
			player.open?.setConnection("connected");
		player1.grant("audio");
		await settle(10);
		expect(player1.call.view.requested.send.video).toBe(true);
		expect(player1.call.view.camera).toBe("on");
		expect(player1.sendingVideo).toBe(asTrack(camera));
	});

	it("sends the camera to a desktop that receives video, and stops it at once on Send camera off", async () => {
		await connected("both", "both");
		const mic = player1.grant("audio");
		const camera = player1.preparedCamera;
		expect(camera).toBeDefined();
		await settle(10);
		expect(player1.call.view.camera).toBe("on");
		expect(player1.sendingVideo).toBe(asTrack(camera as FakeTrack));
		expect(player2.remote("1")?.video).toBeDefined();
		expect(player2.remote("1")?.peerSendsVideo).toBe(true);

		player1.call.setSwitch("send", "video", false);
		expect(camera?.stops).toBe(1);
		expect(mic.stops).toBe(0);
		expect(player1.call.view.camera).toBe("off");
		await settle(1);
		expect(player1.sendingVideo).toBeNull();
		// The peer clears the picture when the new prefs arrive; its audio stays.
		await settle();
		expect(player2.remote("1")?.peerSendsVideo).toBe(false);
		expect(player2.remote("1")?.video).toBeUndefined();
		expect(player2.remote("1")?.audio).toBeDefined();
	});

	it("clears the picture at once when See cameras goes off", async () => {
		await connected("both", "both");
		await settle(10);
		expect(player2.remote("1")?.video).toBeDefined();
		player2.call.setSwitch("receive", "video", false);
		expect(player2.remote("1")?.video).toBeUndefined();
		expect(player2.remote("1")?.audio).toBeDefined();
		expect(player2.call.view.status).toBe("subscribed");
	});

	it("stops the camera at once when a desktop call becomes compact, keeps audio, and does not restore video after", async () => {
		await connected("both", "both");
		const mic = player1.grant("audio");
		const camera = player1.preparedCamera;
		await settle(10);
		player1.call.setForm("compact");
		expect(camera?.stops).toBe(1);
		expect(mic.stops).toBe(0);
		expect(player1.call.view.requested).toEqual({
			inCall: true,
			...presetById("audio").switches,
		});
		expect(player1.remote("2")?.video).toBeUndefined();
		await settle();
		expect(player1.sendingVideo).toBeNull();
		expect(player2.remote("1")?.video).toBeUndefined();
		expect(player2.remote("1")?.audio).toBeDefined();
		const video = (pc: FakePeerConnection | undefined) =>
			pc?.getTransceivers().find((t) => t.receiver.track.kind === "video");
		expect(video(player1.open)?.currentDirection).toBe("inactive");
		expect(video(player2.open)?.currentDirection).toBe("inactive");

		player1.call.setForm("desktop");
		await settle();
		expect(player1.call.view.requested.send.video).toBe(false);
		expect(player1.call.view.requested.receive.video).toBe(false);
		expect(player1.asked("video")).toHaveLength(0);
	});

	it("keeps audio when the user cancels the camera preview", async () => {
		await connected("audio", "both");
		const mic = player1.grant("audio");
		player1.call.setSwitch("send", "video", true);
		await settle(10);
		expect([player1.call.view.mic, player1.call.view.camera]).toEqual([
			"on",
			"off",
		]);
		expect(player1.call.view.requested.send.video).toBe(false);
		expect(player1.asked("video")).toEqual([]);
		expect(player1.sending).toBe(asTrack(mic));
		expect(player1.sendingVideo ?? null).toBeNull();
		expect(player2.remote("1")?.audio).toBeDefined();
	});

	it("asks for the microphone only after Join, and never for Listen only", async () => {
		player1.join("audio");
		player2.join("listen");
		expect(player1.requests.map((r) => r.constraints)).toEqual([
			{ audio: true, video: false },
		]);
		expect(player2.requests).toEqual([]);
		expect(player1.call.view.mic).toBe("pending");
		expect(player2.call.view.mic).toBe("off");
		expect(player1.remote("2")?.status).toBe("waiting");
		await settle();
		expect(player1.remote("3")?.status).toBe("out");
		expect(player1.remote("2")?.status).toBe("connecting");
		expect(player2.remote("1")?.peerSendsAudio).toBe(true);
	});

	it("sends a microphone captured after the link exists, and gives a new link the live microphone", async () => {
		await connected();
		expect(player1.sending).toBeNull();
		const mic = player1.grant();
		await settle(10);
		expect(player1.call.view.mic).toBe("on");
		expect(player1.sending).toBe(asTrack(mic));

		const player3 = new Player("3", wire);
		const three = (self: Seat): CallTableSnapshot => ({
			...snapshot(self),
			holders: { "1": 1, "2": 1, "3": 1 },
			online: new Set<Seat>(["1", "2", "3"]),
		});
		player1.call.update(three("1"));
		player2.call.update(three("2"));
		player3.call.update(three("3"));
		player3.join("listen");
		await settle();
		const toPlayer3 = player1.connections.at(-1);
		expect(player1.connections).toHaveLength(2);
		expect(toPlayer3?.getTransceivers()[0]?.sender.track).toBe(asTrack(mic));
	});

	it("stops the microphone at once when Send mic goes off, then tells the peers", async () => {
		await connected();
		const mic = player1.grant();
		await settle(10);
		player1.call.setSwitch("send", "audio", false);
		expect(mic.stops).toBe(1);
		expect(player1.call.view.mic).toBe("off");
		expect(player1.call.view.status).toBe("subscribed");
		await settle();
		const prefs = wire.last("1", "prefs");
		expect(prefs?.type === "prefs" && prefs.prefs.send.audio).toBe(false);
		expect(player1.sending).toBeNull();
		expect(player2.remote("1")?.peerSendsAudio).toBe(false);
	});

	it("detaches remote audio at once when Hear others goes off", async () => {
		await connected();
		expect(player2.remote("1")?.status).toBe("connected");
		expect(player2.remote("1")?.audio).toBeDefined();
		player2.call.setSwitch("receive", "audio", false);
		expect(player2.remote("1")?.audio).toBeUndefined();
		expect(player2.call.view.status).toBe("subscribed");
	});

	it("leaves the call when the last switch goes off, and when the seat is lost", async () => {
		await connected("listen", "audio");
		player1.call.setSwitch("receive", "audio", false);
		expect(player1.call.view.status).toBe("outside");
		expect(player1.call.view.requested.inCall).toBe(false);
		expect(player1.connections.every((pc) => pc.closed)).toBe(true);
		await settle();
		expect(wire.types("1").at(-1)).toBe("leave");
		expect(player2.remote("1")?.status).toBe("out");

		const mic = player2.grant();
		await settle(10);
		player2.call.update(snapshot(null));
		expect(player2.call.view.status).toBe("outside");
		expect(player2.call.view.canJoin).toBe(false);
		expect(mic.stops).toBe(1);
		player2.join("audio");
		expect(player2.call.view.status).toBe("outside");
	});

	it("ends the call when signaling ends, and stops the microphone", async () => {
		await connected();
		const mic = player1.grant();
		await settle(10);
		wire.end("1");
		expect(player1.call.view.status).toBe("outside");
		expect(player1.call.view.requested.inCall).toBe(false);
		expect(mic.stops).toBe(1);
		expect(player1.connections.every((pc) => pc.closed)).toBe(true);
	});

	it("stays in the call with a refused microphone", async () => {
		player1.join("audio");
		player1.requests[0]?.reject(new DOMException("no", "NotAllowedError"));
		await settle();
		expect(player1.call.view.mic).toBe("denied");
		expect(player1.call.view.status).toBe("subscribed");
		expect(player1.call.view.requested.send.audio).toBe(true);
	});

	it("announces a device class change in the call, and only re-renders outside it", async () => {
		player1.changes.mockClear();
		player1.call.setForm("compact");
		expect(player1.changes).toHaveBeenCalledTimes(1);
		expect(wire.sent).toEqual([]);
		expect(player1.call.view.form).toBe("compact");

		await connected();
		player1.call.setForm("desktop");
		await settle();
		const prefs = wire.last("1", "prefs");
		expect(prefs?.type === "prefs" && prefs.form).toBe("desktop");
		expect(player1.call.view.status).toBe("subscribed");
	});

	it("dispose leaves, closes the links and stops notifying", async () => {
		await connected();
		const mic = player1.grant();
		await settle(10);
		player1.changes.mockClear();
		player1.call.dispose();
		expect(mic.stops).toBe(1);
		expect(player1.connections.every((pc) => pc.closed)).toBe(true);
		expect(player1.changes).not.toHaveBeenCalled();
		await settle();
		expect(wire.types("1").at(-1)).toBe("leave");
	});
});
