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
 * The host page's bot seats. OpenRouter is replaced by a route on the host page that always answers option 0, the
 * best action of the heuristic ranking (src/bot/strategy.ts), so no request leaves the machine and no key is spent.
 * The live model is tested separately (docs/test-results-canasta.md, live runs).
 */
test.describe.configure({ mode: "serial" });

const RESPONSES = "https://openrouter.ai/api/v1/responses";

/** Answers every bot request on this page with `{"choice": 0}`. Returns the count of the requests so far. */
async function routeBots(page: Page): Promise<() => number> {
	let requests = 0;
	await page.route(RESPONSES, async (route) => {
		if (route.request().method() === "OPTIONS") {
			await route.fulfill({
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "POST, OPTIONS",
					"access-control-allow-headers": "authorization,content-type",
				},
			});
			return;
		}
		requests++;
		const body = route.request().postDataJSON();
		expect(body.text.format.name).toBe("canasta_choice");
		await route.fulfill({
			status: 200,
			headers: { "access-control-allow-origin": "*" },
			contentType: "application/json",
			body: JSON.stringify({
				output: [
					{
						type: "message",
						role: "assistant",
						content: [
							{ type: "output_text", text: JSON.stringify({ choice: 0 }) },
						],
					},
				],
			}),
		});
	});
	return () => requests;
}

const tableState = (page: Page) =>
	page.getByTestId("table").evaluate((element) => ({
		hand: element.getAttribute("data-hand"),
		phase: element.getAttribute("data-phase"),
	}));

test("host bots play a whole hand, and the host deals the next one", async ({
	page,
}) => {
	test.setTimeout(240_000);
	const requests = await routeBots(page);
	await page.goto("/");
	for (const [seat, name] of [
		["N", "robot north"],
		["E", "bot east"],
		["S", "robot south"],
		["W", "robot west"],
	] as const) {
		await page.locator(`input[name="name-${seat}"]`).fill(name);
	}
	for (const seat of ["N", "E", "S", "W"])
		await page.locator(`input[name="bot-${seat}"]`).check();
	await page.locator('input[name="openrouter-key"]').fill("test-key");
	await page.getByTestId("create").click();
	await expect(page.getByTestId("table")).toBeVisible();
	const roomUrl = new URL(page.url());
	expect(roomUrl.searchParams.get("bot_seats")).toBe("N,E,S,W");
	expect(roomUrl.searchParams.get("bot_model")).toBe("inception/mercury-3");
	expect(roomUrl.searchParams.get("bot_fallback")).toBe("openai/gpt-6-luna");
	expect(roomUrl.searchParams.get("bot_retries")).toBe("5");
	expect(roomUrl.searchParams.get("bot_delay_ms")).toBe("3000");
	// The key stays in this browser: never in the URL that the players share.
	expect(roomUrl.href).not.toMatch(/api.?key|test-key/i);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("open-canasta.openrouter-api-key"),
		),
	).toBe("test-key");
	await openDrawer(page);
	await page.getByRole("button", { name: "Pause bots" }).click();
	await expect(page.getByRole("button", { name: "Resume bots" })).toBeVisible();
	await page.getByRole("button", { name: "Resume bots" }).click();
	await expect(page.getByRole("button", { name: "Pause bots" })).toBeVisible();

	await expect
		.poll(() => tableState(page), { timeout: 200_000 })
		.toEqual({ hand: "2", phase: "play" });
	// A hand needs at least a draw and a discard from each seat before anybody can go out.
	expect(requests()).toBeGreaterThan(8);
});

test("paused bots stay paused after the host reloads, and play again only on resume", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const requests = await routeBots(page);
	await page.goto("/");
	for (const seat of ["N", "E", "S", "W"])
		await page.locator(`input[name="bot-${seat}"]`).check();
	await page.locator('input[name="openrouter-key"]').fill("test-key");
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
		page.getByTestId("tile-E").locator(".bot-overlay"),
	).toBeVisible();
	const pausedAt = await page.getByTestId("table").getAttribute("data-at");
	const pausedRequests = requests();
	// A started bot asks OpenRouter within a second; a paused one never does.
	await page.waitForTimeout(5_000);
	expect(requests()).toBe(pausedRequests);
	expect(await page.getByTestId("table").getAttribute("data-at")).toBe(
		pausedAt,
	);

	await page.getByRole("button", { name: "Resume bots" }).click();
	await expect(page.getByRole("button", { name: "Pause bots" })).toBeVisible();
	await expect
		.poll(() => requests(), { timeout: 30_000 })
		.toBeGreaterThan(pausedRequests);

	// Bots that played before a reload play after it.
	await page.reload();
	const resumedRequests = requests();
	await expect
		.poll(() => requests(), { timeout: CONNECT_MS })
		.toBeGreaterThan(resumedRequests);
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
	const north = await Player.open(browser, baseURL, "north");
	const east = await Player.open(browser, baseURL, "east");
	const south = await Player.open(browser, baseURL, "south");
	try {
		const hostPage = await host.page("./");
		await routeBots(hostPage);
		const link = await createRoom(hostPage);
		const northPage = await north.page(link);
		await pick(northPage, "N");
		const southPage = await south.page(link);
		await pick(southPage, "S");
		// East is the last free seat, so its page takes it without a picker.
		const eastPage = await east.page(link);
		const pages = { W: hostPage, N: northPage, E: eastPage, S: southPage };
		for (const page of Object.values(pages))
			await expect(page.getByTestId("table")).toHaveAttribute(
				"data-phase",
				"play",
				{ timeout: CONNECT_MS },
			);
		// The first dealer is random. The players before East take their turns, so that East has the turn.
		const order = await turnOrder(pages);
		const before = order.indexOf("E");
		for (const [index, seat] of order.slice(0, before).entries())
			await takeTurn(pages[seat], index * 2);
		await expect(eastPage.getByTestId("action-draw")).toBeEnabled({
			timeout: CONNECT_MS,
		});

		await host.grantPermissions(["microphone"]);
		await north.grantPermissions(["microphone"]);
		await hostPage
			.getByRole("button", { name: "Join call", exact: true })
			.click();
		await northPage
			.getByRole("button", { name: "Join call", exact: true })
			.click();
		await expect(northPage.getByTestId("call-note")).toContainText(
			"Connected to West.",
			{ timeout: CONNECT_MS },
		);

		await openDrawer(hostPage);
		await hostPage.getByRole("button", { name: "Set API key" }).click();
		await hostPage
			.getByTestId("api-key-dialog")
			.getByRole("textbox", { name: "OpenRouter API key" })
			.fill("test-key");
		await hostPage.getByRole("button", { name: "Save key" }).click();

		// A bot seat keeps the person's call: North still sends audio while its seat plays as a bot.
		await hostPage
			.getByTestId("tile-N")
			.getByRole("button", { name: /Switch to bot$/ })
			.click();
		await expect(
			northPage.getByRole("button", { name: "Leave call", exact: true }),
		).toBeVisible();
		await expect(
			northPage.getByRole("button", { name: "Send mic audio", exact: true }),
		).toHaveAttribute("data-actual", "on");
		await hostPage
			.getByTestId("tile-N")
			.getByRole("button", { name: /Switch to player$/ })
			.click();

		// East has the turn: as a bot it draws and discards without a click, so the table moves past its turn.
		await hostPage
			.getByTestId("tile-E")
			.getByRole("button", { name: /Switch to bot$/ })
			.click();
		await expect
			.poll(
				async () =>
					Number(await hostPage.getByTestId("table").getAttribute("data-at")),
				{ timeout: 30_000 },
			)
			.toBeGreaterThanOrEqual(before * 2 + 2);
		expect(new URL(hostPage.url()).searchParams.get("bot_seats")).toBe("E");
		await expect(
			hostPage.getByTestId("tile-E").locator(".bot-overlay"),
		).toBeVisible();
		// South plays next, as a person.
		await expect(southPage.getByTestId("action-draw")).toBeEnabled({
			timeout: 30_000,
		});

		// The bot seat survives the host's reload: the seat list is in the host's URL.
		await hostPage.reload();
		await expect(
			hostPage.getByTestId("tile-E").locator(".bot-overlay"),
		).toBeVisible({ timeout: CONNECT_MS });
	} finally {
		for (const player of [host, north, east, south]) await player.close();
	}
});
