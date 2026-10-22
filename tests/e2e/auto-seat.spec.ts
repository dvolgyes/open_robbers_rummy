import { expect, test } from "@playwright/test";
import { Player, reportNetwork } from "./player";
import { CONNECT_MS, createRoom, expectSeat } from "./room";

/**
 * The last free seat needs no choice: a page that opens the table link when three seats are taken takes the
 * fourth seat by itself. When all four seats are present, the hosting page deals the first hand.
 */
test.describe.configure({ mode: "serial" });

const players: Player[] = [];

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const name of ["creator", "north", "east", "south"])
		players.push(await Player.open(browser, baseURL, name));
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus) await reportNetwork(players);
});

test.afterAll(async () => {
	for (const player of players) await player.close();
});

test("the last free seat is taken by the page that opens the link, and the first hand is dealt", async () => {
	test.setTimeout(240_000);
	const [creator, north, east, south] = players as [
		Player,
		Player,
		Player,
		Player,
	];
	const link = await createRoom(await creator.page("./"));

	for (const [player, seat] of [
		[north, "N"],
		[east, "E"],
	] as const) {
		const page = await player.page(link);
		await expect(page.getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await page.getByTestId(`pick-${seat}`).click();
		await expectSeat(page, seat);
	}

	// Only South is free: this page takes it without a picker.
	const page = await south.page(link);
	await expectSeat(page, "S", {
		timeout: CONNECT_MS,
	});
	await expect(page.getByTestId("pick-S")).toHaveCount(0);

	// All four seats are present, so the host deals hand 1 automatically.
	await expect(page.getByTestId("table")).toHaveAttribute("data-hand", "1", {
		timeout: CONNECT_MS,
	});
});

test("no uncaught errors", () => {
	expect(players.flatMap((player) => player.errors)).toEqual([]);
});
