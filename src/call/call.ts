import { SEATS, type Seat } from "../protocol";
import type { FailureCode } from "../result";
import type { Form } from "./device-class";
import { type CaptureState, type GetUserMedia, LocalMedia } from "./media";
import {
	type CallLink,
	CallMesh,
	type CallRoomSnapshot,
	type LinkOptions,
	type MeshStatus,
} from "./mesh";
import { type LinkState, PeerLink } from "./peer";
import {
	changeForm,
	join,
	joinPresets,
	leave,
	MEDIA,
	type Medium,
	mediaPlan,
	type Party,
	type Prefs,
	type Preset,
	presetById,
	type Switches,
	samePrefs,
	sendable,
	setSwitch,
	supports,
} from "./policy";
import type { OpenCallSignaling } from "./signaling";

/**
 * The call of one seat holder (call/layout plan §4.1, §4.5): the local preferences, the microphone and camera, the
 * mesh and one peer link per remote seat. The room view gives it room snapshots and user actions; it gives back a view
 * for rendering. It never touches the game: a call action cannot send a game command.
 */

export interface CallDeps {
	readonly openSignaling: OpenCallSignaling;
	readonly getUserMedia: GetUserMedia;
	readonly createConnection: () => RTCPeerConnection;
	readonly newSession: () => string;
}

/**
 * `unknown`: the local user is outside the call, so there is no way to know (ADR 0003: no call presence).
 * `waiting`: the local user is joining, or signaling is down, and the seat was not heard yet.
 * `out`: the seat is not in the call.
 */
export type RemoteStatus = "unknown" | "waiting" | "out" | LinkState;

export interface RemoteView {
	readonly seat: Seat;
	readonly status: RemoteStatus;
	/** The remote audio track, only while both sides allow it to reach this side. */
	readonly audio: MediaStreamTrack | undefined;
	/** The remote camera track, under the same rule. */
	readonly video: MediaStreamTrack | undefined;
	/** The peer's last announcement has its microphone switch on. */
	readonly peerSendsAudio: boolean;
	/** The peer's last announcement has its camera switch on (always off for a compact peer). */
	readonly peerSendsVideo: boolean;
	/** The name of the error that made the link unavailable. */
	readonly fault: string | undefined;
}

export interface CallView {
	readonly status: MeshStatus;
	/** This tab holds its seat, so Join can start. */
	readonly canJoin: boolean;
	readonly form: Form;
	/** The media whose switches work now. */
	readonly media: readonly Medium[];
	/** The presets the Join chooser offers now. */
	readonly presets: readonly Preset[];
	/** The local switches; `inCall` is false outside the call. */
	readonly requested: Prefs;
	readonly mic: CaptureState;
	readonly camera: CaptureState;
	readonly problem: FailureCode | undefined;
	/** The other seats, in N, E, S, W order. */
	readonly remotes: readonly RemoteView[];
}

export class CallController {
	readonly #deps: CallDeps;
	readonly #mesh: CallMesh;
	readonly #media: LocalMedia;
	readonly #links = new Map<Seat, PeerLink>();
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribe: () => void;
	/** Outside the call these are the switches that Join starts the call with. */
	#prefs: Prefs = { inCall: false, ...presetById("watch").switches };
	#form: Form;
	#self: Seat | undefined;
	/** The status that the mesh last announced for this seat. */
	#told: Party | undefined;

	constructor(deps: CallDeps, form: Form) {
		this.#deps = deps;
		this.#form = form;
		this.#media = new LocalMedia(deps.getUserMedia, (medium) =>
			this.#mediaChanged(medium),
		);
		this.#mesh = new CallMesh({
			openSignaling: deps.openSignaling,
			newSession: deps.newSession,
			createLink: (options) => this.#createLink(options),
		});
		this.#unsubscribe = this.#mesh.onChange(() => this.#meshChanged());
	}

	get view(): CallView {
		const status = this.#mesh.status;
		const local = this.#party();
		return {
			status,
			canJoin: this.#self !== undefined && !this.#prefs.inCall,
			form: this.#form,
			media: MEDIA.filter((medium) => supports(this.#form, medium)),
			presets: joinPresets(this.#form),
			requested: this.#prefs,
			mic: this.#media.state("audio"),
			camera: this.#media.state("video"),
			problem: this.#mesh.problem,
			remotes: SEATS.filter((seat) => seat !== this.#self).map((seat) =>
				this.#remote(seat, status, local),
			),
		};
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The room changed; a lost seat ends the call. */
	update(snapshot: CallRoomSnapshot): void {
		this.#self = snapshot.self?.seat;
		this.#mesh.update(snapshot);
	}

	/** The local user confirmed Join with the switches of the chooser. All available switches off stays outside. */
	join(selection: Switches): void {
		if (this.#self === undefined || this.#prefs.inCall) return;
		const allowed = this.#media.hasPreparedVideo()
			? selection
			: {
					...selection,
					send: { ...selection.send, video: false },
				};
		const prefs = join(allowed, this.#form);
		if (!prefs.inCall) return;
		this.#prefs = prefs;
		this.#told = this.#party();
		this.#mesh.join(this.#told);
		this.#capture(prefs);
	}

	/** One switch. Outside the call it only chooses what Join starts with; inside, the last switch off leaves the call. */
	setSwitch(way: "send" | "receive", medium: Medium, on: boolean): void {
		if (!this.#prefs.inCall) {
			this.#prefs = setSwitch(this.#prefs, this.#form, way, medium, on);
			this.#emit();
			return;
		}
		if (
			way === "send" &&
			medium === "video" &&
			on &&
			!this.#media.hasPreparedVideo()
		)
			return;
		const prefs = setSwitch(this.#prefs, this.#form, way, medium, on);
		if (!prefs.inCall) {
			this.#end(prefs);
			return;
		}
		this.#prefs = prefs;
		// Consent applies at once: a device stops before the peers hear of the change.
		this.#capture(prefs);
		this.#announce();
	}

	/** Selects a locally chosen camera for the next Send video capture. */
	setVideoDevice(deviceId: string | undefined): void {
		this.#media.selectVideoDevice(deviceId);
	}

	/**
	 * Holds the preview track locally until a subsequent explicit Send video action. Outside the call the Send
	 * camera switch only chooses what Join starts with, so it does not refuse the track.
	 */
	prepareVideo(track: MediaStreamTrack): boolean {
		if (
			this.#form !== "desktop" ||
			(this.#prefs.inCall && this.#prefs.send.video)
		)
			return false;
		return this.#media.prepareVideo(track);
	}

	/** The device class changed: a compact device keeps no video preference, and its camera stops at once. */
	setForm(form: Form): void {
		if (form === this.#form) return;
		this.#form = form;
		const prefs = changeForm(this.#prefs, form);
		if (!this.#prefs.inCall) {
			this.#prefs = prefs;
			this.#emit();
		} else if (!prefs.inCall) {
			this.#end(prefs);
		} else {
			this.#prefs = prefs;
			this.#capture(prefs);
			this.#announce();
		}
	}

	/** Asks for a new connection attempt to one seat. */
	retry(seat: Seat): void {
		this.#mesh.retry(seat);
	}

	leave(): void {
		if (this.#prefs.inCall) this.#end(leave(this.#prefs));
	}

	/** The room view is gone: leave the call and stop notifying. */
	dispose(): void {
		this.#listeners.clear();
		this.#unsubscribe();
		this.#prefs = leave(this.#prefs);
		this.#media.stop();
		this.#mesh.dispose();
	}

	#end(prefs: Prefs): void {
		this.#prefs = prefs;
		this.#media.stop();
		this.#mesh.leave();
	}

	/** The status for the peers: a device that the browser denied or that failed sends nothing. */
	#party(): Party {
		const unavailable = MEDIA.filter((medium) => {
			const state = this.#media.state(medium);
			return state === "denied" || state === "failed";
		});
		return { prefs: sendable(this.#prefs, unavailable), form: this.#form };
	}

	/** Gives the mesh this seat's status, unless the peers already have it. */
	#announce(): void {
		const party = this.#party();
		const told = this.#told;
		if (
			told !== undefined &&
			told.form === party.form &&
			samePrefs(told.prefs, party.prefs)
		) {
			return;
		}
		this.#told = party;
		this.#mesh.setLocal(party);
	}

	/** Each device runs only while its Send switch is on; the prefs already have video off on a compact device. */
	#capture(prefs: Prefs): void {
		for (const medium of MEDIA) {
			const enabled =
				prefs.send[medium] &&
				(medium !== "video" ||
					this.#media.hasPreparedVideo() ||
					this.#media.track("video") !== undefined);
			this.#media.set(medium, enabled);
			const track =
				prefs.inCall && enabled ? (this.#media.track(medium) ?? null) : null;
			for (const link of this.#links.values()) link.setTrack(medium, track);
		}
	}

	#createLink(options: LinkOptions): CallLink {
		const link = new PeerLink({
			...options,
			connection: this.#deps.createConnection(),
			tracks: {
				audio:
					this.#prefs.inCall && this.#prefs.send.audio
						? (this.#media.track("audio") ?? null)
						: null,
				video:
					this.#prefs.inCall && this.#prefs.send.video
						? (this.#media.track("video") ?? null)
						: null,
			},
		});
		this.#links.set(options.seat, link);
		return {
			get connected() {
				return link.connected;
			},
			update: (local, remote) => link.update(local, remote),
			receive: (signal) => link.receive(signal),
			restartIce: () => link.restartIce(),
			close: () => {
				if (this.#links.get(options.seat) === link) {
					this.#links.delete(options.seat);
				}
				link.close();
			},
		};
	}

	#mediaChanged(medium: Medium): void {
		const track =
			this.#prefs.inCall && this.#prefs.send[medium]
				? (this.#media.track(medium) ?? null)
				: null;
		for (const link of this.#links.values()) link.setTrack(medium, track);
		// A refused or failed device changes what the peers hear; a pending one does not.
		if (this.#prefs.inCall) this.#announce();
		this.#emit();
	}

	#meshChanged(): void {
		// The mesh left on its own: the seat was lost or the room is gone.
		if (this.#prefs.inCall && this.#mesh.status === "outside") {
			this.#prefs = leave(this.#prefs);
			this.#media.stop();
		}
		this.#emit();
	}

	#remote(seat: Seat, status: MeshStatus, local: Party): RemoteView {
		const peer = this.#mesh.peer(seat);
		const link = this.#links.get(seat);
		const base = {
			seat,
			peerSendsAudio: peer?.prefs.send.audio ?? false,
			peerSendsVideo: peer?.prefs.send.video ?? false,
			fault: link?.fault,
			audio: undefined,
			video: undefined,
		};
		if (status === "outside") return { ...base, status: "unknown" };
		if (link === undefined) {
			const heard = peer !== undefined || status === "subscribed";
			return { ...base, status: heard ? "out" : "waiting" };
		}
		// A track is shown only while the plan lets it reach this side, so Receive off clears it at once.
		const plan = mediaPlan(local, peer);
		return {
			...base,
			status: link.state,
			audio: plan.audio.receive ? link.remoteAudio : undefined,
			video: plan.video.receive ? link.remoteVideo : undefined,
		};
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}
