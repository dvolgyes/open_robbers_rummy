import { expect, type Page, test } from "@playwright/test";
import {
	BUTTON_MS,
	CLAIM_PULL_MS,
	HOST_LOST_MS,
	STAGGER_MS,
	VOLUNTEER_MS,
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
	openDrawer,
	ownLink,
	pick,
	type SeatKey,
	sendDraft,
	texts,
} from "./room";

/**
 * Host election on the peer-to-peer table (plan §4.4, §9). The owner's numbers: the "Make me the host" button
 * after 10 s without a host, and an automatic volunteer after 30 s. A new term needs a witness: another browser
 * at the table (plan §2 D1). Each test has its own table and its own browsers.
 */

/**
 * The latest time for the automatic host after the host leaves: the host counts as lost HOST_LOST_MS after its
 * last beat, then the volunteer wait, the stagger of the three seats, the claim pull, and slack.
 */
const VOLUNTEER_LATEST_MS =
	HOST_LOST_MS + VOLUNTEER_MS + 3 * STAGGER_MS + CLAIM_PULL_MS + 15_000;
/** The host counts as lost HOST_LOST_MS after its last beat; then the button needs BUTTON_MS more, with slack. */
const BUTTON_LATEST_MS = HOST_LOST_MS + BUTTON_MS + 10_000;
const SEATS = ["W", "N", "E", "S"] as const satisfies readonly SeatKey[];

/** Every browser of every test, for the final error check. */
const all: Player[] = [];
/** The browsers of the running test; closed after it. */
const current: Player[] = [];
let openBrowser: (name: string) => Promise<Player>;

interface SeatedTable {
	readonly link: string;
	readonly tab: Partial<Record<SeatKey, Page>>;
	/** The creator's browser. */
	readonly west: Player;
}

/** West creates a table and hosts it; each other seat takes its place from the link in its own browser. */
async function seatTable(
	seats: readonly Exclude<SeatKey, "W">[],
): Promise<SeatedTable> {
	const west = await openBrowser("west");
	const tab: Partial<Record<SeatKey, Page>> = {};
	const creator = await west.page("./");
	tab.W = creator;
	const link = await createRoom(creator);
	for (const seat of seats) {
		const page = await (await openBrowser(seat)).page(link);
		await expect(page.getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await pick(page, seat);
		await expect(hostRows(page)).toHaveAttribute("data-seat", "W", {
			timeout: CONNECT_MS,
		});
		tab[seat] = page;
	}
	return { link, tab, west };
}

function tabOf(tab: Partial<Record<SeatKey, Page>>, seat: SeatKey): Page {
	const page = tab[seat];
	if (!page) throw new Error(`no tab for ${seat}`);
	return page;
}

/** Each page names the same host, in exactly one roster row. Returns its seat. */
async function commonHost(
	pages: readonly Page[],
	timeout = CONNECT_MS,
): Promise<SeatKey> {
	const [first] = pages;
	if (!first) throw new Error("no page");
	await expect(hostRows(first)).toHaveCount(1, { timeout });
	const seat = await hostRows(first).getAttribute("data-seat");
	const found = SEATS.find((item) => item === seat);
	if (!found) throw new Error(`no host seat: ${seat}`);
	for (const page of pages)
		await expect(hostRows(page)).toHaveAttribute("data-seat", found, {
			timeout,
		});
	return found;
}

/** Checks the condition every 250 ms until the deadline (`Date.now()` value); fails at the first miss. */
async function holdsUntil(
	until: number,
	what: string,
	check: () => Promise<boolean>,
): Promise<void> {
	while (Date.now() < until) {
		expect(await check(), what).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/**
 * Clicks the page's host button at the wall-clock time `at` from inside the page, so that two pages click within
 * the same millisecond, before either can hear the other's claim. Resolves true when the button was enabled.
 */
function clickHostAt(page: Page, at: number): Promise<boolean> {
	return page.evaluate(
		(time) =>
			new Promise<boolean>((resolve) => {
				setTimeout(
					() => {
						const node = document.querySelector('[data-testid="become-host"]');
						const ready =
							node instanceof HTMLButtonElement &&
							!node.disabled &&
							node.checkVisibility();
						if (ready) node.click();
						resolve(ready);
					},
					Math.max(0, time - Date.now()),
				);
			}),
		at,
	);
}

test.beforeAll(({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	openBrowser = async (name) => {
		const player = await Player.open(browser, baseURL, name);
		all.push(player);
		current.push(player);
		return player;
	};
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus) await reportNetwork(current);
	for (const player of current.splice(0)) await player.close();
});

/** West leaves a table where only North sits. North's page waits for a host and shows the disabled button. */
async function northAlone(): Promise<{
	readonly link: string;
	readonly north: Page;
	readonly westBrowser: Player;
	readonly since: number;
	/** When the disabled button showed: BUTTON_MS into North's absence clock. */
	readonly shownAt: number;
}> {
	const { link, tab, west: westBrowser } = await seatTable(["N"]);
	const north = tabOf(tab, "N");
	await tabOf(tab, "W").close({ runBeforeUnload: false });
	const since = Date.now();

	// The banner reads "unreachable" until West's last beat is HOST_LOST_MS old.
	await expectBanner(north, "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	const become = north.getByTestId("become-host");
	await expect(become).toBeVisible({ timeout: BUTTON_LATEST_MS });
	const shownAt = Date.now();
	const shownAfter = shownAt - since;
	test.info().annotations.push({
		type: "button shown after (ms)",
		description: String(shownAfter),
	});
	expect(shownAfter).toBeGreaterThanOrEqual(BUTTON_MS);
	await expect(become).toBeDisabled();
	await expect(north.getByTestId("banner")).toContainText(
		"Another player must be online to confirm",
	);
	return { link, north, westBrowser, since, shownAt };
}

/** The old host reopens and follows North; West's message reaches every page. */
async function westFollowsNorth(
	link: string,
	westBrowser: Player,
	north: Page,
	visitor: Page,
): Promise<void> {
	await expect(visitor.getByTestId("pick-E")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await pick(visitor, "E");
	const west = await westBrowser.page(ownLink(link, "W"));
	await expectSeat(west, "W", {
		timeout: CONNECT_MS,
	});
	expect(await commonHost([north, visitor, west])).toBe("N");
	await sendDraft(west);
	for (const page of [north, visitor, west])
		await expect(texts(page)).toHaveText([MESSAGE.W]);
}

test("the button shows after 10 s without a host; it waits for a witness, and a click gives one host", async () => {
	test.setTimeout(180_000);
	const { link, north, westBrowser, shownAt } = await northAlone();
	const become = north.getByTestId("become-host");

	// A visitor in another browser is a witness. It must connect before the automatic volunteer at 30 s.
	const visitor = await (await openBrowser("visitor")).page(link);
	await expect(become).toBeEnabled({ timeout: CONNECT_MS });
	// North's absence clock was at BUTTON_MS when the button showed.
	const absentAtEnable = BUTTON_MS + Date.now() - shownAt;
	test.info().annotations.push({
		type: "absence when the button was enabled (ms)",
		description: String(absentAtEnable),
	});
	expect(
		absentAtEnable,
		"the witness came before the automatic volunteer",
	).toBeLessThan(VOLUNTEER_MS);
	await become.click();
	await expect(hostRows(north)).toHaveAttribute("data-seat", "N", {
		timeout: CONNECT_MS,
	});
	await expect(north.getByTestId("banner")).toBeHidden();
	await westFollowsNorth(link, westBrowser, north, visitor);
});

test("alone, a seated player never becomes the host; after 30 s it volunteers as soon as a witness comes", async () => {
	test.setTimeout(180_000);
	const { link, north, westBrowser, since } = await northAlone();
	const become = north.getByTestId("become-host");
	// Alone, North never volunteers: no new term without a witness (plan §2 D1).
	await holdsUntil(
		since + HOST_LOST_MS + VOLUNTEER_MS + 10_000,
		"North stays without a host and its button stays disabled",
		async () =>
			(await hostRows(north).count()) === 0 &&
			(await become.isVisible()) &&
			(await become.isDisabled()),
	);

	// The 30 s are over, so the witness's arrival is enough: North volunteers without a click (rule 8).
	const visitor = await (await openBrowser("visitor")).page(link);
	await expect(hostRows(north)).toHaveAttribute("data-seat", "N", {
		timeout: CONNECT_MS,
	});
	await expect(north.getByTestId("banner")).toBeHidden();
	await westFollowsNorth(link, westBrowser, north, visitor);
});

test("with four seats, a player volunteers about 30 s after the host leaves; the old host follows when it returns", async () => {
	test.setTimeout(180_000);
	const { link, tab, west: westBrowser } = await seatTable(["N", "E"]);
	// "All players connected" needs the other three seats.
	await openDrawer(tabOf(tab, "W"));
	await expect(tabOf(tab, "W").getByTestId("all-connected")).toBeHidden();
	const south = await (await openBrowser("S")).page(link);
	await expect(south.getByTestId("pick-S")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await pick(south, "S");
	tab.S = south;
	for (const seat of SEATS) {
		await openDrawer(tabOf(tab, seat));
		await expect(tabOf(tab, seat).getByTestId("all-connected")).toBeVisible({
			timeout: CONNECT_MS,
		});
	}

	await tabOf(tab, "W").close({ runBeforeUnload: false });
	const since = Date.now();
	const guests = (["N", "E", "S"] as const).map((seat) => tabOf(tab, seat));
	for (const page of guests)
		await expect(page.getByTestId("become-host")).toBeEnabled({
			timeout: BUTTON_LATEST_MS,
		});
	// Nobody clicks.
	await expect(hostRows(guests[0] as Page)).toHaveCount(1, {
		timeout: since + VOLUNTEER_LATEST_MS - Date.now(),
	});
	const hostAfter = Date.now() - since;
	test.info().annotations.push({
		type: "automatic host after (ms)",
		description: String(hostAfter),
	});
	expect(hostAfter).toBeGreaterThanOrEqual(VOLUNTEER_MS);
	const host = await commonHost(guests);
	expect(host).not.toBe("W");
	for (const page of guests)
		await expect(page.getByTestId("banner")).toBeHidden();

	const west = await westBrowser.page(ownLink(link, "W"));
	await expectSeat(west, "W", {
		timeout: CONNECT_MS,
	});
	expect(await commonHost([...guests, west])).toBe(host);
	await sendDraft(west);
	for (const page of [...guests, west])
		await expect(texts(page)).toHaveText([MESSAGE.W]);
});

test("two players who click at the same moment get exactly one host", async () => {
	const { tab } = await seatTable(["N", "E"]);
	const north = tabOf(tab, "N");
	const east = tabOf(tab, "E");
	await tabOf(tab, "W").close({ runBeforeUnload: false });
	for (const page of [north, east])
		await expect(page.getByTestId("become-host")).toBeEnabled({
			timeout: BUTTON_LATEST_MS,
		});

	const at = Date.now() + 1_000;
	expect(
		await Promise.all([clickHostAt(north, at), clickHostAt(east, at)]),
		"both clicks reached an enabled button",
	).toEqual([true, true]);
	const host = await commonHost([north, east]);
	test.info().annotations.push({ type: "host", description: host });
	await holdsUntil(
		Date.now() + 8_000,
		"both pages keep one and the same host",
		async () =>
			(await hostRows(north).getAttribute("data-seat")) === host &&
			(await hostRows(east).getAttribute("data-seat")) === host,
	);

	await sendDraft(north);
	await expect(texts(east)).toHaveText([MESSAGE.N]);
	await sendDraft(east);
	for (const page of [north, east])
		await expect(texts(page)).toHaveText([MESSAGE.N, MESSAGE.E]);
});

test("a host that reloads resumes its term, and no page shows the button", async () => {
	const { tab } = await seatTable(["N", "E"]);
	const west = tabOf(tab, "W");
	const guests = [tabOf(tab, "N"), tabOf(tab, "E")];
	const noButton = async (pages: readonly Page[]): Promise<boolean> => {
		for (const page of pages)
			if (await page.getByTestId("become-host").isVisible()) return false;
		return true;
	};
	const watching = holdsUntil(
		Date.now() + 20_000,
		"no guest shows the host button",
		() => noButton(guests),
	);
	await west.reload();
	await expectSeat(west, "W", {
		timeout: CONNECT_MS,
	});
	await holdsUntil(
		Date.now() + 5_000,
		"the reloaded host shows no button",
		() => noButton([west]),
	);
	await watching;
	expect(await commonHost([west, ...guests])).toBe("W");

	await sendDraft(tabOf(tab, "N"));
	for (const page of [west, ...guests])
		await expect(texts(page)).toHaveText([MESSAGE.N]);
});

test("a thawed old host steps down, and its later message still goes through", async () => {
	const { tab } = await seatTable(["N", "E"]);
	const west = tabOf(tab, "W");
	const north = tabOf(tab, "N");
	const east = tabOf(tab, "E");
	const thaw = await freeze(west);
	const become = north.getByTestId("become-host");
	await expect(become).toBeEnabled({ timeout: BUTTON_LATEST_MS });
	await become.click();
	expect(await commonHost([north, east])).toBe("N");

	await thaw();
	expect(await commonHost([west, north, east])).toBe("N");
	await expect(west.getByTestId("banner")).toBeHidden({ timeout: CONNECT_MS });
	await expectSeat(west, "W");
	await sendDraft(west);
	for (const page of [west, north, east])
		await expect(texts(page)).toHaveText([MESSAGE.W]);
	await expect(west.getByTestId("pending").locator("li")).toHaveCount(0);
});

test("a second tab cannot take the host's active seat", async () => {
	const { link, tab, west: westBrowser } = await seatTable(["N"]);
	const old = tabOf(tab, "W");
	const north = tabOf(tab, "N");
	const west = await westBrowser.page(link);
	await expect(
		west.getByRole("heading", { name: "Choose your seat" }),
	).toBeVisible({ timeout: CONNECT_MS });
	await expect(west.getByTestId("pick-W")).toHaveCount(0);
	await expectSeat(old, "W");
	await expect(old.getByTestId("send")).toBeEnabled();

	expect(await commonHost([old, north])).toBe("W");
	await sendDraft(old);
	await expect(texts(north)).toHaveText([MESSAGE.W]);
});

test("no uncaught errors and no request to the old backend", () => {
	expect(all.flatMap((player) => player.errors)).toEqual([]);
	for (const player of all) expect(player.supabaseRequests).toBe(0);
});
