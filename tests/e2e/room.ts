import { expect, type Locator, type Page } from "@playwright/test";

/** Page helpers shared by the browser tests. They use only what a person sees and clicks. */

export const YOU = {
	W: "You are West — player4",
	N: "You are North — player1",
	E: "You are East — player3",
	S: "You are South — player2",
} as const;

/** The prefilled test message of each seat. */
export const MESSAGE = {
	W: "Connection test from West",
	N: "Connection test from North",
	E: "Connection test from East",
	S: "Connection test from South",
} as const;

export type SeatKey = keyof typeof YOU;

/**
 * The wait for a link between two pages, as in p2p-mesh.spec.ts. A link whose first WebRTC exchange fails comes
 * back through a two-page room after about 25 s (src/p2p/mesh.ts); the rest is room for a slow tracker.
 */
export const CONNECT_MS = 45_000;

export const lines = (page: Page): Locator =>
	page.getByTestId("transcript").locator("li");

export const texts = (page: Page): Locator => lines(page).locator(".text");

export const picks = (page: Page): Locator =>
	page.locator('[data-testid^="pick-"]');

export const rosterSeat = (page: Page, seat: SeatKey): Locator =>
	page.getByTestId("roster").locator(`li[data-seat="${seat}"]`);

/** The roster rows with the Host tag: one row when the page knows the host. */
export const hostRows = (page: Page): Locator =>
	page
		.getByTestId("roster")
		.locator("li")
		.filter({ has: page.locator(".tag", { hasText: /^Host$/ }) });

const TABLE_LINK =
	/^http:\/\/localhost:\d+\/?\?.*#v=p2p-v1&k=[A-Za-z0-9_-]{43}$/;

/**
 * Creates a table with the default names. The creator sits West and enters the game directly.
 * Returns the unselected room URL that all players share.
 */
export async function createRoom(page: Page): Promise<string> {
	// Chrome's mobile emulation reports the form below the screenshot viewport; activate its native submit control.
	await page
		.getByTestId("create")
		.evaluate((button) => (button as HTMLButtonElement).click());
	await expect(page).toHaveTitle(/player4 \(W\)$/);
	await expect(page).toHaveURL(/\?.*#v=p2p-v1&k=[A-Za-z0-9_-]{43}$/);
	const linkUrl = new URL(page.url());
	linkUrl.searchParams.delete("selected_player");
	const link = linkUrl.toString();
	expect(link).toMatch(TABLE_LINK);
	expect(linkUrl.searchParams.has("selected_player")).toBe(false);
	return link;
}

export async function pick(page: Page, seat: SeatKey): Promise<void> {
	await page.getByTestId(`pick-${seat}`).click();
	const name = YOU[seat].split(" — ")[1];
	await expect(page).toHaveTitle(new RegExp(`${name} \\(${seat}\\)$`));
}

/** Sends the prefilled message and waits until this tab shows it in the transcript. */
export async function sendDraft(page: Page): Promise<void> {
	const before = await lines(page).count();
	await page.getByTestId("send").click();
	await expect(lines(page)).toHaveCount(before + 1);
}

export async function expectBanner(page: Page, kind: string): Promise<void> {
	await expect(page.getByTestId("banner")).toHaveAttribute("data-kind", kind);
}
