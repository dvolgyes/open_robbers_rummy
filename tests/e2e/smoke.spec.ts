import { expect, type Page, test } from "@playwright/test";
import { Player } from "./player";
import {
	CONNECT_MS,
	createRoom,
	lines,
	MESSAGE,
	pick,
	picks,
	sendDraft,
	takeTurn,
	turnOrder,
} from "./room";

test("one browser: create, three seats from one link, ordered messages, and a reset vote", async ({
	browser,
	baseURL,
}) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	const player = await Player.open(browser, baseURL, "player");
	try {
		const host = await player.page("./");
		const link = await createRoom(host);

		// The tabs share one browser, so active seats stay with their current tabs.
		const guests: Page[] = [];
		const order = [
			{ seat: "N", choices: 3 },
			{ seat: "E", choices: 2 },
			{ seat: "S", choices: 1 },
		] as const;
		for (const { seat, choices } of order) {
			const page = await player.page(link);
			if (choices === 1) {
				await expect(
					page
						.getByTestId("roster")
						.locator(`li[data-seat="${seat}"]`)
						.getByText("You", { exact: true }),
				).toBeAttached({ timeout: CONNECT_MS });
			} else {
				await expect(
					page.getByRole("heading", { name: "Choose your seat" }),
				).toBeVisible({ timeout: CONNECT_MS });
				await expect(picks(page)).toHaveCount(choices);
				await pick(page, seat);
			}
			guests.push(page);
		}

		for (const page of [host, ...guests]) {
			// The players and the connection note sit in the drawer, which is closed by default.
			await page.getByTestId("room-drawer").locator("summary").first().click();
			await expect(
				page.getByTestId("roster").locator('li[data-state="online"]'),
			).toHaveCount(4, { timeout: CONNECT_MS });
			await expect(page.getByTestId("all-connected")).toBeVisible({
				timeout: CONNECT_MS,
			});
		}
		await expect(host.getByTestId("send")).toBeEnabled();
		await sendDraft(host);
		// Each reply waits for the previous one, so the expected order is fixed.
		for (const [index, page] of guests.entries()) {
			await expect(lines(page)).toHaveCount(index + 1);
			await sendDraft(page);
		}

		const expected = [MESSAGE.W, MESSAGE.N, MESSAGE.E, MESSAGE.S];
		for (const page of [host, ...guests]) {
			await expect(lines(page).locator(".text")).toHaveText(expected);
			await expect(lines(page).locator(".receipt")).toHaveText(
				expected.map(() => "Received by 3 of 3"),
			);
			await expect(page.getByTestId("pending").locator("li")).toHaveCount(0);
			await expect(page.getByTestId("banner")).toBeHidden();
		}
		// The first player opens hand 1. West asks for a reset; the three others approve, and the host deals a new
		// match, with a new random dealer.
		const [north, east, south] = guests;
		if (north === undefined || east === undefined || south === undefined)
			throw new Error("a guest has no page");
		const pages = { W: host, N: north, E: east, S: south };
		const firstPage = async () => {
			const [first] = await turnOrder(pages);
			if (first === undefined) throw new Error("nobody plays first");
			return pages[first];
		};
		await takeTurn(await firstPage(), 0);
		await host.getByTestId("reset").click();
		await expect(host.getByTestId("reset-decision")).toContainText(
			"to approve the reset",
		);
		for (const page of guests) {
			const decision = page.getByTestId("reset-decision");
			await expect(decision).toContainText("asks to reset the game");
			await decision.getByRole("button", { name: "Approve reset" }).click();
		}
		for (const page of [host, ...guests]) {
			const table = page.getByTestId("table");
			await expect(table).toHaveAttribute("data-hand", "1");
			await expect(table).toHaveAttribute("data-at", "0");
			await expect(page.getByTestId("reset-decision")).toBeHidden();
			await expect(lines(page).locator(".text")).toHaveText(expected);
		}
		await takeTurn(await firstPage(), 0);
		expect(player.errors).toEqual([]);
		expect(player.supabaseRequests).toBe(0);
	} finally {
		await player.close();
	}
});
