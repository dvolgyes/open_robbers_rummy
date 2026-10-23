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
	for (const name of ["creator", "player1", "player2", "player3"])
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
	const [creator, player1, player2, player3] = players as [
		Player,
		Player,
		Player,
		Player,
	];
	const link = await createRoom(await creator.page("./"));

	for (const [player, seat] of [
		[player1, "1"],
		[player2, "2"],
	] as const) {
		const page = await player.page(link);
		await expect(page.getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await page.getByTestId(`pick-${seat}`).click();
		await expectSeat(page, seat);
	}

	// Only Player 3 is free: this page takes it without a picker.
	const page = await player3.page(link);
	await expectSeat(page, "3", {
		timeout: CONNECT_MS,
	});
	await expect(page.getByTestId("pick-3")).toHaveCount(0);

	// All four seats are present, so the host deals hand 1 automatically.
	await expect(page.getByTestId("table")).toHaveAttribute("data-hand", "1", {
		timeout: CONNECT_MS,
	});
});

test("no uncaught errors", () => {
	expect(players.flatMap((player) => player.errors)).toEqual([]);
});
