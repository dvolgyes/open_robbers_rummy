import { expect, type Locator, type Page } from "@playwright/test";
import type { SeatKey } from "./room";

/**
 * The call probe and page helpers shared by the call specs. The probe runs in each tab before the app: it wraps
 * the browser APIs that a call uses and counts their use. It records only counts, states, times, track ids and
 * byte or frame totals, never session descriptions, addresses or message contents.
 *
 * A tab has two kinds of peer connection: the game links of the table mesh (Trystero, one data channel each) and
 * the call links (media only, src/call/peer.ts). The probe tells them apart by what the page does with them: a
 * data channel makes a game link, a transceiver makes a call link.
 */

export type LinkKind = "mesh" | "call";

export interface PeerRecord {
	/** Unknown until the page opens a data channel or a transceiver on the connection. */
	kind: LinkKind | undefined;
	/** When the page closed the connection. */
	closedAt: number | null;
	/** The connection states it went through. */
	readonly states: string[];
}

export interface CallProbe {
	/** Every peer connection of this tab, in creation order, with its record at the same index. */
	readonly connections: RTCPeerConnection[];
	readonly records: PeerRecord[];
	/** The call links, in the order the probe recognized them. */
	readonly peers: RTCPeerConnection[];
	readonly tracks: MediaStreamTrack[];
	/** The devices of each capture request, in order. */
	readonly requests: { readonly audio: boolean; readonly video: boolean }[];
	/** The send and arrival times of each call message (`oc-call` frame) on the data channels of this tab. */
	readonly callSent: number[];
	readonly callReceived: number[];
	captures: number;
	/** Holds each captured stream back this long before the app gets it. */
	captureDelayMs: number;
	/** Holds each call message back this long before it goes on the data channel. */
	callSendDelayMs: number;
	/**
	 * Each later call link may use relay candidates only. There is no relay server, so its ICE checks really
	 * fail; the game links stay normal.
	 */
	callRelayOnly: boolean;
}

export interface ProbeCounts {
	/** Call links, ever and still open. */
	readonly peers: number;
	readonly openPeers: number;
	readonly captures: number;
	readonly liveTracks: number;
	/** Call messages sent and received. */
	readonly callSent: number;
	readonly callReceived: number;
}

export type Kind = "audio" | "video";

/** Runs in the page before the app, so it may use nothing from this module. */
export function installCallProbe(): void {
	const probe: CallProbe = {
		connections: [],
		records: [],
		peers: [],
		tracks: [],
		requests: [],
		callSent: [],
		callReceived: [],
		captures: 0,
		captureDelayMs: 0,
		callSendDelayMs: 0,
		callRelayOnly: false,
	};
	Object.defineProperty(window, "__callProbe", { value: probe });

	// Trystero wraps each action frame in a room frame: byte 0 is 1, bytes 1..2 give the length of the room token,
	// and the action frame follows the token. The action frame (wire version 2) names its action in its bytes
	// 2..33, padded with zeros, when it is an inline message (kind 0) or the offer of a large one (kind 1). Its
	// byte 1 holds the kind in the low 4 bits and the payload format in the high 4 bits. Only the token length,
	// the kind and the name are read.
	const callName = new TextEncoder().encode("oc-call");
	const isCallFrame = (data: unknown): boolean => {
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: ArrayBuffer.isView(data)
					? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
					: undefined;
		if (bytes === undefined || bytes.length < 3 || bytes[0] !== 1) return false;
		const start = 3 + (((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0));
		if (bytes.length < start + 36 || bytes[start] !== 2) return false;
		const kind = (bytes[start + 1] ?? 0) & 0x0f;
		if (kind !== 0 && kind !== 1) return false;
		for (let at = 0; at < 32; at++) {
			if (bytes[start + 2 + at] !== (callName[at] ?? 0)) return false;
		}
		return true;
	};
	const watched = new WeakSet<RTCDataChannel>();
	const watch = (channel: RTCDataChannel): void => {
		if (watched.has(channel)) return;
		watched.add(channel);
		channel.addEventListener("message", (event: MessageEvent) => {
			if (isCallFrame(event.data)) probe.callReceived.push(Date.now());
		});
	};
	const send = RTCDataChannel.prototype.send as (
		this: RTCDataChannel,
		data: unknown,
	) => void;
	(RTCDataChannel.prototype as { send: (data: unknown) => void }).send =
		function (this: RTCDataChannel, data: unknown) {
			if (!isCallFrame(data)) {
				send.call(this, data);
				return;
			}
			probe.callSent.push(Date.now());
			// A delay holds back the inline frame or the first frame of a large message, not its later chunks.
			// Call messages fit inline, so their order stays.
			const delay = probe.callSendDelayMs;
			if (delay <= 0) {
				send.call(this, data);
				return;
			}
			setTimeout(() => {
				if (this.readyState === "open") send.call(this, data);
			}, delay);
		};

	// No private class members here: Playwright compiles them to helper functions that the page does not have,
	// and the first new connection would throw.
	const recordOf = new WeakMap<RTCPeerConnection, PeerRecord>();
	const classify = (connection: RTCPeerConnection, kind: LinkKind): void => {
		const record = recordOf.get(connection);
		if (record === undefined || record.kind !== undefined) return;
		record.kind = kind;
		if (kind !== "call") return;
		probe.peers.push(connection);
		if (!probe.callRelayOnly) return;
		// Before ICE gathering starts: the offering side is classified at addTransceiver, the answering side at
		// the remote offer. The other settings stay as they are, because a change to them throws.
		const current = connection.getConfiguration();
		connection.setConfiguration({
			iceServers: current.iceServers,
			bundlePolicy: current.bundlePolicy,
			rtcpMuxPolicy: current.rtcpMuxPolicy,
			iceCandidatePoolSize: current.iceCandidatePoolSize,
			iceTransportPolicy: "relay",
		});
	};
	const Native = window.RTCPeerConnection;
	window.RTCPeerConnection = class extends Native {
		constructor(configuration?: RTCConfiguration) {
			super(configuration);
			const record: PeerRecord = {
				kind: undefined,
				closedAt: null,
				states: [],
			};
			recordOf.set(this, record);
			probe.connections.push(this);
			probe.records.push(record);
			this.addEventListener("connectionstatechange", () =>
				record.states.push(this.connectionState),
			);
			this.addEventListener("datachannel", (event: RTCDataChannelEvent) => {
				classify(this, "mesh");
				watch(event.channel);
			});
			// The answering side of a call link gets its transceivers from the remote offer.
			this.addEventListener("signalingstatechange", () => {
				if (this.getTransceivers().length > 0) classify(this, "call");
			});
		}

		override createDataChannel(
			label: string,
			options?: RTCDataChannelInit,
		): RTCDataChannel {
			const channel = super.createDataChannel(label, options);
			classify(this, "mesh");
			watch(channel);
			return channel;
		}

		override addTransceiver(
			trackOrKind: MediaStreamTrack | string,
			init?: RTCRtpTransceiverInit,
		): RTCRtpTransceiver {
			classify(this, "call");
			return super.addTransceiver(trackOrKind, init);
		}

		override close(): void {
			const record = recordOf.get(this);
			if (record !== undefined && record.closedAt === null)
				record.closedAt = Date.now();
			super.close();
		}
	};

	const devices = navigator.mediaDevices;
	const capture = devices.getUserMedia.bind(devices);
	devices.getUserMedia = async (constraints) => {
		probe.captures += 1;
		probe.requests.push({
			audio: Boolean(constraints?.audio),
			video: Boolean(constraints?.video),
		});
		const stream = await capture(constraints);
		probe.tracks.push(...stream.getTracks());
		const delay = probe.captureDelayMs;
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		return stream;
	};
}

export function counts(page: Page): Promise<ProbeCounts> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		return {
			peers: probe.peers.length,
			openPeers: probe.peers.filter((peer) => peer.connectionState !== "closed")
				.length,
			captures: probe.captures,
			liveTracks: probe.tracks.filter((track) => track.readyState === "live")
				.length,
			callSent: probe.callSent.length,
			callReceived: probe.callReceived.length,
		};
	});
}

/**
 * The connected game links, and the connected connections that the probe could not classify. A connection that
 * is not connected yet does not count: Trystero keeps an offer ready for the trackers.
 */
export function links(
	page: Page,
): Promise<{ readonly mesh: number; readonly unknown: number }> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		let mesh = 0;
		let unknown = 0;
		for (const [index, connection] of probe.connections.entries()) {
			if (connection.connectionState !== "connected") continue;
			const kind = probe.records[index]?.kind;
			if (kind === "mesh") mesh += 1;
			if (kind === undefined) unknown += 1;
		}
		return { mesh, unknown };
	});
}

/**
 * Cuts the game links of this tab, as a network change would: it closes every connected game connection, as the
 * harness `dropLinks` does. Trystero learns of the cut from the ICE state event. Call links and the offer that
 * Trystero keeps ready for the trackers stay open. Returns the number of links cut.
 */
export function cutGameLinks(page: Page): Promise<number> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		let closed = 0;
		for (const [index, connection] of probe.connections.entries()) {
			if (probe.records[index]?.kind !== "mesh") continue;
			if (connection.connectionState !== "connected") continue;
			connection.close();
			// close() fires no state event on this side; Trystero reads the state on this event and drops the link.
			connection.dispatchEvent(new Event("iceconnectionstatechange"));
			closed += 1;
		}
		return closed;
	});
}

/** The send and arrival times of the call messages of this tab. */
export function callFrames(
	page: Page,
): Promise<{ readonly sent: number[]; readonly received: number[] }> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		return { sent: [...probe.callSent], received: [...probe.callReceived] };
	});
}

/** From now on, this tab sends each call message `ms` milliseconds late; 0 sends at once again. */
export async function setCallSendDelay(page: Page, ms: number): Promise<void> {
	await page.evaluate((ms) => {
		(
			window as unknown as { __callProbe: CallProbe }
		).__callProbe.callSendDelayMs = ms;
	}, ms);
}

/** From now on, each new call link of this tab may use relay candidates only (`CallProbe.callRelayOnly`). */
export async function setCallRelayOnly(page: Page, on: boolean): Promise<void> {
	await page.evaluate((on) => {
		(
			window as unknown as { __callProbe: CallProbe }
		).__callProbe.callRelayOnly = on;
	}, on);
}

/** The ICE transport policy of each call link of the tab that is not closed. */
export function callTransportPolicies(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		(window as unknown as { __callProbe: CallProbe }).__callProbe.peers
			.filter((peer) => peer.connectionState !== "closed")
			.map((peer) => peer.getConfiguration().iceTransportPolicy ?? "all"),
	);
}

/**
 * The SSRC of the stream that this tab plays for `seat` (its `audio-` or `video-` element), read from the
 * receiver's inbound statistics. The partner's sender of that stream reports the same SSRC, so a test can find
 * the sender of one pair in another tab. An SSRC is a stream number, not an address.
 */
export function receivedSsrc(
	page: Page,
	seat: SeatKey,
	kind: Kind,
): Promise<number | undefined> {
	return page.evaluate(
		async ({ seat, kind }) => {
			const probe = (window as unknown as { __callProbe: CallProbe })
				.__callProbe;
			const element = document.querySelector(`[data-testid="${kind}-${seat}"]`);
			const stream =
				element instanceof HTMLMediaElement ? element.srcObject : null;
			if (!(stream instanceof MediaStream)) return undefined;
			const track = stream.getTracks().find((track) => track.kind === kind);
			if (track === undefined) return undefined;
			for (const peer of probe.peers) {
				if (peer.connectionState === "closed") continue;
				for (const transceiver of peer.getTransceivers()) {
					if (transceiver.receiver.track.id !== track.id) continue;
					const stats = await transceiver.receiver.getStats();
					for (const report of stats.values()) {
						if (report.type === "inbound-rtp" && report.kind === kind)
							return report.ssrc as number;
					}
				}
			}
			return undefined;
		},
		{ seat, kind },
	);
}

/**
 * The senders of the medium on the open call links of this tab, in link order: the SSRC, whether a track is
 * attached, and the bytes sent in 2 s.
 */
export function senderFlow(
	page: Page,
	kind: Kind,
): Promise<
	{
		readonly ssrc: number | undefined;
		readonly track: boolean;
		readonly bytes: number;
	}[]
> {
	return page.evaluate(async (kind) => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		const senders = probe.peers
			.filter((peer) => peer.connectionState !== "closed")
			.flatMap((peer) => peer.getTransceivers())
			.filter((transceiver) => transceiver.receiver.track.kind === kind)
			.map((transceiver) => transceiver.sender);
		const measure = () =>
			Promise.all(
				senders.map(async (sender) => {
					let ssrc: number | undefined;
					let bytes = 0;
					for (const report of (await sender.getStats()).values()) {
						if (report.type !== "outbound-rtp") continue;
						ssrc = report.ssrc as number;
						bytes = report.bytesSent as number;
					}
					return { ssrc, bytes };
				}),
			);
		const before = await measure();
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const after = await measure();
		return senders.map((sender, index) => ({
			ssrc: after[index]?.ssrc ?? before[index]?.ssrc,
			track: sender.track !== null,
			bytes: (after[index]?.bytes ?? 0) - (before[index]?.bytes ?? 0),
		}));
	}, kind);
}

/** The capture requests of this tab that asked for the device. */
export function requestsFor(page: Page, kind: Kind): Promise<number> {
	return page.evaluate(
		(kind) =>
			(
				window as unknown as { __callProbe: CallProbe }
			).__callProbe.requests.filter((request) => request[kind]).length,
		kind,
	);
}

/** The bytes of the medium that each open call link received, by probe index. */
export function peerBytes(
	page: Page,
	kind: Kind,
): Promise<Record<number, number>> {
	return page.evaluate(async (kind) => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		const bytes: Record<number, number> = {};
		for (const [index, peer] of probe.peers.entries()) {
			if (peer.connectionState === "closed") continue;
			let total = 0;
			const report = await peer.getStats();
			report.forEach(
				(entry: { type: string; kind?: string; bytesReceived?: number }) => {
					if (entry.type === "inbound-rtp" && entry.kind === kind)
						total += entry.bytesReceived ?? 0;
				},
			);
			bytes[index] = total;
		}
		return bytes;
	}, kind);
}

/** The audio bytes this tab received over all its open call links. */
export async function receivedAudioBytes(page: Page): Promise<number> {
	return Object.values(await peerBytes(page, "audio")).reduce(
		(sum, bytes) => sum + bytes,
		0,
	);
}

/**
 * The audio bytes each open call link received in two seconds, sorted. The first half second lets the packets
 * in flight land. A tone at 8 kbit/s and more gives about 2000 bytes; silence gives 0.
 */
export async function peerAudioGrowth(page: Page): Promise<number[]> {
	await page.waitForTimeout(500);
	const before = await peerBytes(page, "audio");
	await page.waitForTimeout(2_000);
	const after = await peerBytes(page, "audio");
	return Object.entries(after)
		.map(([index, total]) => total - (before[Number(index)] ?? 0))
		.sort((a, b) => a - b);
}

/** Bytes in two seconds that only a live sender gives. */
export const SOUND = 1_000;

/** Waits until the received audio grows: sound arrives now, not only earlier. */
export async function expectAudioArrives(page: Page): Promise<void> {
	const before = await receivedAudioBytes(page);
	await expect
		.poll(() => receivedAudioBytes(page), { timeout: 20_000 })
		.toBeGreaterThan(before + 1_000);
}

/** The negotiated direction of each transceiver of the medium over all open call links. */
export function directions(page: Page, kind: Kind): Promise<(string | null)[]> {
	return page.evaluate((kind) => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		return probe.peers
			.filter((peer) => peer.connectionState !== "closed")
			.flatMap((peer) => peer.getTransceivers())
			.filter((transceiver) => transceiver.receiver.track.kind === kind)
			.map((transceiver) => transceiver.currentDirection);
	}, kind);
}

export function setCaptureDelay(page: Page, ms: number): Promise<void> {
	return page.evaluate((delay) => {
		(
			window as unknown as { __callProbe: CallProbe }
		).__callProbe.captureDelayMs = delay;
	}, ms);
}

/** Polls every 200 ms until the check holds, and returns the time when it was seen. */
export async function timeWhen(
	check: () => Promise<boolean>,
	timeout: number,
	interval = 200,
): Promise<number> {
	await expect.poll(check, { intervals: [interval], timeout }).toBe(true);
	return Date.now();
}

export const SEAT_NAMES: Readonly<Record<SeatKey, string>> = {
	N: "North",
	E: "East",
	S: "South",
	W: "West",
};

/** The name on the tile of a seated player: the seat letter and the player name that createRoom gives. */
export const TILE_NAMES: Readonly<Record<SeatKey, string>> = {
	N: "N - player1",
	E: "E - player3",
	S: "S - player2",
	W: "W - player4",
};

export const panel = (page: Page): Locator => page.getByTestId("call-panel");
export const note = (page: Page): Locator => page.getByTestId("call-note");

/** The call note is for screen readers only: the panel clips it to one pixel, so it shows no text. */
export async function expectNoteUnseen(page: Page): Promise<void> {
	const box = await note(page).boundingBox();
	expect(box?.width ?? 0).toBeLessThanOrEqual(1);
	expect(box?.height ?? 0).toBeLessThanOrEqual(1);
}
export const caption = (page: Page, seat: SeatKey): Locator =>
	page.getByTestId(`tile-${seat}`).locator(".tile-caption");
export const toggle = (page: Page, name: string): Locator =>
	page.getByRole("button", { name, exact: true });
export const joinButton = (page: Page): Locator =>
	page.getByRole("button", { name: "Join call", exact: true });
export const leaveButton = (page: Page): Locator =>
	page.getByRole("button", { name: "Leave call", exact: true });
export const rejoinButton = (page: Page): Locator =>
	page.getByRole("button", { name: "Rejoin the call", exact: true });

/** The call switches, in the panel's order. */
const SWITCH_NAMES = [
	"Send mic audio",
	"Hear others: receive audio",
	"Send camera video",
	"See cameras: receive video",
] as const;

/** The switches of each mode of the handover §2 table, in SWITCH_NAMES order. */
const MODE_SWITCHES: Readonly<
	Record<string, readonly [boolean, boolean, boolean, boolean]>
> = {
	"Audio only": [true, true, false, false],
	"Send camera; hear others": [true, true, true, false],
	"See cameras; send voice": [true, true, false, true],
	"Audio + video both ways": [true, true, true, true],
	"Listen only": [false, true, false, false],
};

/**
 * Outside the call, the switches choose what Join starts with. A phone cannot turn on its video switches, so a
 * mode with video fails there.
 */
export async function chooseMode(page: Page, mode: string): Promise<void> {
	const wanted = MODE_SWITCHES[mode];
	if (wanted === undefined) throw new Error(`unknown call mode: ${mode}`);
	for (const [index, name] of SWITCH_NAMES.entries()) {
		const node = toggle(page, name);
		const pressed = String(wanted[index]);
		if ((await node.getAttribute("aria-pressed")) !== pressed) {
			await expect(node).toBeEnabled();
			await node.click();
		}
		await expect(node).toHaveAttribute("aria-pressed", pressed);
	}
}

/** Sets the switches of a mode, then joins; a mode that sends video confirms the camera preview first. */
export async function joinWith(page: Page, mode: string): Promise<void> {
	await chooseMode(page, mode);
	await joinButton(page).click();
	if (MODE_SWITCHES[mode]?.[2]) await confirmCamera(page);
	await expect(leaveButton(page)).toBeVisible();
}

/** Waits for the camera preview to show a picture, then sends the camera. */
export async function confirmCamera(page: Page): Promise<void> {
	const preview = page.getByTestId("camera-preview");
	await expect(preview).toBeVisible();
	await expect(page.getByTestId("camera-preview-confirm")).toBeEnabled();
	await page.getByTestId("camera-preview-confirm").click();
	await expect(preview).toBeHidden();
}
