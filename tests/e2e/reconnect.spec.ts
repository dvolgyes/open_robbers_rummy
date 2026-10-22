import { expect, type Locator, type Page, test } from "@playwright/test";
import { BUTTON_MS, HOST_LOST_MS, SEAT_GRACE_MS } from "../../src/p2p/limits";
import { freeze } from "./lifecycle";
import { Player, reportNetwork } from "./player";
import {
	CONNECT_MS,
	createRoom,
	expectBanner,
	expectSeat,
	hostRows,
	openDrawer,
	ownLink,
	pick,
	rosterSeat,
	type SeatKey,
	takeTurn,
	texts,
} from "./room";

/**
 * Connection loss and reconnection in the UI (plan §12 R1 and R4), on one table through the public trackers. Each
 * test builds on the table of the tests before it. Every person has their own browser. A crash closes the tab
 * without unload handlers; a reopen is a new tab of the same browser, so its stored replica and seat come back.
 * Every check of the transcript compares the whole list, so a message that is missing, doubled or out of order
 * fails it (R3). A game action that a modified tab sends while a seat is away is in p2p-mesh.spec.ts (R4).
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["W", "N", "E", "S"] as const satisfies readonly SeatKey[];
/** A seat shows offline 20 s after its last beat; a beat comes every 10 s, plus the 1 s roster coalesce. */
const QUIET_MS = 35_000;
/** The host counts as lost HOST_LOST_MS after its last beat; the become-host button shows BUTTON_MS later. */
const BUTTON_LATEST_MS = HOST_LOST_MS + BUTTON_MS + 10_000;

const players = {} as Record<SeatKey, Player>;
const tab = {} as Record<SeatKey, Page>;
/** The seats whose tab is open. */
const open = new Set<SeatKey>();
let link = "";
const expected: string[] = [];

const table = (page: Page): Locator => page.getByTestId("table");
const prompt = (page: Page): Locator => page.getByTestId("table-prompt");
/** The move buttons; the action bar and the action note are not moves. */
const actions = (page: Page): Locator => page.locator("[data-action]");

/** The cards of the seat's own hand, sorted, so the order of the hand display does not matter. */
async function handCards(page: Page): Promise<string[]> {
	const cards = await page
		.locator(".own-hand button.card")
		.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-card") ?? ""),
		);
	return cards.sort();
}

function openSeats(): SeatKey[] {
	return SEATS.filter((seat) => open.has(seat));
}

async function crash(seat: SeatKey): Promise<void> {
	await tab[seat].close({ runBeforeUnload: false });
	open.delete(seat);
}

/**
 * After a crash the player opens the shared link in a new tab. The host still counts the crashed page as connected
 * for a while, so it refuses the own URL of the seat; once it sees the seat offline, the lobby offers the seat
 * again after the seat grace, and the page of the same browser takes it, because it is the only seat on offer.
 */
async function reopen(seat: SeatKey): Promise<void> {
	tab[seat] = await players[seat].page(link);
	await expectSeat(tab[seat], seat, {
		timeout: HOST_LOST_MS + SEAT_GRACE_MS + CONNECT_MS,
	});
	open.add(seat);
}

/**
 * When no host is reachable, the shared link opens the seat picker with all four seats (ADR 0005), so a crashed
 * player reopens with their own URL, which names the seat. No host holds a link to the crashed page.
 */
async function reopenOwn(seat: SeatKey): Promise<void> {
	tab[seat] = await players[seat].page(ownLink(link, seat));
	await expectSeat(tab[seat], seat, { timeout: CONNECT_MS });
	open.add(seat);
}

/**
 * Types the text into the seat's message box and clicks Send. A send clears the box, so each message is typed.
 * A reopened tab starts with the drawer closed, so the drawer opens first.
 */
async function type(seat: SeatKey, text: string): Promise<void> {
	await openDrawer(tab[seat]);
	await tab[seat].getByRole("textbox", { name: "Message" }).fill(text);
	await tab[seat].getByTestId("send").click();
}

/**
 * Sends a message and waits until the sender's transcript shows it after the earlier messages; the message joins
 * the expected transcript. The sender first waits for the earlier messages, which can still be on their way to it.
 */
async function say(seat: SeatKey, text: string): Promise<void> {
	await expect(texts(tab[seat])).toHaveText(expected, { timeout: CONNECT_MS });
	await type(seat, text);
	expected.push(text);
	await expect(texts(tab[seat])).toHaveText(expected, { timeout: CONNECT_MS });
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

/**
 * The positions in the tests count from East's first turn. The first dealer is random, so test 3 lets the players
 * before East take their turns and sets this offset to the actions that they took.
 */
let offset = 0;

/** Every open tab shows hand 1 at the position: the number of game actions taken in it, after the offset. */
async function expectAt(at: number): Promise<void> {
	for (const seat of openSeats()) {
		await expect(table(tab[seat])).toHaveAttribute("data-hand", "1", {
			timeout: CONNECT_MS,
		});
		await expect(table(tab[seat])).toHaveAttribute(
			"data-at",
			String(offset + at),
			{ timeout: CONNECT_MS },
		);
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

/** At the position, the seat asked to act draws and discards. Returns that seat. */
async function turn(at: number): Promise<SeatKey> {
	await expectAt(at);
	const seat = await actor();
	await takeTurn(tab[seat], offset + at);
	return seat;
}

/** Every open tab names the absent player, and no tab offers a game action. */
async function expectWaitingFor(name: string): Promise<void> {
	for (const seat of openSeats()) {
		await expect(prompt(tab[seat])).toHaveText(
			`Waiting for ${name} to come back`,
			{ timeout: CONNECT_MS },
		);
		await expect(actions(tab[seat])).toHaveCount(0);
	}
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

test("1: four browsers sit down at one table, and the first hand is dealt", async () => {
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
	await expectSeat(tab.S, "S", {
		timeout: CONNECT_MS,
	});
	open.add("S");
	for (const seat of SEATS) {
		await openDrawer(tab[seat]);
		await expect(tab[seat].getByTestId("all-connected")).toBeVisible({
			timeout: CONNECT_MS,
		});
	}
	await expectAt(0);
});

test("2: a follower that crashes, or reloads, gets the messages it missed, each once and in order", async () => {
	test.setTimeout(180_000);
	await crash("N");
	for (const seat of ["W", "E", "S"] as const)
		await say(seat, `${seat}: North is away`);
	await reopen("N");
	await expectTranscripts();

	const reloading = tab.E.reload();
	await say("S", "S: East reloads");
	await reloading;
	await expectSeat(tab.E, "E", {
		timeout: CONNECT_MS,
	});
	await expectTranscripts();

	await say("N", "N: back");
	await expectTranscripts();
});

test("3: a turn waits while a player is away; it goes on after the player returns (R4)", async () => {
	test.setTimeout(180_000);
	await crash("S");
	await expectWaitingFor("South");
	// While South is away, nothing moves.
	await tab.W.waitForTimeout(8_000);
	await expectAt(0);

	// The play goes on once South is back. The players before East take their turns, so that the later tests find
	// the seats in the order that they expect.
	await reopen("S");
	while ((await actor()) !== "E") {
		await turn(0);
		offset += 2;
	}
	expect(await turn(0)).toBe("E");
	await expectAt(2);
	for (const seat of SEATS)
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "play");
});

test("4: the host crashes mid-hand; a player clicks Make me the host; the old host reopens, follows, and the play goes on", async () => {
	test.setTimeout(180_000);
	expect(await turn(2)).toBe("S");
	await expectAt(4);
	await crash("W");
	// The banner reads "unreachable" until the other players' last reports of West are HOST_LOST_MS old.
	await expectBanner(tab.E, "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	const become = tab.E.getByTestId("become-host");
	await expect(become).toBeEnabled({ timeout: BUTTON_LATEST_MS });
	await become.click();
	expect(await commonHost()).toBe("E");
	// The new host keeps the hand, but West's turn waits for West (R4).
	await expectAt(4);
	await expectWaitingFor("West");

	await reopen("W");
	expect(await commonHost()).toBe("E");
	await expect(tab.W.getByTestId("banner")).toBeHidden({ timeout: CONNECT_MS });
	expect(await turn(4)).toBe("W");
	expect(await turn(6)).toBe("N");
	await expectAt(8);
	for (const seat of SEATS)
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "play");
});

test("5: a player crashes after drawing; the table waits; the reopened tab holds the drawn cards and finishes the turn (R4)", async () => {
	test.setTimeout(180_000);
	expect(await turn(8)).toBe("E");
	await expectAt(10);
	expect(await actor()).toBe("S");
	await tab.S.getByTestId("action-draw").click();
	await expectAt(11);
	const drawn = await handCards(tab.S);
	await crash("S");
	await expectWaitingFor("South");

	await reopen("S");
	await expect
		.poll(() => handCards(tab.S), { timeout: CONNECT_MS })
		.toEqual(drawn);
	await expect(prompt(tab.S)).toHaveText(
		"Your turn: meld, extend, then discard.",
		{ timeout: CONNECT_MS },
	);
	await expect(tab.S.getByTestId("action-draw")).toHaveCount(0);
	await tab.S.locator(".own-hand button.card").first().click();
	await tab.S.getByTestId("action-discard").click();
	await expectAt(12);
});

test("6: three players crash while one stays; its message waits; after they reopen, all four have the same table", async () => {
	test.setTimeout(180_000);
	await crash("W");
	await crash("E");
	await crash("N");
	// A frozen or crashed host is "unreachable" until the other players' last reports of it are HOST_LOST_MS old.
	await expectBanner(tab.S, "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	const alone = "S: the others are away";
	await type("S", alone);
	const waiting = tab.S.getByTestId("pending").locator("li");
	await expect(waiting).toHaveAttribute("data-state", "pending");
	await expect(waiting).toContainText(alone);
	await expect(texts(tab.S)).toHaveText(expected);

	for (const seat of ["W", "N", "E"] as const) await reopenOwn(seat);
	expected.push(alone);
	await expectTranscripts();
	await expect(waiting).toHaveCount(0);
	test.info().annotations.push({
		type: "host after the reopen",
		description: await commonHost(),
	});
	await expectAt(12);
	for (const seat of SEATS)
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "play");
	expect(await turn(12)).toBe("W");
	await expectAt(14);
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
	// North's turn: the thawed tab sees it.
	expect(await turn(14)).toBe("N");
	await expectAt(16);
});

test("no uncaught errors and no request to the old backend", () => {
	expect(Object.values(players).flatMap((player) => player.errors)).toEqual([]);
	for (const player of Object.values(players))
		expect(player.supabaseRequests).toBe(0);
});
