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
 * rows before it. Every person has their own browser, so their own holder. An unreachable table has two forms: no
 * host (row 6) and a tracker outage (resilience.spec.ts); expiry is in resilience.spec.ts as well.
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
/** The browser that currently holds each seat; the newcomer takes Player 1 over in row 5c. */
const holder = {} as Record<SeatKey, Player>;
let link = "";
const expected: string[] = [];

async function expectAllTranscripts(): Promise<void> {
	for (const page of Object.values(tab))
		await expect(texts(page)).toHaveText(expected);
}

/** Every tab names the same host. Returns its seat. */
async function commonHost(): Promise<SeatKey> {
	const seat = await hostRows(tab["4"]).getAttribute("data-seat", {
		timeout: CONNECT_MS,
	});
	if (seat !== "4" && seat !== "1" && seat !== "2" && seat !== "3")
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
	Object.assign(holder, { "4": west, "1": north, "3": south, "2": east });
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus) await reportNetwork(players);
});

test.afterAll(async () => {
	for (const player of players) await player.close();
});

test("1: the creator gets one table link and hosts from Player 4", async () => {
	tab["4"] = await west.page("./");
	link = await createRoom(tab["4"]);
	const roster = tab["4"].getByTestId("roster");
	await expect(roster.locator('li[data-state="online"]')).toHaveCount(1);
	await expect(roster.locator('li[data-state="free"]')).toHaveCount(3);
	await expect(hostRows(tab["4"])).toHaveAttribute("data-seat", "4");
	// A message needs no other player: the host orders it at once.
	await expect(tab["4"].getByTestId("send")).toBeEnabled();
});

test("2: three browsers take Player 1, Player 3 and Player 2 from the same link; the lobby offers only free seats", async () => {
	for (const [player, seat, offered] of [
		[north, "1", ["1", "2", "3"]],
		[south, "3", ["2", "3"]],
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
	// Player 2 is the last free seat, so its page takes it without a lobby.
	tab["2"] = await east.page(link);
	await expectSeat(tab["2"], "2", {
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
	await sendDraft(tab["4"]);
	expected.push(MESSAGE["4"]);
	for (const seat of ["1", "3", "2"] as const) {
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
	await tab["3"].reload();
	await expectSeat(tab["3"], "3", {
		timeout: CONNECT_MS,
	});
	await expect(texts(tab["3"])).toHaveText(expected);
	await expect(tab["3"].getByTestId("banner")).toBeHidden({
		timeout: CONNECT_MS,
	});
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
	const old = tab["3"];
	const page = await south.page(link);
	await expect(page.getByText("All seats are taken.")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await expect(page.locator('[data-testid="take-back-3"]')).toHaveCount(0);
	await expectSeat(old, "3");
	await expect(old.getByTestId("send")).toBeEnabled();
	await expect(old.getByTestId("draft")).toBeEnabled();
	await page.close();
});

test("5c: another player releases a silent seat; a new browser takes it; the old tab is superseded when it wakes", async () => {
	const old = tab["1"];
	const thaw = await freeze(old);
	// Any seated player may release an offline seat (plan §2 D2); Player 2 is not the host.
	await expect(rosterSeat(tab["2"], "1")).toHaveAttribute(
		"data-state",
		"offline",
		{
			timeout: QUIET_MS,
		},
	);
	await tab["2"].getByTestId("release-1").click();
	await tab["2"].getByTestId("confirm-release-1").click();
	await expect(rosterSeat(tab["2"], "1")).toHaveAttribute("data-state", "free");

	// N is the only free seat, so the newcomer's page takes it without a picker.
	const page = await newcomer.page(link);
	await expectSeat(page, "1", {
		timeout: CONNECT_MS,
	});
	tab["1"] = page;
	holder["1"] = newcomer;
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
		tab["4"].getByTestId("roster").locator('li[data-state="online"]'),
	).toHaveCount(4, { timeout: CONNECT_MS });
});

test("5d: reopening the link after closing the tab gives the same seat back", async () => {
	await tab["2"].close();
	const page = await east.page(link);
	await expectSeat(page, "2", {
		timeout: CONNECT_MS,
	});
	await expect(
		page.getByRole("heading", { name: "Choose your seat" }),
	).toHaveCount(0);
	await expect(texts(page)).toHaveText(expected);
	tab["2"] = page;
});

test("6: the host crashes; a guest message waits; it is stored once after the host reopens", async () => {
	test.setTimeout(240_000);
	await tab["4"].close({ runBeforeUnload: false });
	// Until the other players' last reports of the host are HOST_LOST_MS old, the banner says that the host is
	// unreachable; the wait allows for that and for the roster update.
	await expectBanner(tab["1"], "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	// The newcomer took Player 1 in 5c with a new tab, and a new tab starts with the drawer closed.
	await openDrawer(tab["1"]);
	await tab["1"].getByTestId("send").click();
	const waiting = tab["1"].getByTestId("pending").locator("li");
	await expect(waiting).toHaveAttribute("data-state", "pending");
	await expect(waiting).toContainText("Pending — waiting for the host");
	await expect(texts(tab["1"])).toHaveText(expected);

	// The table link opens the seat picker (ADR 0002); a player reopens with their own URL, which names the seat.
	tab["4"] = await west.page(ownLink(link, "4"));
	await expectSeat(tab["4"], "4", {
		timeout: CONNECT_MS,
	});
	expected.push(MESSAGE["1"]);
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
	const seats = ["4", "1", "3", "2"] as const;
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
	const seat = (["3", "2", "1"] as const).find((other) => other !== host);
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
	await tab["4"].goto("./");
	const second = await createRoom(tab["4"]);
	expect(new URL(second).hash).not.toBe(oldKey);
	await expect(lines(tab["4"])).toHaveCount(0);
	const page = await south.page(second);
	await expect(page.getByTestId("pick-3")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await pick(page, "3");
	await expect(lines(page)).toHaveCount(0);
	// The first table is unaffected.
	await expect(texts(tab["1"])).toHaveText(expected);
});

test("no uncaught errors", () => {
	expect(players.flatMap((player) => player.errors)).toEqual([]);
});
