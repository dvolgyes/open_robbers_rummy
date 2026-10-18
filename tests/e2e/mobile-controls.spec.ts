import { expect, test } from "@playwright/test";
import { Player } from "./player";

test("mobile bidding shares the board link and hides Reset", async ({
	browser,
	baseURL,
}) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	const player = await Player.open(browser, baseURL, "mobile", {
		viewport: { width: 360, height: 800 },
		isMobile: true,
		hasTouch: true,
	});
	try {
		await player.addInitScript(() => {
			Object.defineProperty(navigator, "share", {
				configurable: true,
				value: async ({ url }: { url?: string }) => {
					(window as Window & { sharedUrl?: string }).sharedUrl = url;
				},
			});
		});
		const page = await player.page("./");
		await page.route(
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
				const field = kind === "call" ? "call" : "card";
				const values = body.text.format.schema.properties[field]
					.enum as string[];
				const choice =
					kind === "call" && body.input.includes("No calls yet")
						? (values.find((value) => value === "1NT") ?? values[0])
						: kind === "call"
							? (values.find((value) => value === "P") ?? values[0])
							: values[0];
				await new Promise((resolve) => setTimeout(resolve, 100));
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
										text: JSON.stringify({ [field]: choice }),
									},
								],
							},
						],
					}),
				});
			},
		);
		for (const seat of ["N", "E", "S", "W"])
			await page.locator(`input[name="bot-${seat}"]`).check({ force: true });
		await page
			.locator('input[name="openrouter-key"]')
			.fill("test-key", { force: true });
		await page
			.getByTestId("create")
			.evaluate((button) => (button as HTMLButtonElement).click());
		await expect(
			page.getByRole("button", { name: "Pause bots" }),
		).toBeVisible();
		await expect(page.locator(".bridge-table")).toHaveAttribute(
			"data-phase",
			"auction",
		);
		await page.getByRole("button", { name: "Pause bots" }).click();
		await expect(
			page.getByRole("button", { name: "Resume bots" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Switch to player$/ }).first(),
		).toBeVisible();
		await page.getByRole("button", { name: "Set API key" }).click();
		await expect(page.getByTestId("api-key-dialog")).toBeVisible();
		await page
			.getByTestId("api-key-dialog")
			.getByLabel("OpenRouter API key")
			.fill("updated-test-key");
		await page.getByRole("button", { name: "Save key" }).click();
		expect(
			await page.evaluate(() =>
				localStorage.getItem("libre-bridge.openrouter-api-key"),
			),
		).toBe("updated-test-key");
		const boardUrl = new URL(page.url());
		boardUrl.searchParams.delete("selected_player");
		const sharedBoardUrl = boardUrl.toString();

		const pageGaps = await page
			.locator(".mobile-auction")
			.evaluate((auction) => {
				const bounds = auction.getBoundingClientRect();
				return {
					left: bounds.left,
					right: document.documentElement.clientWidth - bounds.right,
				};
			});
		expect(Math.abs(pageGaps.left - pageGaps.right)).toBeLessThanOrEqual(1);
		const sections = await page
			.locator(".mobile-auction > *")
			.evaluateAll((nodes) => nodes.map((node) => node.classList[0]));
		expect(sections.indexOf("mobile-auction-bids")).toBeLessThan(
			sections.indexOf("mobile-auction-board"),
		);
		expect(sections.indexOf("mobile-auction-board")).toBeLessThan(
			sections.indexOf("mobile-auction-controls"),
		);
		await expect(page.locator(".mobile-auction-bids .bid-box")).toHaveCount(0);
		await expect(
			page.locator(".mobile-auction-controls .bid-box"),
		).toBeVisible();
		await expect(page.locator(".mobile-auction-board")).toHaveCSS(
			"background-color",
			"rgb(61, 122, 92)",
		);
		const edgeGaps = await page
			.locator(".mobile-auction-board")
			.evaluate((board) => {
				const cards = board.querySelectorAll<HTMLElement>(
					".mobile-board-top .back",
				);
				const first = cards[0]?.getBoundingClientRect();
				const last = cards[cards.length - 1]?.getBoundingClientRect();
				const bounds = board.getBoundingClientRect();
				if (!first || !last) throw new Error("top hand cards are missing");
				return {
					left: first.left - bounds.left,
					right: bounds.right - last.right,
				};
			});
		expect(Math.abs(edgeGaps.left - edgeGaps.right)).toBeLessThanOrEqual(1);
		await expect(page.getByRole("button", { name: "Reset" })).toBeHidden();
		await page.getByRole("button", { name: "Share URL" }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "Share action completed." }),
		).toBeAttached();
		const sharedUrl = await page.evaluate(
			() => (window as Window & { sharedUrl?: string }).sharedUrl,
		);
		expect(sharedUrl).toBe(sharedBoardUrl);
	} finally {
		await player.close();
	}
});
