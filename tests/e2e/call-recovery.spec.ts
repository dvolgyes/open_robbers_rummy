import { expect, type Page, test } from "@playwright/test";
import {
	caption,
	counts,
	expectAudioArrives,
	installCallProbe,
	joinWith,
	leaveButton,
	note,
	rejoinButton,
	requestsFor,
	SEAT_NAMES,
	TILE_NAMES,
	toggle,
} from "./call-probe";
import { Player, reportNetwork } from "./player";
import {
	CONNECT_MS,
	createRoom,
	expectBanner,
	expectSeat,
	hostRows,
	pick,
	type SeatKey,
} from "./room";

/**
 * The call after a crash, a host change and a lost permission (plan §12 R2), on one P2P table through the public
 * trackers. Each person has their own browser, which may use the microphone (a generated tone). The seats join
 * with different switches, so the captions show whether a restored status is the stored one: North sends no
 * audio, and East hears nobody. A crash closes the tab without unload handlers; a reopen is a new tab of the same
 * browser, so its replica, its seat and its call record come back.
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["W", "N", "E", "S"] as const satisfies readonly SeatKey[];
/** Each seat's Send mic audio and Hear others switches after test 1. */
const SWITCHES: Readonly<
	Record<SeatKey, { readonly send: boolean; readonly hear: boolean }>
> = {
	W: { send: true, hear: true },
	N: { send: false, hear: true },
	E: { send: true, hear: false },
	S: { send: true, hear: true },
};
/** A closed page goes offline in the roster (acceptance.spec.ts), and then out of the call (VANISHED_MS 10 s). */
const GONE_MS = 40_000;
/** The become-host button shows at 10 s without a host; the automatic volunteer starts at 30 s. */
const BUTTON_LATEST_MS = 30_000;

const players = {} as Record<SeatKey, Player>;
const tab = {} as Record<SeatKey, Page>;
let link = "";

const table = (page: Page) => page.getByTestId("table");

/** The caption that `viewer` shows for `other` when both are in the call with their switches. */
function heard(viewer: SeatKey, other: SeatKey): string {
	const text = !SWITCHES[viewer].hear
		? "Audio reception off"
		: SWITCHES[other].send
			? "Audio only"
			: "Mic off";
	return `${TILE_NAMES[other]} · ${text}`;
}

/** Each seat in `seats` shows its own switches, and the stored switches of every other seat in `seats`. */
async function expectStatuses(seats: readonly SeatKey[]): Promise<void> {
	for (const viewer of seats) {
		const page = tab[viewer];
		await expect(leaveButton(page)).toBeVisible({ timeout: CONNECT_MS });
		await expect(toggle(page, "Send mic audio")).toHaveAttribute(
			"aria-pressed",
			String(SWITCHES[viewer].send),
		);
		await expect(toggle(page, "Hear others: receive audio")).toHaveAttribute(
			"aria-pressed",
			String(SWITCHES[viewer].hear),
		);
		for (const other of seats)
			if (other !== viewer)
				await expect(caption(page, other)).toHaveText(heard(viewer, other), {
					timeout: CONNECT_MS,
				});
	}
}

/** The seats that the call note names as connected, sorted. */
async function connectedTo(page: Page): Promise<string[]> {
	const text = (await note(page).textContent()) ?? "";
	return (/Connected to ([^.]*)\./.exec(text)?.[1]?.split(", ") ?? []).sort();
}

/** Each seat in `seats` is connected to the other seats in `seats`, and only to them. */
async function expectConnected(seats: readonly SeatKey[]): Promise<void> {
	for (const seat of seats)
		await expect
			.poll(() => connectedTo(tab[seat]), { timeout: CONNECT_MS })
			.toEqual(
				seats
					.filter((other) => other !== seat)
					.map((other) => SEAT_NAMES[other])
					.sort(),
			);
}

async function crash(seat: SeatKey): Promise<void> {
	await tab[seat].close({ runBeforeUnload: false });
}

async function reopen(seat: SeatKey): Promise<void> {
	tab[seat] = await players[seat].page(link);
	await expectSeat(tab[seat], seat, {
		timeout: CONNECT_MS,
	});
}

/** Each seat in `seats` names the same host. Returns its seat. */
async function commonHost(seats: readonly SeatKey[]): Promise<string> {
	const [first, ...others] = seats;
	if (!first) throw new Error("no seat");
	await expect(hostRows(tab[first])).toHaveCount(1, { timeout: CONNECT_MS });
	const host = (await hostRows(tab[first]).getAttribute("data-seat")) ?? "";
	for (const other of others)
		await expect(hostRows(tab[other])).toHaveAttribute("data-seat", host, {
			timeout: CONNECT_MS,
		});
	return host;
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const seat of SEATS) {
		players[seat] = await Player.open(browser, baseURL, `recovery-${seat}`, {
			permissions: ["microphone"],
		});
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

test("1: four browsers join the call; North turns its microphone off, and East stops hearing", async () => {
	tab.W = await players.W.page("./");
	link = await createRoom(tab.W);
	for (const seat of ["N", "E"] as const) {
		tab[seat] = await players[seat].page(link);
		await pick(tab[seat], seat);
	}
	// South is the last free seat, so its page takes it without a picker.
	tab.S = await players.S.page(link);
	await expectSeat(tab.S, "S", {
		timeout: CONNECT_MS,
	});
	// The tiles come with the first hand, which the hosting page deals once all four seats are present.
	for (const seat of SEATS)
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "play");
	for (const seat of SEATS) await joinWith(tab[seat], "Audio only");
	await toggle(tab.N, "Send mic audio").click();
	await toggle(tab.E, "Hear others: receive audio").click();
	await expectConnected(SEATS);
	await expectStatuses(SEATS);
	expect(await commonHost(SEATS)).toBe("W");
});

test("2: a player whose tab crashes comes back in the call with its switches, and opens no microphone", async () => {
	test.setTimeout(180_000);
	await crash("N");
	const others = ["W", "E", "S"] as const;
	for (const seat of others)
		await expect(caption(tab[seat], "N")).toHaveText(
			"N - player1 · Not in call",
			{
				timeout: GONE_MS,
			},
		);
	await expectConnected(others);

	await reopen("N");
	await expectConnected(SEATS);
	await expectStatuses(SEATS);
	// The stored status sends no audio, so the page never asks for the microphone.
	expect(await requestsFor(tab.N, "audio")).toBe(0);
	expect(await counts(tab.N)).toMatchObject({ captures: 0, liveTracks: 0 });
});

test("3: the host's tab crashes; the call goes on, another player becomes the host, and the old host comes back in the call", async () => {
	test.setTimeout(240_000);
	await crash("W");
	const others = ["N", "E", "S"] as const;
	for (const seat of others)
		await expect(caption(tab[seat], "W")).toHaveText(
			"W - player4 · Not in call",
			{
				timeout: GONE_MS,
			},
		);
	await expectBanner(tab.E, "waiting-for-host");
	// The host change does not touch the call between the other seats.
	await expectConnected(others);
	await expectStatuses(others);

	const become = tab.E.getByTestId("become-host");
	await expect(become).toBeEnabled({ timeout: BUTTON_LATEST_MS });
	await become.click();
	expect(await commonHost(others)).toBe("E");
	await expectConnected(others);
	await expectStatuses(others);

	await reopen("W");
	expect(await commonHost(SEATS)).toBe("E");
	await expectConnected(SEATS);
	await expectStatuses(SEATS);
	await expectAudioArrives(tab.W);
	expect(await counts(tab.W)).toMatchObject({ captures: 1, liveTracks: 1 });
});

test("4: a browser that must ask for the microphone again offers Rejoin the call, and opens nothing before the click", async () => {
	// The browser forgets the microphone permission, as after "Allow this time".
	await tab.S.context().clearPermissions();
	await tab.S.reload();
	await expectSeat(tab.S, "S", {
		timeout: CONNECT_MS,
	});
	await expect(rejoinButton(tab.S)).toBeVisible({ timeout: CONNECT_MS });
	await tab.S.waitForTimeout(3_000);
	expect(await counts(tab.S)).toMatchObject({
		peers: 0,
		captures: 0,
		liveTracks: 0,
		callSent: 0,
	});
	expect(await requestsFor(tab.S, "audio")).toBe(0);
	for (const seat of ["W", "N", "E"] as const)
		await expect(caption(tab[seat], "S")).toHaveText(
			"S - player2 · Not in call",
			{
				timeout: GONE_MS,
			},
		);

	await tab.S.context().grantPermissions(["microphone"]);
	await rejoinButton(tab.S).click();
	await expectConnected(SEATS);
	await expectStatuses(SEATS);
	expect(await counts(tab.S)).toMatchObject({ captures: 1, liveTracks: 1 });
});

test("no uncaught errors and no request to the old backend", () => {
	expect(Object.values(players).flatMap((player) => player.errors)).toEqual([]);
	for (const player of Object.values(players))
		expect(player.supabaseRequests, player.name).toBe(0);
});
