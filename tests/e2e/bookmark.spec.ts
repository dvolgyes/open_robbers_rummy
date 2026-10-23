import { expect, type Page, test } from "@playwright/test";
import { Player, reportNetwork } from "./player";
import { CONNECT_MS } from "./table";

/** A shared table link carries setup values; a player's page URL also selects their seat. */
test.describe.configure({ mode: "serial" });

const BOOKMARK_QUERY = "p2=zsdh&p4=dvolgyes&host=2";
const TABLE_QUERY =
	"p1=player1&p2=zsdh&p3=player3&p4=dvolgyes&host=2&rules=gamerules&jokers=4&assist=1&bot_seats=";
const TABLE_LINK = new RegExp(
	`^http://localhost:\\d+/\\?${TABLE_QUERY}#v=p2p-v2&k=[A-Za-z0-9_-]{43}$`,
);

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
	await expect(page.getByLabel("Player 2 name")).toHaveValue("zsdh");
	await expect(page.getByLabel("Player 4 name")).toHaveValue("dvolgyes");
	await expect(page.getByLabel("Player 1 name")).toHaveValue("player1");
	await expect(page.locator('input[name="me"][value="2"]')).toBeChecked();
	for (const seat of ["1", "2", "3", "4"]) {
		await expect(page.locator(`input[name="bot-${seat}"]`)).not.toBeChecked();
	}
	await page.getByLabel("Player 1 name").fill("robot");
	await expect(page.locator('input[name="bot-1"]')).not.toBeChecked();
	await page.getByLabel("Player 1 name").fill("player1");
});

test("create opens the game and selects the host seat in the page URL", async () => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.getByTestId("create").click();
	await expect(page).toHaveTitle(/Open Robber's Rummy: zsdh \(Player 2\)$/);
	await expect(page).toHaveURL(
		new RegExp(
			`\\?${TABLE_QUERY}&selected_player=2#v=p2p-v2&k=[A-Za-z0-9_-]{43}$`,
		),
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
	await expect(page.getByTestId("pick-4")).toHaveCount(0);

	const visitor = await guest.page(link);
	await expect(visitor.getByTestId("pick-4")).toContainText("dvolgyes", {
		timeout: CONNECT_MS,
	});
	await visitor.getByTestId("pick-4").click();
	await expect(visitor).toHaveTitle(/dvolgyes \(Player 4\)$/);
});

test("reloading the selected-player address seats the host again", async () => {
	await page.reload();
	await expect(page).toHaveTitle(/Open Robber's Rummy: zsdh \(Player 2\)$/, {
		timeout: CONNECT_MS,
	});
	await expect(page.getByTestId("pick-2")).toHaveCount(0);
});

test("no uncaught errors", () => {
	expect(players.flatMap((player) => player.errors)).toEqual([]);
});
