import { expect, type Page, test } from "@playwright/test";
import {
	type CallProbe,
	caption,
	chooseMode,
	confirmCamera,
	counts,
	directions,
	expectAudioArrives,
	installCallProbe,
	joinButton,
	joinWith,
	leaveButton,
	peerAudioGrowth,
	peerBytes,
	receivedSsrc,
	requestsFor,
	SOUND,
	senderFlow,
	setCallSendDelay,
	timeWhen,
	toggle,
} from "./call-probe";
import { type ContextOptions, Player, reportNetwork } from "./player";
import { createRoom, pick, type SeatKey } from "./room";

/**
 * Desktop video and the asymmetric combinations (call/layout plan C6), on one P2P table through the public
 * trackers. West, North and South may use the microphone and the camera (generated test media); East may use
 * only the microphone until test 4. South is a phone, so it is audio only even with camera access.
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["W", "N", "E", "S"] as const satisfies readonly SeatKey[];
const DESKTOPS = ["W", "N", "E"] as const satisfies readonly SeatKey[];
type Desktop = (typeof DESKTOPS)[number];

const OPTIONS: Readonly<Record<SeatKey, ContextOptions>> = {
	W: { permissions: ["microphone", "camera"] },
	N: { permissions: ["microphone", "camera"] },
	E: { permissions: ["microphone"] },
	S: {
		permissions: ["microphone", "camera"],
		viewport: { width: 390, height: 664 },
		isMobile: true,
		hasTouch: true,
	},
};

/** The four switches in panel order, by accessible name. */
const SWITCH_NAMES = [
	"Send mic audio",
	"Hear others: receive audio",
	"Send camera video",
	"See cameras: receive video",
] as const;

type Mode = "audio" | "camera" | "watch" | "both" | "listen";

const MODE_LABELS: Readonly<Record<Mode, string>> = {
	audio: "Audio only",
	camera: "Send camera; hear others",
	watch: "See cameras; send voice",
	both: "Audio + video both ways",
	listen: "Listen only",
};

/** The switches of each mode, in SWITCH_NAMES order. */
const MODE_SWITCHES: Readonly<
	Record<Mode, readonly [boolean, boolean, boolean, boolean]>
> = {
	audio: [true, true, false, false],
	camera: [true, true, true, false],
	watch: [true, true, false, true],
	both: [true, true, true, true],
	listen: [false, true, false, false],
};

const sendsVideo = (mode: Mode): boolean => MODE_SWITCHES[mode][2];
const receivesVideo = (mode: Mode): boolean => MODE_SWITCHES[mode][3];

interface Box {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

const players = {} as Record<SeatKey, Player>;
const tab = {} as Record<SeatKey, Page>;

/** Whether the tile video of the seat has a source. */
function hasSource(page: Page, seat: SeatKey): Promise<boolean> {
	return page
		.getByTestId(`video-${seat}`)
		.evaluate((node) => (node as HTMLVideoElement).srcObject !== null);
}

/**
 * The seats whose tile video has a source, and the seats whose video frames arrive in 1.5 s, sorted. A frame
 * count is matched to its tile by the receiver track id; frames for no tile count as "unattached".
 */
function videoFlow(
	page: Page,
): Promise<{ attached: string[]; arriving: string[] }> {
	return page.evaluate(async () => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		const seatOf = new Map<string, string>();
		for (const seat of ["N", "E", "S", "W"]) {
			const node = document.querySelector(`[data-testid="video-${seat}"]`);
			const source = node instanceof HTMLVideoElement ? node.srcObject : null;
			const track =
				source instanceof MediaStream ? source.getVideoTracks()[0] : undefined;
			if (track !== undefined) seatOf.set(track.id, seat);
		}
		const frames = async (): Promise<Map<string, number>> => {
			const totals = new Map<string, number>();
			for (const peer of probe.peers) {
				if (peer.connectionState === "closed") continue;
				const report = await peer.getStats();
				report.forEach(
					(entry: {
						type: string;
						kind?: string;
						trackIdentifier?: string;
						framesReceived?: number;
					}) => {
						if (
							entry.type === "inbound-rtp" &&
							entry.kind === "video" &&
							entry.trackIdentifier !== undefined
						)
							totals.set(entry.trackIdentifier, entry.framesReceived ?? 0);
					},
				);
			}
			return totals;
		};
		const before = await frames();
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const after = await frames();
		const arriving = [...after]
			.filter(([id, count]) => count > (before.get(id) ?? 0))
			.map(([id]) => seatOf.get(id) ?? "unattached");
		return { attached: [...seatOf.values()].sort(), arriving: arriving.sort() };
	});
}

/** The open peer connections of the tab without a video section. */
function audioOnlyPeers(page: Page): Promise<number> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		return probe.peers.filter(
			(peer) =>
				peer.connectionState !== "closed" &&
				!peer
					.getTransceivers()
					.some((transceiver) => transceiver.receiver.track.kind === "video"),
		).length;
	});
}

/** The tab's camera tracks that are still live. */
function liveCameras(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			(
				window as unknown as { __callProbe: CallProbe }
			).__callProbe.tracks.filter(
				(track) => track.kind === "video" && track.readyState === "live",
			).length,
	);
}

async function expectSwitches(page: Page, mode: Mode): Promise<void> {
	for (const [index, name] of SWITCH_NAMES.entries()) {
		await expect(toggle(page, name)).toHaveAttribute(
			"aria-pressed",
			String(MODE_SWITCHES[mode][index]),
		);
	}
}

/**
 * Changes the mode with the panel switches; turning the camera on confirms its preview. Every mode keeps Hear
 * others on, so no step leaves the call.
 */
async function switchMode(page: Page, from: Mode, to: Mode): Promise<void> {
	await expectSwitches(page, from);
	for (const [index, name] of SWITCH_NAMES.entries()) {
		const wanted = MODE_SWITCHES[to][index];
		if (MODE_SWITCHES[from][index] === wanted) continue;
		await toggle(page, name).click();
		if (name === "Send camera video" && wanted) await confirmCamera(page);
		await expect(toggle(page, name)).toHaveAttribute(
			"aria-pressed",
			String(wanted),
		);
	}
}

/** The seats whose video may reach the viewer: x → y iff x sends video and y receives it (handover §3). */
function allowedTo(
	round: Readonly<Record<Desktop, Mode>>,
	viewer: Desktop,
): string[] {
	return DESKTOPS.filter(
		(seat) =>
			seat !== viewer &&
			sendsVideo(round[seat]) &&
			receivesVideo(round[viewer]),
	).sort();
}

async function expectRound(
	round: Readonly<Record<Desktop, Mode>>,
): Promise<void> {
	for (const viewer of DESKTOPS) {
		const allowed = allowedTo(round, viewer);
		await expect
			.poll(() => videoFlow(tab[viewer]), {
				message: `video at ${viewer}`,
				timeout: 30_000,
			})
			.toEqual({ attached: allowed, arriving: allowed });
		for (const seat of SEATS) {
			if (seat === viewer) continue;
			await expect(tab[viewer].getByTestId(`tile-${seat}`)).toHaveAttribute(
				"data-video",
				allowed.includes(seat) ? "on" : "off",
			);
		}
	}
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const seat of SEATS) {
		players[seat] = await Player.open(
			browser,
			baseURL,
			`video-${seat}`,
			OPTIONS[seat],
		);
		await players[seat].addInitScript(installCallProbe);
	}
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus)
		await reportNetwork(Object.values(players));
});

test.afterAll(async () => {
	for (const player of Object.values(players)) await player.close();
});

test("1: the phone cannot turn on video, the desktop can receive it, and nothing asks for the camera before Join", async () => {
	tab.W = await players.W.page("./");
	const link = await createRoom(tab.W);
	for (const seat of ["N", "E", "S"] as const) {
		tab[seat] = await players[seat].page(link);
		await pick(tab[seat], seat);
	}
	// The hosting page deals the first hand by itself, so there is no click here.
	await expect(tab.W.getByTestId("table")).toHaveAttribute(
		"data-phase",
		"play",
	);
	// Both forms show the four switches; outside the call they choose what Join starts with, and the phone cannot
	// turn on its two video switches.
	for (const seat of ["W", "S"] as const)
		for (const name of SWITCH_NAMES)
			await expect(toggle(tab[seat], name)).toHaveCount(1);
	await expect(toggle(tab.W, "See cameras: receive video")).toBeEnabled();
	await expect(toggle(tab.W, "Send camera video")).toBeEnabled();
	await expect(toggle(tab.S, "See cameras: receive video")).toBeDisabled();
	await expect(toggle(tab.S, "Send camera video")).toBeDisabled();
	for (const seat of SEATS) {
		for (const other of SEATS) {
			if (other === seat) continue;
			await expect(tab[seat].getByTestId(`video-${other}`)).toBeHidden();
			expect(await hasSource(tab[seat], other)).toBe(false);
		}
		expect(await requestsFor(tab[seat], "video")).toBe(0);
	}
});

test("2: a tile shows each call state in place, and a camera stream gets the low priority", async () => {
	const tile = tab.W.getByTestId("tile-N");
	const boxes: { state: string; box: Box | null }[] = [];
	// In page coordinates: the call panel is below the table, so a click on it scrolls the page.
	const record = async (state: string): Promise<void> => {
		const box = await tile.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			return {
				x: rect.x + window.scrollX,
				y: rect.y + window.scrollY,
				width: rect.width,
				height: rect.height,
			};
		});
		boxes.push({ state, box });
	};
	await expect(caption(tab.W, "N")).toHaveText("N - player1");
	await record("outside");

	await joinWith(tab.W, MODE_LABELS.both);
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Not in call");
	await record("Not in call");

	// West answers late: its call messages leave 4 s after the app sends them, so its link to North stays in
	// "Connecting" for seconds.
	await setCallSendDelay(tab.W, 4_000);
	await joinWith(tab.N, MODE_LABELS.audio);
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Connecting");
	await record("Connecting");
	await setCallSendDelay(tab.W, 0);
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Audio only");
	await expect(tile).toHaveAttribute("data-video", "off");
	await record("Audio only");

	await toggle(tab.N, "Send camera video").click();
	await confirmCamera(tab.N);
	await expect(toggle(tab.N, "Send camera video")).toHaveAttribute(
		"data-actual",
		"on",
	);
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Audio + video");
	await expect(tile).toHaveAttribute("data-video", "on");
	await expect(tab.W.getByTestId("video-N")).toHaveAttribute(
		"data-play",
		"playing",
	);
	await expect
		.poll(() =>
			tab.W.getByTestId("video-N").evaluate(
				(node) => (node as HTMLVideoElement).videoWidth,
			),
		)
		.toBeGreaterThan(0);
	await record("Audio + video");

	// North's only connection is the one to West: audio goes first on a poor network.
	await expect
		.poll(() =>
			tab.N.evaluate(() => {
				const probe = (window as unknown as { __callProbe: CallProbe })
					.__callProbe;
				const peer = probe.peers.find(
					(item) => item.connectionState !== "closed",
				);
				return peer?.getTransceivers().map((transceiver) => {
					const parameters = transceiver.sender.getParameters();
					return {
						kind: transceiver.receiver.track.kind,
						sending: transceiver.sender.track !== null,
						encodings: parameters.encodings.map((encoding) => [
							encoding.priority,
							encoding.networkPriority,
						]),
						degradation:
							transceiver.receiver.track.kind === "video"
								? parameters.degradationPreference
								: undefined,
					};
				});
			}),
		)
		.toEqual([
			{
				kind: "audio",
				sending: true,
				encodings: [["high", "high"]],
				degradation: undefined,
			},
			{
				kind: "video",
				sending: true,
				encodings: [["low", "low"]],
				degradation: "maintain-framerate",
			},
		]);

	await toggle(tab.W, "See cameras: receive video").click();
	await expect(caption(tab.W, "N")).toHaveText(
		"N - player1 · Video reception off",
	);
	await expect(tile).toHaveAttribute("data-video", "off");
	expect(await hasSource(tab.W, "N")).toBe(false);
	await record("Video reception off");

	const origin = boxes[0]?.box;
	if (origin === null || origin === undefined) throw new Error("no tile box");
	for (const { state, box } of boxes) {
		for (const key of ["x", "y", "width", "height"] as const) {
			expect(
				Math.abs((box?.[key] ?? Number.NaN) - origin[key]),
				`${state}: ${key}`,
			).toBeLessThanOrEqual(1);
		}
	}

	await toggle(tab.W, "See cameras: receive video").click();
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Audio + video");
});

test("3: with the camera blocked, the preview says so and Join waits; East joins without it, and nobody sees a picture of East", async () => {
	await chooseMode(tab.E, MODE_LABELS.both);
	await joinButton(tab.E).click();
	await expect(tab.E.getByTestId("camera-preview-status")).toHaveText(
		"Camera access was denied.",
	);
	await expect(tab.E.getByTestId("camera-preview-confirm")).toBeDisabled();
	await tab.E.getByTestId("camera-preview-cancel").click();
	await expect(tab.E.getByTestId("camera-preview")).toBeHidden();
	await expect(joinButton(tab.E)).toBeVisible();
	expect((await counts(tab.E)).openPeers).toBe(0);

	await joinWith(tab.E, MODE_LABELS.watch);
	await expect(toggle(tab.E, "Send mic audio")).toHaveAttribute(
		"data-actual",
		"on",
	);
	for (const seat of DESKTOPS) {
		await expect
			.poll(
				async () => {
					const growth = await peerAudioGrowth(tab[seat]);
					return growth.length === 2 && growth.every((bytes) => bytes > SOUND);
				},
				{ message: `audio at ${seat}` },
			)
			.toBe(true);
	}
	// West receives video from North only; North receives none; East receives both pictures.
	await expect
		.poll(() => videoFlow(tab.W))
		.toEqual({
			attached: ["N"],
			arriving: ["N"],
		});
	await expect(caption(tab.W, "E")).toHaveText("E - player3 · Audio only");
	await expect
		.poll(() => videoFlow(tab.N))
		.toEqual({
			attached: [],
			arriving: [],
		});
	await expect
		.poll(() => videoFlow(tab.E))
		.toEqual({
			attached: ["N", "W"],
			arriving: ["N", "W"],
		});
	expect(await requestsFor(tab.E, "video")).toBe(1);
});

/**
 * A covering set of mode pairs (call/layout plan C6): each mode sends next to a peer that receives video and
 * one that does not, in A by Join, then in B and C by the switches of a running call.
 *   A: West both, North camera, East watch.  B: West camera, North watch, East audio.
 *   C: West listen, North both, East camera.
 */
const ROUND_A = { W: "both", N: "camera", E: "watch" } as const;
const ROUND_B = { W: "camera", N: "watch", E: "audio" } as const;
const ROUND_C = { W: "listen", N: "both", E: "camera" } as const;

test("4: video frames arrive only where the sender sends and the receiver receives", async () => {
	for (const seat of DESKTOPS) {
		await leaveButton(tab[seat]).click();
		await expect(joinButton(tab[seat])).toBeVisible();
	}
	await players.E.grantPermissions(["camera"]);
	const eastCamera = await requestsFor(tab.E, "video");
	for (const seat of DESKTOPS)
		await joinWith(tab[seat], MODE_LABELS[ROUND_A[seat]]);
	for (const seat of DESKTOPS) await expectSwitches(tab[seat], ROUND_A[seat]);
	await expect(toggle(tab.N, "Send camera video")).toHaveAttribute(
		"data-actual",
		"on",
	);
	await expectRound(ROUND_A);
	// East watches: it gets the pictures and does not ask for the camera.
	expect(await requestsFor(tab.E, "video")).toBe(eastCamera);

	for (const seat of DESKTOPS)
		await switchMode(tab[seat], ROUND_A[seat], ROUND_B[seat]);
	await expectRound(ROUND_B);

	for (const seat of DESKTOPS)
		await switchMode(tab[seat], ROUND_B[seat], ROUND_C[seat]);
	await expectRound(ROUND_C);
	await expect(toggle(tab.E, "Send camera video")).toHaveAttribute(
		"data-actual",
		"on",
	);
});

test("5: a seat that turns off See cameras gets no video from its partners, and their video to a third seat continues", async () => {
	// Owner, 2026-10-19: a receiver can ask its partners to stop sending video. All three desktops send and see.
	const all = { W: "both", N: "both", E: "both" } as const;
	await switchMode(tab.W, ROUND_C.W, all.W);
	await switchMode(tab.E, ROUND_C.E, all.E);
	await expectRound(all);
	// North's video senders to East and to West, by the SSRC that each receiver sees. The link order stays while
	// no link opens or closes.
	const toEast = await receivedSsrc(tab.E, "N", "video");
	const toWest = await receivedSsrc(tab.W, "N", "video");
	const flowing = await senderFlow(tab.N, "video");
	const eastSender = flowing.findIndex((sender) => sender.ssrc === toEast);
	const westSender = flowing.findIndex((sender) => sender.ssrc === toWest);
	expect(toEast).toBeDefined();
	expect(eastSender).toBeGreaterThanOrEqual(0);
	expect(westSender).toBeGreaterThanOrEqual(0);

	await toggle(tab.E, "See cameras: receive video").click();
	await expect(caption(tab.E, "N")).toHaveText(
		"N - player1 · Video reception off",
	);
	// The sender side: North's sender to East has no track and sends nothing; its sender to West goes on.
	await expect
		.poll(async () => (await senderFlow(tab.N, "video"))[eastSender]?.track)
		.toBe(false);
	const paused = await senderFlow(tab.N, "video");
	console.error(`pause: North's video senders ${JSON.stringify(paused)}`);
	expect(paused[eastSender]?.bytes).toBe(0);
	expect(paused[westSender]?.track).toBe(true);
	expect(paused[westSender]?.bytes).toBeGreaterThan(SOUND);
	await expectRound({ ...all, E: "camera" });

	await toggle(tab.E, "See cameras: receive video").click();
	await expectRound(all);
	await expect
		.poll(async () =>
			(await senderFlow(tab.N, "video")).map(
				(sender) => sender.track && sender.bytes > SOUND,
			),
		)
		.toEqual([true, true]);

	// Round C again, for the phone.
	await switchMode(tab.W, all.W, ROUND_C.W);
	await switchMode(tab.E, all.E, ROUND_C.E);
	await expectRound(ROUND_C);
});

test("6: a phone gets audio only next to camera senders, also when an offer forces video on it", async () => {
	await joinWith(tab.S, MODE_LABELS.audio);
	await expectAudioArrives(tab.S);
	for (const seat of DESKTOPS) {
		await expect.poll(() => audioOnlyPeers(tab[seat])).toBe(1);
		await expect(caption(tab.S, seat)).toHaveText(/· (Audio only|Mic off)$/);
	}
	expect(await directions(tab.S, "video")).toEqual([]);
	expect(await videoFlow(tab.S)).toEqual({ attached: [], arriving: [] });
	// The desktop receiver still gets its picture: North sees East.
	await expectRound(ROUND_C);

	// North adds a sendrecv video section with a drawn track to its connection to South, and keeps it from
	// being turned off; its next offer carries it.
	await tab.N.evaluate(() => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		const peer = probe.peers.find(
			(item) =>
				item.connectionState !== "closed" &&
				!item
					.getTransceivers()
					.some((transceiver) => transceiver.receiver.track.kind === "video"),
		);
		if (peer === undefined) throw new Error("no audio-only connection");
		const canvas = document.createElement("canvas");
		canvas.width = 64;
		canvas.height = 36;
		const context = canvas.getContext("2d");
		let shade = 0;
		setInterval(() => {
			shade = (shade + 16) % 256;
			if (context === null) return;
			context.fillStyle = `rgb(${shade}, 0, 0)`;
			context.fillRect(0, 0, canvas.width, canvas.height);
		}, 66);
		const [track] = canvas.captureStream(15).getVideoTracks();
		if (track === undefined) throw new Error("no canvas track");
		const transceiver = peer.addTransceiver(track, { direction: "sendrecv" });
		Object.defineProperty(transceiver, "direction", {
			get: () => "sendrecv",
			set: () => undefined,
		});
		Object.defineProperty(transceiver.sender, "replaceTrack", {
			value: async () => undefined,
		});
	});
	const mic = toggle(tab.N, "Send mic audio");
	await mic.click();
	await expect(mic).toHaveAttribute("aria-pressed", "false");
	await expect.poll(() => directions(tab.S, "video")).toEqual(["inactive"]);
	await mic.click();
	await expect(mic).toHaveAttribute("aria-pressed", "true");
	expect(await videoFlow(tab.S)).toEqual({ attached: [], arriving: [] });
	expect(Object.values(await peerBytes(tab.S, "video"))).toEqual([0, 0, 0]);
	expect(await requestsFor(tab.S, "video")).toBe(0);
	for (const seat of DESKTOPS) expect(await hasSource(tab.S, seat)).toBe(false);
	await expectAudioArrives(tab.S);
});

test("7: a desktop that becomes compact stops its camera at once and keeps the audio; video stays off afterwards", async () => {
	await switchMode(tab.W, ROUND_C.W, "both");
	await expect(toggle(tab.W, "Send camera video")).toHaveAttribute(
		"data-actual",
		"on",
	);
	await expect
		.poll(() => videoFlow(tab.W))
		.toEqual({
			attached: ["E", "N"],
			arriving: ["E", "N"],
		});
	await expect.poll(() => hasSource(tab.N, "W")).toBe(true);
	const cameraRequests = await requestsFor(tab.W, "video");

	const start = Date.now();
	await tab.W.setViewportSize({ width: 800, height: 720 });
	const ended = await timeWhen(
		async () => (await liveCameras(tab.W)) === 0,
		5_000,
		50,
	);
	console.log(`compact: camera ended ${ended - start} ms after the resize`);
	expect(ended - start).toBeLessThanOrEqual(1_000);
	await expect(toggle(tab.W, "Send camera video")).toBeDisabled();
	await expect(toggle(tab.W, "Send camera video")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	for (const seat of ["N", "E", "S"] as const)
		expect(await hasSource(tab.W, seat)).toBe(false);
	await expectAudioArrives(tab.W);
	for (const bytes of await peerAudioGrowth(tab.N))
		expect(bytes).toBeGreaterThan(SOUND);
	await expect.poll(() => hasSource(tab.N, "W")).toBe(false);

	await tab.W.setViewportSize({ width: 1280, height: 720 });
	await expect(toggle(tab.W, "Send camera video")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(toggle(tab.W, "See cameras: receive video")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(toggle(tab.W, "Send mic audio")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// The absence of a new camera request needs time to show.
	await tab.W.waitForTimeout(3_000);
	expect(await requestsFor(tab.W, "video")).toBe(cameraRequests);
	expect(await liveCameras(tab.W)).toBe(0);
	for (const seat of ["N", "E", "S"] as const)
		expect(await hasSource(tab.W, seat)).toBe(false);
});

test("8: the phone leaves with its icon: its microphone and connections end, and the desktops see Not in call", async () => {
	await leaveButton(tab.S).click();
	await expect(joinButton(tab.S)).toBeVisible();
	await expect
		.poll(async () => {
			const { openPeers, liveTracks } = await counts(tab.S);
			return { openPeers, liveTracks };
		})
		.toEqual({ openPeers: 0, liveTracks: 0 });
	for (const seat of DESKTOPS) {
		await expect(caption(tab[seat], "S")).toHaveText(
			"S - player2 · Not in call",
		);
		await expect.poll(async () => (await counts(tab[seat])).openPeers).toBe(2);
	}
});

test("no uncaught errors and no request to the old backend", () => {
	expect(Object.values(players).flatMap((player) => player.errors)).toEqual([]);
	for (const player of Object.values(players))
		expect(player.supabaseRequests).toBe(0);
});
