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
import {
	CONNECT_MS,
	createTable,
	expectSeat,
	pick,
	type SeatKey,
} from "./table";

/**
 * The audio call between real browsers, on one P2P table through the public
 * trackers. Call messages travel on the game links' data channels; the media goes over a call link per pair.
 * Player 4, Player 1 and Player 3 may use the microphone (a generated tone); Player 2 may not until test 9. Player 3 is a phone.
 * A probe in each tab (call-probe.ts) counts the call activity: call links, microphone requests and call
 * messages. Each seat's call status is stored in the table, so a reload joins the call again.
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
				const opened = indexedDB.open(
					"github.com/dvolgyes/open_robbers_rummy/p2p",
				);
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

const SEATS = ["4", "1", "2", "3"] as const satisfies readonly SeatKey[];
/** Player 2 may not use the microphone; Player 3 is a phone. */
const OPTIONS: Readonly<Record<SeatKey, ContextOptions>> = {
	"4": { permissions: ["microphone"] },
	"1": { permissions: ["microphone"] },
	"2": { permissions: [] },
	"3": {
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
		// Player 2's trackers can be cut in test 6.
		players[seat] = await Player.open(
			browser,
			baseURL,
			`audio-${seat}`,
			OPTIONS[seat],
			{ trackerSwitch: seat === "2" },
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
	await openTab("4", "./");
	const link = await createTable(tab["4"]);
	await openTab("1", link);
	await pick(tab["1"], "1");
	await openTab("2", link);
	await pick(tab["2"], "2");
	await openTab("3", link);
	await pick(tab["3"], "3");
	for (const page of Object.values(tab)) {
		await expect(panel(page)).toHaveAttribute("data-status", "outside");
		await expect(note(page)).toHaveText("");
		await expect(joinButton(page)).toBeEnabled();
	}
	// The tiles come with the first hand. Outside the call nobody's call status is known, so they show names.
	// The hosting page deals the first hand by itself, so there is no click here.
	await expect(tab["4"].getByTestId("table")).toHaveAttribute(
		"data-phase",
		"play",
	);
	await expect(caption(tab["4"], "1")).toHaveText("player1");
	// The absence of activity needs time to show: the game links carry beats meanwhile.
	await tab["4"].waitForTimeout(4_000);
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
	const table = tab["4"].getByTestId("table");
	const before = {
		phase: await table.getAttribute("data-phase"),
		hand: await table.getAttribute("data-hand"),
		at: await table.getAttribute("data-at"),
	};
	const logged = (await loggedTypes(tab["4"])).length;

	await joinWith(tab["4"], "Audio only");
	await joinWith(tab["1"], "Audio only");
	await expect(note(tab["4"])).toHaveText(/Connected to Player 1\./);
	await expect(note(tab["1"])).toHaveText(/Connected to Player 4\./);
	await expect(caption(tab["4"], "1")).toHaveText("player1 · Audio only");
	await expect(caption(tab["1"], "4")).toHaveText("player4 · Audio only");
	await expect(toggle(tab["4"], "Send mic audio")).toHaveAttribute(
		"data-actual",
		"on",
	);
	await expectAudioArrives(tab["4"]);
	await expectAudioArrives(tab["1"]);
	await expect(tab["4"].getByTestId("audio-1")).toHaveAttribute(
		"data-play",
		"playing",
	);

	// The probe sees the call, so its zero counts elsewhere are meaningful.
	const player4 = await counts(tab["4"]);
	expect(player4.captures).toBe(1);
	expect(player4.openPeers).toBeGreaterThan(0);
	expect(player4.callSent).toBeGreaterThan(0);
	// Player 2 and Player 3 stayed outside: other calls do not make them capture, connect or send call messages.
	for (const seat of ["2", "3"] as const) {
		expect(await counts(tab[seat])).toMatchObject({
			peers: 0,
			captures: 0,
			callSent: 0,
		});
	}

	// Each join adds one call status to the log and no game command; the game did not move.
	await expect
		.poll(async () => (await loggedTypes(tab["4"])).slice(logged))
		.toEqual(["media", "media"]);
	expect({
		phase: await table.getAttribute("data-phase"),
		hand: await table.getAttribute("data-hand"),
		at: await table.getAttribute("data-at"),
	}).toEqual(before);
});

test("3: Send off and Hear off change one direction, and each side shows the result", async () => {
	await toggle(tab["1"], "Send mic audio").click();
	await expect(toggle(tab["1"], "Send mic audio")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(caption(tab["4"], "1")).toHaveText("player1 · Mic off");
	await toggle(tab["1"], "Send mic audio").click();
	await expect(toggle(tab["1"], "Send mic audio")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(caption(tab["4"], "1")).toHaveText("player1 · Audio only");

	await toggle(tab["4"], "Hear others: receive audio").click();
	await expect(toggle(tab["4"], "Hear others: receive audio")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(tab["4"].getByTestId("audio-1")).toHaveAttribute(
		"data-play",
		"off",
	);
	await expect(caption(tab["4"], "1")).toHaveText(
		"player1 · Audio reception off",
	);
	await toggle(tab["4"], "Hear others: receive audio").click();
	await expect(tab["4"].getByTestId("audio-1")).toHaveAttribute(
		"data-play",
		"playing",
	);
	await expect(caption(tab["4"], "1")).toHaveText("player1 · Audio only");
	await expectAudioArrives(tab["4"]);
});

test("4: Listen only needs no microphone, and a refused microphone stays out of the call box", async () => {
	await joinWith(tab["2"], "Listen only");
	await expect(note(tab["2"])).toHaveText(
		/Connected to (Player 1, Player 4|Player 4, Player 1)\./,
	);
	await expect(caption(tab["2"], "4")).toHaveText("player4 · Audio only");
	await expect(caption(tab["4"], "2")).toHaveText("player2 · Mic off");
	await expectAudioArrives(tab["2"]);
	expect((await counts(tab["2"])).captures).toBe(0);

	await toggle(tab["2"], "Send mic audio").click();
	const send = toggle(tab["2"], "Send mic audio");
	await expect(send).toHaveAttribute("aria-pressed", "true");
	await expect(send).toHaveAttribute("data-actual", "denied");
	await expect(note(tab["2"])).toContainText(
		"The browser blocks the microphone: others cannot hear you.",
	);
	await expectNoteUnseen(tab["2"]);
	expect((await counts(tab["2"])).captures).toBe(1);
	// The others still reach Player 2; only Player 2's sending failed.
	await expect(caption(tab["4"], "2")).toHaveText("player2 · Mic off");
	await expectAudioArrives(tab["2"]);
});

test("5: Leave stops the microphone and the connections, and the others see Not in call", async () => {
	await leaveButton(tab["1"]).click();
	await expect(joinButton(tab["1"])).toBeVisible();
	await expect(panel(tab["1"])).toHaveAttribute("data-status", "outside");
	await expect
		.poll(async () => {
			const player1 = await counts(tab["1"]);
			return { openPeers: player1.openPeers, liveTracks: player1.liveTracks };
		})
		.toEqual({ openPeers: 0, liveTracks: 0 });
	await expect(caption(tab["4"], "1")).toHaveText("player1 · Not in call");
	await expect(caption(tab["2"], "1")).toHaveText("player1 · Not in call");
	await expect(note(tab["4"])).toHaveText(/Connected to Player 2\./);
});

test("6: after Player 2's game links and trackers are cut for longer than 10 s, the call comes back and the audio flows again", async () => {
	test.setTimeout(240_000);
	// A network change: the data channels that carry the call messages close, and no tracker can be reached.
	// The call link itself stays open; only the game links are cut.
	await players["2"].network.block();
	expect(await cutGameLinks(tab["2"])).toBe(3);
	// Without game links Player 2 is offline for the others; after 10 s each side drops the call link.
	await expect(caption(tab["4"], "2")).toHaveText("player2 · Not in call", {
		timeout: 30_000,
	});
	await expect
		.poll(async () => (await counts(tab["2"])).openPeers, { timeout: 30_000 })
		.toBe(0);
	const cut = Date.now();
	players["2"].network.unblock();
	await expect(note(tab["2"])).toHaveText(/Connected to Player 4\./, {
		timeout: 120_000,
	});
	console.error(
		`cut: the call came back ${Date.now() - cut} ms after the trackers returned`,
	);
	await expect(caption(tab["4"], "2")).toHaveText("player2 · Mic off");
	await expect(caption(tab["2"], "4")).toHaveText("player4 · Audio only");
	await expectAudioArrives(tab["2"]);
});

test("7: outside the call, the keyboard reaches the switches from Join and changes them", async () => {
	const captures = (await counts(tab["1"])).captures;
	const join = joinButton(tab["1"]);
	const mic = toggle(tab["1"], "Send mic audio");
	await join.focus();
	// The switches follow Join in the panel, so the next Tab stop is the first switch.
	await tab["1"].keyboard.press("Tab");
	await expect(mic).toBeFocused();
	const before = await mic.getAttribute("aria-pressed");
	const flipped = before === "true" ? "false" : "true";
	await tab["1"].keyboard.press("Space");
	await expect(mic).toHaveAttribute("aria-pressed", flipped);
	await tab["1"].keyboard.press("Space");
	await expect(mic).toHaveAttribute("aria-pressed", before ?? "false");
	await expect(leaveButton(tab["1"])).toHaveCount(0);
	// Outside the call, a switch only chooses what Join starts with; it starts nothing.
	expect((await counts(tab["1"])).captures).toBe(captures);
});

test("8: a reload joins the call again with the stored switches; a page outside the call stays outside", async () => {
	// Player 4 is in the call with Audio only, and the browser lets this site use the microphone.
	await reload("4");
	await expect(leaveButton(tab["4"])).toBeVisible();
	await expect(toggle(tab["4"], "Send mic audio")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(toggle(tab["4"], "Hear others: receive audio")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(note(tab["4"])).toHaveText(/Connected to Player 2\./, {
		timeout: 30_000,
	});
	await expect(caption(tab["2"], "4")).toHaveText("player4 · Audio only");
	await expectAudioArrives(tab["2"]);
	expect(await counts(tab["4"])).toMatchObject({ captures: 1, liveTracks: 1 });

	// Player 1 left the call in test 5, so its stored status is outside the call.
	await reload("1");
	await expect(joinButton(tab["1"])).toBeEnabled();
	await tab["1"].waitForTimeout(3_000);
	await expect(panel(tab["1"])).toHaveAttribute("data-status", "outside");
	await expect(rejoinButton(tab["1"])).toHaveCount(0);
	expect(await counts(tab["1"])).toMatchObject({
		peers: 0,
		captures: 0,
		callSent: 0,
	});
});

test("9: four seats join within one second, each hears the other three, and the burst stays in budget", async () => {
	// Player 4 is in the call again after its reload (test 8), and Player 2 still listens.
	for (const seat of ["4", "2"] as const) {
		await leaveButton(tab[seat]).click();
		await expect(joinButton(tab[seat])).toBeVisible();
	}
	await players["2"].grantPermissions(["microphone"]);
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

	// The burst: call messages received over all four tabs, per one-second window.
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
	// The sender side (owner, 2026-10-19): Player 4's senders to Player 3 and to Player 1, by the SSRC that each receiver
	// sees. The link order stays while no link opens or closes.
	const toPlayer3 = await receivedSsrc(tab["3"], "4", "audio");
	const toPlayer1 = await receivedSsrc(tab["1"], "4", "audio");
	const flowing = await senderFlow(tab["4"], "audio");
	const player3Sender = flowing.findIndex(
		(sender) => sender.ssrc === toPlayer3,
	);
	const player1Sender = flowing.findIndex(
		(sender) => sender.ssrc === toPlayer1,
	);
	expect(toPlayer3).toBeDefined();
	expect(player3Sender).toBeGreaterThanOrEqual(0);
	expect(player1Sender).toBeGreaterThanOrEqual(0);

	await toggle(tab["3"], "Hear others: receive audio").click();
	for (const seat of ["4", "1", "2"] as const) {
		await expect(tab["3"].getByTestId(`audio-${seat}`)).toHaveAttribute(
			"data-play",
			"off",
		);
	}
	// The label names the viewer's own reception; Player 4 still hears Player 3.
	await expect(caption(tab["3"], "4")).toHaveText(
		"player4 · Audio reception off",
	);
	await expect(caption(tab["4"], "3")).toHaveText("player3 · Audio only");
	await expect
		.poll(() => directions(tab["3"], "audio"))
		.toEqual(["sendonly", "sendonly", "sendonly"]);
	const [player3, ...others] = await Promise.all(
		(["3", "4", "1", "2"] as const).map((seat) => peerAudioGrowth(tab[seat])),
	);
	for (const bytes of player3 ?? []) expect(bytes).toBeLessThan(100);
	for (const perPeer of others) {
		expect(perPeer).toHaveLength(3);
		for (const bytes of perPeer) expect(bytes).toBeGreaterThan(SOUND);
	}
	// Player 4's sender to Player 3 has no track and sends nothing; its sender to Player 1 goes on.
	await expect
		.poll(
			async () => (await senderFlow(tab["4"], "audio"))[player3Sender]?.track,
		)
		.toBe(false);
	const paused = await senderFlow(tab["4"], "audio");
	console.error(`pause: Player 4's audio senders ${JSON.stringify(paused)}`);
	expect(paused[player3Sender]?.bytes).toBe(0);
	expect(paused[player1Sender]?.track).toBe(true);
	expect(paused[player1Sender]?.bytes).toBeGreaterThan(SOUND);

	await toggle(tab["3"], "Hear others: receive audio").click();
	await expect(tab["3"].getByTestId("audio-4")).toHaveAttribute(
		"data-play",
		"playing",
	);
	await expect
		.poll(() => directions(tab["3"], "audio"))
		.toEqual(["sendrecv", "sendrecv", "sendrecv"]);
	for (const bytes of await peerAudioGrowth(tab["3"]))
		expect(bytes).toBeGreaterThan(SOUND);
	await expect
		.poll(async () =>
			(await senderFlow(tab["4"], "audio")).map(
				(sender) => sender.track && sender.bytes > SOUND,
			),
		)
		.toEqual([true, true, true]);
});

test("11: Send off while the microphone request is pending stops the late track and never sends it", async () => {
	const send = toggle(tab["2"], "Send mic audio");
	await send.click();
	await expect(send).toHaveAttribute("data-actual", "off");
	await setCaptureDelay(tab["2"], 3_000);
	const captures = (await counts(tab["2"])).captures;
	await send.click();
	await expect(send).toHaveAttribute("data-actual", "pending");
	await send.click();
	await expect(send).toHaveAttribute("aria-pressed", "false");
	await expect(send).toHaveAttribute("data-actual", "off");
	// The held-back stream reaches the app 3 s after the request.
	expect((await counts(tab["2"])).captures).toBe(captures + 1);
	await tab["2"].waitForTimeout(3_500);
	const late = await tab["2"].evaluate(() => {
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
	expect((await counts(tab["2"])).liveTracks).toBe(0);
	await expect(send).toHaveAttribute("data-actual", "off");
	await expect(caption(tab["4"], "2")).toHaveText("player2 · Mic off");

	await setCaptureDelay(tab["2"], 0);
	await send.click();
	await expect(send).toHaveAttribute("data-actual", "on");
	await expect(caption(tab["4"], "2")).toHaveText("player2 · Audio only");
	expect((await counts(tab["2"])).liveTracks).toBe(1);
});

test("12: rapid toggles at two seats at once end in each seat's last choice", async () => {
	const pair = ["4", "1"] as const;
	const peers = {
		"4": (await counts(tab["4"])).peers,
		"1": (await counts(tab["1"])).peers,
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
		await expect(caption(tab["2"], seat)).toHaveText(
			`${TILE_NAMES[seat]} · Mic off`,
		);
	}
	// Player 4 still hears Player 2 and Player 3, and nothing from Player 1, whose microphone is off.
	const [silent, ...heard] = await peerAudioGrowth(tab["4"]);
	expect(silent).toBeLessThan(100);
	for (const bytes of heard) expect(bytes).toBeGreaterThan(SOUND);

	for (const seat of pair) {
		await toggle(tab[seat], "Send mic audio").click();
		await expect(toggle(tab[seat], "Send mic audio")).toHaveAttribute(
			"data-actual",
			"on",
		);
		await expect(caption(tab["2"], seat)).toHaveText(
			`${TILE_NAMES[seat]} · Audio only`,
		);
		expect((await counts(tab[seat])).liveTracks).toBe(1);
	}
});

test("13: a reload joins the call again, and the peers drop the old link at once", async () => {
	const peers = ["4", "2", "3"] as const;
	const before = {} as Record<(typeof peers)[number], number[]>;
	for (const seat of peers) {
		before[seat] = (await peerLog(tab[seat]))
			.filter((peer) => peer.closedAt === null)
			.map((peer) => peer.index);
	}
	// Test 12's last toggles at Player 1 can still be in negotiation: reload a Player 1 that is quiet.
	await expect
		.poll(
			async () => Date.now() - ((await callFrames(tab["1"])).sent.at(-1) ?? 0),
			{ message: "Player 1's call messages stop" },
		)
		.toBeGreaterThan(2_000);
	const start = Date.now();
	await reload("1");
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
			`reload: ${seat} closed the old Player 1 link ${closedAt - start} ms after the reload`,
		);
		// The new generation of Player 1's seat closes the link, long before the ICE consent timeout (about 30 s)
		// would fail it.
		expect(closedAt - start).toBeLessThan(10_000);
		expect(closed?.states).not.toContain("failed");
	}

	// Player 1 was in the call with Audio only, and the microphone is allowed, so it joins again.
	await expect(leaveButton(tab["1"])).toBeVisible();
	await expect(toggle(tab["1"], "Send mic audio")).toHaveAttribute(
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
		await expect(caption(tab[seat], "1")).toHaveText("player1 · Audio only");
	}
	expect(await counts(tab["1"])).toMatchObject({
		captures: 1,
		liveTracks: 1,
		openPeers: 3,
	});
	for (const bytes of await peerAudioGrowth(tab["1"]))
		expect(bytes).toBeGreaterThan(SOUND);
	for (const seat of peers) {
		for (const bytes of await peerAudioGrowth(tab[seat]))
			expect(bytes).toBeGreaterThan(SOUND);
	}
	const play = await Promise.all(
		peers.map((seat) =>
			tab["1"].getByTestId(`audio-${seat}`).getAttribute("data-play"),
		),
	);
	console.error(
		`reload: Player 1's playback after the rejoin: ${play.join(", ")}`,
	);
});

test("14: a tab that vanishes without leaving is out of the call 10 s after its presence ends", async () => {
	const player3 = (page: Page): Locator =>
		page.getByTestId("roster").locator('li[data-seat="3"]');
	await expect(player3(tab["4"])).toHaveAttribute("data-state", "online");
	const start = Date.now();
	// The app sends nothing on unload, so closing the tab is a vanish: no leave message and no new generation.
	await tab["3"].close();
	const offline = await timeWhen(
		async () =>
			(await player3(tab["4"]).getAttribute("data-state")) === "offline",
		60_000,
	);
	const gone = await timeWhen(
		async () =>
			(await caption(tab["4"], "3").textContent()) === "player3 · Not in call",
		30_000,
	);
	console.error(
		`vanished: presence ended after ${offline - start} ms; Not in call ${gone - offline} ms later`,
	);
	expect(gone - offline).toBeLessThanOrEqual(10_000 + 1_500);
	for (const seat of ["4", "1", "2"] as const) {
		await expect(caption(tab[seat], "3")).toHaveText("player3 · Not in call");
		await expect.poll(async () => (await counts(tab[seat])).openPeers).toBe(2);
	}
});

test("no uncaught errors", () => {
	expect(Object.values(players).flatMap((player) => player.errors)).toEqual([]);
});
