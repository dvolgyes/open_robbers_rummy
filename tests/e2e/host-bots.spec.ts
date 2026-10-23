import { expect, type Page, test } from "@playwright/test";
import { Player } from "./player";
import {
	CONNECT_MS,
	createRoom,
	openDrawer,
	pick,
	takeTurn,
	turnOrder,
} from "./room";

/**
 * The host page's solver bots. They need no key and no network, so the tests count the table actions (`data-at`).
 * A bot acts 5 s after the last play that it saw, and 1 s after its previous command (src/bot/pacing.ts).
 */
test.describe.configure({ mode: "serial" });

const tableAt = async (page: Page): Promise<number> =>
	Number(await page.getByTestId("table").getAttribute("data-at"));

test("host bots take the turns of every seat", async ({ page }) => {
	test.setTimeout(180_000);
	await page.goto("/");
	for (const [seat, name] of [
		["1", "robot one"],
		["2", "bot two"],
		["3", "robot three"],
		["4", "robot four"],
	] as const) {
		await page.locator(`input[name="name-${seat}"]`).fill(name);
	}
	for (const seat of ["1", "2", "3", "4"])
		await page.locator(`input[name="bot-${seat}"]`).check();
	await page.getByTestId("create").click();
	await expect(page.getByTestId("table")).toBeVisible();
	const roomUrl = new URL(page.url());
	expect(roomUrl.searchParams.get("bot_seats")).toBe("1,2,3,4");
	// The solver bots have no model settings and no key.
	expect(roomUrl.href).not.toMatch(/bot_model|api.?key/i);
	await openDrawer(page);
	await page.getByRole("button", { name: "Pause bots" }).click();
	await expect(page.getByRole("button", { name: "Resume bots" })).toBeVisible();
	await page.getByRole("button", { name: "Resume bots" }).click();
	await expect(page.getByRole("button", { name: "Pause bots" })).toBeVisible();

	// Two actions per turn: each of the four seats takes at least one turn.
	await expect
		.poll(() => tableAt(page), { timeout: 150_000 })
		.toBeGreaterThan(8);
	await expect(page.getByTestId("table")).toHaveAttribute(
		"data-phase",
		/^(play|over)$/,
	);
});

test("paused bots stay paused after the host reloads, and play again only on resume", async ({
	page,
}) => {
	test.setTimeout(180_000);
	await page.goto("/");
	for (const seat of ["1", "2", "3", "4"])
		await page.locator(`input[name="bot-${seat}"]`).check();
	await page.getByTestId("create").click();
	await expect(page.getByTestId("table")).toBeVisible();
	await openDrawer(page);
	await page.getByRole("button", { name: "Pause bots" }).click();
	await expect(page.getByRole("button", { name: "Resume bots" })).toBeVisible();

	await page.reload();
	await expect(page.getByTestId("table")).toHaveAttribute(
		"data-phase",
		"play",
		{
			timeout: CONNECT_MS,
		},
	);
	await openDrawer(page);
	await expect(page.getByRole("button", { name: "Resume bots" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Pause bots" })).toBeHidden();
	await expect(
		page.getByTestId("tile-2").locator(".bot-overlay"),
	).toBeVisible();
	const pausedAt = await tableAt(page);
	// A started bot acts within 5 s of the deal plus 1 s; a paused one never does.
	await page.waitForTimeout(8_000);
	expect(await tableAt(page)).toBe(pausedAt);

	await page.getByRole("button", { name: "Resume bots" }).click();
	await expect(page.getByRole("button", { name: "Pause bots" })).toBeVisible();
	await expect
		.poll(() => tableAt(page), { timeout: 30_000 })
		.toBeGreaterThan(pausedAt);

	// Bots that played before a reload play after it.
	await page.reload();
	await expect(page.getByTestId("table")).toHaveAttribute(
		"data-phase",
		"play",
		{ timeout: CONNECT_MS },
	);
	const resumedAt = await tableAt(page);
	await expect
		.poll(() => tableAt(page), { timeout: CONNECT_MS })
		.toBeGreaterThan(resumedAt);
	await openDrawer(page);
	await expect(page.getByRole("button", { name: "Pause bots" })).toBeVisible();
});

test("switching the player whose turn it is to a bot starts it at once; the call goes on", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(180_000);
	if (!baseURL) throw new Error("baseURL is not configured");
	const host = await Player.open(browser, baseURL, "host");
	const one = await Player.open(browser, baseURL, "one");
	const two = await Player.open(browser, baseURL, "two");
	const three = await Player.open(browser, baseURL, "three");
	try {
		const hostPage = await host.page("./");
		const link = await createRoom(hostPage);
		const onePage = await one.page(link);
		await pick(onePage, "1");
		const threePage = await three.page(link);
		await pick(threePage, "3");
		// Player 2 is the last free seat, so its page takes it without a picker.
		const twoPage = await two.page(link);
		const pages = {
			"4": hostPage,
			"1": onePage,
			"2": twoPage,
			"3": threePage,
		};
		for (const page of Object.values(pages))
			await expect(page.getByTestId("table")).toHaveAttribute(
				"data-phase",
				"play",
				{ timeout: CONNECT_MS },
			);
		// The first dealer is random. The players before Player 2 take their turns, so that Player 2 has the turn.
		const order = await turnOrder(pages);
		const before = order.indexOf("2");
		for (const [index, seat] of order.slice(0, before).entries())
			await takeTurn(pages[seat], index * 2);
		await expect(twoPage.getByTestId("action-draw")).toBeEnabled({
			timeout: CONNECT_MS,
		});

		await host.grantPermissions(["microphone"]);
		await one.grantPermissions(["microphone"]);
		await hostPage
			.getByRole("button", { name: "Join call", exact: true })
			.click();
		await onePage
			.getByRole("button", { name: "Join call", exact: true })
			.click();
		await expect(onePage.getByTestId("call-note")).toContainText(
			"Connected to Player 4.",
			{ timeout: CONNECT_MS },
		);

		// A bot seat keeps the person's call: Player 1 still sends audio while its seat plays as a bot.
		await hostPage
			.getByTestId("tile-1")
			.getByRole("button", { name: /Switch to bot$/ })
			.click();
		await expect(
			onePage.getByRole("button", { name: "Leave call", exact: true }),
		).toBeVisible();
		await expect(
			onePage.getByRole("button", { name: "Send mic audio", exact: true }),
		).toHaveAttribute("data-actual", "on");
		await hostPage
			.getByTestId("tile-1")
			.getByRole("button", { name: /Switch to player$/ })
			.click();

		// Player 2 has the turn: as a bot it takes the turn without a click, so the table moves past its turn.
		await hostPage
			.getByTestId("tile-2")
			.getByRole("button", { name: /Switch to bot$/ })
			.click();
		await expect
			.poll(() => tableAt(hostPage), { timeout: 30_000 })
			.toBeGreaterThanOrEqual(before * 2 + 2);
		expect(new URL(hostPage.url()).searchParams.get("bot_seats")).toBe("2");
		await expect(
			hostPage.getByTestId("tile-2").locator(".bot-overlay"),
		).toBeVisible();
		// Player 3 plays next, as a person.
		await expect(threePage.getByTestId("action-draw")).toBeEnabled({
			timeout: 30_000,
		});

		// The bot seat survives the host's reload: the seat list is in the host's URL.
		await hostPage.reload();
		await expect(
			hostPage.getByTestId("tile-2").locator(".bot-overlay"),
		).toBeVisible({ timeout: CONNECT_MS });
	} finally {
		for (const player of [host, one, two, three]) await player.close();
	}
});
