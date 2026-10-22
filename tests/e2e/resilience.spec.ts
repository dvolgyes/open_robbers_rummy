import { expect, type Page, test } from "@playwright/test";
import { BUTTON_MS, HOST_LOST_MS } from "../../src/p2p/limits";
import { Player, type RigOptions, reportNetwork } from "./player";
import {
	CONNECT_MS,
	createRoom,
	expectBanner,
	expectSeat,
	MESSAGE,
	openDrawer,
	pick,
	picks,
	type SeatKey,
	sendDraft,
	takeTurn,
	texts,
	turnOrder,
} from "./room";

/**
 * Failures around the table (plan §9): the trackers go down, the browser does not store data, the link is old,
 * of another version or damaged, and the table expires. Each test has its own browsers. The trackers and the
 * peers are the real ones.
 */

const all: Player[] = [];
const current: Player[] = [];
let openBrowser: (name: string, rig?: RigOptions) => Promise<Player>;

/** Every table older than this is expired (24 h without activity, plan §4.7). */
const AGED_MS = 25 * 60 * 60 * 1_000;

/**
 * Moves the last activity of every table stored in this browser back by 25 h, as on a device that last played a
 * day ago. The page must be at the app's origin. The records stay valid, so the app reads them as usual.
 */
async function ageStoredTables(page: Page): Promise<number> {
	return page.evaluate(
		(aged) =>
			new Promise<number>((resolve, reject) => {
				const opened = indexedDB.open("oc-p2p");
				opened.onerror = () => reject(opened.error);
				opened.onsuccess = () => {
					const db = opened.result;
					const tx = db.transaction("tables", "readwrite");
					const store = tx.objectStore("tables");
					let changed = 0;
					const cursor = store.openCursor();
					cursor.onsuccess = () => {
						const row = cursor.result;
						if (!row) return;
						row.update({ ...row.value, lastActivityAt: Date.now() - aged });
						changed += 1;
						row.continue();
					};
					tx.oncomplete = () => {
						db.close();
						resolve(changed);
					};
					tx.onerror = () => reject(tx.error);
				};
			}),
		AGED_MS,
	);
}

test.beforeAll(({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	openBrowser = async (name, rig = {}) => {
		const player = await Player.open(browser, baseURL, name, {}, rig);
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

test("a tracker outage keeps the table: messages, the deal and the play go on; a newcomer finds the table afterwards", async () => {
	test.setTimeout(180_000);
	const seats = ["W", "N", "E", "S"] as const satisfies readonly SeatKey[];
	const browsers = {} as Record<SeatKey, Player>;
	const tab = {} as Record<SeatKey, Page>;
	for (const seat of seats)
		browsers[seat] = await openBrowser(seat, { trackerSwitch: true });
	tab.W = await browsers.W.page("./");
	const link = await createRoom(tab.W);
	for (const seat of ["N", "E", "S"] as const) {
		tab[seat] = await browsers[seat].page(link);
		await expect(tab[seat].getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await pick(tab[seat], seat);
	}
	for (const seat of seats) {
		await openDrawer(tab[seat]);
		await expect(tab[seat].getByTestId("all-connected")).toBeVisible({
			timeout: CONNECT_MS,
		});
	}

	for (const seat of seats) await browsers[seat].network.block();
	const cutAt = Date.now();
	const expected: string[] = [];
	for (const seat of seats) {
		await sendDraft(tab[seat]);
		expected.push(MESSAGE[seat]);
		for (const other of seats)
			await expect(texts(tab[other])).toHaveText(expected);
	}
	// The hosting page deals the first hand by itself, so there is no click here.
	for (const seat of seats)
		await expect(tab[seat].getByTestId("table")).toHaveAttribute(
			"data-phase",
			"play",
		);
	// The first dealer is random, so the first player is too.
	const [first] = await turnOrder(tab);
	if (first === undefined) throw new Error("nobody plays first");
	await takeTurn(tab[first], 0);
	for (const seat of seats)
		await expect(tab[seat].getByTestId("table")).toHaveAttribute(
			"data-at",
			"2",
		);
	// Longer than a host loss (6 s) and the roster coalesce: nobody counts as gone without the trackers.
	await expect
		.poll(() => Date.now() - cutAt, { timeout: 30_000 })
		.toBeGreaterThan(15_000);
	for (const seat of seats) {
		await expect(
			tab[seat].getByTestId("roster").locator('li[data-state="online"]'),
		).toHaveCount(4);
		await expect(tab[seat].getByTestId("banner")).toBeHidden();
	}

	for (const seat of seats) browsers[seat].network.unblock();
	const newcomer = await (await openBrowser("newcomer")).page(link);
	await expect(newcomer.getByText("All seats are taken.")).toBeVisible({
		timeout: 90_000,
	});
});

test("a browser that does not store data cannot create a table, but it can take a seat and play; it cannot become the host", async () => {
	test.setTimeout(120_000);
	const west = await openBrowser("west");
	const creator = await west.page("./");
	const link = await createRoom(creator);
	const blocked = await openBrowser("blocked", { blockSiteData: true });

	const create = await blocked.page("./");
	await expect(
		create.getByText(
			"This browser does not allow storing data, so it cannot create a table",
		),
	).toBeVisible();
	await expect(create.getByTestId("create")).toBeDisabled();
	await create.close();

	const page = await blocked.page(link);
	await expect(
		page.getByText(/^This browser does not store data \(/),
	).toBeVisible({ timeout: CONNECT_MS });
	await expect(page.getByTestId("pick-N")).toBeVisible({ timeout: CONNECT_MS });
	await pick(page, "N");
	await sendDraft(page);
	await expect(texts(creator)).toHaveText([MESSAGE.N]);
	await sendDraft(creator);
	await expect(texts(page)).toHaveText([MESSAGE.N, MESSAGE.W]);

	await creator.close({ runBeforeUnload: false });
	await expectBanner(page, "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	const become = page.getByTestId("become-host");
	await expect(become).toBeVisible({
		timeout: HOST_LOST_MS + BUTTON_MS + 10_000,
	});
	await expect(become).toBeDisabled();
	await expect(page.getByTestId("banner")).toContainText(
		"This browser cannot store the table",
	);
});

test("an old Supabase link shows the old-version message", async () => {
	const page = await (await openBrowser("visitor")).page(
		"./#room=0123456789abcdefABCDEF",
	);
	await expect(
		page.getByText(
			"This link is for the old version. Ask the table creator for a new link.",
		),
	).toBeVisible();
});

test("a link of another version shows the version message", async () => {
	const page = await (await openBrowser("visitor")).page(
		`./#v=p2p-v9&k=${"A".repeat(43)}`,
	);
	await expect(
		page.getByText(
			"This link is for another version of the app. Reload the page, or ask the table creator for a new link.",
		),
	).toBeVisible();
});

test("a damaged key opens an empty table: nobody is there", async () => {
	const west = await openBrowser("west");
	const creator = await west.page("./");
	const link = await createRoom(creator);
	// The same length and alphabet, the first key character changed: another table. The last character holds
	// only 4 key bits, so a change there can make the link not valid instead. The search starts at the fragment,
	// because a query name can also end in "k=" (bot_fallback=).
	const at = link.indexOf("k=", link.indexOf("#")) + 2;
	const first = link[at] === "A" ? "B" : "A";
	const damaged = `${link.slice(0, at)}${first}${link.slice(at + 1)}`;
	const page = await (await openBrowser("visitor")).page(damaged);
	await expect(
		page.getByText("Nobody is at this table right now. Keep this page open"),
	).toBeVisible({ timeout: CONNECT_MS });
	// The link carries the full setup, so the empty table offers all four seats (ADR 0005). The real table, where
	// West is taken, would offer three.
	await expect(picks(page)).toHaveCount(4);
	// The real table is unaffected.
	await expectSeat(creator, "W");
});

test("a table without activity for 24 h expires and stays expired; the full room link starts it again", async () => {
	const west = await openBrowser("west");
	const page = await west.page("./");
	const link = await createRoom(page);
	// Without the setup query the link has only the key, so nothing can start the table again (ADR 0005).
	const keyOnly = new URL(link);
	keyOnly.search = "";
	await sendDraft(page);
	await page.goto("./");
	expect(await ageStoredTables(page)).toBe(1);
	await page.goto(keyOnly.toString());
	await expect(
		page.getByRole("heading", {
			name: "The game has expired or is no longer available",
		}),
	).toBeVisible({ timeout: CONNECT_MS });
	await expect(
		page.getByRole("button", { name: "Create new game" }),
	).toBeVisible();
	// The table is deleted and a tombstone keeps the link expired.
	await page.reload();
	await expect(
		page.getByRole("heading", {
			name: "The game has expired or is no longer available",
		}),
	).toBeVisible({ timeout: CONNECT_MS });
	await page.getByRole("button", { name: "Create new game" }).click();
	await expect(page.getByTestId("create")).toBeVisible();
	// The room link carries the names and the host seat: it clears the tombstone, offers all four seats, and the
	// host seat starts a fresh table (ADR 0005).
	await page.goto(link);
	await expect(picks(page)).toHaveCount(4, { timeout: CONNECT_MS });
	await pick(page, "W");
	await expectSeat(page, "W");
	await expect(page.getByTestId("table")).toHaveAttribute(
		"data-phase",
		"waiting",
	);
});

test("no uncaught errors and no request to the old backend", () => {
	expect(all.flatMap((player) => player.errors)).toEqual([]);
	for (const player of all) expect(player.supabaseRequests).toBe(0);
});
