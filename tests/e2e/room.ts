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

/** A player's own URL: the table link with `selected_player`, which a reopened tab keeps its seat with (ADR 0005). */
export function ownLink(link: string, seat: SeatKey): string {
	const url = new URL(link);
	url.searchParams.set("selected_player", seat);
	return url.toString();
}

export async function pick(page: Page, seat: SeatKey): Promise<void> {
	await page.getByTestId(`pick-${seat}`).click();
	const name = YOU[seat].split(" — ")[1];
	await expect(page).toHaveTitle(new RegExp(`${name} \\(${seat}\\)$`));
}

/**
 * Waits until this page holds the seat: the title names the player and the seat, and the roster tags the row "You".
 * The roster sits in the closed room drawer, so the tag is attached, not visible.
 */
export async function expectSeat(
	page: Page,
	seat: SeatKey,
	options: { timeout?: number } = {},
): Promise<void> {
	const name = YOU[seat].split(" — ")[1];
	await expect(page).toHaveTitle(new RegExp(`${name} \\(${seat}\\)$`), options);
	await expect(
		rosterSeat(page, seat).locator(".tag", { hasText: /^You$/ }),
	).toBeAttached(options);
}

/** Opens the room drawer, where the roster and the connection note sit. Does nothing when it is open. */
export async function openDrawer(page: Page): Promise<void> {
	const drawer = page.getByTestId("room-drawer");
	if (!(await drawer.evaluate((node) => (node as HTMLDetailsElement).open)))
		await drawer.locator("summary").first().click();
}

/** The seats clockwise, in the order of play. */
const CLOCKWISE = ["N", "E", "S", "W"] as const satisfies readonly SeatKey[];

/**
 * The seats in the order of play from the seat whose page shows its turn. The first dealer is random, so the first
 * player is too.
 */
export async function turnOrder(
	pages: Record<SeatKey, Page>,
): Promise<SeatKey[]> {
	const playing = async (): Promise<SeatKey[]> => {
		const seats: SeatKey[] = [];
		for (const seat of CLOCKWISE)
			if (
				(await pages[seat]
					.getByTestId("table")
					.getAttribute("data-your-turn")) === "true"
			)
				seats.push(seat);
		return seats;
	};
	// A page can show the play phase a render before it shows the turn, so wait for one seat to have it.
	await expect
		.poll(async () => (await playing()).length, { timeout: CONNECT_MS })
		.toBe(1);
	const [first] = await playing();
	if (first === undefined) throw new Error("expected one seat to play");
	const start = CLOCKWISE.indexOf(first);
	return [...CLOCKWISE.slice(start), ...CLOCKWISE.slice(0, start)];
}

/**
 * One canasta turn through the buttons a player uses, from table position `at`: draw from the stock, then discard
 * the first card of the hand. Any card is a legal discard after a draw, so the turn needs no knowledge of the deal.
 */
export async function takeTurn(page: Page, at: number): Promise<void> {
	const table = page.getByTestId("table");
	await expect(table).toHaveAttribute("data-at", String(at));
	await page.getByTestId("action-draw").click();
	await expect(table).toHaveAttribute("data-at", String(at + 1));
	await page.locator(".own-hand button.card").first().click();
	await page.getByTestId("action-discard").click();
	await expect(table).toHaveAttribute("data-at", String(at + 2));
}

/** Sends the prefilled message and waits until this tab shows it in the transcript. */
export async function sendDraft(page: Page): Promise<void> {
	const before = await lines(page).count();
	// The message form sits in the room drawer, which is closed by default.
	await openDrawer(page);
	await page.getByTestId("send").click();
	await expect(lines(page)).toHaveCount(before + 1);
}

export async function expectBanner(
	page: Page,
	kind: string,
	options?: { timeout: number },
): Promise<void> {
	await expect(page.getByTestId("banner")).toHaveAttribute(
		"data-kind",
		kind,
		options,
	);
}
