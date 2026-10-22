import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	type CallProbe,
	callFrames,
	caption,
	chooseMode,
	counts,
	cutGameLinks,
	directions,
	expectAudioArrives,
	expectNoteUnseen,
	installCallProbe,
	joinButton,
	joinWith,
	leaveButton,
	links,
	note,
	panel,
	peerAudioGrowth,
	receivedSsrc,
	rejoinButton,
	SEAT_NAMES,
	SOUND,
	senderFlow,
	setCaptureDelay,
	TILE_NAMES,
	timeWhen,
	toggle,
} from "./call-probe";
import { type ContextOptions, Player, reportNetwork } from "./player";
import { CONNECT_MS, createRoom, expectSeat, pick, type SeatKey } from "./room";

/**
 * The audio call between real browsers (call/layout plan C5a and C5b), on one P2P table through the public
 * trackers. Call messages travel on the game links' data channels; the media goes over a call link per pair.
 * West, North and South may use the microphone (a generated tone); East may not until test 9. South is a phone.
 * A probe in each tab (call-probe.ts) counts the call activity: call links, microphone requests and call
 * messages. Each seat's call status is stored in the table (plan §12 R2), so a reload joins the call again.
 */
test.describe.configure({ mode: "serial" });

/** The probe index, close time and states of each call link. */
function peerLog(
	page: Page,
): Promise<{ index: number; closedAt: number | null; states: string[] }[]> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		return probe.connections.flatMap((_, index) => {
			const record = probe.records[index];
			return record?.kind === "call"
				? [{ index, closedAt: record.closedAt, states: [...record.states] }]
				: [];
		});
	});
}

/**
 * The command types in this browser's stored table log, in log order: "seat" for a seat entry. A read-only look
 * at the replica in IndexedDB; this browser holds one table and one seat.
 */
function loggedTypes(page: Page): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve, reject) => {
				const opened = indexedDB.open("oc-p2p");
				opened.onerror = () => reject(opened.error);
				opened.onsuccess = () => {
					const db = opened.result;
					const read = db
						.transaction("entries", "readonly")
						.objectStore("entries")
						.getAll();
					read.onerror = () => reject(read.error);
					read.onsuccess = () => {
						db.close();
						const rows = read.result as {
							seq: number;
							entry: { kind: string; payload?: { type?: unknown } };
						}[];
						resolve(
							rows
								.sort((a, b) => a.seq - b.seq)
								.map(({ entry }) =>
									entry.kind === "seat" ? "seat" : String(entry.payload?.type),
								),
						);
					};
				};
			}),
	);
}

/** The largest number of times that fall in one window [t, t + width). */
function peakPerWindow(times: readonly number[], width: number): number {
	const sorted = [...times].sort((a, b) => a - b);
	let peak = 0;
	let start = 0;
	for (const [end, time] of sorted.entries()) {
		while (time - (sorted[start] ?? time) >= width) start += 1;
		peak = Math.max(peak, end - start + 1);
	}
	return peak;
}

const SEATS = ["W", "N", "E", "S"] as const satisfies readonly SeatKey[];
/** East may not use the microphone; South is a phone. */
const OPTIONS: Readonly<Record<SeatKey, ContextOptions>> = {
	W: { permissions: ["microphone"] },
	N: { permissions: ["microphone"] },
	E: { permissions: [] },
	S: {
		permissions: ["microphone"],
		viewport: { width: 390, height: 664 },
		isMobile: true,
		hasTouch: true,
	},
};

const players = {} as Record<SeatKey, Player>;
const tab = {} as Record<SeatKey, Page>;

/** The seats that the call note names as connected, sorted. */
async function connectedTo(page: Page): Promise<string[]> {
	const text = (await note(page).textContent()) ?? "";
	return (/Connected to ([^.]*)\./.exec(text)?.[1]?.split(", ") ?? []).sort();
}

const othersOf = (seat: SeatKey): string[] =>
	SEATS.filter((other) => other !== seat)
		.map((other) => SEAT_NAMES[other])
		.sort();

async function openTab(seat: SeatKey, url: string): Promise<void> {
	tab[seat] = await players[seat].page(url);
}

/** Reloads the tab and waits until it holds its seat again. */
async function reload(seat: SeatKey): Promise<void> {
	await tab[seat].reload();
	await expectSeat(tab[seat], seat, {
		timeout: CONNECT_MS,
	});
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const seat of SEATS) {
		// East's trackers can be cut in test 6.
		players[seat] = await Player.open(
			browser,
			baseURL,
			`audio-${seat}`,
			OPTIONS[seat],
			{ trackerSwitch: seat === "E" },
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

test("1: without Join, the table makes no call activity", async () => {
	await openTab("W", "./");
	const link = await createRoom(tab.W);
	await openTab("N", link);
	await pick(tab.N, "N");
	await openTab("E", link);
	await pick(tab.E, "E");
	await openTab("S", link);
	await pick(tab.S, "S");
	for (const page of Object.values(tab)) {
		await expect(panel(page)).toHaveAttribute("data-status", "outside");
		await expect(note(page)).toHaveText("");
		await expect(joinButton(page)).toBeEnabled();
	}
	// The tiles come with the first hand. Outside the call nobody's call status is known, so they show names.
	// The hosting page deals the first hand by itself, so there is no click here.
	await expect(tab.W.getByTestId("table")).toHaveAttribute(
		"data-phase",
		"play",
	);
	await expect(caption(tab.W, "N")).toHaveText("N - player1");
	// The absence of activity needs time to show: the game links carry beats meanwhile.
	await tab.W.waitForTimeout(4_000);
	for (const seat of SEATS) {
		// The probe sees the three game links of each tab, so its zero call counts are meaningful.
		await expect
			.poll(() => links(tab[seat]), { timeout: CONNECT_MS })
			.toEqual({ mesh: 3, unknown: 0 });
		expect(await counts(tab[seat])).toEqual({
			peers: 0,
			openPeers: 0,
			captures: 0,
			liveTracks: 0,
			callSent: 0,
			callReceived: 0,
		});
		expect(await loggedTypes(tab[seat])).not.toContain("media");
	}
});

test("2: two seats on Audio only hear each other, and the call stores only its status in the table", async () => {
	const table = tab.W.getByTestId("table");
	const before = {
		phase: await table.getAttribute("data-phase"),
		hand: await table.getAttribute("data-hand"),
		at: await table.getAttribute("data-at"),
	};
	const logged = (await loggedTypes(tab.W)).length;

	await joinWith(tab.W, "Audio only");
	await joinWith(tab.N, "Audio only");
	await expect(note(tab.W)).toHaveText(/Connected to North\./);
	await expect(note(tab.N)).toHaveText(/Connected to West\./);
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Audio only");
	await expect(caption(tab.N, "W")).toHaveText("W - player4 · Audio only");
	await expect(toggle(tab.W, "Send mic audio")).toHaveAttribute(
		"data-actual",
		"on",
	);
	await expectAudioArrives(tab.W);
	await expectAudioArrives(tab.N);
	await expect(tab.W.getByTestId("audio-N")).toHaveAttribute(
		"data-play",
		"playing",
	);

	// The probe sees the call, so its zero counts elsewhere are meaningful.
	const west = await counts(tab.W);
	expect(west.captures).toBe(1);
	expect(west.openPeers).toBeGreaterThan(0);
	expect(west.callSent).toBeGreaterThan(0);
	// East and South stayed outside: other calls do not make them capture, connect or send call messages.
	for (const seat of ["E", "S"] as const) {
		expect(await counts(tab[seat])).toMatchObject({
			peers: 0,
			captures: 0,
			callSent: 0,
		});
	}

	// Each join adds one call status to the log (R2) and no game command; the game did not move.
	await expect
		.poll(async () => (await loggedTypes(tab.W)).slice(logged))
		.toEqual(["media", "media"]);
	expect({
		phase: await table.getAttribute("data-phase"),
		hand: await table.getAttribute("data-hand"),
		at: await table.getAttribute("data-at"),
	}).toEqual(before);
});

test("3: Send off and Hear off change one direction, and each side shows the result", async () => {
	await toggle(tab.N, "Send mic audio").click();
	await expect(toggle(tab.N, "Send mic audio")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Mic off");
	await toggle(tab.N, "Send mic audio").click();
	await expect(toggle(tab.N, "Send mic audio")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Audio only");

	await toggle(tab.W, "Hear others: receive audio").click();
	await expect(toggle(tab.W, "Hear others: receive audio")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(tab.W.getByTestId("audio-N")).toHaveAttribute(
		"data-play",
		"off",
	);
	await expect(caption(tab.W, "N")).toHaveText(
		"N - player1 · Audio reception off",
	);
	await toggle(tab.W, "Hear others: receive audio").click();
	await expect(tab.W.getByTestId("audio-N")).toHaveAttribute(
		"data-play",
		"playing",
	);
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Audio only");
	await expectAudioArrives(tab.W);
});

test("4: Listen only needs no microphone, and a refused microphone stays out of the call box", async () => {
	await joinWith(tab.E, "Listen only");
	await expect(note(tab.E)).toHaveText(
		/Connected to (North, West|West, North)\./,
	);
	await expect(caption(tab.E, "W")).toHaveText("W - player4 · Audio only");
	await expect(caption(tab.W, "E")).toHaveText("E - player3 · Mic off");
	await expectAudioArrives(tab.E);
	expect((await counts(tab.E)).captures).toBe(0);

	await toggle(tab.E, "Send mic audio").click();
	const send = toggle(tab.E, "Send mic audio");
	await expect(send).toHaveAttribute("aria-pressed", "true");
	await expect(send).toHaveAttribute("data-actual", "denied");
	await expect(note(tab.E)).toContainText(
		"The browser blocks the microphone: others cannot hear you.",
	);
	await expectNoteUnseen(tab.E);
	expect((await counts(tab.E)).captures).toBe(1);
	// The others still reach East; only East's sending failed.
	await expect(caption(tab.W, "E")).toHaveText("E - player3 · Mic off");
	await expectAudioArrives(tab.E);
});

test("5: Leave stops the microphone and the connections, and the others see Not in call", async () => {
	await leaveButton(tab.N).click();
	await expect(joinButton(tab.N)).toBeVisible();
	await expect(panel(tab.N)).toHaveAttribute("data-status", "outside");
	await expect
		.poll(async () => {
			const north = await counts(tab.N);
			return { openPeers: north.openPeers, liveTracks: north.liveTracks };
		})
		.toEqual({ openPeers: 0, liveTracks: 0 });
	await expect(caption(tab.W, "N")).toHaveText("N - player1 · Not in call");
	await expect(caption(tab.E, "N")).toHaveText("N - player1 · Not in call");
	await expect(note(tab.W)).toHaveText(/Connected to East\./);
});

test("6: after East's game links and trackers are cut for longer than 10 s, the call comes back and the audio flows again", async () => {
	test.setTimeout(240_000);
	// A network change: the data channels that carry the call messages close, and no tracker can be reached.
	// The call link itself stays open, as in plan §12 R1 only the game links are cut.
	await players.E.network.block();
	expect(await cutGameLinks(tab.E)).toBe(3);
	// Without game links East is offline for the others; after 10 s each side drops the call link.
	await expect(caption(tab.W, "E")).toHaveText("E - player3 · Not in call", {
		timeout: 30_000,
	});
	await expect
		.poll(async () => (await counts(tab.E)).openPeers, { timeout: 30_000 })
		.toBe(0);
	const cut = Date.now();
	players.E.network.unblock();
	await expect(note(tab.E)).toHaveText(/Connected to West\./, {
		timeout: 120_000,
	});
	console.error(
		`cut: the call came back ${Date.now() - cut} ms after the trackers returned`,
	);
	await expect(caption(tab.W, "E")).toHaveText("E - player3 · Mic off");
	await expect(caption(tab.E, "W")).toHaveText("W - player4 · Audio only");
	await expectAudioArrives(tab.E);
});

test("7: outside the call, the keyboard reaches the switches from Join and changes them", async () => {
	const captures = (await counts(tab.N)).captures;
	const join = joinButton(tab.N);
	const mic = toggle(tab.N, "Send mic audio");
	await join.focus();
	// The switches follow Join in the panel, so the next Tab stop is the first switch.
	await tab.N.keyboard.press("Tab");
	await expect(mic).toBeFocused();
	const before = await mic.getAttribute("aria-pressed");
	const flipped = before === "true" ? "false" : "true";
	await tab.N.keyboard.press("Space");
	await expect(mic).toHaveAttribute("aria-pressed", flipped);
	await tab.N.keyboard.press("Space");
	await expect(mic).toHaveAttribute("aria-pressed", before ?? "false");
	await expect(leaveButton(tab.N)).toHaveCount(0);
	// Outside the call, a switch only chooses what Join starts with; it starts nothing.
	expect((await counts(tab.N)).captures).toBe(captures);
});

test("8: a reload joins the call again with the stored switches; a page outside the call stays outside", async () => {
	// Plan §12 R2: West is in the call with Audio only, and the browser lets this site use the microphone.
	await reload("W");
	await expect(leaveButton(tab.W)).toBeVisible();
	await expect(toggle(tab.W, "Send mic audio")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(toggle(tab.W, "Hear others: receive audio")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(note(tab.W)).toHaveText(/Connected to East\./, {
		timeout: 30_000,
	});
	await expect(caption(tab.E, "W")).toHaveText("W - player4 · Audio only");
	await expectAudioArrives(tab.E);
	expect(await counts(tab.W)).toMatchObject({ captures: 1, liveTracks: 1 });

	// North left the call in test 5, so its stored status is outside the call.
	await reload("N");
	await expect(joinButton(tab.N)).toBeEnabled();
	await tab.N.waitForTimeout(3_000);
	await expect(panel(tab.N)).toHaveAttribute("data-status", "outside");
	await expect(rejoinButton(tab.N)).toHaveCount(0);
	expect(await counts(tab.N)).toMatchObject({
		peers: 0,
		captures: 0,
		callSent: 0,
	});
});

test("9: four seats join within one second, each hears the other three, and the burst stays in budget", async () => {
	// West is in the call again after its reload (test 8), and East still listens.
	for (const seat of ["W", "E"] as const) {
		await leaveButton(tab[seat]).click();
		await expect(joinButton(tab[seat])).toBeVisible();
	}
	await players.E.grantPermissions(["microphone"]);
	// All four set their switches first, so that the four Join clicks fall within one second.
	for (const seat of SEATS) await chooseMode(tab[seat], "Audio only");
	const start = Date.now();
	await Promise.all(SEATS.map((seat) => joinButton(tab[seat]).click()));
	expect(Date.now() - start).toBeLessThan(1_000);

	for (const seat of SEATS) {
		await expect
			.poll(() => connectedTo(tab[seat]), { timeout: 30_000 })
			.toEqual(othersOf(seat));
	}
	const connected = Date.now() - start;
	// One link per pair, one live microphone per tab, and each of the 12 directions carries sound.
	for (const seat of SEATS) {
		expect(await counts(tab[seat])).toMatchObject({
			openPeers: 3,
			liveTracks: 1,
		});
	}
	const growth = await Promise.all(
		SEATS.map((seat) => peerAudioGrowth(tab[seat])),
	);
	for (const perPeer of growth) {
		expect(perPeer).toHaveLength(3);
		for (const bytes of perPeer) expect(bytes).toBeGreaterThan(SOUND);
	}

	// The burst (plan §4.4): call messages received over all four tabs, per one-second window.
	const frames = await Promise.all(SEATS.map((seat) => callFrames(tab[seat])));
	const received = frames
		.flatMap((frame) => frame.received)
		.filter((time) => time >= start);
	const sent = frames
		.flatMap((frame) => frame.sent)
		.filter((time) => time >= start).length;
	const peak = peakPerWindow(received, 1_000);
	console.error(
		`call burst: connected after ${connected} ms; ${sent} call messages sent, ${received.length} received, peak ${peak} per 1 s`,
	);
	expect(received.length).toBeGreaterThan(0);
	expect(peak).toBeLessThanOrEqual(50);
});

test("10: when one seat stops hearing, the other seats still hear each other", async () => {
	// The sender side (owner, 2026-10-19): West's senders to South and to North, by the SSRC that each receiver
	// sees. The link order stays while no link opens or closes.
	const toSouth = await receivedSsrc(tab.S, "W", "audio");
	const toNorth = await receivedSsrc(tab.N, "W", "audio");
	const flowing = await senderFlow(tab.W, "audio");
	const southSender = flowing.findIndex((sender) => sender.ssrc === toSouth);
	const northSender = flowing.findIndex((sender) => sender.ssrc === toNorth);
	expect(toSouth).toBeDefined();
	expect(southSender).toBeGreaterThanOrEqual(0);
	expect(northSender).toBeGreaterThanOrEqual(0);

	await toggle(tab.S, "Hear others: receive audio").click();
	for (const seat of ["W", "N", "E"] as const) {
		await expect(tab.S.getByTestId(`audio-${seat}`)).toHaveAttribute(
			"data-play",
			"off",
		);
	}
	// The label names the viewer's own reception; West still hears South.
	await expect(caption(tab.S, "W")).toHaveText(
		"W - player4 · Audio reception off",
	);
	await expect(caption(tab.W, "S")).toHaveText("S - player2 · Audio only");
	await expect
		.poll(() => directions(tab.S, "audio"))
		.toEqual(["sendonly", "sendonly", "sendonly"]);
	const [south, ...others] = await Promise.all(
		(["S", "W", "N", "E"] as const).map((seat) => peerAudioGrowth(tab[seat])),
	);
	for (const bytes of south ?? []) expect(bytes).toBeLessThan(100);
	for (const perPeer of others) {
		expect(perPeer).toHaveLength(3);
		for (const bytes of perPeer) expect(bytes).toBeGreaterThan(SOUND);
	}
	// West's sender to South has no track and sends nothing; its sender to North goes on.
	await expect
		.poll(async () => (await senderFlow(tab.W, "audio"))[southSender]?.track)
		.toBe(false);
	const paused = await senderFlow(tab.W, "audio");
	console.error(`pause: West's audio senders ${JSON.stringify(paused)}`);
	expect(paused[southSender]?.bytes).toBe(0);
	expect(paused[northSender]?.track).toBe(true);
	expect(paused[northSender]?.bytes).toBeGreaterThan(SOUND);

	await toggle(tab.S, "Hear others: receive audio").click();
	await expect(tab.S.getByTestId("audio-W")).toHaveAttribute(
		"data-play",
		"playing",
	);
	await expect
		.poll(() => directions(tab.S, "audio"))
		.toEqual(["sendrecv", "sendrecv", "sendrecv"]);
	for (const bytes of await peerAudioGrowth(tab.S))
		expect(bytes).toBeGreaterThan(SOUND);
	await expect
		.poll(async () =>
			(await senderFlow(tab.W, "audio")).map(
				(sender) => sender.track && sender.bytes > SOUND,
			),
		)
		.toEqual([true, true, true]);
});

test("11: Send off while the microphone request is pending stops the late track and never sends it", async () => {
	const send = toggle(tab.E, "Send mic audio");
	await send.click();
	await expect(send).toHaveAttribute("data-actual", "off");
	await setCaptureDelay(tab.E, 3_000);
	const captures = (await counts(tab.E)).captures;
	await send.click();
	await expect(send).toHaveAttribute("data-actual", "pending");
	await send.click();
	await expect(send).toHaveAttribute("aria-pressed", "false");
	await expect(send).toHaveAttribute("data-actual", "off");
	// The held-back stream reaches the app 3 s after the request.
	expect((await counts(tab.E)).captures).toBe(captures + 1);
	await tab.E.waitForTimeout(3_500);
	const late = await tab.E.evaluate(() => {
		const probe = (window as unknown as { __callProbe: CallProbe }).__callProbe;
		const track = probe.tracks[probe.tracks.length - 1];
		return {
			state: track?.readyState,
			attached: probe.peers.some((peer) =>
				peer.getSenders().some((sender) => sender.track === track),
			),
		};
	});
	expect(late).toEqual({ state: "ended", attached: false });
	expect((await counts(tab.E)).liveTracks).toBe(0);
	await expect(send).toHaveAttribute("data-actual", "off");
	await expect(caption(tab.W, "E")).toHaveText("E - player3 · Mic off");

	await setCaptureDelay(tab.E, 0);
	await send.click();
	await expect(send).toHaveAttribute("data-actual", "on");
	await expect(caption(tab.W, "E")).toHaveText("E - player3 · Audio only");
	expect((await counts(tab.E)).liveTracks).toBe(1);
});

test("12: rapid toggles at two seats at once end in each seat's last choice", async () => {
	const pair = ["W", "N"] as const;
	const peers = {
		W: (await counts(tab.W)).peers,
		N: (await counts(tab.N)).peers,
	};
	// Five Send clicks and four Hear clicks: Send ends off, Hear ends on. Never both off at once, because all
	// switches off means Leave.
	const send = "Send mic audio";
	const hear = "Hear others: receive audio";
	const clicks = [send, send, hear, hear, send, send, hear, hear, send];
	await Promise.all(
		pair.map(async (seat) => {
			for (const name of clicks) await toggle(tab[seat], name).click();
		}),
	);
	for (const seat of pair) {
		const send = toggle(tab[seat], "Send mic audio");
		await expect(send).toHaveAttribute("aria-pressed", "false");
		await expect(send).toHaveAttribute("data-actual", "off");
		await expect(
			toggle(tab[seat], "Hear others: receive audio"),
		).toHaveAttribute("aria-pressed", "true");
		await expect.poll(async () => (await counts(tab[seat])).liveTracks).toBe(0);
		// The toggles renegotiate the existing links; they make no new ones.
		expect(await counts(tab[seat])).toMatchObject({
			peers: peers[seat],
			openPeers: 3,
		});
		await expect(caption(tab.E, seat)).toHaveText(
			`${TILE_NAMES[seat]} · Mic off`,
		);
	}
	// West still hears East and South, and nothing from North, whose microphone is off.
	const [silent, ...heard] = await peerAudioGrowth(tab.W);
	expect(silent).toBeLessThan(100);
	for (const bytes of heard) expect(bytes).toBeGreaterThan(SOUND);

	for (const seat of pair) {
		await toggle(tab[seat], "Send mic audio").click();
		await expect(toggle(tab[seat], "Send mic audio")).toHaveAttribute(
			"data-actual",
			"on",
		);
		await expect(caption(tab.E, seat)).toHaveText(
			`${TILE_NAMES[seat]} · Audio only`,
		);
		expect((await counts(tab[seat])).liveTracks).toBe(1);
	}
});

test("13: a reload joins the call again, and the peers drop the old link at once", async () => {
	const peers = ["W", "E", "S"] as const;
	const before = {} as Record<(typeof peers)[number], number[]>;
	for (const seat of peers) {
		before[seat] = (await peerLog(tab[seat]))
			.filter((peer) => peer.closedAt === null)
			.map((peer) => peer.index);
	}
	// Test 12's last toggles at North can still be in negotiation: reload a North that is quiet.
	await expect
		.poll(
			async () => Date.now() - ((await callFrames(tab.N)).sent.at(-1) ?? 0),
			{ message: "North's call messages stop" },
		)
		.toBeGreaterThan(2_000);
	const start = Date.now();
	await reload("N");
	for (const seat of peers) {
		await expect
			.poll(async () =>
				(await peerLog(tab[seat])).filter(
					(peer) => before[seat].includes(peer.index) && peer.closedAt !== null,
				),
			)
			.toHaveLength(1);
		const [closed] = (await peerLog(tab[seat])).filter(
			(peer) => before[seat].includes(peer.index) && peer.closedAt !== null,
		);
		const closedAt = closed?.closedAt ?? Number.NaN;
		console.error(
			`reload: ${seat} closed the old North link ${closedAt - start} ms after the reload`,
		);
		// The new generation of North's seat closes the link, long before the ICE consent timeout (about 30 s)
		// would fail it.
		expect(closedAt - start).toBeLessThan(10_000);
		expect(closed?.states).not.toContain("failed");
	}

	// Plan §12 R2: North was in the call with Audio only, and the microphone is allowed, so it joins again.
	await expect(leaveButton(tab.N)).toBeVisible();
	await expect(toggle(tab.N, "Send mic audio")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	for (const seat of SEATS) {
		await expect
			.poll(() => connectedTo(tab[seat]), { timeout: 30_000 })
			.toEqual(othersOf(seat));
	}
	for (const seat of peers) {
		const log = await peerLog(tab[seat]);
		expect(log.filter((peer) => peer.closedAt === null)).toHaveLength(3);
		await expect(caption(tab[seat], "N")).toHaveText(
			"N - player1 · Audio only",
		);
	}
	expect(await counts(tab.N)).toMatchObject({
		captures: 1,
		liveTracks: 1,
		openPeers: 3,
	});
	for (const bytes of await peerAudioGrowth(tab.N))
		expect(bytes).toBeGreaterThan(SOUND);
	for (const seat of peers) {
		for (const bytes of await peerAudioGrowth(tab[seat]))
			expect(bytes).toBeGreaterThan(SOUND);
	}
	const play = await Promise.all(
		peers.map((seat) =>
			tab.N.getByTestId(`audio-${seat}`).getAttribute("data-play"),
		),
	);
	console.error(
		`reload: North's playback after the rejoin: ${play.join(", ")}`,
	);
});

test("14: a tab that vanishes without leaving is out of the call 10 s after its presence ends", async () => {
	const south = (page: Page): Locator =>
		page.getByTestId("roster").locator('li[data-seat="S"]');
	await expect(south(tab.W)).toHaveAttribute("data-state", "online");
	const start = Date.now();
	// The app sends nothing on unload, so closing the tab is a vanish: no leave message and no new generation.
	await tab.S.close();
	const offline = await timeWhen(
		async () => (await south(tab.W).getAttribute("data-state")) === "offline",
		60_000,
	);
	const gone = await timeWhen(
		async () =>
			(await caption(tab.W, "S").textContent()) === "S - player2 · Not in call",
		30_000,
	);
	console.error(
		`vanished: presence ended after ${offline - start} ms; Not in call ${gone - offline} ms later`,
	);
	expect(gone - offline).toBeLessThanOrEqual(10_000 + 1_500);
	for (const seat of ["W", "N", "E"] as const) {
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
