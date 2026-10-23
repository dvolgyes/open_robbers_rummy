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
	createTable,
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
} from "./table";

/**
 * Host election on the peer-to-peer table. The owner's numbers: the "Make me the host" button
 * after 10 s without a host, and an automatic volunteer after 30 s. A new term needs a witness: another browser
 * at the table. Each test has its own table and its own browsers.
 */

/**
 * The latest time for the automatic host after the host leaves: the host counts as lost HOST_LOST_MS after its
 * last beat, then the volunteer wait, the stagger of the three seats, the claim pull, and slack.
 */
const VOLUNTEER_LATEST_MS =
	HOST_LOST_MS + VOLUNTEER_MS + 3 * STAGGER_MS + CLAIM_PULL_MS + 15_000;
/** The host counts as lost HOST_LOST_MS after its last beat; then the button needs BUTTON_MS more, with slack. */
const BUTTON_LATEST_MS = HOST_LOST_MS + BUTTON_MS + 10_000;
const SEATS = ["4", "1", "2", "3"] as const satisfies readonly SeatKey[];

/** Every browser of every test, for the final error check. */
const all: Player[] = [];
/** The browsers of the running test; closed after it. */
const current: Player[] = [];
let openBrowser: (name: string) => Promise<Player>;

interface SeatedTable {
	readonly link: string;
	readonly tab: Partial<Record<SeatKey, Page>>;
	/** The creator's browser. */
	readonly player4: Player;
}

/** Player 4 creates a table and hosts it; each other seat takes its place from the link in its own browser. */
async function seatTable(
	seats: readonly Exclude<SeatKey, "4">[],
): Promise<SeatedTable> {
	const player4 = await openBrowser("player4");
	const tab: Partial<Record<SeatKey, Page>> = {};
	const creator = await player4.page("./");
	tab["4"] = creator;
	const link = await createTable(creator);
	for (const seat of seats) {
		const page = await (await openBrowser(seat)).page(link);
		await expect(page.getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await pick(page, seat);
		await expect(hostRows(page)).toHaveAttribute("data-seat", "4", {
			timeout: CONNECT_MS,
		});
		tab[seat] = page;
	}
	return { link, tab, player4 };
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

/** Player 4 leaves a table where only Player 1 sits. Player 1's page waits for a host and shows the disabled button. */
async function player1Alone(): Promise<{
	readonly link: string;
	readonly player1: Page;
	readonly player4Browser: Player;
	readonly since: number;
	/** When the disabled button showed: BUTTON_MS into Player 1's absence clock. */
	readonly shownAt: number;
}> {
	const { link, tab, player4: player4Browser } = await seatTable(["1"]);
	const player1 = tabOf(tab, "1");
	await tabOf(tab, "4").close({ runBeforeUnload: false });
	const since = Date.now();

	// The banner reads "unreachable" until Player 4's last beat is HOST_LOST_MS old.
	await expectBanner(player1, "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	const become = player1.getByTestId("become-host");
	await expect(become).toBeVisible({ timeout: BUTTON_LATEST_MS });
	const shownAt = Date.now();
	const shownAfter = shownAt - since;
	test.info().annotations.push({
		type: "button shown after (ms)",
		description: String(shownAfter),
	});
	expect(shownAfter).toBeGreaterThanOrEqual(BUTTON_MS);
	await expect(become).toBeDisabled();
	await expect(player1.getByTestId("banner")).toContainText(
		"Another player must be online to confirm",
	);
	return { link, player1, player4Browser, since, shownAt };
}

/** The old host reopens and follows Player 1; Player 4's message reaches every page. */
async function player4FollowsPlayer1(
	link: string,
	player4Browser: Player,
	player1: Page,
	visitor: Page,
): Promise<void> {
	await expect(visitor.getByTestId("pick-2")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await pick(visitor, "2");
	const player4 = await player4Browser.page(ownLink(link, "4"));
	await expectSeat(player4, "4", {
		timeout: CONNECT_MS,
	});
	expect(await commonHost([player1, visitor, player4])).toBe("1");
	await sendDraft(player4);
	for (const page of [player1, visitor, player4])
		await expect(texts(page)).toHaveText([MESSAGE["4"]]);
}

test("the button shows after 10 s without a host; it waits for a witness, and a click gives one host", async () => {
	test.setTimeout(180_000);
	const { link, player1, player4Browser, shownAt } = await player1Alone();
	const become = player1.getByTestId("become-host");

	// A visitor in another browser is a witness. It must connect before the automatic volunteer at 30 s.
	const visitor = await (await openBrowser("visitor")).page(link);
	await expect(become).toBeEnabled({ timeout: CONNECT_MS });
	// Player 1's absence clock was at BUTTON_MS when the button showed.
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
	await expect(hostRows(player1)).toHaveAttribute("data-seat", "1", {
		timeout: CONNECT_MS,
	});
	await expect(player1.getByTestId("banner")).toBeHidden();
	await player4FollowsPlayer1(link, player4Browser, player1, visitor);
});

test("alone, a seated player never becomes the host; after 30 s it volunteers as soon as a witness comes", async () => {
	test.setTimeout(180_000);
	const { link, player1, player4Browser, since } = await player1Alone();
	const become = player1.getByTestId("become-host");
	// Alone, Player 1 never volunteers: no new term without a witness.
	await holdsUntil(
		since + HOST_LOST_MS + VOLUNTEER_MS + 10_000,
		"Player 1 stays without a host and its button stays disabled",
		async () =>
			(await hostRows(player1).count()) === 0 &&
			(await become.isVisible()) &&
			(await become.isDisabled()),
	);

	// The 30 s are over, so the witness's arrival is enough: Player 1 volunteers without a click (rule 8).
	const visitor = await (await openBrowser("visitor")).page(link);
	await expect(hostRows(player1)).toHaveAttribute("data-seat", "1", {
		timeout: CONNECT_MS,
	});
	await expect(player1.getByTestId("banner")).toBeHidden();
	await player4FollowsPlayer1(link, player4Browser, player1, visitor);
});

test("with four seats, a player volunteers about 30 s after the host leaves; the old host follows when it returns", async () => {
	test.setTimeout(180_000);
	const { link, tab, player4: player4Browser } = await seatTable(["1", "2"]);
	// "All players connected" needs the other three seats.
	await openDrawer(tabOf(tab, "4"));
	await expect(tabOf(tab, "4").getByTestId("all-connected")).toBeHidden();
	const player3 = await (await openBrowser("3")).page(link);
	await expect(player3.getByTestId("pick-3")).toBeVisible({
		timeout: CONNECT_MS,
	});
	await pick(player3, "3");
	tab["3"] = player3;
	for (const seat of SEATS) {
		await openDrawer(tabOf(tab, seat));
		await expect(tabOf(tab, seat).getByTestId("all-connected")).toBeVisible({
			timeout: CONNECT_MS,
		});
	}

	await tabOf(tab, "4").close({ runBeforeUnload: false });
	const since = Date.now();
	const guests = (["1", "2", "3"] as const).map((seat) => tabOf(tab, seat));
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
	expect(host).not.toBe("4");
	for (const page of guests)
		await expect(page.getByTestId("banner")).toBeHidden();

	const player4 = await player4Browser.page(ownLink(link, "4"));
	await expectSeat(player4, "4", {
		timeout: CONNECT_MS,
	});
	expect(await commonHost([...guests, player4])).toBe(host);
	await sendDraft(player4);
	for (const page of [...guests, player4])
		await expect(texts(page)).toHaveText([MESSAGE["4"]]);
});

test("two players who click at the same moment get exactly one host", async () => {
	const { tab } = await seatTable(["1", "2"]);
	const player1 = tabOf(tab, "1");
	const player2 = tabOf(tab, "2");
	await tabOf(tab, "4").close({ runBeforeUnload: false });
	for (const page of [player1, player2])
		await expect(page.getByTestId("become-host")).toBeEnabled({
			timeout: BUTTON_LATEST_MS,
		});

	const at = Date.now() + 1_000;
	expect(
		await Promise.all([clickHostAt(player1, at), clickHostAt(player2, at)]),
		"both clicks reached an enabled button",
	).toEqual([true, true]);
	const host = await commonHost([player1, player2]);
	test.info().annotations.push({ type: "host", description: host });
	await holdsUntil(
		Date.now() + 8_000,
		"both pages keep one and the same host",
		async () =>
			(await hostRows(player1).getAttribute("data-seat")) === host &&
			(await hostRows(player2).getAttribute("data-seat")) === host,
	);

	await sendDraft(player1);
	await expect(texts(player2)).toHaveText([MESSAGE["1"]]);
	await sendDraft(player2);
	for (const page of [player1, player2])
		await expect(texts(page)).toHaveText([MESSAGE["1"], MESSAGE["2"]]);
});

test("a host that reloads resumes its term, and no page shows the button", async () => {
	const { tab } = await seatTable(["1", "2"]);
	const player4 = tabOf(tab, "4");
	const guests = [tabOf(tab, "1"), tabOf(tab, "2")];
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
	await player4.reload();
	await expectSeat(player4, "4", {
		timeout: CONNECT_MS,
	});
	await holdsUntil(
		Date.now() + 5_000,
		"the reloaded host shows no button",
		() => noButton([player4]),
	);
	await watching;
	expect(await commonHost([player4, ...guests])).toBe("4");

	await sendDraft(tabOf(tab, "1"));
	for (const page of [player4, ...guests])
		await expect(texts(page)).toHaveText([MESSAGE["1"]]);
});

test("a thawed old host steps down, and its later message still goes through", async () => {
	const { tab } = await seatTable(["1", "2"]);
	const player4 = tabOf(tab, "4");
	const player1 = tabOf(tab, "1");
	const player2 = tabOf(tab, "2");
	const thaw = await freeze(player4);
	const become = player1.getByTestId("become-host");
	await expect(become).toBeEnabled({ timeout: BUTTON_LATEST_MS });
	await become.click();
	expect(await commonHost([player1, player2])).toBe("1");

	await thaw();
	expect(await commonHost([player4, player1, player2])).toBe("1");
	await expect(player4.getByTestId("banner")).toBeHidden({
		timeout: CONNECT_MS,
	});
	await expectSeat(player4, "4");
	await sendDraft(player4);
	for (const page of [player4, player1, player2])
		await expect(texts(page)).toHaveText([MESSAGE["4"]]);
	await expect(player4.getByTestId("pending").locator("li")).toHaveCount(0);
});

test("a second tab cannot take the host's active seat", async () => {
	const { link, tab, player4: player4Browser } = await seatTable(["1"]);
	const old = tabOf(tab, "4");
	const player1 = tabOf(tab, "1");
	const player4 = await player4Browser.page(link);
	await expect(
		player4.getByRole("heading", { name: "Choose your seat" }),
	).toBeVisible({ timeout: CONNECT_MS });
	await expect(player4.getByTestId("pick-4")).toHaveCount(0);
	await expectSeat(old, "4");
	await expect(old.getByTestId("send")).toBeEnabled();

	expect(await commonHost([old, player1])).toBe("4");
	await sendDraft(old);
	await expect(texts(player1)).toHaveText([MESSAGE["4"]]);
});

test("no uncaught errors", () => {
	expect(all.flatMap((player) => player.errors)).toEqual([]);
});
