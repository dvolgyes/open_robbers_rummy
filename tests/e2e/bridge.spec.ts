import { expect, type Locator, type Page, test } from "@playwright/test";
import { type Card, isCard } from "../../src/bridge/cards";
import { Player, reportNetwork } from "./player";
import { CONNECT_MS, createRoom, pick, type SeatKey, YOU } from "./room";

/**
 * Bridge acceptance on the peer-to-peer table (plan §9). Four browsers play board 1 to the end, each tab taking
 * the first action it offers, then pass out board 2. Each test builds on the table of the tests before it.
 * Board 1: North deals and opens 1♣, the others pass, so North declares, South is dummy and East leads.
 * A modified client is a real page whose disabled card button is enabled and clicked: the page's own handler
 * sends the play, and the host must refuse it.
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["N", "E", "S", "W"] as const satisfies readonly SeatKey[];
const DUMMY = "S";
const players = {} as Record<SeatKey, Player>;
const tab = {} as Record<SeatKey, Page>;
/** True after the host refused a card that does not follow suit. */
let revokeRefused = false;
let totalsAfterBoard1 = "";

const table = (page: Page): Locator => page.getByTestId("table");
const prompt = (page: Page): Locator => page.getByTestId("table-prompt");
const hand = (page: Page, seat: SeatKey): Locator =>
	page.getByTestId(`hand-${seat}`);
const cards = (scope: Locator): Locator => scope.locator("button.card");
const playable = (scope: Page | Locator): Locator =>
	scope.locator("button.card:enabled");
const refusals = (page: Page): Locator =>
	page.getByTestId("table-actions").locator('li[data-state="not-accepted"]');

/**
 * The rendered table without this tab's action notes. A refused command is not stored (plan §4.5), so its note
 * lives only in the page and a reload clears it; everything else comes from the replicated table.
 */
const tableText = (page: Page): Promise<string> =>
	table(page).evaluate((node) =>
		Array.from(
			node.querySelectorAll<HTMLElement>(
				":scope > .table-status > *, :scope > :not(.table-status)",
			),
		)
			.filter((part) => part.dataset.testid !== "table-actions")
			.map((part) => part.innerText)
			.join("\n"),
	);

async function cardOf(button: Locator): Promise<Card> {
	const card = await button.getAttribute("data-card");
	if (!isCard(card)) throw new Error(`not a card: ${card}`);
	return card;
}

/** Plays a card that the tab shows disabled, as a modified client could. One task, so no render comes between. */
async function forcePlay(button: Locator): Promise<void> {
	await button.evaluate((node) => {
		if (!(node instanceof HTMLButtonElement)) throw new Error("not a button");
		node.disabled = false;
		node.click();
	});
}

/** Waits until every tab shows the board at the position: the number of calls and cards made. */
async function expectAt(board: number, at: number): Promise<void> {
	for (const seat of SEATS) {
		await expect(table(tab[seat])).toHaveAttribute("data-board", String(board));
		await expect(table(tab[seat])).toHaveAttribute("data-at", String(at));
	}
}

/** The one seat whose tab asks its player to act. After a reload, the prompts wait until the seat is back. */
async function actor(): Promise<SeatKey> {
	let asked: SeatKey[] = [];
	await expect
		.poll(
			async () => {
				asked = [];
				for (const seat of SEATS)
					if ((await prompt(tab[seat]).textContent())?.startsWith("Your turn"))
						asked.push(seat);
				return asked.length;
			},
			{ timeout: CONNECT_MS },
		)
		.toBe(1);
	const [seat] = asked;
	if (!seat) throw new Error("nobody is asked to act");
	return seat;
}

/** At the position, the seat asked to act clicks the call. Returns that seat. */
async function call(board: number, at: number, code: string): Promise<SeatKey> {
	await expectAt(board, at);
	const seat = await actor();
	await tab[seat]
		.getByTestId("bid-box")
		.locator(`button[data-call="${code}"]`)
		.click();
	return seat;
}

/**
 * When the seat must follow suit from its own hand and holds other suits, plays one of the other cards as a
 * modified client could. The host must refuse it, and the table must not move.
 */
async function forceRevoke(seat: SeatKey, at: number): Promise<void> {
	const own = hand(tab[seat], seat);
	if ((await playable(own).count()) === 0) return;
	const blocked = own.locator("button.card:disabled");
	if ((await blocked.count()) === 0) return;
	const button = blocked.first();
	const card = await cardOf(button);
	const before = await refusals(tab[seat]).count();
	await forcePlay(button);
	await expect(refusals(tab[seat])).toHaveCount(before + 1);
	await expect(refusals(tab[seat]).last()).toContainText(
		`Not accepted: ${card} does not follow suit`,
	);
	revokeRefused = true;
	await expectAt(1, at);
}

/** At the position on board 1, the seat asked to act plays the first card its tab offers. */
async function playFirst(at: number): Promise<SeatKey> {
	await expectAt(1, at);
	const seat = await actor();
	expect(seat, "dummy's own tab is never asked to play").not.toBe(DUMMY);
	if (!revokeRefused) await forceRevoke(seat, at);
	await playable(tab[seat]).first().click();
	return seat;
}

/** Reloads each tab and checks that it shows the same table as before, once it is connected again. */
async function reloadKeepsTable(
	seats: readonly SeatKey[],
	board: number,
	at: number,
): Promise<void> {
	for (const seat of seats) {
		const page = tab[seat];
		// Just after the previous seat's reload, this page can still wait for that seat ("Waiting for South to
		// come back"); compare the steady table, which needs all four seats online.
		await expect(
			page.getByTestId("roster").locator('li[data-state="online"]'),
		).toHaveCount(4, { timeout: CONNECT_MS });
		const before = await tableText(page);
		await page.reload();
		await expect(page.getByTestId("you")).toHaveText(YOU[seat], {
			timeout: CONNECT_MS,
		});
		await expect(table(page)).toHaveAttribute("data-at", String(at));
		await expect
			.poll(() => tableText(page), { timeout: CONNECT_MS })
			.toBe(before);
	}
	await expectAt(board, at);
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const [seat, name] of [
		["W", "west"],
		["N", "north"],
		["S", "south"],
		["E", "east"],
	] as const)
		players[seat] = await Player.open(browser, baseURL, name);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus)
		await reportNetwork(Object.values(players));
});

test.afterAll(async () => {
	for (const player of Object.values(players)) await player.close();
});

test("1: four browsers sit down; North deals board 1 and each sees only their own hand", async () => {
	tab.W = await players.W.page("./");
	const link = await createRoom(tab.W);
	for (const seat of ["N", "S"] as const) {
		tab[seat] = await players[seat].page(link);
		await expect(tab[seat].getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await pick(tab[seat], seat);
	}
	// East is the last free seat, so its page takes it without a picker.
	tab.E = await players.E.page(link);
	await expect(tab.E.getByTestId("you")).toHaveText(YOU.E, {
		timeout: CONNECT_MS,
	});
	// The host deals board 1 automatically once all four seats are present.
	for (const seat of SEATS)
		await expect(tab[seat].getByTestId("deal")).toBeHidden();
	await expectAt(1, 0);
	const dealt: Card[] = [];
	for (const seat of SEATS) {
		const page = tab[seat];
		await expect(table(page)).toHaveAttribute("data-phase", "auction");
		await expect(table(page)).toContainText("Dealer: North · Vulnerable: None");
		await expect(page.getByTestId("deal")).toBeHidden();
		for (const other of SEATS)
			await expect(hand(page, other)).toHaveAttribute(
				"data-visible",
				String(other === seat),
			);
		const own = cards(hand(page, seat));
		await expect(own).toHaveCount(13);
		for (const button of await own.all()) dealt.push(await cardOf(button));
	}
	expect(new Set(dealt).size).toBe(52);
});

test("2: the auction 1♣ and three passes; a guest and the host reload mid-auction", async () => {
	expect(await call(1, 0, "1C")).toBe("N");
	expect(await call(1, 1, "P")).toBe("E");
	await expectAt(1, 2);
	await reloadKeepsTable(["S", "W"], 1, 2);
	expect(await call(1, 2, "P")).toBe("S");
	expect(await call(1, 3, "P")).toBe("W");

	await expectAt(1, 4);
	for (const seat of SEATS) {
		const page = tab[seat];
		await expect(table(page)).toHaveAttribute("data-phase", "play");
		await expect(page.getByTestId("auction").locator("tbody td")).toHaveText([
			"1♣",
			"Pass",
			"Pass",
			"Pass",
		]);
		await expect(table(page)).toContainText("1♣ by North");
		await expect(page.getByTestId("bid-box")).toBeHidden();
	}
});

test("3: East leads; then dummy is shown to everyone and only declarer plays it, even when dummy's tab is modified", async () => {
	await expectAt(1, 4);
	await expect(hand(tab.E, DUMMY)).toHaveAttribute("data-visible", "false");
	expect(await playFirst(4)).toBe("E");

	await expectAt(1, 5);
	for (const seat of SEATS)
		await expect(hand(tab[seat], DUMMY)).toHaveAttribute(
			"data-visible",
			"true",
		);
	await expect(prompt(tab.N)).toHaveText("Your turn: play a card from dummy.");
	await expect(prompt(tab.S)).toHaveText(
		"Waiting for North to play from dummy.",
	);
	await tab.E.setViewportSize({ width: 390, height: 664 });
	await tab.N.setViewportSize({ width: 390, height: 664 });
	await tab.E.locator(".mobile-auction-controls")
		.getByRole("button", { name: "Undo" })
		.click();
	await expect(tab.N.getByTestId("mobile-undo-overlay")).toBeVisible();
	await tab.N.getByTestId("mobile-undo-overlay")
		.getByRole("button", { name: "Approve" })
		.click();
	await expectAt(1, 4);
	await tab.E.setViewportSize({ width: 1280, height: 720 });
	expect(await playFirst(4)).toBe("E");
	await expectAt(1, 5);
	await expect(tab.N.getByTestId("mobile-undo-overlay")).toBeHidden();
	await expect(tab.N.locator(".room")).toHaveAttribute("data-form", "compact");
	await expect(tab.N.locator(".mobile-auction")).toBeVisible();
	await expect(tab.N.locator(".mobile-auction-bids .auction")).toContainText(
		"1♣",
	);
	await expect(tab.N.locator(".mobile-board-center .trick")).toBeVisible();
	await expect(tab.N.locator(".mobile-auction-controls")).toContainText(
		"Claim …",
	);
	await expect(tab.N.locator(".mobile-auction-controls")).toContainText(
		"Claim all",
	);
	await tab.N.locator(".mobile-auction-controls")
		.getByRole("button", { name: "Claim …" })
		.click();
	await expect(tab.N.getByTestId("claim-count")).toBeVisible();
	await tab.N.locator(".mobile-auction-controls")
		.getByRole("button", { name: "Go back" })
		.click();
	await expect(tab.N.getByTestId("claim-count")).toBeHidden();
	await tab.N.locator(".mobile-auction-controls")
		.getByRole("button", { name: "Claim all" })
		.click();
	await expect(tab.N.getByTestId("claim-confirm")).toBeVisible();
	await expect(tab.N.locator(".mobile-auction-controls")).toContainText(
		"Confirm that you claim all 12 remaining tricks.",
	);
	await tab.N.locator(".mobile-auction-controls")
		.getByRole("button", { name: "Go back" })
		.click();
	await tab.N.setViewportSize({ width: 1280, height: 720 });
	await expect(playable(tab.S)).toHaveCount(0);
	await expect(playable(hand(tab.N, "N"))).toHaveCount(0);
	const fromDummy = playable(hand(tab.N, DUMMY)).first();
	await expect(fromDummy).toBeVisible();
	const card = await cardOf(fromDummy);

	await forcePlay(hand(tab.S, DUMMY).locator(`[data-card="${card}"]`));
	await expect(refusals(tab.S)).toContainText(
		"Not accepted: dummy's cards are played by declarer",
	);
	await expectAt(1, 5);

	expect(await playFirst(5)).toBe("N");
	await expectAt(1, 6);
	await expect(cards(hand(tab.W, DUMMY))).toHaveCount(12);
	await expect(hand(tab.W, DUMMY).locator(`[data-card="${card}"]`)).toHaveCount(
		0,
	);
});

test("4: play to the end of trick 4; the host and declarer reload mid-play", async () => {
	test.setTimeout(240_000);
	for (let at = 6; at < 20; at += 1) await playFirst(at);
	await expectAt(1, 20);
	for (const seat of SEATS)
		await expect(tab[seat].getByTestId("trick")).toContainText(
			"Trick 4 won by",
		);
	await reloadKeepsTable(["W", "N"], 1, 20);
});

test("5: the board is played out; the result and the duplicate score agree in every tab", async () => {
	test.setTimeout(300_000);
	for (let at = 20; at < 56; at += 1) await playFirst(at);
	await expectAt(1, 56);

	const result = await tab.W.getByTestId("result").innerText();
	const scored = /^1♣(?:=|[+-]\d) by North: (N-S|E-W) \+(\d+)\.$/.exec(result);
	expect(scored, result).not.toBeNull();
	const [, side, points] = scored ?? [];
	const sheet = await tab.W.getByTestId("scores").innerText();
	for (const seat of SEATS) {
		const page = tab[seat];
		await expect(table(page)).toHaveAttribute("data-phase", "complete");
		await expect(page.getByTestId("result")).toHaveText(result);
		const row = page.getByTestId("scores").locator("tbody tr");
		await expect(row).toHaveCount(1);
		await expect(row.locator("td.num").nth(side === "N-S" ? 0 : 1)).toHaveText(
			points ?? "",
		);
		expect(await page.getByTestId("scores").innerText()).toBe(sheet);
		// The finished board shows the whole deal, and nothing can be played.
		for (const other of SEATS)
			await expect(cards(hand(page, other))).toHaveCount(13);
		await expect(playable(page)).toHaveCount(0);
		await expect(page.getByTestId("deal")).toHaveText("Deal board 2");
		await expect(page.getByTestId("deal")).toBeEnabled();
	}
	totalsAfterBoard1 = await tab.W.getByTestId("scores")
		.locator("tfoot")
		.innerText();
	expect(
		revokeRefused,
		"no seat had to follow suit while it held another suit",
	).toBe(true);
});

test("6: East deals board 2 and all four pass: passed out, no score", async () => {
	await tab.E.getByTestId("deal").click();
	await expectAt(2, 0);
	for (const seat of SEATS)
		await expect(table(tab[seat])).toContainText(
			"Dealer: East · Vulnerable: N-S",
		);
	for (const [at, seat] of [
		[0, "E"],
		[1, "S"],
		[2, "W"],
		[3, "N"],
	] as const)
		expect(await call(2, at, "P")).toBe(seat);

	await expectAt(2, 4);
	for (const seat of SEATS) {
		const page = tab[seat];
		await expect(table(page)).toHaveAttribute("data-phase", "complete");
		await expect(page.getByTestId("result")).toHaveText(
			"Passed out. No score.",
		);
		const rows = page.getByTestId("scores").locator("tbody tr");
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(1)).toContainText("Passed out");
		await expect(page.getByTestId("scores").locator("tfoot")).toHaveText(
			totalsAfterBoard1,
			{ useInnerText: true },
		);
		await expect(page.getByTestId("deal")).toHaveText("Deal board 3");
	}
});

test("no uncaught errors and no request to the old backend", () => {
	const all = Object.values(players);
	expect(all.flatMap((player) => player.errors)).toEqual([]);
	for (const player of all) expect(player.supabaseRequests).toBe(0);
});
