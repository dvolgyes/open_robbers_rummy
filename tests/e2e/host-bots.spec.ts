import { expect, test } from "@playwright/test";
import { Player } from "./player";
import { CONNECT_MS, createRoom, pick } from "./room";

test.describe.configure({ mode: "serial" });

test("host bots play two consecutive boards from auction through the final trick", async ({
	page,
}) => {
	let requests = 0;
	await page.route("https://openrouter.ai/api/v1/responses", async (route) => {
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
		const kind = body.text.format.name === "bridge_call" ? "call" : "card";
		const values = body.text.format.schema.properties[kind].enum as string[];
		const choice =
			kind === "call" && body.input.includes("No calls yet")
				? (values.find((value) => value === "1NT") ?? values[0])
				: kind === "call"
					? (values.find((value) => value === "P") ?? values[0])
					: values[0];
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
							{ type: "output_text", text: JSON.stringify({ [kind]: choice }) },
						],
					},
				],
			}),
		});
	});

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
	await expect(page.getByTestId("room-controls")).toBeVisible();
	const roomUrl = new URL(page.url());
	expect(roomUrl.searchParams.get("bot_seats")).toBe("N,E,S,W");
	expect(roomUrl.searchParams.get("bot_model")).toBe("inception/mercury-3");
	expect(roomUrl.searchParams.get("bot_fallback")).toBe("openai/gpt-6-luna");
	expect(roomUrl.searchParams.get("bot_retries")).toBe("5");
	expect(roomUrl.searchParams.get("bot_delay_ms")).toBe("3000");
	expect(roomUrl.search).not.toMatch(/api.?key|test-key/i);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("open-canasta.openrouter-api-key"),
		),
	).toBe("test-key");
	await expect(page.getByRole("button", { name: "Pause bots" })).toBeVisible();
	await page.getByRole("button", { name: "Pause bots" }).click();
	await expect(page.getByRole("button", { name: "Resume bots" })).toBeVisible();
	await page.getByRole("button", { name: "Resume bots" }).click();

	await expect
		.poll(
			() =>
				page.locator("[data-phase]").evaluate((element) => ({
					board: element.getAttribute("data-board"),
					phase: element.getAttribute("data-phase"),
				})),
			{ timeout: 110_000 },
		)
		.toEqual({ board: "2", phase: "complete" });
	expect(requests).toBeGreaterThan(100);
});

test("switching the current bidder to a bot starts it immediately", async ({
	browser,
	baseURL,
}) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	const host = await Player.open(browser, baseURL, "host");
	const north = await Player.open(browser, baseURL, "north");
	const east = await Player.open(browser, baseURL, "east");
	const south = await Player.open(browser, baseURL, "south");
	try {
		const hostPage = await host.page("./");
		await hostPage.route(
			"https://openrouter.ai/api/v1/responses",
			async (route) => {
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
				const body = route.request().postDataJSON();
				const kind = body.text.format.name === "bridge_call" ? "call" : "card";
				const values = body.text.format.schema.properties[kind]
					.enum as string[];
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
									{
										type: "output_text",
										text: JSON.stringify({ [kind]: values[0] }),
									},
								],
							},
						],
					}),
				});
			},
		);

		const link = await createRoom(hostPage);
		const northPage = await north.page(link);
		await pick(northPage, "N");
		const southPage = await south.page(link);
		await pick(southPage, "S");
		const eastPage = await east.page(link);
		await expect(hostPage.getByTestId("table")).toHaveAttribute(
			"data-phase",
			"auction",
			{ timeout: CONNECT_MS },
		);
		await expect(eastPage.getByTestId("table")).toHaveAttribute(
			"data-phase",
			"auction",
			{ timeout: CONNECT_MS },
		);
		await expect(
			northPage.getByTestId("bid-box").locator("button:enabled").first(),
		).toBeEnabled({ timeout: CONNECT_MS });
		await host.grantPermissions(["microphone"]);
		await north.grantPermissions(["microphone"]);
		await hostPage
			.getByRole("button", { name: "Join call", exact: true })
			.click();
		await northPage
			.getByRole("button", { name: "Join call", exact: true })
			.click();
		await expect(hostPage.getByTestId("call-note")).toContainText(
			"Connected to North.",
		);
		await expect(northPage.getByTestId("call-note")).toContainText(
			"Connected to West.",
		);
		await expect(
			northPage.getByRole("button", { name: "Send mic audio", exact: true }),
		).toHaveAttribute("data-actual", "on");
		await expect(hostPage.getByTestId("call-presence-N")).toBeHidden();
		await expect(eastPage.getByTestId("call-presence-N")).toBeVisible();

		await hostPage.getByRole("button", { name: "Set API key" }).click();
		await hostPage
			.getByTestId("api-key-dialog")
			.getByRole("textbox", { name: "OpenRouter API key" })
			.fill("test-key");
		await hostPage.getByRole("button", { name: "Save key" }).click();
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
		await expect(eastPage.getByTestId("call-presence-N")).toBeVisible();
		await hostPage
			.getByTestId("tile-N")
			.getByRole("button", { name: /Switch to player$/ })
			.click();
		await expect(
			northPage.getByRole("button", { name: "Leave call", exact: true }),
		).toBeVisible();
		await expect(
			northPage.getByRole("button", { name: "Send mic audio", exact: true }),
		).toHaveAttribute("data-actual", "on");
		await expect(eastPage.getByTestId("call-presence-N")).toBeVisible();
		await hostPage
			.getByTestId("tile-N")
			.getByRole("button", { name: /Switch to bot$/ })
			.click();
		await expect(hostPage.getByTestId("table")).toHaveAttribute(
			"data-at",
			"1",
			{
				timeout: 15_000,
			},
		);
		expect(new URL(hostPage.url()).searchParams.get("bot_seats")).toBe("N");
		await hostPage.reload();
		await expect(
			hostPage.getByTestId("tile-N").locator(".bot-overlay"),
		).toBeVisible({
			timeout: CONNECT_MS,
		});
		await expect(
			hostPage.getByRole("button", { name: "Pause bots" }),
		).toBeVisible();
		await hostPage.getByRole("button", { name: "Pause bots" }).click();
		await expect(
			hostPage.getByRole("button", { name: "Resume bots" }),
		).toBeVisible();
		await hostPage
			.getByTestId("tile-E")
			.getByRole("button", { name: /Switch to bot$/ })
			.click();
		await expect(hostPage.getByTestId("table")).toHaveAttribute(
			"data-at",
			"2",
			{
				timeout: 15_000,
			},
		);
		await expect(
			hostPage.getByTestId("tile-E").locator(".bot-overlay"),
		).toBeVisible();
		const autoplay = hostPage.getByTestId("host-autoplay-toggle");
		await expect(autoplay).toHaveText("🤖 Enable autoplay (bot)");
		await autoplay.click();
		await expect(autoplay).toHaveText("👱 Disable autoplay");
		await southPage
			.getByTestId("bid-box")
			.getByRole("button", { name: "Pass" })
			.click();
		await southPage
			.getByTestId("bid-box")
			.getByRole("button", { name: /^Confirm/ })
			.click();
		await expect(hostPage.getByTestId("table")).toHaveAttribute(
			"data-at",
			"4",
			{
				timeout: 15_000,
			},
		);
	} finally {
		await Promise.all(
			[host, north, east, south].map((player) => player.close()),
		);
	}
});
