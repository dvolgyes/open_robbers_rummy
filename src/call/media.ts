import type { Medium } from "./policy";

/**
 * The local microphone and, on desktop, the camera. A capture starts only while the local
 * user is in the call with the matching Send switch on; the caller checks the device class. Every request has a
 * token: a result that arrives after the switch changed is stopped at once and never attached.
 */

/** `denied`: the browser or the user refused the permission; `failed`: no usable device, or the track ended. */
export type CaptureState = "off" | "pending" | "on" | "denied" | "failed";

export type GetUserMedia = (
	constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

/** Each request asks for one kind only, so a camera prompt never comes with the microphone, or the reverse. */
const CONSTRAINTS: Readonly<Record<Medium, MediaStreamConstraints>> = {
	audio: { audio: true, video: false },
	video: { audio: false, video: { width: 640, height: 360, frameRate: 15 } },
};

function constraintsFor(
	medium: Medium,
	videoDeviceId: string | undefined,
): MediaStreamConstraints {
	if (medium !== "video" || videoDeviceId === undefined)
		return CONSTRAINTS[medium];
	return {
		...CONSTRAINTS.video,
		video: {
			width: 640,
			height: 360,
			frameRate: 15,
			deviceId: { exact: videoDeviceId },
		},
	};
}

function refusal(error: unknown): CaptureState {
	const name = error instanceof DOMException ? error.name : "";
	return name === "NotAllowedError" || name === "SecurityError"
		? "denied"
		: "failed";
}

/** One capture device: at most one live track of its kind. */
class Capture {
	readonly #medium: Medium;
	readonly #getUserMedia: GetUserMedia;
	readonly #onChange: () => void;
	readonly #videoDeviceId: () => string | undefined;
	#state: CaptureState = "off";
	#track: MediaStreamTrack | undefined;
	#prepared: MediaStreamTrack | undefined;
	#request = 0;

	constructor(
		medium: Medium,
		getUserMedia: GetUserMedia,
		onChange: () => void,
		videoDeviceId: () => string | undefined,
	) {
		this.#medium = medium;
		this.#getUserMedia = getUserMedia;
		this.#onChange = onChange;
		this.#videoDeviceId = videoDeviceId;
	}

	get state(): CaptureState {
		return this.#state;
	}

	get track(): MediaStreamTrack | undefined {
		return this.#track;
	}

	set(on: boolean): void {
		if (!on) {
			this.stop();
			return;
		}
		if (this.#state === "on" || this.#state === "pending") return;
		if (this.#prepared !== undefined) {
			const track = this.#prepared;
			this.#prepared = undefined;
			this.#capturedTrack(track);
			return;
		}
		const token = ++this.#request;
		this.#state = "pending";
		this.#onChange();
		this.#getUserMedia(
			constraintsFor(this.#medium, this.#videoDeviceId()),
		).then(
			(stream) => this.#captured(token, stream),
			(error: unknown) => {
				if (token !== this.#request) return;
				this.#state = refusal(error);
				this.#onChange();
			},
		);
	}

	stop(): void {
		this.#request++;
		const track = this.#track;
		const prepared = this.#prepared;
		const changed = this.#state !== "off" || prepared !== undefined;
		this.#prepared = undefined;
		this.#track = undefined;
		this.#state = "off";
		track?.stop();
		prepared?.stop();
		if (changed) this.#onChange();
	}

	prepare(track: MediaStreamTrack): boolean {
		if (this.#medium !== "video" || track.kind !== "video") return false;
		if (track.readyState !== "live") return false;
		this.#request++;
		this.#track?.stop();
		this.#track = undefined;
		this.#state = "off";
		this.#prepared?.stop();
		this.#prepared = track;
		return true;
	}

	hasPrepared(): boolean {
		return this.#prepared !== undefined;
	}

	#captured(token: number, stream: MediaStream): void {
		const [audio, video] = [stream.getAudioTracks(), stream.getVideoTracks()];
		const [track, ...extra] = this.#medium === "audio" ? audio : video;
		const others = this.#medium === "audio" ? video : audio;
		for (const other of [...extra, ...others]) other.stop();
		if (token !== this.#request) {
			track?.stop();
			return;
		}
		if (track === undefined) {
			this.#state = "failed";
			this.#onChange();
			return;
		}
		this.#capturedTrack(track);
	}

	#capturedTrack(track: MediaStreamTrack): void {
		// `ended` fires when the device goes away or the permission is revoked, never after our own stop().
		track.addEventListener("ended", () => {
			if (this.#track !== track) return;
			this.#track = undefined;
			this.#state = "failed";
			this.#onChange();
		});
		this.#track = track;
		this.#state = "on";
		this.#onChange();
	}
}

export class LocalMedia {
	readonly #captures: Readonly<Record<Medium, Capture>>;
	#videoDeviceId: string | undefined;

	/** `onChange` names the medium whose state or track changed. */
	constructor(getUserMedia: GetUserMedia, onChange: (medium: Medium) => void) {
		this.#captures = {
			audio: new Capture(
				"audio",
				getUserMedia,
				() => onChange("audio"),
				() => undefined,
			),
			video: new Capture(
				"video",
				getUserMedia,
				() => onChange("video"),
				() => this.#videoDeviceId,
			),
		};
	}

	selectVideoDevice(deviceId: string | undefined): void {
		this.#videoDeviceId = deviceId;
	}

	state(medium: Medium): CaptureState {
		return this.#captures[medium].state;
	}

	/** The live track of the medium, if any. */
	track(medium: Medium): MediaStreamTrack | undefined {
		return this.#captures[medium].track;
	}

	/** Starts or stops one device to match the local Send switch of its medium. */
	set(medium: Medium, on: boolean): void {
		this.#captures[medium].set(on);
	}

	prepareVideo(track: MediaStreamTrack): boolean {
		return this.#captures.video.prepare(track);
	}

	hasPreparedVideo(): boolean {
		return this.#captures.video.hasPrepared();
	}

	/** Stops both devices and drops every pending request. */
	stop(): void {
		this.#captures.audio.stop();
		this.#captures.video.stop();
	}
}
