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
 * Connection loss and reconnection in the UI, on one table through the public trackers. Each
 * test builds on the table of the tests before it. Every person has their own browser. A crash closes the tab
 * without unload handlers; a reopen is a new tab of the same browser, so its stored replica and seat come back.
 * Every check of the transcript compares the whole list, so a message that is missing, doubled or out of order
 * fails it. A game action that a modified tab sends while a seat is away is in p2p-mesh.spec.ts.
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["4", "1", "2", "3"] as const satisfies readonly SeatKey[];
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
 * When no host is reachable, the shared link opens the seat picker with all four seats (ADR 0002), so a crashed
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
	if (seat !== "4" && seat !== "1" && seat !== "2" && seat !== "3")
		throw new Error(`no host seat: ${seat}`);
	for (const other of others)
		await expect(hostRows(tab[other])).toHaveAttribute("data-seat", seat, {
			timeout: CONNECT_MS,
		});
	return seat;
}

/**
 * The positions in the tests count from Player 2's first turn. The first dealer is random, so test 3 lets the players
 * before Player 2 take their turns and sets this offset to the actions that they took.
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

/** At the position, the seat asked to act draws and ends the turn. Returns that seat. */
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
		["4", "player4"],
		["1", "player1"],
		["2", "player2"],
		["3", "player3"],
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
	tab["4"] = await players["4"].page("./");
	link = await createRoom(tab["4"]);
	open.add("4");
	for (const seat of ["1", "2"] as const) {
		tab[seat] = await players[seat].page(link);
		await expect(tab[seat].getByTestId(`pick-${seat}`)).toBeVisible({
			timeout: CONNECT_MS,
		});
		await pick(tab[seat], seat);
		open.add(seat);
	}
	// Player 3 is the last free seat, so its page takes it without a picker.
	tab["3"] = await players["3"].page(link);
	await expectSeat(tab["3"], "3", {
		timeout: CONNECT_MS,
	});
	open.add("3");
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
	await crash("1");
	for (const seat of ["4", "2", "3"] as const)
		await say(seat, `${seat}: Player 1 is away`);
	await reopen("1");
	await expectTranscripts();

	const reloading = tab["2"].reload();
	await say("3", "3: Player 2 reloads");
	await reloading;
	await expectSeat(tab["2"], "2", {
		timeout: CONNECT_MS,
	});
	await expectTranscripts();

	await say("1", "1: back");
	await expectTranscripts();
});

test("3: a turn waits while a player is away; it goes on after the player returns ", async () => {
	test.setTimeout(180_000);
	await crash("3");
	await expectWaitingFor("Player 3");
	// While Player 3 is away, nothing moves.
	await tab["4"].waitForTimeout(8_000);
	await expectAt(0);

	// The play goes on once Player 3 is back. The players before Player 2 take their turns, so that the later tests find
	// the seats in the order that they expect.
	await reopen("3");
	while ((await actor()) !== "2") {
		await turn(0);
		offset += 2;
	}
	expect(await turn(0)).toBe("2");
	await expectAt(2);
	for (const seat of SEATS)
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "play");
});

test("4: the host crashes mid-hand; a player clicks Make me the host; the old host reopens, follows, and the play goes on", async () => {
	test.setTimeout(180_000);
	expect(await turn(2)).toBe("3");
	await expectAt(4);
	await crash("4");
	// The banner reads "unreachable" until the other players' last reports of Player 4 are HOST_LOST_MS old.
	await expectBanner(tab["2"], "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	const become = tab["2"].getByTestId("become-host");
	await expect(become).toBeEnabled({ timeout: BUTTON_LATEST_MS });
	await become.click();
	expect(await commonHost()).toBe("2");
	// The new host keeps the hand, but Player 4's turn waits for Player 4.
	await expectAt(4);
	await expectWaitingFor("Player 4");

	await reopen("4");
	expect(await commonHost()).toBe("2");
	await expect(tab["4"].getByTestId("banner")).toBeHidden({
		timeout: CONNECT_MS,
	});
	expect(await turn(4)).toBe("4");
	expect(await turn(6)).toBe("1");
	await expectAt(8);
	for (const seat of SEATS)
		await expect(table(tab[seat])).toHaveAttribute("data-phase", "play");
});

test("5: a player crashes after drawing; the table waits; the reopened tab holds the drawn cards and finishes the turn ", async () => {
	test.setTimeout(180_000);
	expect(await turn(8)).toBe("2");
	await expectAt(10);
	expect(await actor()).toBe("3");
	await tab["3"].getByTestId("action-draw").click();
	await expectAt(11);
	const drawn = await handCards(tab["3"]);
	await crash("3");
	await expectWaitingFor("Player 3");

	await reopen("3");
	await expect
		.poll(() => handCards(tab["3"]), { timeout: CONNECT_MS })
		.toEqual(drawn);
	await expect(prompt(tab["3"])).toHaveText(
		"Open with 40 points of new melds from your hand, or end your turn.",
		{ timeout: CONNECT_MS },
	);
	await expect(tab["3"].getByTestId("action-draw")).toHaveCount(0);
	await tab["3"].getByTestId("action-end").click();
	await expectAt(12);
});

test("6: three players crash while one stays; its message waits; after they reopen, all four have the same table", async () => {
	test.setTimeout(180_000);
	await crash("4");
	await crash("2");
	await crash("1");
	// A frozen or crashed host is "unreachable" until the other players' last reports of it are HOST_LOST_MS old.
	await expectBanner(tab["3"], "waiting-for-host", {
		timeout: HOST_LOST_MS + 10_000,
	});
	const alone = "3: the others are away";
	await type("3", alone);
	const waiting = tab["3"].getByTestId("pending").locator("li");
	await expect(waiting).toHaveAttribute("data-state", "pending");
	await expect(waiting).toContainText(alone);
	await expect(texts(tab["3"])).toHaveText(expected);

	for (const seat of ["4", "1", "2"] as const) await reopenOwn(seat);
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
	expect(await turn(12)).toBe("4");
	await expectAt(14);
});

test("7: a frozen player shows offline, and after the thaw it has everything it missed", async () => {
	test.setTimeout(120_000);
	const host = await commonHost();
	const frozen = (["1", "4", "3"] as const).find((seat) => seat !== host);
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
	// Player 1's turn: the thawed tab sees it.
	expect(await turn(14)).toBe("1");
	await expectAt(16);
});

test("no uncaught errors", () => {
	expect(Object.values(players).flatMap((player) => player.errors)).toEqual([]);
});
