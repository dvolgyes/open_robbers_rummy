import { expect, type Page, test } from "@playwright/test";
import {
	BEAT_MS,
	BUTTON_MS,
	HOST_LOST_MS,
	SEAT_GRACE_MS,
} from "../../src/p2p/limits";
import { freeze } from "./lifecycle";
import { Player, reportNetwork } from "./player";
import {
	CONNECT_MS,
	createRoom,
	expectBanner,
	expectSeat,
	hostRows,
	MESSAGE,
	pick,
	rosterSeat,
	type SeatKey,
	sendDraft,
	texts,
} from "./room";

/**
 * A seat whose player has gone silent (a suspended phone, a frozen tab) becomes free when the host sees it offline
 * and has not heard from it for the seat grace (SEAT_GRACE_MS, 15 s). A seat is offline HOST_LOST_MS (20 s) after
 * the last message of its page, and a page beats every 10 s, so the seat must not be offered within about 8 s of
 * the silence (10 s for the last beat and 2 s for timer and network jitter). Visitors get the lobby again every 5 s.
 */
test.describe.configure({ mode: "serial" });

const EARLIEST_MS = Math.max(HOST_LOST_MS, SEAT_GRACE_MS) - BEAT_MS - 2_000;
/** The latest time at which a free seat shows in a visitor's lobby, with room for a slow link. */
const LATEST_MS = HOST_LOST_MS + SEAT_GRACE_MS + 30_000;
/** A seat shows offline 20 s after its last message (HOST_LOST_MS), plus the 1 s roster coalesce. */
const QUIET_MS = HOST_LOST_MS + 10_000;
/**
 * A host is replaced after 20 s without its beats (HOST_LOST_MS), then "Make me the host" shows after 10 s more
 * (BUTTON_MS, plan §4.4 rule 7), so the button can take about 30 s after the last beat.
 */
const BUTTON_LATEST_MS = HOST_LOST_MS + BUTTON_MS + 20_000;

const players: Player[] = [];
let host: Player;
let north: Player;
let east: Player;
let south: Player;
let newcomer: Player;
let latecomer: Player;
let link = "";
/** The tab that currently holds each seat. */
const tab = {} as Record<SeatKey, Page>;

/**
 * Waits until the page of a visitor who opened the link takes `seat`. The visitor takes the seat at once when it is
 * the only one free, so the wait is for the seat itself. Returns the wait from `since`.
 */
async function seatOffered(
	page: Page,
	seat: SeatKey,
	since: number,
): Promise<number> {
	await expectSeat(page, seat, {
		timeout: LATEST_MS,
	});
	return Date.now() - since;
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	const open = async (name: string): Promise<Player> => {
		const player = await Player.open(browser, baseURL, name);
		players.push(player);
		return player;
	};
	host = await open("west");
	north = await open("north");
	east = await open("east");
	south = await open("south");
	newcomer = await open("newcomer");
	latecomer = await open("latecomer");
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus) await reportNetwork(players);
});

test.afterAll(async () => {
	for (const player of players) await player.close();
});

test("a frozen player's seat shows offline, frees after the timeout, and the thawed tab is superseded", async () => {
	test.setTimeout(180_000);
	tab.W = await host.page("./");
	link = await createRoom(tab.W);
	for (const [player, seat] of [
		[north, "N"],
		[east, "E"],
	] as const) {
		const page = await player.page(link);
		await expect(page.getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await pick(page, seat);
		tab[seat] = page;
	}
	// South is the last free seat, so its page takes it without a picker. Its seat stays held during the test.
	tab.S = await south.page(link);
	await expectSeat(tab.S, "S", {
		timeout: CONNECT_MS,
	});
	await expect(rosterSeat(tab.W, "N")).toHaveAttribute("data-state", "online", {
		timeout: CONNECT_MS,
	});

	const old = tab.N;
	const thaw = await freeze(old);
	const silentSince = Date.now();
	for (const seat of ["W", "E"] as const)
		await expect(rosterSeat(tab[seat], "N")).toHaveAttribute(
			"data-state",
			"offline",
			{ timeout: QUIET_MS },
		);

	const page = await newcomer.page(link);
	const elapsed = await seatOffered(page, "N", silentSince);
	test.info().annotations.push({
		type: "seat offered after (ms)",
		description: String(elapsed),
	});
	expect(elapsed).toBeGreaterThanOrEqual(EARLIEST_MS);
	tab.N = page;

	await thaw();
	await expectBanner(old, "superseded");
	await expect(old.getByTestId("banner")).toContainText(
		"another device holds this seat now",
	);
	await expect(old.getByTestId("send")).toBeDisabled();
	await expect(rosterSeat(tab.W, "N")).toHaveAttribute("data-state", "online");
});

test("a frozen host is replaced; its seat frees after the timeout; the thawed old host is superseded", async () => {
	test.setTimeout(180_000);
	const old = tab.W;
	const thaw = await freeze(old);
	// A frozen or crashed host is "unreachable" until the other players' last reports of it are HOST_LOST_MS old.
	await expectBanner(tab.N, "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	// East is the witness of the new North (plan §2 D1).
	const become = tab.N.getByTestId("become-host");
	await expect(become).toBeEnabled({ timeout: BUTTON_LATEST_MS });
	await become.click();
	const hostSince = Date.now();
	for (const seat of ["N", "E"] as const) {
		await expect(hostRows(tab[seat])).toHaveAttribute("data-seat", "N");
		await expect(tab[seat].getByTestId("banner")).toBeHidden();
	}

	// The new host starts the old host's seat clock at its claim (plan §4.4 rule 9), and the old host is offline
	// from then on, so its seat frees after the seat grace.
	const page = await latecomer.page(link);
	const elapsed = await seatOffered(page, "W", hostSince);
	test.info().annotations.push({
		type: "host seat offered after (ms)",
		description: String(elapsed),
	});
	expect(elapsed).toBeGreaterThanOrEqual(SEAT_GRACE_MS - 2_000);
	tab.W = page;

	await thaw();
	await expectBanner(old, "superseded");
	await expect(old.getByTestId("send")).toBeDisabled();

	// The new host orders the new West's message.
	await sendDraft(tab.W);
	for (const seat of ["W", "N", "E"] as const)
		await expect(texts(tab[seat])).toHaveText([MESSAGE.W]);
	await expectSeat(tab.W, "W");
});

test("no uncaught errors and no request to the old backend", () => {
	expect(players.flatMap((player) => player.errors)).toEqual([]);
	for (const player of players) expect(player.supabaseRequests).toBe(0);
});
