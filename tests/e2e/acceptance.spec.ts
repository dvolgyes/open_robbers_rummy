import { expect, type Page, test } from "@playwright/test";
import { HOST_LOST_MS } from "../../src/p2p/limits";
import { freeze } from "./lifecycle";
import { Player, reportNetwork } from "./player";
import {
	CONNECT_MS,
	createRoom,
	expectBanner,
	expectSeat,
	hostRows,
	lines,
	MESSAGE,
	openDrawer,
	ownLink,
	pick,
	picks,
	rosterSeat,
	type SeatKey,
	sendDraft,
	texts,
} from "./room";

/**
 * Milestone 1 acceptance on the peer-to-peer table (plan §9). Each test is one row and builds on the table of the
 * rows before it. Every person has their own browser, so their own holder. The Supabase version's row 10 (the
 * backend is unreachable) has two P2P forms: no host (row 6) and a tracker outage (resilience.spec.ts); expiry is
 * in resilience.spec.ts as well.
 */
test.describe.configure({ mode: "serial" });

/** A seat shows offline 20 s after its last beat; a beat comes every 10 s, plus the 1 s roster coalesce. */
const QUIET_MS = 35_000;

const players: Player[] = [];
let west: Player;
let north: Player;
let south: Player;
let east: Player;
let newcomer: Player;
/** The tab that currently holds each seat. */
const tab = {} as Record<SeatKey, Page>;
/** The browser that currently holds each seat; the newcomer takes North over in row 5c. */
const holder = {} as Record<SeatKey, Player>;
let link = "";
const expected: string[] = [];

async function expectAllTranscripts(): Promise<void> {
	for (const page of Object.values(tab))
		await expect(texts(page)).toHaveText(expected);
}

/** Every tab names the same host. Returns its seat. */
async function commonHost(): Promise<SeatKey> {
	const seat = await hostRows(tab.W).getAttribute("data-seat", {
		timeout: CONNECT_MS,
	});
	if (seat !== "W" && seat !== "N" && seat !== "E" && seat !== "S")
		throw new Error(`no host seat: ${seat}`);
	for (const page of Object.values(tab))
		await expect(hostRows(page)).toHaveAttribute("data-seat", seat, {
			timeout: CONNECT_MS,
		});
	return seat;
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	const open = async (name: string): Promise<Player> => {
		const player = await Player.open(browser, baseURL, name);
		players.push(player);
		return player;
	};
	west = await open("west");
	north = await open("north");
	south = await open("south");
	east = await open("east");
	newcomer = await open("newcomer");
	Object.assign(holder, { W: west, N: north, S: south, E: east });
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus) await reportNetwork(players);
});

test.afterAll(async () => {
	for (const player of players) await player.close();
});

test("1: the creator gets one table link and hosts from West", async () => {
	tab.W = await west.page("./");
	link = await createRoom(tab.W);
	const roster = tab.W.getByTestId("roster");
	await expect(roster.locator('li[data-state="online"]')).toHaveCount(1);
	await expect(roster.locator('li[data-state="free"]')).toHaveCount(3);
	await expect(hostRows(tab.W)).toHaveAttribute("data-seat", "W");
	// A message needs no other player: the host orders it at once.
	await expect(tab.W.getByTestId("send")).toBeEnabled();
});

test("2: three browsers take North, South and East from the same link; the lobby offers only free seats", async () => {
	for (const [player, seat, offered] of [
		[north, "N", ["N", "E", "S"]],
		[south, "S", ["E", "S"]],
	] as const) {
		const page = await player.page(link);
		await expect(
			page.getByRole("heading", { name: "Choose your seat" }),
		).toBeVisible({ timeout: CONNECT_MS });
		await expect(picks(page)).toHaveCount(offered.length);
		for (const choice of offered)
			await expect(page.getByTestId(`pick-${choice}`)).toBeVisible();
		await pick(page, seat);
		tab[seat] = page;
	}
	// East is the last free seat, so its page takes it without a lobby.
	tab.E = await east.page(link);
	await expectSeat(tab.E, "E", {
		timeout: CONNECT_MS,
	});
	for (const page of Object.values(tab)) {
		await expect(
			page.getByTestId("roster").locator('li[data-state="online"]'),
		).toHaveCount(4, { timeout: CONNECT_MS });
		await openDrawer(page);
		await expect(page.getByTestId("all-connected")).toBeVisible({
			timeout: CONNECT_MS,
		});
	}
});

test("3: a test message and three replies arrive in one order everywhere", async () => {
	await sendDraft(tab.W);
	expected.push(MESSAGE.W);
	for (const seat of ["N", "S", "E"] as const) {
		await expect(lines(tab[seat])).toHaveCount(expected.length);
		await sendDraft(tab[seat]);
		expected.push(MESSAGE[seat]);
	}
	await expectAllTranscripts();
	for (const page of Object.values(tab)) {
		await expect(lines(page).locator(".receipt")).toHaveText(
			expected.map(() => "Received by 3 of 3"),
		);
		await expect(page.getByTestId("pending").locator("li")).toHaveCount(0);
	}
});

test("4: a guest reload restores the seat and the transcript", async () => {
	await tab.S.reload();
	await expectSeat(tab.S, "S", {
		timeout: CONNECT_MS,
	});
	await expect(texts(tab.S)).toHaveText(expected);
	await expect(tab.S.getByTestId("banner")).toBeHidden({ timeout: CONNECT_MS });
});

test("5a: a held seat is not offered to another browser", async () => {
	const page = await newcomer.page(link);
	await expect(page.getByText("All seats are taken.")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await expect(picks(page)).toHaveCount(0);
	await page.close();
});

test("5b: a second tab cannot take an active seat from the first tab", async () => {
	const old = tab.S;
	const page = await south.page(link);
	await expect(page.getByText("All seats are taken.")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await expect(page.locator('[data-testid="take-back-S"]')).toHaveCount(0);
	await expectSeat(old, "S");
	await expect(old.getByTestId("send")).toBeEnabled();
	await expect(old.getByTestId("draft")).toBeEnabled();
	await page.close();
});

test("5c: another player releases a silent seat; a new browser takes it; the old tab is superseded when it wakes", async () => {
	const old = tab.N;
	const thaw = await freeze(old);
	// Any seated player may release an offline seat (plan §2 D2); East is not the host.
	await expect(rosterSeat(tab.E, "N")).toHaveAttribute(
		"data-state",
		"offline",
		{
			timeout: QUIET_MS,
		},
	);
	await tab.E.getByTestId("release-N").click();
	await tab.E.getByTestId("confirm-release-N").click();
	await expect(rosterSeat(tab.E, "N")).toHaveAttribute("data-state", "free");

	// N is the only free seat, so the newcomer's page takes it without a picker.
	const page = await newcomer.page(link);
	await expectSeat(page, "N", {
		timeout: CONNECT_MS,
	});
	tab.N = page;
	holder.N = newcomer;
	await expect(texts(page)).toHaveText(expected);

	await thaw();
	await expectBanner(old, "superseded");
	await expect(old.getByTestId("send")).toBeDisabled();
	// Taking the seat back fails while the new holder is present.
	await old.getByTestId("retry-seat").click();
	await expect(
		old.getByText("Another player took this seat. Choose another one."),
	).toBeVisible({ timeout: CONNECT_MS });
	await expect(old.getByText("All seats are taken.")).toBeVisible();
	await old.close();
	await expect(
		tab.W.getByTestId("roster").locator('li[data-state="online"]'),
	).toHaveCount(4, { timeout: CONNECT_MS });
});

test("5d: reopening the link after closing the tab gives the same seat back", async () => {
	await tab.E.close();
	const page = await east.page(link);
	await expectSeat(page, "E", {
		timeout: CONNECT_MS,
	});
	await expect(
		page.getByRole("heading", { name: "Choose your seat" }),
	).toHaveCount(0);
	await expect(texts(page)).toHaveText(expected);
	tab.E = page;
});

test("6: the host crashes; a guest message waits; it is stored once after the host reopens", async () => {
	test.setTimeout(240_000);
	await tab.W.close({ runBeforeUnload: false });
	// Until the other players' last reports of the host are HOST_LOST_MS old, the banner says that the host is
	// unreachable; the wait allows for that and for the roster update.
	await expectBanner(tab.N, "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	// The newcomer took North in 5c with a new tab, and a new tab starts with the drawer closed.
	await openDrawer(tab.N);
	await tab.N.getByTestId("send").click();
	const waiting = tab.N.getByTestId("pending").locator("li");
	await expect(waiting).toHaveAttribute("data-state", "pending");
	await expect(waiting).toContainText("Pending — waiting for the host");
	await expect(texts(tab.N)).toHaveText(expected);

	// The table link opens the seat picker (ADR 0005); a player reopens with their own URL, which names the seat.
	tab.W = await west.page(ownLink(link, "W"));
	await expectSeat(tab.W, "W", {
		timeout: CONNECT_MS,
	});
	expected.push(MESSAGE.N);
	await expectAllTranscripts();
	await expect(waiting).toHaveCount(0);
	for (const page of Object.values(tab))
		await expect(page.getByTestId("banner")).toBeHidden({
			timeout: CONNECT_MS,
		});
	// The reopened host resumes its term unless a player volunteered first (after 30 s without a host).
	test.info().annotations.push({
		type: "host after the crash",
		description: await commonHost(),
	});
});

test("7: all four browsers quit and reopen the link: same seats, same table", async () => {
	const seats = ["W", "N", "S", "E"] as const;
	for (const seat of seats) await holder[seat].restart();
	for (const seat of seats) {
		tab[seat] = await holder[seat].page(ownLink(link, seat));
		await expectSeat(tab[seat], seat, {
			timeout: CONNECT_MS,
		});
	}
	await expectAllTranscripts();
	for (const page of Object.values(tab))
		await expect(
			page.getByTestId("roster").locator('li[data-state="online"]'),
		).toHaveCount(4, { timeout: CONNECT_MS });
	await commonHost();
});

test("8: a message whose result is lost is stored once", async () => {
	const host = await commonHost();
	const seat = (["S", "E", "N"] as const).find((other) => other !== host);
	if (!seat) throw new Error("no guest seat");
	// The host page holds the message unread while the guest's tab closes, so the result goes to a closed page.
	const thaw = await freeze(tab[host]);
	// Every tab reopened in test 7, and a reopened tab starts with the drawer closed.
	await openDrawer(tab[seat]);
	await tab[seat].getByTestId("send").click();
	await expect(
		tab[seat].getByTestId("pending").locator('li[data-state="sending"]'),
	).toHaveCount(1);
	await tab[seat].close({ runBeforeUnload: false });
	await thaw();
	expected.push(MESSAGE[seat]);
	for (const other of Object.keys(tab) as SeatKey[])
		if (other !== seat) await expect(texts(tab[other])).toHaveText(expected);

	tab[seat] = await holder[seat].page(link);
	await expectSeat(tab[seat], seat, {
		timeout: CONNECT_MS,
	});
	await expectAllTranscripts();
	await expect(tab[seat].getByTestId("pending").locator("li")).toHaveCount(0, {
		timeout: CONNECT_MS,
	});
	// The table continues after the lost result.
	await sendDraft(tab[seat]);
	expected.push(MESSAGE[seat]);
	await expectAllTranscripts();
});

test("9: a second game gets a new link and shows no old messages", async () => {
	const oldKey = new URL(link).hash;
	await tab.W.goto("./");
	const second = await createRoom(tab.W);
	expect(new URL(second).hash).not.toBe(oldKey);
	await expect(lines(tab.W)).toHaveCount(0);
	const page = await south.page(second);
	await expect(page.getByTestId("pick-S")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await pick(page, "S");
	await expect(lines(page)).toHaveCount(0);
	// The first table is unaffected.
	await expect(texts(tab.N)).toHaveText(expected);
});

test("no uncaught errors and no request to the old backend", () => {
	expect(players.flatMap((player) => player.errors)).toEqual([]);
	for (const player of players) expect(player.supabaseRequests).toBe(0);
});
