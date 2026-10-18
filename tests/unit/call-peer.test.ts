import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkSignal } from "../../src/call/mesh";
import { MAX_CANDIDATES, MAX_SDP_LENGTH } from "../../src/call/messages";
import {
	ANSWER_TIMEOUT_MS,
	CONNECT_TIMEOUT_MS,
	GATHER_WAIT_MS,
	ICE_BATCH_MS,
	PeerLink,
} from "../../src/call/peer";
import {
	MEDIA,
	type Medium,
	mediaPlan,
	type Party,
	PRESETS,
	type PresetId,
	setSwitch,
} from "../../src/call/policy";
import type { Seat } from "../../src/protocol";
import { AUDIO, BOTH, party } from "./call-fakes";
import {
	asConnection,
	asTrack,
	FakePeerConnection,
	FakeTrack,
	type FakeTransceiver,
	parseFakeSdp,
} from "./call-rtc-fakes";

/** Long enough for every queued step of one exchange; shorter than every timer in `peer.ts`. */
const SETTLE_MS = 50;

async function settle(ms = SETTLE_MS): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

function switched(
	local: Party,
	way: "send" | "receive",
	on: boolean,
	medium: Medium = "audio",
): Party {
	return {
		...local,
		prefs: setSwitch(local.prefs, local.form, way, medium, on),
	};
}

function candidate(text: string) {
	return { candidate: text, sdpMid: "0", sdpMLineIndex: 0 };
}

interface Wire {
	readonly from: Seat;
	readonly signal: LinkSignal;
}

/** North (impolite) and East (polite) with their links to each other; signals are delivered in send order. */
class Pair {
	readonly a = new FakePeerConnection();
	readonly b = new FakePeerConnection();
	readonly micA = new FakeTrack("audio");
	readonly micB = new FakeTrack("audio");
	readonly camA = new FakeTrack("video");
	readonly camB = new FakeTrack("video");
	readonly sent: Wire[] = [];
	/** Held back while `hold` is set; `release()` delivers them. */
	held: Wire[] = [];
	hold = false;
	drop: (wire: Wire) => boolean = () => false;
	readonly northChanges = vi.fn();
	readonly eastChanges = vi.fn();
	readonly north: PeerLink;
	readonly east: PeerLink;

	constructor(
		north: Party,
		east: Party,
		setup: (pair: Pair) => void = () => undefined,
	) {
		setup(this);
		this.north = new PeerLink({
			seat: "E",
			polite: false,
			local: north,
			remote: east,
			connection: asConnection(this.a),
			tracks: { audio: asTrack(this.micA), video: asTrack(this.camA) },
			send: (signal) => this.#route("N", signal),
			onState: this.northChanges,
		});
		this.east = new PeerLink({
			seat: "N",
			polite: true,
			local: east,
			remote: north,
			connection: asConnection(this.b),
			tracks: { audio: asTrack(this.micB), video: asTrack(this.camB) },
			send: (signal) => this.#route("E", signal),
			onState: this.eastChanges,
		});
	}

	get ta(): FakeTransceiver {
		const [transceiver] = this.a.getTransceivers();
		if (transceiver === undefined) throw new Error("no transceiver at N");
		return transceiver;
	}

	get tb(): FakeTransceiver {
		const [transceiver] = this.b.getTransceivers();
		if (transceiver === undefined) throw new Error("no transceiver at E");
		return transceiver;
	}

	/** The transceiver of the medium at N (`a`) or at E (`b`), if the connection has one. */
	section(side: "a" | "b", medium: Medium): FakeTransceiver | undefined {
		return this[side]
			.getTransceivers()
			.find((transceiver) => transceiver.receiver.track.kind === medium);
	}

	/** The name of the local track that the section sends (fakes of one kind are deep-equal, so names compare). */
	sending(side: "a" | "b", medium: Medium): string | null {
		const track = this.section(side, medium)?.sender.track ?? null;
		if (track === null) return null;
		const names = new Map<MediaStreamTrack, string>([
			[asTrack(this.micA), "micA"],
			[asTrack(this.micB), "micB"],
			[asTrack(this.camA), "camA"],
			[asTrack(this.camB), "camB"],
		]);
		return names.get(track) ?? "other";
	}

	types(from: Seat): string[] {
		return this.sent
			.filter((wire) => wire.from === from)
			.map((wire) => wire.signal.type);
	}

	signals(from: Seat, type: LinkSignal["type"]): LinkSignal[] {
		return this.sent
			.filter((wire) => wire.from === from && wire.signal.type === type)
			.map((wire) => wire.signal);
	}

	release(): void {
		this.hold = false;
		const held = this.held;
		this.held = [];
		for (const wire of held) this.#deliver(wire);
	}

	connect(): void {
		this.a.setConnection("connected");
		this.b.setConnection("connected");
	}

	#route(from: Seat, signal: LinkSignal): void {
		const wire = { from, signal };
		this.sent.push(wire);
		if (this.drop(wire)) return;
		if (this.hold) this.held.push(wire);
		else this.#deliver(wire);
	}

	#deliver(wire: Wire): void {
		(wire.from === "N" ? this.east : this.north).receive(wire.signal);
	}
}

async function connectedPair(north = AUDIO, east = AUDIO): Promise<Pair> {
	const pair = new Pair(north, east);
	await settle();
	pair.connect();
	return pair;
}

function sdpOf(signal: LinkSignal | undefined): string {
	if (signal === undefined || signal.type === "ice") {
		throw new Error("not a description");
	}
	return signal.sdp;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PeerLink negotiation (call/layout plan §4.4 step 4)", () => {
	it("connects a symmetric audio pair in one offer/answer round", async () => {
		const pair = new Pair(AUDIO, AUDIO);
		await settle();
		expect(pair.types("N")).toEqual(["offer"]);
		expect(pair.types("E")).toEqual(["answer"]);
		expect(pair.a.signalingState).toBe("stable");
		expect(pair.b.signalingState).toBe("stable");
		// The impolite side owns the m-lines; the polite side only uses the one it received.
		expect(pair.a.getTransceivers()).toHaveLength(1);
		expect(pair.b.getTransceivers()).toHaveLength(1);
		expect(pair.ta.currentDirection).toBe("sendrecv");
		expect(pair.tb.currentDirection).toBe("sendrecv");
		expect(pair.ta.sender.track).toBe(asTrack(pair.micA));
		expect(pair.tb.sender.track).toBe(asTrack(pair.micB));
		expect(pair.north.state).toBe("connecting");
		expect(pair.north.connected).toBe(false);

		pair.connect();
		expect(pair.north.state).toBe("connected");
		expect(pair.north.connected).toBe(true);
		expect(pair.east.state).toBe("connected");
		expect(pair.north.remoteAudio).toBe(pair.ta.receiver.track);
		expect(pair.east.remoteAudio).toBe(pair.tb.receiver.track);
	});

	it("never sends a track from a listen-only side", async () => {
		const pair = new Pair(AUDIO, party("listen"));
		await settle();
		expect(pair.ta.currentDirection).toBe("sendonly");
		expect(pair.tb.currentDirection).toBe("recvonly");
		expect(pair.tb.sender.track).toBeNull();
		expect(pair.tb.sender.replacements).toBe(0);
	});

	it("removes the track at once when the impolite side turns send off, then renegotiates", async () => {
		const pair = await connectedPair();
		const quiet = switched(AUDIO, "send", false);
		pair.north.update(quiet, AUDIO);
		pair.east.update(AUDIO, quiet);
		await settle();
		expect(pair.ta.sender.track).toBeNull();
		expect(pair.types("N")).toEqual(["offer", "offer"]);
		expect(pair.ta.currentDirection).toBe("recvonly");
		expect(pair.tb.currentDirection).toBe("sendonly");
		expect(pair.tb.sender.track).toBe(asTrack(pair.micB));
		expect(pair.north.state).toBe("connected");
	});

	it("lets the polite side stop sending without an offer of its own", async () => {
		const pair = await connectedPair();
		const quiet = switched(AUDIO, "send", false);
		pair.east.update(quiet, AUDIO);
		await settle();
		expect(pair.tb.sender.track).toBeNull();
		expect(pair.types("E")).toEqual(["answer"]);

		// Its prefs reach the impolite side, which offers the new directions.
		pair.north.update(AUDIO, quiet);
		await settle();
		expect(pair.types("N")).toEqual(["offer", "offer"]);
		expect(pair.types("E")).toEqual(["answer", "answer"]);
		expect(pair.ta.currentDirection).toBe("sendonly");
		expect(pair.tb.currentDirection).toBe("recvonly");
		expect(pair.tb.sender.track).toBeNull();
	});

	it("stops receiving after the polite side turns receive off", async () => {
		const pair = await connectedPair();
		const deaf = switched(AUDIO, "receive", false);
		pair.east.update(deaf, AUDIO);
		pair.north.update(AUDIO, deaf);
		await settle();
		expect(pair.ta.currentDirection).toBe("recvonly");
		expect(pair.tb.currentDirection).toBe("sendonly");
		expect(pair.ta.sender.track).toBeNull();
	});

	it("offers a change that comes while an offer is out after that offer's answer", async () => {
		const pair = new Pair(AUDIO, AUDIO, (p) => {
			p.hold = true;
		});
		await settle();
		expect(pair.held.map((wire) => wire.signal.type)).toEqual(["offer"]);
		const quiet = switched(AUDIO, "send", false);
		pair.north.update(quiet, AUDIO);
		pair.east.update(AUDIO, quiet);
		await settle();
		expect(pair.types("N")).toEqual(["offer"]);

		pair.release();
		await settle();
		expect(pair.types("N")).toEqual(["offer", "offer"]);
		expect(pair.ta.currentDirection).toBe("recvonly");
		expect(pair.a.signalingState).toBe("stable");
	});

	it("resolves glare: the impolite side ignores the colliding offer and the polite side rolls back", async () => {
		const pair = await connectedPair();
		pair.hold = true;
		pair.east.restartIce();
		const quiet = switched(AUDIO, "send", false);
		pair.north.update(quiet, AUDIO);
		pair.east.update(AUDIO, quiet);
		await settle();
		expect(pair.a.signalingState).toBe("have-local-offer");
		expect(pair.b.signalingState).toBe("have-local-offer");
		expect(
			pair.held.map((wire) => `${wire.from} ${wire.signal.type}`).sort(),
		).toEqual(["E offer", "N offer"]);

		pair.release();
		await settle();
		expect(pair.b.rollbacks).toBe(1);
		expect(pair.a.signalingState).toBe("stable");
		expect(pair.b.signalingState).toBe("stable");
		expect(pair.types("E")).toEqual(["answer", "offer", "answer"]);
		expect(pair.types("N")).toEqual(["offer", "offer"]);
		expect(pair.b.getTransceivers()).toHaveLength(1);
		expect(pair.ta.currentDirection).toBe("recvonly");

		// The rolled-back offer has no answer timer left.
		await settle(ANSWER_TIMEOUT_MS + SETTLE_MS);
		expect(pair.east.state).toBe("connected");
		expect(pair.north.state).toBe("connected");
	});

	it("replaces a lost first offer on Retry, from have-local-offer, with new ICE credentials", async () => {
		let dropped = 0;
		const pair = new Pair(AUDIO, AUDIO, (p) => {
			p.drop = (wire) => wire.signal.type === "offer" && dropped++ === 0;
		});
		await settle();
		expect(pair.a.signalingState).toBe("have-local-offer");
		expect(pair.types("E")).toEqual([]);

		await settle(ANSWER_TIMEOUT_MS);
		expect(pair.north.state).toBe("unavailable");
		expect(pair.northChanges).toHaveBeenCalled();

		pair.north.restartIce();
		expect(pair.north.state).toBe("connecting");
		await settle();
		const [lost, replacement] = pair.signals("N", "offer");
		expect(replacement?.negotiation).toBeGreaterThan(lost?.negotiation ?? 0);
		expect(parseFakeSdp(sdpOf(replacement)).ufrag).not.toBe(
			parseFakeSdp(sdpOf(lost)).ufrag,
		);
		expect(pair.a.signalingState).toBe("stable");
		pair.connect();
		expect(pair.north.state).toBe("connected");
	});

	it("offers a lost renegotiation again while the media still flows", async () => {
		const pair = await connectedPair();
		let dropped = 0;
		pair.drop = (wire) => wire.signal.type === "offer" && dropped++ === 0;
		const quiet = switched(AUDIO, "send", false);
		pair.north.update(quiet, AUDIO);
		pair.east.update(AUDIO, quiet);
		await settle();
		expect(pair.a.signalingState).toBe("have-local-offer");

		await settle(ANSWER_TIMEOUT_MS);
		expect(pair.types("N")).toEqual(["offer", "offer", "offer"]);
		expect(pair.a.signalingState).toBe("stable");
		expect(pair.ta.currentDirection).toBe("recvonly");
		expect(pair.north.state).toBe("connected");
	});

	it("does nothing on a polite Retry before any offer arrived", async () => {
		const pair = new Pair(AUDIO, AUDIO, (p) => {
			p.drop = (wire) => wire.from === "N";
		});
		await settle();
		pair.east.restartIce();
		await settle();
		expect(pair.types("E")).toEqual([]);
		expect(pair.b.getTransceivers()).toHaveLength(0);
	});
});

describe("PeerLink stale signals", () => {
	it("ignores an answer to another negotiation and candidates of an old one; holds early ones", async () => {
		const pair = new Pair(AUDIO, AUDIO, (p) => {
			p.hold = true;
		});
		await settle();
		const offer = pair.held[0]?.signal;
		expect(offer?.negotiation).toBe(1);
		pair.north.receive({
			type: "answer",
			negotiation: 7,
			sdp: JSON.stringify({ type: "answer", ufrag: "x", sections: [] }),
		});
		pair.north.receive({
			type: "ice",
			negotiation: 0,
			candidates: [candidate("candidate:old")],
		});
		pair.north.receive({
			type: "ice",
			negotiation: 1,
			candidates: [candidate("candidate:early")],
		});
		await settle();
		expect(pair.a.signalingState).toBe("have-local-offer");
		expect(pair.a.candidates).toEqual([]);

		pair.release();
		await settle();
		expect(pair.a.signalingState).toBe("stable");
		expect(pair.a.candidates.map((c) => c.candidate)).toEqual([
			"candidate:early",
		]);
	});

	it("drops a remote candidate that the browser refuses without failing the link", async () => {
		const pair = await connectedPair();
		pair.north.receive({
			type: "ice",
			negotiation: 1,
			candidates: [candidate("candidate:refused"), candidate("candidate:good")],
		});
		await settle();
		expect(pair.a.candidates.map((c) => c.candidate)).toEqual([
			"candidate:good",
		]);
		expect(pair.north.state).toBe("connected");
	});

	it("makes the link unavailable on a refused description, and reports only the error name", async () => {
		const pair = await connectedPair();
		pair.east.receive({ type: "offer", negotiation: 9, sdp: "a=bad" });
		await settle();
		expect(pair.east.state).toBe("unavailable");
		expect(pair.east.fault).toBe("SyntaxError");
	});
});

describe("PeerLink half-trickle ICE (call/layout plan §4.4 step 5)", () => {
	it("sends the description after gathering or GATHER_WAIT_MS, then batches later candidates", async () => {
		const pair = new Pair(AUDIO, AUDIO, (p) => {
			p.a.gathering = "manual";
		});
		await settle();
		pair.a.gather("candidate:in-the-offer");
		await settle(GATHER_WAIT_MS - SETTLE_MS - 1);
		expect(pair.types("N")).toEqual([]);
		await settle(1);
		expect(pair.types("N")).toEqual(["offer"]);

		for (let n = 0; n < MAX_CANDIDATES + 8; n++)
			pair.a.gather(`candidate:${n}`);
		pair.a.gather("x".repeat(2000));
		pair.a.gather("");
		await settle(ICE_BATCH_MS - 1);
		expect(pair.types("N")).toEqual(["offer"]);
		await settle(1);
		const batches = pair.signals("N", "ice");
		expect(
			batches.map((signal) =>
				signal.type === "ice" ? signal.candidates.length : -1,
			),
		).toEqual([MAX_CANDIDATES, 8]);
		expect(batches.every((signal) => signal.negotiation === 1)).toBe(true);
		const texts = batches.flatMap((signal) =>
			signal.type === "ice" ? signal.candidates.map((c) => c.candidate) : [],
		);
		expect(texts).not.toContain("candidate:in-the-offer");
	});

	it("sends the answer as soon as gathering completes", async () => {
		const pair = new Pair(AUDIO, AUDIO, (p) => {
			p.b.gathering = "manual";
		});
		await settle();
		expect(pair.types("E")).toEqual([]);
		pair.b.finishGathering();
		await settle();
		expect(pair.types("E")).toEqual(["answer"]);
	});

	it("never sends a description over the size limit", async () => {
		const pair = new Pair(AUDIO, AUDIO, (p) => {
			p.a.padding = "x".repeat(MAX_SDP_LENGTH);
		});
		await settle();
		expect(pair.sent).toEqual([]);
		expect(pair.north.state).toBe("unavailable");
		expect(pair.north.fault).toBe("SdpTooLong");
	});
});

describe("PeerLink state and lifecycle (call/layout plan §4.5)", () => {
	it("is unavailable when not connected in time, and follows the connection afterwards", async () => {
		const pair = new Pair(AUDIO, AUDIO);
		await settle(CONNECT_TIMEOUT_MS - SETTLE_MS);
		expect(pair.north.state).toBe("connecting");
		await settle(SETTLE_MS);
		expect(pair.north.state).toBe("unavailable");

		pair.a.setConnection("connected");
		expect(pair.north.state).toBe("connected");
		pair.a.setConnection("disconnected");
		expect(pair.north.state).toBe("reconnecting");
		pair.a.setConnection("failed");
		expect(pair.north.state).toBe("unavailable");
	});

	it("follows the microphone where the plan sends audio", async () => {
		const pair = await connectedPair(AUDIO, party("listen"));
		const other = new FakeTrack("audio");
		pair.north.setTrack("audio", asTrack(other));
		pair.east.setTrack("audio", asTrack(other));
		await settle();
		expect(pair.ta.sender.track).toBe(asTrack(other));
		expect(pair.tb.sender.track).toBeNull();

		pair.north.setTrack("audio", null);
		await settle();
		expect(pair.ta.sender.track).toBeNull();
	});

	it("closes the connection, and nothing goes out or changes afterwards", async () => {
		const pair = new Pair(AUDIO, AUDIO, (p) => {
			p.a.gathering = "manual";
		});
		await settle();
		pair.north.close();
		await settle(CONNECT_TIMEOUT_MS + GATHER_WAIT_MS);
		expect(pair.a.closed).toBe(true);
		expect(pair.sent).toEqual([]);
		expect(pair.northChanges).not.toHaveBeenCalled();
		pair.north.receive({
			type: "ice",
			negotiation: 1,
			candidates: [candidate("candidate:late")],
		});
		pair.north.restartIce();
		await settle();
		expect(pair.sent).toEqual([]);
	});
});

/** What one medium of a negotiated pair looks like at N and at E. */
function observed(pair: Pair, medium: Medium) {
	const [a, b] = [pair.section("a", medium), pair.section("b", medium)];
	return {
		sections: [a !== undefined, b !== undefined],
		directions: [a?.currentDirection ?? null, b?.currentDirection ?? null],
		sends: [pair.sending("a", medium), pair.sending("b", medium)],
	};
}

/** The same, derived from the policy alone. */
function expected(north: Party, east: Party, medium: Medium) {
	const [n, e] = [
		mediaPlan(north, east)[medium],
		mediaPlan(east, north)[medium],
	];
	// The audio section always exists; the video one only when some video may flow.
	const present = medium === "audio" || n.direction !== "inactive";
	const [mine, theirs] =
		medium === "audio" ? ["micA", "micB"] : ["camA", "camB"];
	return {
		sections: [present, present],
		directions: present ? [n.direction, e.direction] : [null, null],
		sends: [n.send ? mine : null, e.send ? theirs : null],
	};
}

describe("PeerLink video and asymmetric combinations (call/layout plan C6)", () => {
	const pairs = PRESETS.flatMap((n) =>
		PRESETS.map((e): [PresetId, PresetId] => [n.id, e.id]),
	);

	it.each(pairs)(
		"N %s, E %s: both media follow the plan in one offer/answer round",
		async (n, e) => {
			const north = party(n);
			const east = party(e);
			const pair = new Pair(north, east);
			await settle();
			expect(pair.types("N")).toEqual(["offer"]);
			expect(pair.types("E")).toEqual(["answer"]);
			for (const medium of MEDIA) {
				expect(observed(pair, medium)).toEqual(expected(north, east, medium));
			}
		},
	);

	it("has a video section that carries both cameras for two desktops on Both", async () => {
		const pair = new Pair(BOTH, BOTH);
		await settle();
		expect(observed(pair, "video")).toEqual({
			sections: [true, true],
			directions: ["sendrecv", "sendrecv"],
			sends: ["camA", "camB"],
		});
	});

	it.each([
		["desktop", "compact"],
		["compact", "desktop"],
		["compact", "compact"],
	] as const)(
		"N %s, E %s on Both: audio only, with no video section",
		async (n, e) => {
			const pair = new Pair(party("both", n), party("both", e));
			await settle();
			expect(observed(pair, "audio").directions).toEqual([
				"sendrecv",
				"sendrecv",
			]);
			expect(observed(pair, "video")).toEqual({
				sections: [false, false],
				directions: [null, null],
				sends: [null, null],
			});
		},
	);

	it("ignores video switches that a compact party claims (stored or forged prefs)", async () => {
		const pair = new Pair(BOTH, { ...BOTH, form: "compact" });
		await settle();
		expect(pair.section("a", "video")).toBeUndefined();
		expect(pair.section("b", "video")).toBeUndefined();
	});

	it("keeps an offered video section inactive on a compact side, without a camera", async () => {
		// A modified desktop client offers video to a compact peer anyway.
		const pair = new Pair(BOTH, { ...BOTH, form: "compact" }, (p) => {
			const add = p.a.addTransceiver.bind(p.a);
			p.a.addTransceiver = (trackOrKind, init) => {
				const transceiver = add(trackOrKind, init);
				if (p.a.getTransceivers().length === 1) {
					add(asTrack(p.camA), { direction: "sendrecv" });
				}
				return transceiver;
			};
		});
		await settle();
		const video = pair.section("b", "video");
		expect(video?.direction).toBe("inactive");
		expect(video?.currentDirection).toBe("inactive");
		expect(pair.sending("b", "video")).toBeNull();
		expect(pair.section("a", "video")?.currentDirection).toBe("inactive");
		expect(observed(pair, "audio").directions).toEqual([
			"sendrecv",
			"sendrecv",
		]);
		expect(pair.types("E")).toEqual(["answer"]);
	});

	it("adds the video section when the impolite side starts its camera, and keeps it inactive after Send off", async () => {
		const watch = party("watch");
		const pair = await connectedPair(AUDIO, watch);
		expect(pair.section("a", "video")).toBeUndefined();

		const camera = switched(AUDIO, "send", true, "video");
		pair.north.update(camera, watch);
		pair.east.update(watch, camera);
		await settle();
		expect(pair.types("N")).toEqual(["offer", "offer"]);
		expect(observed(pair, "video")).toEqual({
			sections: [true, true],
			directions: ["sendonly", "recvonly"],
			sends: ["camA", null],
		});
		expect(pair.east.remoteVideo).toBe(
			pair.section("b", "video")?.receiver.track,
		);

		pair.north.setTrack("video", null);
		pair.north.update(AUDIO, watch);
		pair.east.update(watch, AUDIO);
		await settle();
		expect(pair.a.getTransceivers()).toHaveLength(2);
		expect(observed(pair, "video")).toEqual({
			sections: [true, true],
			directions: ["inactive", "inactive"],
			sends: [null, null],
		});
		expect(observed(pair, "audio").directions).toEqual([
			"sendrecv",
			"sendrecv",
		]);
	});

	it("lets the polite side start its camera: the impolite side adds the section, the polite side only answers", async () => {
		const watch = party("watch");
		const pair = await connectedPair(watch, AUDIO);
		const camera = switched(AUDIO, "send", true, "video");
		pair.east.update(camera, watch);
		await settle();
		expect(pair.types("E")).toEqual(["answer"]);
		expect(pair.section("b", "video")).toBeUndefined();

		pair.north.update(watch, camera);
		await settle();
		expect(pair.types("N")).toEqual(["offer", "offer"]);
		expect(pair.types("E")).toEqual(["answer", "answer"]);
		expect(observed(pair, "video")).toEqual({
			sections: [true, true],
			directions: ["recvonly", "sendonly"],
			sends: [null, "camB"],
		});
		expect(pair.north.remoteVideo).toBe(
			pair.section("a", "video")?.receiver.track,
		);
		expect(pair.east.remoteVideo).toBe(
			pair.section("b", "video")?.receiver.track,
		);
	});

	it("gives the received picture only while its track is unmuted, and reports each change", async () => {
		const pair = await connectedPair(BOTH, BOTH);
		const track = pair.section("a", "video")?.receiver.track;
		if (track === undefined) throw new Error("no video section at N");
		expect(pair.north.remoteVideo).toBe(asTrack(track));
		const changes = pair.northChanges.mock.calls.length;

		// No frames arrive: the peer's camera is blocked, or its first frames are not here yet.
		track.setMuted(true);
		expect(pair.north.remoteVideo).toBeUndefined();
		expect(pair.northChanges).toHaveBeenCalledTimes(changes + 1);

		track.setMuted(false);
		expect(pair.north.remoteVideo).toBe(asTrack(track));
		expect(pair.northChanges).toHaveBeenCalledTimes(changes + 2);
	});

	it("detaches the camera at once on Send off, before any renegotiation", async () => {
		const pair = await connectedPair(BOTH, BOTH);
		pair.east.setTrack("video", null);
		await settle();
		expect(pair.sending("b", "video")).toBeNull();
		expect(pair.types("E")).toEqual(["answer"]);
		expect(pair.types("N")).toEqual(["offer"]);
	});

	it("gives audio the priority on a connection with video, and sets each sender once", async () => {
		const pair = await connectedPair(BOTH, BOTH);
		for (const side of ["a", "b"] as const) {
			expect(pair.section(side, "audio")?.sender.getParameters()).toEqual({
				encodings: [{ priority: "high", networkPriority: "high" }],
			});
			expect(pair.section(side, "video")?.sender.getParameters()).toEqual({
				degradationPreference: "maintain-framerate",
				encodings: [{ priority: "low", networkPriority: "low" }],
			});
		}
		const settings = () =>
			[...pair.a.getTransceivers(), ...pair.b.getTransceivers()].map(
				(transceiver) => transceiver.sender.settings,
			);
		expect(settings()).toEqual([1, 1, 1, 1]);

		const quiet = switched(BOTH, "send", false);
		pair.north.update(quiet, BOTH);
		pair.east.update(BOTH, quiet);
		await settle();
		expect(pair.types("N")).toEqual(["offer", "offer"]);
		expect(settings()).toEqual([1, 1, 1, 1]);
	});

	it("leaves the senders of an audio-only connection as they are", async () => {
		const pair = await connectedPair();
		expect([pair.ta.sender.settings, pair.tb.sender.settings]).toEqual([0, 0]);
	});
});
