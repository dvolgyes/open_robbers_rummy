import { expect, type Page, test } from "@playwright/test";
import { Player, reportNetwork } from "./player";
import { CONNECT_MS } from "./room";

/** A shared room link carries setup values; a player's page URL also selects their seat. */
test.describe.configure({ mode: "serial" });

const BOOKMARK_QUERY = "east=zsdh&west=dvolgyes&host=east";
const TABLE_LINK =
	/^http:\/\/localhost:\d+\/\?north=player1&east=zsdh&south=player2&west=dvolgyes&host=east&bot_seats=&bot_model=inception%2Fmercury-3&bot_fallback=openai%2Fgpt-6-luna&bot_retries=5&bot_delay_ms=3000&bot_models=[^&#]+#v=p2p-v1&k=[A-Za-z0-9_-]{43}$/;

const players: Player[] = [];
let owner: Player;
let guest: Player;
let page: Page;
let link = "";

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	owner = await Player.open(browser, baseURL, "owner");
	guest = await Player.open(browser, baseURL, "guest");
	players.push(owner, guest);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus) await reportNetwork(players);
});

test.afterAll(async () => {
	for (const player of players) await player.close();
});

test("the create screen is prefilled from the bookmark, with the host seat chosen", async () => {
	page = await owner.page(`./?${BOOKMARK_QUERY}`);
	await expect(page.getByLabel("East name")).toHaveValue("zsdh");
	await expect(page.getByLabel("West name")).toHaveValue("dvolgyes");
	await expect(page.getByLabel("North name")).toHaveValue("player1");
	await expect(page.locator('input[name="me"][value="E"]')).toBeChecked();
	for (const seat of ["N", "E", "S", "W"]) {
		await expect(page.locator(`input[name="bot-${seat}"]`)).not.toBeChecked();
	}
	await page.getByLabel("North name").fill("robot");
	await expect(page.locator('input[name="bot-N"]')).not.toBeChecked();
	await page.getByLabel("North name").fill("player1");
});

test("create opens the game and selects the host seat in the page URL", async () => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.getByTestId("create").click();
	await expect(page).toHaveTitle("Open Canasta: zsdh (E)");
	await expect(page).toHaveURL(
		/\?north=player1&east=zsdh&south=player2&west=dvolgyes&host=east&bot_seats=&bot_model=inception%2Fmercury-3&bot_fallback=openai%2Fgpt-6-luna&bot_retries=5&bot_delay_ms=3000&bot_models=[^&#]+&selected_player=E#v=p2p-v1&k=[A-Za-z0-9_-]{43}$/,
	);
	await expect(page.getByRole("textbox", { name: "Table link" })).toHaveCount(
		0,
	);
	await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
	await expect(page.locator(".copy-status")).toHaveCount(0);
	link = await page.evaluate(() => navigator.clipboard.readText());
	expect(link).toMatch(TABLE_LINK);
});

test("the other players see the names and can choose a seat from the shared URL", async () => {
	await expect(page.getByTestId("pick-W")).toHaveCount(0);

	const visitor = await guest.page(link);
	await expect(visitor.getByTestId("pick-W")).toContainText("dvolgyes", {
		timeout: CONNECT_MS,
	});
	await visitor.getByTestId("pick-W").click();
	await expect(visitor).toHaveTitle(/dvolgyes \(W\)$/);
});

test("reloading the selected-player address seats the host again", async () => {
	await page.reload();
	await expect(page).toHaveTitle("Open Canasta: zsdh (E)", {
		timeout: CONNECT_MS,
	});
	await expect(page.getByTestId("pick-E")).toHaveCount(0);
});

test("no uncaught errors", () => {
	expect(players.flatMap((player) => player.errors)).toEqual([]);
});
