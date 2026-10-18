/**
 * Stand-ins for the browser media objects in `peer.ts` and `media.ts` tests. The fake connection follows the
 * JSEP rules that the link relies on: implicit offer creation in `stable` and `have-local-offer`, implicit rollback
 * of a local offer by a remote offer, answer directions as the intersection with the reversed offer, and
 * transceivers created by a remote offer. Its "SDP" is JSON with the ICE ufrag and one direction per m-line.
 */

export class FakeTrack extends EventTarget {
	readyState: MediaStreamTrackState = "live";
	muted = false;
	stops = 0;

	constructor(readonly kind: "audio" | "video") {
		super();
	}

	/** Media stopped or started to arrive on a receiver track. */
	setMuted(muted: boolean): void {
		this.muted = muted;
		this.dispatchEvent(new Event(muted ? "mute" : "unmute"));
	}

	stop(): void {
		this.stops++;
		this.readyState = "ended";
	}

	/** The device went away or the permission was revoked. */
	end(): void {
		this.readyState = "ended";
		this.dispatchEvent(new Event("ended"));
	}
}

export function fakeStream(...tracks: FakeTrack[]): MediaStream {
	return {
		getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
		getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
	} as unknown as MediaStream;
}

export const asTrack = (track: FakeTrack): MediaStreamTrack =>
	track as unknown as MediaStreamTrack;

/** The sender settings that `peer.ts` tunes; Chrome starts every encoding at "low". */
interface FakeSendParameters {
	degradationPreference?: RTCDegradationPreference;
	encodings: {
		priority?: RTCPriorityType;
		networkPriority?: RTCPriorityType;
	}[];
}

class FakeSender {
	replacements = 0;
	settings = 0;
	#parameters: FakeSendParameters = {
		encodings: [{ priority: "low", networkPriority: "low" }],
	};

	constructor(public track: MediaStreamTrack | null) {}

	replaceTrack(track: MediaStreamTrack | null): Promise<void> {
		this.replacements++;
		this.track = track;
		return Promise.resolve();
	}

	/** A copy, as in the browser: changes apply only through setParameters. */
	getParameters(): FakeSendParameters {
		return structuredClone(this.#parameters);
	}

	setParameters(parameters: FakeSendParameters): Promise<void> {
		this.settings++;
		this.#parameters = structuredClone(parameters);
		return Promise.resolve();
	}
}

export class FakeTransceiver {
	currentDirection: RTCRtpTransceiverDirection | null = null;
	readonly sender: FakeSender;
	readonly receiver: { readonly track: FakeTrack };

	constructor(
		kind: "audio" | "video",
		public direction: RTCRtpTransceiverDirection,
		track: MediaStreamTrack | null,
	) {
		this.sender = new FakeSender(track);
		this.receiver = { track: new FakeTrack(kind) };
	}
}

interface Section {
	readonly kind: "audio" | "video";
	readonly direction: RTCRtpTransceiverDirection;
}

interface FakeSdp {
	readonly type: "offer" | "answer";
	readonly ufrag: string;
	readonly sections: readonly Section[];
	readonly padding?: string;
}

const SENDS = new Set(["sendrecv", "sendonly"]);
const RECEIVES = new Set(["sendrecv", "recvonly"]);

function directionOf(
	send: boolean,
	receive: boolean,
): RTCRtpTransceiverDirection {
	if (send && receive) return "sendrecv";
	if (send) return "sendonly";
	return receive ? "recvonly" : "inactive";
}

function reversed(
	direction: RTCRtpTransceiverDirection,
): RTCRtpTransceiverDirection {
	return directionOf(RECEIVES.has(direction), SENDS.has(direction));
}

function intersect(
	a: RTCRtpTransceiverDirection,
	b: RTCRtpTransceiverDirection,
): RTCRtpTransceiverDirection {
	return directionOf(
		SENDS.has(a) && SENDS.has(b),
		RECEIVES.has(a) && RECEIVES.has(b),
	);
}

export function parseFakeSdp(sdp: string): FakeSdp {
	return JSON.parse(sdp) as FakeSdp;
}

export function invalidState(message: string): DOMException {
	return new DOMException(message, "InvalidStateError");
}

let ufrags = 0;

export class FakePeerConnection extends EventTarget {
	signalingState: RTCSignalingState = "stable";
	connectionState: RTCPeerConnectionState = "new";
	iceGatheringState: RTCIceGatheringState = "new";
	localDescription: RTCSessionDescriptionInit | null = null;
	remoteDescription: RTCSessionDescriptionInit | null = null;
	/** "instant": gathering completes inside setLocalDescription; "manual": the test calls `finishGathering()`. */
	gathering: "instant" | "manual" = "instant";
	/** Added to every local description, to test the size limit. */
	padding = "";
	rollbacks = 0;
	closed = false;
	readonly candidates: RTCIceCandidateInit[] = [];
	readonly #transceivers: FakeTransceiver[] = [];
	#ufrag = "";
	#remoteUfrag = "";
	#restart = true;

	addTransceiver(
		trackOrKind: MediaStreamTrack | string,
		init: RTCRtpTransceiverInit = {},
	): FakeTransceiver {
		const kind = (
			typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind
		) as "audio" | "video";
		const track = typeof trackOrKind === "string" ? null : trackOrKind;
		const transceiver = new FakeTransceiver(
			kind,
			init.direction ?? "sendrecv",
			track,
		);
		this.#transceivers.push(transceiver);
		return transceiver;
	}

	getTransceivers(): FakeTransceiver[] {
		return [...this.#transceivers];
	}

	restartIce(): void {
		this.#restart = true;
	}

	async setLocalDescription(
		description?: RTCLocalSessionDescriptionInit,
	): Promise<void> {
		await Promise.resolve();
		this.#open();
		if (description?.type === "rollback") {
			this.signalingState = "stable";
			return;
		}
		if (this.#restart) {
			this.#ufrag = `u${++ufrags}`;
			this.#restart = false;
			this.iceGatheringState = "new";
		}
		if (this.signalingState === "have-remote-offer") {
			const offer = parseFakeSdp(this.remoteDescription?.sdp ?? "");
			const sections = offer.sections.map((section, index) => {
				const transceiver = this.#transceivers[index];
				if (transceiver === undefined) throw invalidState("no transceiver");
				const direction = intersect(
					transceiver.direction,
					reversed(section.direction),
				);
				transceiver.currentDirection = direction;
				return { kind: section.kind, direction };
			});
			this.localDescription = {
				type: "answer",
				sdp: this.#sdp("answer", sections),
			};
			this.signalingState = "stable";
		} else {
			const sections = this.#transceivers.map((transceiver) => ({
				kind: transceiver.receiver.track.kind,
				direction: transceiver.direction,
			}));
			this.localDescription = {
				type: "offer",
				sdp: this.#sdp("offer", sections),
			};
			this.signalingState = "have-local-offer";
		}
		if (this.iceGatheringState !== "complete") {
			this.iceGatheringState =
				this.gathering === "instant" ? "complete" : "gathering";
		}
	}

	async setRemoteDescription(
		description: RTCSessionDescriptionInit,
	): Promise<void> {
		await Promise.resolve();
		this.#open();
		const sdp = parseFakeSdp(description.sdp ?? "");
		if (description.type === "offer") {
			if (this.signalingState === "have-local-offer") this.rollbacks++;
			// An offer with new remote credentials is an ICE restart: the answer gets new ones too.
			if (sdp.ufrag !== this.#remoteUfrag) this.#restart = true;
			this.#remoteUfrag = sdp.ufrag;
			sdp.sections.forEach((section, index) => {
				if (this.#transceivers[index] === undefined) {
					this.#transceivers.push(
						new FakeTransceiver(section.kind, "recvonly", null),
					);
				}
			});
			this.signalingState = "have-remote-offer";
		} else {
			if (this.signalingState !== "have-local-offer") {
				throw invalidState(`answer in ${this.signalingState}`);
			}
			sdp.sections.forEach((section, index) => {
				const transceiver = this.#transceivers[index];
				if (transceiver !== undefined) {
					transceiver.currentDirection = reversed(section.direction);
				}
			});
			this.signalingState = "stable";
		}
		this.remoteDescription = description;
	}

	async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		await Promise.resolve();
		if (this.remoteDescription === null)
			throw invalidState("no remote description");
		if (candidate.candidate?.includes("refused")) {
			throw new DOMException("bad candidate", "OperationError");
		}
		this.candidates.push(candidate);
	}

	close(): void {
		this.closed = true;
		this.signalingState = "closed";
		this.connectionState = "closed";
	}

	/** The ufrag of the current local description. */
	get ufrag(): string {
		return this.#ufrag;
	}

	setConnection(state: RTCPeerConnectionState): void {
		this.connectionState = state;
		this.dispatchEvent(new Event("connectionstatechange"));
	}

	gather(
		text: string,
		sdpMid: string | null = "0",
		sdpMLineIndex: number | null = 0,
	): void {
		const candidate = { candidate: text, sdpMid, sdpMLineIndex };
		this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate }));
	}

	finishGathering(): void {
		this.iceGatheringState = "complete";
		this.dispatchEvent(new Event("icegatheringstatechange"));
	}

	#open(): void {
		if (this.closed) throw invalidState("closed");
	}

	#sdp(type: "offer" | "answer", sections: readonly Section[]): string {
		const sdp: FakeSdp = { type, ufrag: this.#ufrag, sections };
		return JSON.stringify(
			this.padding === "" ? sdp : { ...sdp, padding: this.padding },
		);
	}
}

export const asConnection = (pc: FakePeerConnection): RTCPeerConnection =>
	pc as unknown as RTCPeerConnection;
