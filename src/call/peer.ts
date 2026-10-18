import type { CallLink, LinkOptions, LinkSignal } from "./mesh";
import {
	type IceCandidate,
	MAX_CANDIDATE_LENGTH,
	MAX_CANDIDATES,
	MAX_SDP_LENGTH,
	MAX_SDP_MID_LENGTH,
	MAX_SDP_MLINE_INDEX,
} from "./messages";
import { MEDIA, type Medium, mediaPlan, type Party } from "./policy";

/**
 * One RTCPeerConnection to one remote seat (call/layout plan §4.4 steps 4–5, §4.5). Perfect negotiation with fixed
 * roles: the impolite side owns the m-lines, so it adds the transceivers and makes every offer for a change of
 * preferences. The polite side only sets directions and tracks on the transceivers it received, and offers only
 * for an ICE restart; a colliding offer rolls it back. All description and candidate steps run in one serial queue.
 */

/** Wait this long for ICE gathering; then the description goes out with the candidates gathered so far. */
export const GATHER_WAIT_MS = 1000;
/** Candidates gathered after the description go out in batches over this window. */
export const ICE_BATCH_MS = 250;
/** An offer without an answer this long: a connected link offers again, any other link is unavailable. */
export const ANSWER_TIMEOUT_MS = 10_000;
/** A link that is not connected this long after it starts (or after Retry) is unavailable. */
export const CONNECT_TIMEOUT_MS = 20_000;
/** Remote candidates kept while their description is not applied yet. */
const MAX_PENDING_CANDIDATES = 4 * MAX_CANDIDATES;

export type LinkState =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "unavailable";

export type LocalTracks = Readonly<Record<Medium, MediaStreamTrack | null>>;

export interface PeerLinkOptions extends LinkOptions {
	readonly connection: RTCPeerConnection;
	/** The live microphone and camera tracks, or null. */
	readonly tracks: LocalTracks;
}

/** Audio goes first when the network is poor (call/layout plan §4.5). Chrome's default is "low" for both. */
const PRIORITY: Readonly<Record<Medium, RTCPriorityType>> = {
	audio: "high",
	video: "low",
};

function mediumOf(transceiver: RTCRtpTransceiver): Medium {
	return transceiver.receiver.track.kind === "video" ? "video" : "audio";
}

function usable(candidate: RTCIceCandidate): IceCandidate | undefined {
	const { candidate: text, sdpMid, sdpMLineIndex } = candidate;
	if (
		text === "" ||
		text.length > MAX_CANDIDATE_LENGTH ||
		(sdpMid !== null && sdpMid.length > MAX_SDP_MID_LENGTH) ||
		(sdpMLineIndex !== null &&
			(sdpMLineIndex < 0 || sdpMLineIndex > MAX_SDP_MLINE_INDEX))
	) {
		return undefined;
	}
	return { candidate: text, sdpMid, sdpMLineIndex };
}

export class PeerLink implements CallLink {
	readonly #pc: RTCPeerConnection;
	readonly #polite: boolean;
	readonly #send: (signal: LinkSignal) => void;
	readonly #onState: () => void;
	#local: Party;
	#remote: Party;
	#tracks: LocalTracks;
	#queue: Promise<void> = Promise.resolve();
	#closed = false;
	/** The highest negotiation number seen or used on this link; a local offer takes the next one. */
	#highest = 0;
	/** The negotiation of the last offer sent or accepted; signals for another one are stale. */
	#current = 0;
	/** The negotiation of this side's offer while it waits for the answer. */
	#offered: number | undefined;
	/** The negotiation whose remote description is applied; candidates wait for it. */
	#applied: number | undefined;
	#pending: IceCandidate[] = [];
	/** A change came while an offer was out: offer again after its answer. */
	#offerAgain = false;
	/** Every local description and close() start a new epoch; a late gather or batch of an old one is dropped. */
	#epoch = 0;
	/** The negotiation of the current local description. */
	#localNegotiation = 0;
	/** Set once the current local description went out: later candidates trickle. */
	#trickle = false;
	#batch: IceCandidate[] = [];
	#batchTimer: ReturnType<typeof setTimeout> | undefined;
	#answerTimer: ReturnType<typeof setTimeout> | undefined;
	#connectTimer: ReturnType<typeof setTimeout> | undefined;
	#unavailable = false;
	#fault: string | undefined;
	#state: LinkState = "connecting";
	#remoteAudio: MediaStreamTrack | undefined;
	#remoteVideo: MediaStreamTrack | undefined;
	/** Receiver tracks whose mute changes refresh the link. */
	readonly #watched = new Set<MediaStreamTrack>();

	constructor(options: PeerLinkOptions) {
		this.#pc = options.connection;
		this.#polite = options.polite;
		this.#send = options.send;
		this.#onState = options.onState;
		this.#local = options.local;
		this.#remote = options.remote;
		this.#tracks = options.tracks;
		const pc = this.#pc;
		pc.addEventListener("icecandidate", (event) => {
			if (event.candidate !== null) this.#gatheredCandidate(event.candidate);
		});
		pc.addEventListener("connectionstatechange", () => {
			if (pc.connectionState === "connected") {
				this.#unavailable = false;
				clearTimeout(this.#connectTimer);
			}
			this.#refresh();
		});
		this.#armConnect();
		if (!this.#polite) {
			this.#addSections();
			this.#enqueue(() => this.#offer(false));
		}
	}

	get state(): LinkState {
		return this.#state;
	}

	get connected(): boolean {
		return this.#state === "connected";
	}

	/** The receiver track of the audio section, once a remote description is applied. */
	get remoteAudio(): MediaStreamTrack | undefined {
		return this.#remoteAudio;
	}

	/** The receiver track of the video section, once a remote description with one is applied and frames arrive. */
	get remoteVideo(): MediaStreamTrack | undefined {
		return this.#remoteVideo;
	}

	/** The name of the error that made this link unavailable (never a message: it can quote the SDP). */
	get fault(): string | undefined {
		return this.#fault;
	}

	update(local: Party, remote: Party): void {
		this.#local = local;
		this.#remote = remote;
		this.#enqueue(async () => {
			const added = !this.#polite && this.#addSections();
			const changed = await this.#applyPlan(!this.#polite);
			if (added || changed) await this.#offer(false);
		});
	}

	/** A local device changed: sends its track where the plan allows, or stops sending that medium. */
	setTrack(medium: Medium, track: MediaStreamTrack | null): void {
		this.#tracks = { ...this.#tracks, [medium]: track };
		this.#enqueue(async () => {
			await this.#applyPlan(false);
		});
	}

	receive(signal: LinkSignal): void {
		switch (signal.type) {
			case "offer":
				this.#enqueue(() => this.#answer(signal.negotiation, signal.sdp));
				break;
			case "answer":
				this.#enqueue(() => this.#accept(signal.negotiation, signal.sdp));
				break;
			case "ice":
				this.#enqueue(() =>
					this.#candidates(signal.negotiation, [...signal.candidates]),
				);
				break;
		}
	}

	restartIce(): void {
		if (this.#closed) return;
		this.#unavailable = false;
		this.#fault = undefined;
		this.#armConnect();
		this.#refresh();
		this.#enqueue(async () => {
			// Before the first offer arrives the polite side has no m-line to offer; the impolite side offers again.
			if (this.#polite && this.#pc.getTransceivers().length === 0) return;
			this.#pc.restartIce();
			await this.#offer(true);
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#epoch++;
		clearTimeout(this.#batchTimer);
		clearTimeout(this.#answerTimer);
		clearTimeout(this.#connectTimer);
		this.#batch = [];
		this.#pending = [];
		this.#pc.close();
	}

	#enqueue(task: () => Promise<void>): void {
		this.#queue = this.#queue
			.then(() => (this.#closed ? undefined : task()))
			.catch((error: unknown) => {
				if (this.#closed) return;
				this.#unavailable = true;
				this.#fault = error instanceof Error ? error.name : "Error";
				this.#refresh();
			});
	}

	/** `replace`: a lost offer (or an ICE restart) is replaced from have-local-offer; otherwise it waits for its answer. */
	async #offer(replace: boolean): Promise<void> {
		const pc = this.#pc;
		if (pc.signalingState === "have-local-offer" && !replace) {
			this.#offerAgain = true;
			return;
		}
		this.#offerAgain = false;
		const negotiation = ++this.#highest;
		await pc.setLocalDescription();
		if (this.#closed) return;
		this.#begin(negotiation);
		this.#offered = negotiation;
		this.#armAnswer(negotiation);
		this.#publish("offer", negotiation);
	}

	async #answer(negotiation: number, sdp: string): Promise<void> {
		const pc = this.#pc;
		// The impolite side ignores a colliding offer; the polite side rolls its own offer back.
		if (pc.signalingState === "have-local-offer" && !this.#polite) return;
		this.#highest = Math.max(this.#highest, negotiation);
		this.#offered = undefined;
		this.#offerAgain = false;
		clearTimeout(this.#answerTimer);
		this.#begin(negotiation);
		await pc.setRemoteDescription({ type: "offer", sdp });
		if (this.#closed) return;
		await this.#remoteApplied(negotiation);
		// Directions and tracks go on before the answer, so a symmetric pair needs one round.
		await this.#applyPlan(true);
		await pc.setLocalDescription();
		if (this.#closed) return;
		this.#publish("answer", negotiation);
		await this.#tune();
		this.#refresh();
	}

	async #accept(negotiation: number, sdp: string): Promise<void> {
		const pc = this.#pc;
		if (
			pc.signalingState !== "have-local-offer" ||
			negotiation !== this.#offered
		) {
			return;
		}
		this.#offered = undefined;
		clearTimeout(this.#answerTimer);
		await pc.setRemoteDescription({ type: "answer", sdp });
		if (this.#closed) return;
		await this.#remoteApplied(negotiation);
		await this.#tune();
		this.#refresh();
		if (this.#offerAgain) await this.#offer(false);
	}

	async #candidates(
		negotiation: number,
		candidates: IceCandidate[],
	): Promise<void> {
		if (negotiation !== this.#current) return;
		if (this.#applied !== negotiation) {
			const room = MAX_PENDING_CANDIDATES - this.#pending.length;
			this.#pending.push(...candidates.slice(0, Math.max(0, room)));
			return;
		}
		await this.#addCandidates(candidates);
	}

	async #addCandidates(candidates: IceCandidate[]): Promise<void> {
		for (const candidate of candidates) {
			// A remote candidate is untrusted input: one that the browser refuses is dropped, not a link failure.
			await this.#pc.addIceCandidate(candidate).catch(() => undefined);
			if (this.#closed) return;
		}
	}

	#begin(negotiation: number): void {
		if (this.#current !== negotiation) {
			this.#current = negotiation;
			this.#pending = [];
		}
		this.#applied = undefined;
	}

	async #remoteApplied(negotiation: number): Promise<void> {
		this.#applied = negotiation;
		const pending = this.#pending;
		this.#pending = [];
		await this.#addCandidates(pending);
	}

	/**
	 * Impolite side only: an audio section from the start, and a video section once the plan first sends or
	 * receives video. A pair with a compact device therefore never has one. A section is never removed; it goes
	 * inactive. Returns whether a section was added.
	 */
	#addSections(): boolean {
		const plan = mediaPlan(this.#local, this.#remote);
		const present = new Set(this.#pc.getTransceivers().map(mediumOf));
		let added = false;
		for (const medium of MEDIA) {
			const { send, direction } = plan[medium];
			if (
				present.has(medium) ||
				(medium === "video" && direction === "inactive")
			)
				continue;
			this.#pc.addTransceiver((send ? this.#tracks[medium] : null) ?? medium, {
				direction,
			});
			added = true;
		}
		return added;
	}

	/**
	 * Puts the media plan on the transceivers: tracks always, directions only when `directions` is set. Returns
	 * whether a direction changed. A video section that the plan does not allow (for example one offered to a
	 * compact device) goes inactive and gets no track.
	 */
	async #applyPlan(directions: boolean): Promise<boolean> {
		const plan = mediaPlan(this.#local, this.#remote);
		let changed = false;
		for (const transceiver of this.#pc.getTransceivers()) {
			if (transceiver.currentDirection === "stopped") continue;
			const medium = mediumOf(transceiver);
			const { send, direction } = plan[medium];
			if (directions && transceiver.direction !== direction) {
				transceiver.direction = direction;
				changed = true;
			}
			const track = send ? this.#tracks[medium] : null;
			if (transceiver.sender.track !== track) {
				await transceiver.sender.replaceTrack(track);
				if (this.#closed) return false;
			}
		}
		return changed;
	}

	/**
	 * Audio first on a poor network (call/layout plan §4.5): on a connection with video, audio senders get a high
	 * priority, and video senders a low one and keep their frame rate. Runs after each negotiation; a sender without
	 * encodings sends nothing yet and is tuned after a later one. Chrome keeps the values over renegotiation and
	 * replaceTrack (probe, Chrome 155).
	 */
	async #tune(): Promise<void> {
		const transceivers = this.#pc
			.getTransceivers()
			.filter((transceiver) => transceiver.currentDirection !== "stopped");
		if (!transceivers.some((transceiver) => mediumOf(transceiver) === "video"))
			return;
		for (const transceiver of transceivers) {
			const medium = mediumOf(transceiver);
			const priority = PRIORITY[medium];
			// getParameters and setParameters must run in the same task.
			const parameters = transceiver.sender.getParameters();
			const tuned =
				parameters.encodings.every(
					(encoding) =>
						encoding.priority === priority &&
						encoding.networkPriority === priority,
				) &&
				(medium === "audio" ||
					parameters.degradationPreference === "maintain-framerate");
			if (parameters.encodings.length === 0 || tuned) continue;
			for (const encoding of parameters.encodings) {
				encoding.priority = priority;
				encoding.networkPriority = priority;
			}
			if (medium === "video")
				parameters.degradationPreference = "maintain-framerate";
			await transceiver.sender.setParameters(parameters);
			if (this.#closed) return;
		}
	}

	/** Half-trickle: the description goes out when gathering completes or after GATHER_WAIT_MS. */
	#publish(type: "offer" | "answer", negotiation: number): void {
		const epoch = ++this.#epoch;
		this.#localNegotiation = negotiation;
		this.#trickle = false;
		this.#batch = [];
		clearTimeout(this.#batchTimer);
		this.#batchTimer = undefined;
		void this.#gathered().then(() => {
			if (epoch !== this.#epoch) return;
			const sdp = this.#pc.localDescription?.sdp;
			if (sdp === undefined) return;
			if (sdp.length > MAX_SDP_LENGTH) {
				this.#unavailable = true;
				this.#fault = "SdpTooLong";
				this.#refresh();
				return;
			}
			this.#trickle = true;
			this.#send({ type, negotiation, sdp });
		});
	}

	#gathered(): Promise<void> {
		const pc = this.#pc;
		return new Promise((resolve) => {
			if (pc.iceGatheringState === "complete") {
				resolve();
				return;
			}
			const done = (): void => {
				clearTimeout(timer);
				pc.removeEventListener("icegatheringstatechange", check);
				resolve();
			};
			const check = (): void => {
				if (pc.iceGatheringState === "complete") done();
			};
			const timer = setTimeout(done, GATHER_WAIT_MS);
			pc.addEventListener("icegatheringstatechange", check);
		});
	}

	/** A candidate gathered before the description went out is already in it. */
	#gatheredCandidate(candidate: RTCIceCandidate): void {
		if (this.#closed || !this.#trickle) return;
		const usableCandidate = usable(candidate);
		if (usableCandidate === undefined) return;
		this.#batch.push(usableCandidate);
		if (this.#batchTimer !== undefined) return;
		const epoch = this.#epoch;
		this.#batchTimer = setTimeout(() => {
			this.#batchTimer = undefined;
			if (epoch !== this.#epoch) return;
			const batch = this.#batch;
			this.#batch = [];
			for (let start = 0; start < batch.length; start += MAX_CANDIDATES) {
				this.#send({
					type: "ice",
					negotiation: this.#localNegotiation,
					candidates: batch.slice(start, start + MAX_CANDIDATES),
				});
			}
		}, ICE_BATCH_MS);
	}

	#armConnect(): void {
		clearTimeout(this.#connectTimer);
		this.#connectTimer = setTimeout(() => {
			this.#connectTimer = undefined;
			if (this.#closed || this.#pc.connectionState === "connected") return;
			this.#unavailable = true;
			this.#refresh();
		}, CONNECT_TIMEOUT_MS);
	}

	#armAnswer(negotiation: number): void {
		clearTimeout(this.#answerTimer);
		this.#answerTimer = setTimeout(() => {
			this.#answerTimer = undefined;
			if (this.#closed || this.#offered !== negotiation) return;
			if (this.#pc.connectionState === "connected") {
				// The media still flows; the lost renegotiation is offered again, unless its answer is queued.
				this.#enqueue(async () => {
					if (this.#offered === negotiation) await this.#offer(true);
				});
				return;
			}
			this.#unavailable = true;
			this.#refresh();
		}, ANSWER_TIMEOUT_MS);
	}

	#derive(): LinkState {
		if (this.#unavailable) return "unavailable";
		switch (this.#pc.connectionState) {
			case "connected":
				return "connected";
			case "disconnected":
				return "reconnecting";
			case "failed":
			case "closed":
				return "unavailable";
			default:
				return "connecting";
		}
	}

	/** Tells the owner when the state or a remote track changed. */
	#refresh(): void {
		if (this.#closed) return;
		const state = this.#derive();
		const remoteAudio = this.#receiverTrack("audio");
		const remoteVideo = this.#receiverTrack("video");
		if (
			state === this.#state &&
			remoteAudio === this.#remoteAudio &&
			remoteVideo === this.#remoteVideo
		)
			return;
		this.#state = state;
		this.#remoteAudio = remoteAudio;
		this.#remoteVideo = remoteVideo;
		this.#onState();
	}

	/**
	 * A video receiver track stays muted while no frames arrive, for example while the peer's camera is blocked:
	 * it gives no picture then, so no tile shows an empty video.
	 */
	#receiverTrack(medium: Medium): MediaStreamTrack | undefined {
		if (this.#pc.remoteDescription === null) return undefined;
		const track = this.#pc
			.getTransceivers()
			.find((transceiver) => mediumOf(transceiver) === medium)?.receiver.track;
		if (track === undefined || medium === "audio") return track;
		if (!this.#watched.has(track)) {
			this.#watched.add(track);
			track.addEventListener("mute", () => this.#refresh());
			track.addEventListener("unmute", () => this.#refresh());
		}
		return track.muted ? undefined : track;
	}
}
