import { expect, type Locator, type Page, test } from "@playwright/test";
import { freeze } from "./lifecycle";
import { Player, reportNetwork } from "./player";
import {
	CONNECT_MS,
	createRoom,
	expectBanner,
	hostRows,
	lines,
	pick,
	rosterSeat,
	type SeatKey,
	texts,
	YOU,
} from "./room";

/**
 * Connection loss and reconnection in the UI (plan §12 R1 and R4), on one table through the public trackers. Each
 * test builds on the table of the tests before it. Every person has their own browser. A crash closes the tab
 * without unload handlers; a reopen is a new tab of the same browser, so its stored replica and seat come back.
 * Every check of the transcript compares the whole list, so a message that is missing, doubled or out of order
 * fails it (R3).
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["W", "N", "E", "S"] as const satisfies readonly SeatKey[];
/** Board 1: North deals and declares 1♣, so South is dummy. */
const DUMMY = "S";
/** A seat shows offline 20 s after its last beat; a beat comes every 10 s, plus the 1 s roster coalesce. */
const QUIET_MS = 35_000;
/** The become-host button shows at 10 s without a host; the automatic volunteer starts at 30 s. */
const BUTTON_LATEST_MS = 30_000;

const players = {} as Record<SeatKey, Player>;
const tab = {} as Record<SeatKey, Page>;
/** The seats whose tab is open. */
const open = new Set<SeatKey>();
let link = "";
const expected: string[] = [];

const table = (page: Page): Locator => page.getByTestId("table");
const prompt = (page: Page): Locator => page.getByTestId("table-prompt");
const deal = (page: Page): Locator => page.getByTestId("deal");
const playable = (page: Page): Locator => page.locator("button.card:enabled");
const refusals = (page: Page): Locator =>
	page.getByTestId("table-actions").locator('li[data-state="not-accepted"]');

function openSeats(): SeatKey[] {
	return SEATS.filter((seat) => open.has(seat));
}

async function crash(seat: SeatKey): Promise<void> {
	await tab[seat].close({ runBeforeUnload: false });
	open.delete(seat);
}

async function reopen(seat: SeatKey): Promise<void> {
	tab[seat] = await players[seat].page(link);
	await expect(tab[seat].getByTestId("you")).toHaveText(YOU[seat], {
		timeout: CONNECT_MS,
	});
	open.add(seat);
}

/** Types the text into the seat's message box and clicks Send. A send clears the box, so each message is typed. */
async function type(seat: SeatKey, text: string): Promise<void> {
	await tab[seat].getByRole("textbox", { name: "Message" }).fill(text);
	await tab[seat].getByTestId("send").click();
}

/** Sends a message and waits until the sender's transcript shows it; the message joins the expected transcript. */
async function say(seat: SeatKey, text: string): Promise<void> {
	const before = await lines(tab[seat]).count();
	await type(seat, text);
	await expect(lines(tab[seat])).toHaveCount(before + 1, {
		timeout: CONNECT_MS,
	});
	expected.push(text);
}

async function expectTranscripts(): Promise<void> {
	for (const seat of openSeats())
		await expect(texts(tab[seat])).toHaveText(expected, {
			timeout: CONNECT_MS,
		});
}

/** Every open tab names the same host. Returns its seat. */
async function commonHost(): Promise<SeatKey> {
	const [first, ...others] = openSeats();
	if (!first) throw new Error("no open tab");
	await expect(hostRows(tab[first])).toHaveCount(1, { timeout: CONNECT_MS });
	const seat = await hostRows(tab[first]).getAttribute("data-seat");
	if (seat !== "W" && seat !== "N" && seat !== "E" && seat !== "S")
		throw new Error(`no host seat: ${seat}`);
	for (const other of others)
		await expect(hostRows(tab[other])).toHaveAttribute("data-seat", seat, {
			timeout: CONNECT_MS,
		});
	return seat;
}

/** Every open tab shows the board at the position: the number of calls and cards made. */
async function expectAt(board: number, at: number): Promise<void> {
	for (const seat of openSeats()) {
		await expect(table(tab[seat])).toHaveAttribute(
			"data-board",
			String(board),
			{
				timeout: CONNECT_MS,
			},
		);
		await expect(table(tab[seat])).toHaveAttribute("data-at", String(at), {
			timeout: CONNECT_MS,
		});
	}
}

/** The one open tab that asks its player to act. */
async function actor(): Promise<SeatKey> {
	let asked: SeatKey[] = [];
	await expect
		.poll(
			async () => {
				asked = [];
				for (const seat of openSeats())
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

/** At the position on board 1, the seat asked to act plays the first card its tab offers. Returns that seat. */
async function playFirst(at: number): Promise<SeatKey> {
	await expectAt(1, at);
	const seat = await actor();
	await playable(tab[seat]).first().click();
	return seat;
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const [seat, name] of [
		["W", "west"],
		["N", "north"],
		["E", "east"],
		["S", "south"],
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

test("1: four browsers sit down at one table", async () => {
	tab.W = await players.W.page("./");
	link = await createRoom(tab.W);
	open.add("W");
	for (const seat of ["N", "E"] as const) {
		tab[seat] = await players[seat].page(link);
		await expect(tab[seat].getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await pick(tab[seat], seat);
		open.add(seat);
	}
	// South is the last free seat, so its page takes it without a picker.
	tab.S = await players.S.page(link);
	await expect(tab.S.getByTestId("you")).toHaveText(YOU.S, {
		timeout: CONNECT_MS,
	});
	open.add("S");
	for (const seat of SEATS)
		await expect(tab[seat].getByTestId("all-connected")).toBeVisible({
			timeout: CONNECT_MS,
		});
});

test("2: a follower that crashes, or reloads, gets the messages it missed, each once and in order", async () => {
	await crash("N");
	for (const seat of ["W", "E", "S"] as const)
		await say(seat, `${seat}: North is away`);
	await reopen("N");
	await expectTranscripts();

	const reloading = tab.E.reload();
	await say("S", "S: East reloads");
	await reloading;
	await expect(tab.E.getByTestId("you")).toHaveText(YOU.E, {
		timeout: CONNECT_MS,
	});
	await expectTranscripts();

	await say("N", "N: back");
	await expectTranscripts();
});

test("3: a deal waits while a player is away, also when a tab forces it; it goes through after the player returns (R4)", async () => {
	await crash("S");
	for (const seat of openSeats()) {
		await expect(prompt(tab[seat])).toHaveText(
			"Waiting for South to come back",
			{ timeout: CONNECT_MS },
		);
		await expect(deal(tab[seat])).toBeDisabled();
	}
	// A modified tab sends the deal anyway: the host answers "waiting" with the same reason, and the outbox
	// sends it again every 2 s.
	await deal(tab.W).evaluate((node) => {
		if (!(node instanceof HTMLButtonElement)) throw new Error("not a button");
		node.disabled = false;
		node.click();
	});
	const forced = tab.W.getByTestId("table-actions").locator(
		'li[data-state="pending"]',
	);
	await expect(forced).toHaveCount(1, { timeout: CONNECT_MS });
	await expect(forced).toContainText("Waiting for South to come back");
	// Several resends while South is away start no board.
	await tab.W.waitForTimeout(8_000);
	await expectAt(0, 0);
	await expect(forced).toHaveCount(1);
	await expect(refusals(tab.W)).toHaveCount(0);

	// When South is back, the waiting deal goes through once, without a second click.
	await reopen("S");
	await expectAt(1, 0);
	await expect(forced).toHaveCount(0);
	await expect(refusals(tab.W)).toHaveCount(0);
	for (const seat of SEATS)
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "auction");
});

test("4: the host crashes mid-auction; a player clicks Make me the host; the old host reopens, follows, and the auction goes on", async () => {
	test.setTimeout(180_000);
	expect(await call(1, 0, "1C")).toBe("N");
	await expectAt(1, 1);
	await crash("W");
	await expectBanner(tab.E, "waiting-for-host");
	const become = tab.E.getByTestId("become-host");
	await expect(become).toBeEnabled({ timeout: BUTTON_LATEST_MS });
	await become.click();
	expect(await commonHost()).toBe("E");
	// The new host keeps the board, but the auction waits for West (R4).
	await expectAt(1, 1);
	for (const seat of openSeats())
		await expect(prompt(tab[seat])).toHaveText(
			"Waiting for West to come back",
			{ timeout: CONNECT_MS },
		);
	await expect(tab.E.getByTestId("bid-box").locator("button")).toHaveCount(0);

	await reopen("W");
	expect(await commonHost()).toBe("E");
	await expect(tab.W.getByTestId("banner")).toBeHidden({ timeout: CONNECT_MS });
	expect(await call(1, 1, "P")).toBe("E");
	expect(await call(1, 2, "P")).toBe("S");
	expect(await call(1, 3, "P")).toBe("W");
	await expectAt(1, 4);
	for (const seat of SEATS) {
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "play");
		await expect(table(tab[seat])).toContainText("1♣ by North");
	}
});

test("5: dummy crashes during the play: declarer plays on; the next deal waits for dummy (R4)", async () => {
	test.setTimeout(300_000);
	await crash(DUMMY);
	for (let at = 4; at < 56; at += 1) {
		const seat = await playFirst(at);
		expect(seat, "dummy is away").not.toBe(DUMMY);
	}
	await expectAt(1, 56);
	const result = await tab.W.getByTestId("result").innerText();
	expect(result).toMatch(/^1♣(?:=|[+-]\d) by North: /);
	for (const seat of openSeats()) {
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "complete");
		await expect(tab[seat].getByTestId("result")).toHaveText(result);
		await expect(deal(tab[seat])).toHaveText("Deal board 2");
		await expect(deal(tab[seat])).toBeDisabled();
		await expect(prompt(tab[seat])).toHaveText(
			"Waiting for South to come back",
		);
	}

	await reopen(DUMMY);
	await expectAt(1, 56);
	await expect(tab.S.getByTestId("result")).toHaveText(result);
	const sheet = await tab.W.getByTestId("scores").innerText();
	await expect(tab.S.getByTestId("scores")).toHaveText(sheet, {
		useInnerText: true,
	});
	for (const seat of SEATS)
		await expect(deal(tab[seat])).toBeEnabled({ timeout: CONNECT_MS });
});

test("6: three players crash while one stays; its message waits; after they reopen, all four have the same table", async () => {
	test.setTimeout(180_000);
	const result = await tab.S.getByTestId("result").innerText();
	await crash("W");
	await crash("E");
	await crash("N");
	await expectBanner(tab.S, "waiting-for-host");
	const alone = "S: the others are away";
	await type("S", alone);
	const waiting = tab.S.getByTestId("pending").locator("li");
	await expect(waiting).toHaveAttribute("data-state", "pending");
	await expect(waiting).toContainText(alone);
	await expect(texts(tab.S)).toHaveText(expected);

	for (const seat of ["W", "N", "E"] as const) await reopen(seat);
	expected.push(alone);
	await expectTranscripts();
	await expect(waiting).toHaveCount(0);
	test.info().annotations.push({
		type: "host after the reopen",
		description: await commonHost(),
	});
	for (const seat of SEATS) {
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "complete");
		await expect(tab[seat].getByTestId("result")).toHaveText(result);
		await expect(deal(tab[seat])).toBeEnabled({ timeout: CONNECT_MS });
	}
	await deal(tab.E).click();
	await expectAt(2, 0);
});

test("7: a frozen player shows offline, and after the thaw it has everything it missed", async () => {
	test.setTimeout(120_000);
	const host = await commonHost();
	const frozen = (["N", "W", "S"] as const).find((seat) => seat !== host);
	if (!frozen) throw new Error("no follower to freeze");
	const thaw = await freeze(tab[frozen]);
	for (const seat of openSeats())
		if (seat !== frozen) await say(seat, `${seat}: ${frozen} is frozen`);
	await expect(rosterSeat(tab[host], frozen)).toHaveAttribute(
		"data-state",
		"offline",
		{ timeout: QUIET_MS },
	);
	await thaw();
	await expectTranscripts();
	for (const seat of SEATS)
		await expect(
			tab[seat].getByTestId("roster").locator('li[data-state="online"]'),
		).toHaveCount(4, { timeout: CONNECT_MS });
	await expect(tab[frozen].getByTestId("banner")).toBeHidden();
	// Board 2: East deals and calls first; the thawed tab sees the call.
	expect(await call(2, 0, "1D")).toBe("E");
	await expectAt(2, 1);
});

test("no uncaught errors and no request to the old backend", () => {
	expect(Object.values(players).flatMap((player) => player.errors)).toEqual([]);
	for (const player of Object.values(players))
		expect(player.supabaseRequests).toBe(0);
});
