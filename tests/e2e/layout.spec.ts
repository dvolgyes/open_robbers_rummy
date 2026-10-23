import { expect, type Locator, type Page, test } from "@playwright/test";
import { Player } from "./player";
import {
	CONNECT_MS,
	createTable,
	pick,
	type SeatKey,
	turnOrder,
} from "./table";

/**
 * Player-relative layout. Four desktop browsers check the row of the other players, the tiles and the free space
 * between the table parts; a phone-sized browser checks the compact layout at a second table. A deal needs every
 * seat, so three of the desktop browsers also sit at the second table. Tables of six and of two fill the other
 * seats with the host page's bots.
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["1", "2", "3", "4"] as const satisfies readonly SeatKey[];
const SIX = ["1", "2", "3", "4", "5", "6"] as const;
/** Half a pixel absorbs subpixel rounding of the layout. */
const SUBPIXEL = 0.5;
/** The call controls; each name spells out the way and the medium. */
const DESKTOP_TOGGLES = [
	"Send mic audio",
	"Hear others: receive audio",
	"Send camera video",
	"See cameras: receive video",
] as const;
const COMPACT_TOGGLES = ["Send mic audio", "Hear others: receive audio"];
/** A 1366×768 laptop screen less the browser's own bars. */
const LOW_LAPTOP = { width: 1366, height: 650 };
/** Phone viewports for the compact layout, portrait and landscape. */
const PHONE_VIEWPORTS = [
	{ width: 320, height: 568 },
	{ width: 390, height: 664 },
	{ width: 844, height: 390 },
] as const;

const players = {} as Record<SeatKey, Player>;
const tab = {} as Record<SeatKey, Page>;
let phone: Player | undefined;
let phoneTab: Page | undefined;

const table = (page: Page): Locator => page.getByTestId("table");
const tile = (page: Page, seat: string): Locator =>
	page.getByTestId(`tile-${seat}`);

interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

const right = (rect: Rect): number => rect.x + rect.width;
const bottom = (rect: Rect): number => rect.y + rect.height;
const middle = (rect: Rect): { x: number; y: number } => ({
	x: rect.x + rect.width / 2,
	y: rect.y + rect.height / 2,
});

/**
 * The boxes, in viewport pixels, of the first element that each CSS selector finds. Each render can replace
 * the table's elements, so all boxes are read in one page call, from one layout. A missing or undisplayed
 * element has no box.
 */
function measure(
	page: Page,
	selectors: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, Rect>>> {
	return page.evaluate((entries) => {
		const rects: Record<string, Rect> = {};
		for (const [name, selector] of entries) {
			const node = document.querySelector(selector);
			if (!node?.checkVisibility()) continue;
			const { x, y, width, height } = node.getBoundingClientRect();
			rects[name] = { x, y, width, height };
		}
		return rects;
	}, Object.entries(selectors));
}

function shown(rects: Readonly<Record<string, Rect>>, name: string): Rect {
	const rect = rects[name];
	if (!rect) throw new Error(`${name} is not displayed`);
	return rect;
}

/** The area two rectangles share, ignoring a shared edge. */
function overlap(a: Rect, b: Rect): number {
	const width = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
	const height = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
	return width > SUBPIXEL && height > SUBPIXEL ? width * height : 0;
}

/** The displayed parts must not overlap pairwise. */
function expectApart(
	rects: Readonly<Record<string, Rect>>,
	names: readonly string[],
): void {
	const parts = names.filter((name) => rects[name]);
	for (const [index, name] of parts.entries())
		for (const other of parts.slice(index + 1))
			expect(
				overlap(shown(rects, name), shown(rects, other)),
				`${name} overlaps ${other}`,
			).toBe(0);
}

/** The parts of the table that must keep apart: the row of the other players, the centre, the own place and the call dock. */
const TABLE_PARTS: Readonly<Record<string, string>> = {
	others: '[data-testid="opponents"]',
	centre: '[data-testid="centre"]',
	own: ".seat-bottom",
	dock: ".dock",
};

/**
 * The other players sit in one row above the centre, in turn order from the seat after the viewer, each with a
 * tile; the viewer has no tile and holds the hand in the own place below the centre. No two parts of the table
 * overlap.
 */
async function expectRotation(
	page: Page,
	viewer: string,
	seats: readonly string[],
): Promise<void> {
	const at = seats.indexOf(viewer);
	const order = [...seats.slice(at + 1), ...seats.slice(0, at)];
	const row = page.getByTestId("opponents").locator(".seat.opponent");
	await expect(row).toHaveCount(order.length);
	for (const [index, seat] of order.entries()) {
		await expect(
			row.nth(index),
			`Player ${seat} is number ${index + 1} in the row`,
		).toHaveAttribute("data-testid", `seat-${seat}`);
		await expect(row.nth(index).getByTestId(`tile-${seat}`)).toHaveCount(1);
		await expect(tile(page, seat).locator(".avatar")).toHaveText(seat);
	}
	await expect(tile(page, viewer)).toHaveCount(0);
	await expect(page.locator(".seat-bottom .own-hand")).toHaveCount(1);

	const tiles = await row.evaluateAll((nodes) =>
		nodes.map((node) => {
			const { x, y } = (
				node.querySelector(".tile") ?? node
			).getBoundingClientRect();
			return { x, y };
		}),
	);
	for (const [index, box] of tiles.entries()) {
		expect(Math.abs(box.y - (tiles[0]?.y ?? 0)), "one row").toBeLessThanOrEqual(
			1,
		);
		if (index > 0)
			expect(box.x, "turn order from left to right").toBeGreaterThan(
				tiles[index - 1]?.x ?? 0,
			);
	}
	const rects = await measure(page, TABLE_PARTS);
	const middleY = (name: string): number => middle(shown(rects, name)).y;
	expect(middleY("others"), "the other players above the centre").toBeLessThan(
		middleY("centre"),
	);
	expect(middleY("centre"), "the centre above the own place").toBeLessThan(
		middleY("own"),
	);
	expectApart(rects, Object.keys(TABLE_PARTS));
}

/** The page does not scroll sideways, and the named parts show inside the window without page scroll. */
async function expectFit(
	page: Page,
	parts: Readonly<Record<string, string>>,
): Promise<void> {
	// The canvas scale follows the window's resize event, which can arrive after a viewport change.
	await expect(async () => {
		await page.evaluate(() => window.scrollTo(0, 0));
		const view = await page.evaluate(() => ({
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		expect(view.scrollWidth, "sideways page scroll").toBeLessThanOrEqual(
			view.innerWidth,
		);
		const rects = await measure(page, parts);
		for (const name of Object.keys(parts)) {
			const rect = shown(rects, name);
			expect(rect.x, `${name} left edge`).toBeGreaterThanOrEqual(-SUBPIXEL);
			expect(rect.y, `${name} top edge`).toBeGreaterThanOrEqual(-SUBPIXEL);
			expect(right(rect), `${name} right edge`).toBeLessThanOrEqual(
				view.innerWidth + SUBPIXEL,
			);
			expect(bottom(rect), `${name} bottom edge`).toBeLessThanOrEqual(
				view.innerHeight + SUBPIXEL,
			);
		}
	}).toPass({ timeout: 5_000 });
}

/** The parts that are not seats: the call dock, the table controls, the game description, the drawer and the language. */
const SIDE_PARTS: Readonly<Record<string, string>> = {
	dock: ".dock",
	controls: '[data-testid="table-page-controls"]',
	head: ".table-head",
	drawer: '[data-testid="table-page-drawer"]',
	language: ".table-page .language-control",
};

/** The first item of each row on the felt: the first other player's tile, the stock, the first meld and the first own card. */
const FELT_STARTS: Readonly<Record<string, string>> = {
	"first tile": '[data-testid="opponents"] .tile',
	stock: ".stock",
	"first meld": ".melds > *",
	"first card": ".own-hand > *",
};

/** How near to its corner of the canvas a corner part must be, as a part of the canvas size. */
const CORNER = 0.03;
/** The largest space between two neighbouring parts of the side panel, as a part of the canvas height. */
const PANEL_GAP = 0.02;
/** The width of the canvas in CSS pixels (style.css). */
const CANVAS_WIDTH = 1920;
/** The height of a card back in the other players' card count on the canvas: twice the 18 pixels of the phone. */
const CANVAS_BACK_HEIGHT = 36;

/**
 * On a wide landscape window the table is one 16:9 felt canvas, scaled to fit the window, and every part is on the
 * felt. A side panel at the right edge holds, from the top, the table controls with the language, the game
 * description, the players and messages, and the call dock in the bottom-right corner. The other players, the
 * stock, the melds and the own hand start at the left edge of the felt, and the card backs of the other players are
 * twice the phone size with the same overlap. On a phone the dock and the table controls sit below the felt.
 */
async function expectSideParts(
	page: Page,
	form: "canvas" | "below",
): Promise<void> {
	const rects = await measure(page, {
		felt: ".felt",
		tablePage: ".table-page",
		...TABLE_PARTS,
		...SIDE_PARTS,
		...FELT_STARTS,
	});
	if (form === "below") {
		const felt = shown(rects, "felt");
		for (const name of ["dock", "controls"])
			expect(shown(rects, name).y, `${name} below the felt`).toBeGreaterThan(
				bottom(felt) - SUBPIXEL,
			);
		return;
	}
	const view = await page.evaluate(() => ({
		width: window.innerWidth,
		height: window.innerHeight,
	}));
	const tablePage = shown(rects, "tablePage");
	expect(tablePage.width / tablePage.height, "16:9 canvas").toBeCloseTo(
		16 / 9,
		2,
	);
	expect(
		Math.max(tablePage.width / view.width, tablePage.height / view.height),
		"the canvas fills the window in one direction",
	).toBeCloseTo(1, 2);
	for (const name of Object.keys(SIDE_PARTS)) {
		const part = shown(rects, name);
		expect(part.x, `${name} on the felt`).toBeGreaterThanOrEqual(
			tablePage.x - SUBPIXEL,
		);
		expect(part.y, `${name} on the felt`).toBeGreaterThanOrEqual(
			tablePage.y - SUBPIXEL,
		);
		expect(right(part), `${name} on the felt`).toBeLessThanOrEqual(
			right(tablePage) + SUBPIXEL,
		);
		expect(bottom(part), `${name} on the felt`).toBeLessThanOrEqual(
			bottom(tablePage) + SUBPIXEL,
		);
	}
	const controls = shown(rects, "controls");
	expect(
		right(tablePage) - right(controls),
		"table controls at the right edge",
	).toBeLessThan(tablePage.width * CORNER);
	expect(controls.y - tablePage.y, "table controls at the top").toBeLessThan(
		tablePage.height * CORNER,
	);
	const dock = shown(rects, "dock");
	expect(
		right(tablePage) - right(dock),
		"call dock at the right edge",
	).toBeLessThan(tablePage.width * CORNER);
	expect(
		bottom(tablePage) - bottom(dock),
		"call dock at the bottom",
	).toBeLessThan(tablePage.height * CORNER);
	const panel = ["controls", "head", "drawer", "dock"];
	for (const [index, name] of panel.slice(1).entries()) {
		const above = panel[index] ?? "";
		expect(shown(rects, name).y, `${name} below ${above}`).toBeGreaterThan(
			bottom(shown(rects, above)) - SUBPIXEL,
		);
	}
	expect(
		shown(rects, "head").y - bottom(controls),
		"the game description right below the table controls",
	).toBeLessThan(tablePage.height * PANEL_GAP);
	// The side panel starts right of every part of the table.
	const tableRight = Math.max(
		...Object.keys(TABLE_PARTS)
			.filter((name) => name !== "dock")
			.map((name) => right(shown(rects, name))),
	);
	for (const name of panel)
		expect(
			shown(rects, name).x,
			`${name} right of the table`,
		).toBeGreaterThanOrEqual(tableRight - SUBPIXEL);
	expect(
		bottom(tablePage) - bottom(shown(rects, "own")),
		"the own place at the bottom",
	).toBeLessThan(tablePage.height * CORNER);
	for (const name of Object.keys(FELT_STARTS))
		expect(
			shown(rects, name).x - tablePage.x,
			`${name} at the left edge`,
		).toBeLessThan(tablePage.width * CORNER);
	expect(
		overlap(shown(rects, "language"), controls),
		"the language with the table controls",
	).toBeGreaterThan(0);
	expectApart(rects, panel);

	// Two neighbouring card backs of the first other player give the size and the overlap.
	const backs = await page
		.getByTestId("opponents")
		.locator(".count-backs")
		.first()
		.locator(".count-back")
		.evaluateAll((nodes) =>
			nodes.slice(0, 2).map((node) => {
				const { x, width, height } = node.getBoundingClientRect();
				return { x, width, height };
			}),
		);
	const [first, second] = backs;
	if (!first || !second)
		throw new Error("the first other player shows fewer than two card backs");
	const scale = tablePage.width / CANVAS_WIDTH;
	expect(first.height / scale, "card back height on the canvas").toBeCloseTo(
		CANVAS_BACK_HEIGHT,
		0,
	);
	expect(
		(second.x - first.x) / first.width,
		"the visible part of a card back",
	).toBeCloseTo(1 / 3, 1);
}

/** The viewer's own hand and its action buttons. */
const OWN_PARTS = {
	"own hand": ".own-hand",
	"action bar": '[data-testid="action-bar"]',
};

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const [seat, identity] of [
		["4", "identity-9"],
		["1", "identity-6"],
		["3", "identity-7"],
		["2", "identity-8"],
	] as const)
		players[seat] = await Player.open(browser, baseURL, identity);
	phone = await Player.open(browser, baseURL, "identity-4", {
		viewport: { width: 390, height: 664 },
		isMobile: true,
		hasTouch: true,
	});
});

test.afterAll(async () => {
	for (const player of Object.values(players)) await player.close();
	await phone?.close();
});

test("1: desktop, first hand: each of the four viewers sits at the bottom, with the other players in one row above", async () => {
	tab["4"] = await players["4"].page("./");
	const link = await createTable(tab["4"]);
	for (const seat of ["1", "3", "2"] as const) {
		tab[seat] = await players[seat].page(link);
		await pick(tab[seat], seat);
	}
	// The hosting page deals the first hand by itself once all four seats are present.
	for (const seat of SEATS) {
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "play", {
			timeout: CONNECT_MS,
		});
		await expectRotation(tab[seat], seat, SEATS);
	}

	// The window of the first player shows the hand and the action buttons without page scroll, also on a low
	// laptop window.
	const [first] = await turnOrder(tab);
	if (first === undefined) throw new Error("nobody plays first");
	await expect(tab[first].getByTestId("action-draw")).toBeVisible();
	await expectFit(tab[first], OWN_PARTS);
	await expectSideParts(tab[first], "canvas");
	await tab[first].setViewportSize(LOW_LAPTOP);
	await expectFit(tab[first], OWN_PARTS);
	await expectSideParts(tab[first], "canvas");
	await tab[first].setViewportSize({ width: 1280, height: 720 });
});

test("2: a phone shows the table without sideways scroll, with the own hand and the actions in reach", async () => {
	if (!phone) throw new Error("the phone browser is not open");
	const host = await players["4"].page("./");
	const link = await createTable(host);
	phoneTab = await phone.page(link);
	await pick(phoneTab, "1");
	for (const seat of ["3", "2"] as const)
		await pick(await players[seat].page(link), seat);
	await expect(table(phoneTab)).toHaveAttribute("data-phase", "play", {
		timeout: CONNECT_MS,
	});
	for (const size of PHONE_VIEWPORTS) {
		await phoneTab.setViewportSize(size);
		await test.step(`${size.width}×${size.height}`, async () => {
			const page = phoneTab as Page;
			await expectRotation(page, "1", SEATS);
			await expectSideParts(page, "below");
			await page.locator(".own-hand").scrollIntoViewIfNeeded();
			const view = await page.evaluate(() => ({
				innerWidth: window.innerWidth,
				scrollWidth: document.documentElement.scrollWidth,
			}));
			expect(view.scrollWidth, "sideways page scroll").toBeLessThanOrEqual(
				view.innerWidth,
			);
		});
	}
	await phoneTab.setViewportSize({ width: 390, height: 664 });
});

test("3: the call controls have names that spell out the way and the medium, and their off state has a slash", async () => {
	if (!phoneTab) throw new Error("the phone tab is not open");
	const forms = [
		[tab["4"], DESKTOP_TOGGLES],
		[phoneTab, COMPACT_TOGGLES],
	] as const;
	// Outside the call the switches choose what Join starts with (call-video test 1), so a switch that is on is
	// turned off for the check and then on again.
	for (const [page, toggles] of forms) {
		for (const name of toggles) {
			const toggle = page.getByRole("button", { name, exact: true });
			await expect(toggle).toHaveCount(1);
			const on = (await toggle.getAttribute("aria-pressed")) === "true";
			if (on) await toggle.click();
			await expect(toggle).toHaveAttribute("aria-pressed", "false");
			await expect(toggle.locator(".icon-slash")).toHaveCount(1);
			if (!on) continue;
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-pressed", "true");
			await expect(toggle.locator(".icon-slash")).toHaveCount(0);
		}
		await expect(
			page.getByRole("button", { name: "Join call", exact: true }),
		).toHaveCount(1);
	}
	// The phone shows the video switches too, but it cannot turn them on.
	for (const name of ["Send camera video", "See cameras: receive video"]) {
		const toggle = phoneTab.getByRole("button", { name, exact: true });
		await expect(toggle).toBeDisabled();
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(toggle.locator(".icon-slash")).toHaveCount(1);
	}
});

/**
 * Creates a table of `count` seats on the host page, where the host sits at `me` and its bots take `bots`. The deal
 * needs no other browser. Returns once the first hand is dealt.
 */
async function createBotTable(
	page: Page,
	count: number,
	me: string,
	bots: readonly string[],
): Promise<void> {
	await page.locator('select[name="players"]').selectOption(String(count));
	await page.locator(`input[name="me"][value="${me}"]`).check();
	for (const seat of bots)
		await page.locator(`input[name="bot-${seat}"]`).check();
	await page.getByTestId("create").click();
	await expect(table(page)).toHaveAttribute("data-phase", "play", {
		timeout: CONNECT_MS,
	});
}

test("4: a table of six shows the five other players in one row, also at phone width", async () => {
	const page = await players["4"].page("./");
	try {
		await createBotTable(page, 6, "4", ["1", "2", "3", "5", "6"]);
		await expectRotation(page, "4", SIX);
		await expectFit(page, OWN_PARTS);
		await expectSideParts(page, "canvas");
		await page.setViewportSize({ width: 320, height: 568 });
		await expectRotation(page, "4", SIX);
		await expectSideParts(page, "below");
		const view = await page.evaluate(() => ({
			innerWidth: window.innerWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		expect(view.scrollWidth, "sideways page scroll").toBeLessThanOrEqual(
			view.innerWidth,
		);
	} finally {
		// Closing the host page stops its bots.
		await page.close();
	}
});

test("5: a table of two shows the one other player above the centre", async () => {
	const page = await players["4"].page("./");
	try {
		await createBotTable(page, 2, "2", ["1"]);
		await expectRotation(page, "2", SIX.slice(0, 2));
		await expectFit(page, OWN_PARTS);
		await expectSideParts(page, "canvas");
		await expect(
			page.locator(".links p"),
			"the share note names no number of players",
		).toHaveText(
			"Send this link to the people who play at this table. Each one opens it and takes a free seat.",
		);
	} finally {
		await page.close();
	}
});
