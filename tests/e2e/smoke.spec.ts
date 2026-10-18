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
	YOU,
} from "./room";

test("one browser: create, three seats from one link, ordered messages", async ({
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
				await expect(page.getByTestId("you")).toHaveText(YOU[seat], {
					timeout: CONNECT_MS,
				});
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
		expect(player.errors).toEqual([]);
		expect(player.supabaseRequests).toBe(0);
	} finally {
		await player.close();
	}
});
