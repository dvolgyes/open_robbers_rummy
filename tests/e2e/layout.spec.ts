import { expect, type Locator, type Page, test } from "@playwright/test";
import { Player } from "./player";
import { CONNECT_MS, createRoom, pick, type SeatKey } from "./room";

/**
 * Player-relative layout (call/layout plan C3). Four desktop browsers check the rotation, the tiles and the
 * free space between the table parts; a phone-sized browser checks the scaled room canvas at a second table. A deal
 * needs all four seats (plan §12 R4), so three of the desktop browsers also sit at the second table.
 * Board 1: North deals; North's tab shows the full bid grid at the start of the auction.
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["N", "E", "S", "W"] as const satisfies readonly SeatKey[];
const SEAT_NAMES: Readonly<Record<SeatKey, string>> = {
	N: "North",
	E: "East",
	S: "South",
	W: "West",
};
const NAMES: Readonly<Record<SeatKey, string>> = {
	N: "player1",
	E: "player3",
	S: "player2",
	W: "player4",
};
/** Play goes clockwise, so the next seat sits on the viewer's left. */
const AROUND: Readonly<
	Record<SeatKey, { left: SeatKey; partner: SeatKey; right: SeatKey }>
> = {
	N: { left: "E", partner: "S", right: "W" },
	E: { left: "S", partner: "W", right: "N" },
	S: { left: "W", partner: "N", right: "E" },
	W: { left: "N", partner: "E", right: "S" },
};
/** Phone, 4:3 and Full HD viewports used to check the room canvas. */
const CANVAS_VIEWPORTS = [
	{ width: 320, height: 568 },
	{ width: 360, height: 640 },
	{ width: 390, height: 664 },
	{ width: 844, height: 390 },
	{ width: 1440, height: 1080 },
	{ width: 1920, height: 1080 },
] as const;
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

const players = {} as Record<SeatKey, Player>;
const tab = {} as Record<SeatKey, Page>;
let phone: Player | undefined;
let phoneTab: Page | undefined;

const table = (page: Page): Locator => page.getByTestId("table");
const hand = (page: Page, seat: SeatKey): Locator =>
	page.getByTestId(`hand-${seat}`);
const tile = (page: Page, seat: SeatKey): Locator =>
	page.getByTestId(`tile-${seat}`);
const slot = (page: Page): Locator => page.getByTestId("game-slot");
const byTestId = (id: string): string => `[data-testid="${id}"]`;

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
 * The boxes, in viewport pixels, of the first element that each CSS selector finds. Each render replaces
 * the table's elements, so all boxes are read in one page call, from one layout; a box read element by
 * element can belong to an element that a render just removed. A missing or undisplayed element has no box.
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

async function expectAt(seats: readonly SeatKey[], at: number): Promise<void> {
	for (const seat of seats)
		await expect(table(tab[seat])).toHaveAttribute("data-at", String(at));
}

/** Desktop parts that must keep apart: hands, tiles, the center, the call panel and the game-control slot. */
const DESKTOP_PARTS: Readonly<Record<string, string>> = {
	...Object.fromEntries(
		SEATS.map((seat) => [`hand ${seat}`, byTestId(`hand-${seat}`)]),
	),
	...Object.fromEntries(
		SEATS.map((seat) => [`tile ${seat}`, byTestId(`tile-${seat}`)]),
	),
	auction: byTestId("auction"),
	trick: byTestId("trick"),
	"call panel": byTestId("call-panel"),
	"game slot": byTestId("game-slot"),
};

/**
 * Own hand lowest, partner highest, left opponent leftmost, right opponent rightmost; a tile beside each
 * other hand, as high as a card and 4:3 wide; no two parts of the table overlap.
 */
async function expectDesktopLayout(viewer: SeatKey): Promise<void> {
	const page = tab[viewer];
	const around = AROUND[viewer];
	const others = SEATS.filter((seat) => seat !== viewer);
	await expect(page.locator(".room")).toHaveAttribute("data-form", "desktop");
	for (const seat of SEATS)
		await expect(hand(page, seat).locator(".seat-label .name")).toHaveText(
			`${SEAT_NAMES[seat]} — ${NAMES[seat]}`,
		);
	for (const seat of others) {
		await expect(tile(page, seat).locator(".avatar")).toHaveText(seat);
		await expect(tile(page, seat)).toContainText(SEAT_NAMES[seat]);
	}
	await expect(tile(page, viewer)).toHaveCount(0);

	const rects = await measure(page, {
		...DESKTOP_PARTS,
		card: `${byTestId(`hand-${viewer}`)} .face`,
	});
	const handOf = (seat: SeatKey): Rect => shown(rects, `hand ${seat}`);
	const tileOf = (seat: SeatKey): Rect => shown(rects, `tile ${seat}`);
	const at = (seat: SeatKey): { x: number; y: number } => middle(handOf(seat));

	for (const seat of others)
		expect(at(viewer).y, `own hand below ${seat}`).toBeGreaterThan(at(seat).y);
	for (const seat of others.filter((seat) => seat !== around.partner))
		expect(at(around.partner).y, `partner above ${seat}`).toBeLessThan(
			at(seat).y,
		);
	for (const seat of others.filter((seat) => seat !== around.left))
		expect(at(around.left).x, `left opponent left of ${seat}`).toBeLessThan(
			at(seat).x,
		);
	for (const seat of others.filter((seat) => seat !== around.right))
		expect(
			at(around.right).x,
			`right opponent right of ${seat}`,
		).toBeGreaterThan(at(seat).x);

	expect(
		tileOf(around.partner).x,
		"top tile right of the top hand",
	).toBeGreaterThanOrEqual(right(handOf(around.partner)) - SUBPIXEL);
	expect(
		bottom(tileOf(around.left)),
		"left tile above the left hand",
	).toBeLessThanOrEqual(handOf(around.left).y + SUBPIXEL);
	expect(
		tileOf(around.right).y,
		"right tile below the right hand",
	).toBeGreaterThanOrEqual(bottom(handOf(around.right)) - SUBPIXEL);

	const card = shown(rects, "card");
	for (const seat of others) {
		const rect = tileOf(seat);
		expect(
			Math.abs(rect.height - card.height),
			`tile ${seat} height`,
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(rect.width / rect.height - 4 / 3),
			`tile ${seat} ratio`,
		).toBeLessThanOrEqual(0.02);
	}
	expectApart(rects, Object.keys(DESKTOP_PARTS));
	expect(await ranksCut(page), "ranks under the next card").toEqual([]);
}

/** The rank labels as the table shows them. */
const RANK_LABELS = [
	"A",
	"K",
	"Q",
	"J",
	"10",
	"9",
	"8",
	"7",
	"6",
	"5",
	"4",
	"3",
	"2",
];

/**
 * The overlapped cards whose visible strip cannot show every rank label in full, with the overflow in pixels.
 * The ink box of the tallest, deepest and widest label is placed at each card's rank baseline in its own
 * font, so the result does not depend on the deal or on the device font.
 */
function ranksCut(page: Page): Promise<string[]> {
	return page.evaluate((labels) => {
		const context = document.createElement("canvas").getContext("2d");
		if (!context) throw new Error("no 2D canvas");
		const cut: string[] = [];
		for (const hand of document.querySelectorAll<HTMLElement>(".hand")) {
			const cards = [
				...hand.querySelectorAll<HTMLElement>(":scope > .card"),
			].filter((card) => card.checkVisibility());
			for (const card of cards.slice(0, -1)) {
				const rank = card.querySelector<HTMLElement>(".rank");
				const text = rank?.firstChild;
				if (!rank || !(text instanceof Text)) continue;
				const style = getComputedStyle(rank);
				context.font = style.font;
				context.letterSpacing = style.letterSpacing;
				const ink = labels.map((label) => context.measureText(label));
				const range = document.createRange();
				range.selectNodeContents(text);
				const box = range.getBoundingClientRect();
				const baseline = box.top + (ink[0]?.fontBoundingBoxAscent ?? 0);
				const strip = card.getBoundingClientRect();
				const over = Math.max(
					strip.top -
						(baseline - Math.max(...ink.map((m) => m.actualBoundingBoxAscent))),
					baseline +
						Math.max(...ink.map((m) => m.actualBoundingBoxDescent)) -
						strip.bottom,
					box.left +
						Math.max(...ink.map((m) => m.actualBoundingBoxRight)) -
						strip.right,
				);
				if (over > 1)
					cut.push(
						`${hand.closest("[data-testid]")?.getAttribute("data-testid")} ${text.data}: ${over.toFixed(1)}px`,
					);
			}
		}
		return cut;
	}, RANK_LABELS);
}

/** The slot shows all of its content: it does not scroll inside itself. */
async function expectSlotWithoutScroll(page: Page): Promise<void> {
	const sizes = await slot(page).evaluate((node) => ({
		scrollHeight: node.scrollHeight,
		clientHeight: node.clientHeight,
	}));
	expect(sizes.scrollHeight).toBeLessThanOrEqual(sizes.clientHeight);
}

function pageViewport(page: Page): Promise<{
	innerWidth: number;
	innerHeight: number;
}> {
	return page.evaluate(() => ({
		innerWidth: window.innerWidth,
		innerHeight: window.innerHeight,
	}));
}

function expectInside(
	name: string,
	rect: Rect,
	view: { innerWidth: number; innerHeight: number },
): void {
	expect(rect.x, `${name} left edge`).toBeGreaterThanOrEqual(-SUBPIXEL);
	expect(rect.y, `${name} top edge`).toBeGreaterThanOrEqual(-SUBPIXEL);
	expect(right(rect), `${name} right edge`).toBeLessThanOrEqual(
		view.innerWidth + SUBPIXEL,
	);
	expect(bottom(rect), `${name} bottom edge`).toBeLessThanOrEqual(
		view.innerHeight + SUBPIXEL,
	);
}

type DeskPart = "own hand" | "game slot" | "call panel";
const ALL_DESK_PARTS = [
	"own hand",
	"game slot",
	"call panel",
] as const satisfies readonly DeskPart[];

/** The given parts of the viewer's table show in the window without page scroll. */
async function expectDesktopFit(
	viewer: SeatKey,
	parts: readonly DeskPart[],
): Promise<void> {
	const page = tab[viewer];
	await page.evaluate(() => window.scrollTo(0, 0));
	const view = await pageViewport(page);
	const rects = await measure(page, {
		"own hand": byTestId(`hand-${viewer}`),
		"game slot": byTestId("game-slot"),
		"call panel": byTestId("call-panel"),
	});
	for (const name of parts) expectInside(name, shown(rects, name), view);
}

/** A 1366×768 laptop screen less the browser's own bars. */
const LOW_LAPTOP = { width: 1366, height: 650 };

/** The whole room keeps its 1920×1080 layout and fits the viewport without reflow. */
async function expectRoomCanvasFit(page: Page): Promise<void> {
	await expect(page.locator(".room")).toHaveAttribute("data-form", "desktop");
	const geometry = await page.locator(".room").evaluate((node) => {
		const rect = node.getBoundingClientRect();
		const sidebar = node.querySelector(".table-sidebar");
		if (!sidebar) throw new Error("the room sidebar is missing");
		const sidebarRect = sidebar.getBoundingClientRect();
		const videoSlot = node.querySelector(".video-right");
		const felt = videoSlot?.closest(".felt");
		const botControl = videoSlot?.querySelector(".tile-bot-control");
		const main = node.closest("main");
		if (!videoSlot || !felt || !botControl || !main)
			throw new Error("the right player's video slot is missing");
		const scale = Number.parseFloat(
			getComputedStyle(main).getPropertyValue("--room-canvas-scale"),
		);
		return {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
			layoutWidth: (node as HTMLElement).offsetWidth,
			layoutHeight: (node as HTMLElement).offsetHeight,
			sidebarLeft: sidebarRect.left,
			sidebarRight: sidebarRect.right,
			sidebarTop: sidebarRect.top,
			sidebarBottom: sidebarRect.bottom,
			rightVideoBottomGap:
				(felt.getBoundingClientRect().bottom -
					videoSlot.getBoundingClientRect().bottom) /
				scale,
			botControlInRightVideo: videoSlot.contains(botControl),
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
		};
	});
	const expectedWidth = Math.min(
		geometry.viewportWidth,
		geometry.viewportHeight * (16 / 9),
	);
	const expectedHeight = expectedWidth * (9 / 16);
	expect(geometry.layoutWidth).toBe(1920);
	expect(geometry.layoutHeight).toBe(1080);
	expect(
		Math.abs(geometry.width - expectedWidth),
		JSON.stringify(geometry),
	).toBeLessThanOrEqual(1);
	expect(Math.abs(geometry.height - expectedHeight)).toBeLessThanOrEqual(1);
	expect(
		Math.abs(geometry.x - (geometry.viewportWidth - expectedWidth) / 2),
	).toBeLessThanOrEqual(1);
	expect(
		Math.abs(geometry.y - (geometry.viewportHeight - expectedHeight) / 2),
	).toBeLessThanOrEqual(1);
	expect(geometry.sidebarLeft).toBeGreaterThanOrEqual(geometry.x - 1);
	expect(geometry.sidebarRight).toBeLessThanOrEqual(
		geometry.x + geometry.width + 1,
	);
	expect(geometry.sidebarTop).toBeGreaterThanOrEqual(geometry.y - 1);
	expect(geometry.sidebarBottom).toBeLessThanOrEqual(
		geometry.y + geometry.height + 1,
	);
	expect(Math.abs(geometry.rightVideoBottomGap - 40)).toBeLessThanOrEqual(1);
	expect(geometry.botControlInRightVideo).toBe(true);
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const [seat, identity] of [
		["W", "identity-9"],
		["N", "identity-6"],
		["S", "identity-7"],
		["E", "identity-8"],
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

test("1: desktop, start of the auction: each of the four viewers sits at the bottom, with tiles beside the others", async () => {
	tab.W = await players.W.page("./");
	const link = await createRoom(tab.W);
	for (const seat of ["N", "S", "E"] as const) {
		tab[seat] = await players[seat].page(link);
		await pick(tab[seat], seat);
	}
	// The hosting page deals the first board by itself once all four seats are present.
	await expectAt(SEATS, 0);
	await expect(tab.N.getByTestId("bid-box")).toBeVisible();

	for (const seat of SEATS) {
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "auction");
		await expectDesktopLayout(seat);
	}

	// The window shows the own hand, the full bid grid and the call panel without page scroll; a low laptop window
	// shows at least the hand and the bid grid.
	await expectDesktopFit("N", ALL_DESK_PARTS);
	await tab.N.setViewportSize(LOW_LAPTOP);
	await expectDesktopFit("N", ["own hand", "game slot"]);
	await tab.N.setViewportSize({ width: 1280, height: 720 });
});

test("2: desktop, during play: dummy's cards and the trick keep apart from the rest", async () => {
	for (const [seat, code] of [
		["N", "1C"],
		["E", "P"],
		["S", "P"],
		["W", "P"],
	] as const) {
		await tab[seat]
			.getByTestId("bid-box")
			.locator(`button[data-call="${code}"]`)
			.click();
		await expectAt(SEATS, SEATS.indexOf(seat) + 1);
	}
	await tab.E.locator("button.card:enabled").first().click();
	await expectAt(SEATS, 5);

	for (const seat of SEATS) {
		const page = tab[seat];
		await expect(table(page)).toHaveAttribute("data-phase", "play");
		await expect(hand(page, "S")).toHaveAttribute("data-visible", "true");
		await expect(page.getByTestId("trick")).toBeVisible();
		await expect(page.getByTestId("bid-box")).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Claim all" }),
		).toBeDisabled();
		await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
		await expectDesktopLayout(seat);
		await expectSlotWithoutScroll(page);
		await expectDesktopFit(seat, ALL_DESK_PARTS);
	}
	await tab.E.setViewportSize(LOW_LAPTOP);
	await expectDesktopFit("E", ["own hand", "game slot"]);

	// The narrowest and lowest desktop window gives the smallest cards; dummy is a column on East's left.
	await tab.E.setViewportSize({ width: 900, height: 600 });
	await expectDesktopLayout("E");
	await tab.E.setViewportSize({ width: 1280, height: 720 });

	// The entire room keeps its desktop composition at narrow sizes and scales as one 16:9 canvas.
	await tab.E.setViewportSize({ width: 390, height: 664 });
	await expectRoomCanvasFit(tab.E);
	await expectSlotWithoutScroll(tab.E);
	expect(await ranksCut(tab.E), "ranks under the next card").toEqual([]);
	await tab.E.setViewportSize({ width: 1280, height: 720 });
	await expect(tab.E.locator(".room")).toHaveAttribute("data-form", "desktop");
});

test("3: the Full HD room canvas scales proportionally across viewport aspect ratios", async () => {
	if (!phone) throw new Error("the phone browser is not open");
	const host = await players.W.page("./");
	const link = await createRoom(host);
	phoneTab = await phone.page(link);
	await pick(phoneTab, "N");
	for (const seat of ["S", "E"] as const)
		await pick(await players[seat].page(link), seat);
	await expectRoomCanvasFit(phoneTab);
	await expectSlotWithoutScroll(phoneTab);

	// The hosting page deals the first board by itself once all four seats are present.
	await expect(table(phoneTab)).toHaveAttribute("data-phase", "auction", {
		timeout: CONNECT_MS,
	});
	await expect(phoneTab.getByTestId("bid-box")).toBeVisible();
	for (const size of CANVAS_VIEWPORTS) {
		await phoneTab.setViewportSize(size);
		await test.step(`${size.width}×${size.height}`, () =>
			expectRoomCanvasFit(phoneTab as Page));
	}
});

test("4: the call controls have names that spell out the way and the medium, and their off state has a slash", async () => {
	if (!phoneTab) throw new Error("the phone tab is not open");
	const forms = [
		[tab.W, DESKTOP_TOGGLES],
		[phoneTab, COMPACT_TOGGLES],
	] as const;
	for (const [page, toggles] of forms) {
		for (const name of toggles) {
			const toggle = page.getByRole("button", { name, exact: true });
			await expect(toggle).toHaveCount(1);
			await expect(toggle).toHaveAttribute("aria-pressed", "false");
			await expect(toggle).toBeDisabled();
			await expect(toggle.locator(".icon-slash")).toHaveCount(1);
		}
		await expect(
			page.getByRole("button", { name: "Join call", exact: true }),
		).toHaveCount(1);
	}
	await expect(
		phoneTab.getByRole("button", { name: "Send camera video" }),
	).toHaveCount(0);
	await expect(
		phoneTab.getByRole("button", { name: "See cameras: receive video" }),
	).toHaveCount(0);
	for (const name of ["Claim all", "Undo"])
		await expect(
			phoneTab.getByRole("button", { name, exact: true }),
		).toBeDisabled();
});
