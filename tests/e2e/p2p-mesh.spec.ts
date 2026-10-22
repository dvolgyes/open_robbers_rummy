import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { StoredCallRecord } from "../../src/call/record";
import { parseRummyState, tableSeat } from "../../src/game/rummy";
import { HOST_LOST_MS, SEAT_GRACE_MS } from "../../src/p2p/limits";
import type { TableView } from "../../src/p2p/table";
import type { Seat as TableSeat } from "../../src/protocol";
import type { CallView, Harness, TranscriptLine } from "./harness/main";
import { withholdOffers } from "./network";
import { buildTrackerUrls } from "./player";

/**
 * The P2P table on the real network (plan P6, P7 and §12 R1, R2): production modules in Chrome, Trystero over
 * the public trackers, WebRTC data channels, IndexedDB and Web Locks. No part of the network is simulated.
 * Each player is one browser context, so each has its own storage and holder. The link key never appears in
 * an assertion message.
 */

const HARNESS = "http://localhost:4174/";
/** These tests fill a table of four players. */
type Seat = Extract<TableSeat, "1" | "2" | "3" | "4">;
const SEATS: readonly Seat[] = ["1", "2", "3", "4"];
/** Discovery took under 1 s in the spike; this leaves room for a slow tracker. */
const CONNECT_MS = 45_000;
/** The host button appears after 10 s without a host. */
const BUTTON_MS = 40_000;

interface Player {
	readonly context: BrowserContext;
	page: Page;
}

const contexts: BrowserContext[] = [];
const pages: Page[] = [];
const pageErrors: string[] = [];

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus) await dumpPages();
	pages.splice(0);
	for (const context of contexts.splice(0)) await context.close();
	const errors = pageErrors.splice(0);
	expect(errors, "uncaught page errors").toEqual([]);
});

/** On failure: the state of every open page on stderr. Counts and states only; no key, no address. */
async function dumpPages() {
	for (const [index, page] of pages.entries()) {
		if (page.isClosed()) continue;
		const summary = await page.evaluate(() => {
			const harness = window.ocHarness as Harness;
			const current = harness.view();
			if (!current)
				return { stranger: harness.strangerView()?.network ?? null };
			return {
				status: current.status,
				seat: current.seat,
				election: current.election,
				follower: current.follower,
				hosting: current.hosting,
				hostSeat: current.hostSeat,
				ready: current.ready,
				seatError: current.seatError,
				lobby: current.lobby?.seats.map(
					(row) => `${row.seat}:${row.available ? "free" : "taken"}`,
				),
				roster: current.roster?.peers.map(
					(binding) => `${binding.seat}/${binding.gen}`,
				),
				peers: current.peers.map(
					(peer) => `${peer.seat ?? "-"}:${peer.check?.state ?? "none"}`,
				),
				network: current.network,
				entries: harness.transcript().length,
			};
		});
		console.error(`page ${index}: ${JSON.stringify(summary)}`);
	}
}

async function openPage(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	pages.push(page);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(HARNESS);
	await page.waitForFunction(() => window.ocHarness !== undefined);
	return page;
}

async function newPlayer(browser: Browser): Promise<Player> {
	const context = await browser.newContext();
	contexts.push(context);
	return { context, page: await openPage(context) };
}

function view(page: Page): Promise<TableView | null> {
	return page.evaluate(() => (window.ocHarness as Harness).view());
}

function transcript(page: Page): Promise<readonly TranscriptLine[]> {
	return page.evaluate(() => (window.ocHarness as Harness).transcript());
}

async function create(player: Player, seat: Seat): Promise<string> {
	const { key } = await player.page.evaluate(
		(chosen) => (window.ocHarness as Harness).createTable(chosen),
		seat,
	);
	return key;
}

/** `seat` opens the player's own URL, which keeps the selected seat (ADR 0005); without it, the shared link. */
function openTable(page: Page, key: string, seat?: Seat): Promise<void> {
	return page.evaluate(
		({ link, chosen }) => (window.ocHarness as Harness).openTable(link, chosen),
		{ link: key, chosen: seat },
	);
}

function choose(page: Page, seat: Seat) {
	return page.evaluate(
		(chosen) => (window.ocHarness as Harness).choose(chosen),
		seat,
	);
}

function send(page: Page, text: string) {
	return page.evaluate(
		(body) => (window.ocHarness as Harness).send(body),
		text,
	);
}

/** The page holds `seat`, follows a host, and its own commands reach that host. */
async function expectSeated(page: Page, seat: Seat, hostSeat?: Seat) {
	await expect
		.poll(
			async () => {
				const current = await view(page);
				return {
					status: current?.status,
					seat: current?.seat,
					ready: current?.ready,
					host: hostSeat === undefined ? undefined : current?.hostSeat,
				};
			},
			{ timeout: CONNECT_MS },
		)
		.toEqual({ status: "open", seat, ready: true, host: hostSeat });
}

/** A visitor opens the link, receives the lobby, and takes `seat`. */
async function takeSeat(page: Page, key: string, seat: Seat) {
	await openTable(page, key);
	await expect
		.poll(async () => (await view(page))?.lobby !== null, {
			timeout: CONNECT_MS,
		})
		.toBe(true);
	expect(await choose(page, seat)).toEqual({ ok: true });
	await expectSeated(page, seat);
}

async function fullTable(
	browser: Browser,
): Promise<{ key: string; players: Record<Seat, Player> }> {
	const north = await newPlayer(browser);
	const key = await create(north, "1");
	await expectSeated(north.page, "1", "1");
	const players: Record<Seat, Player> = {
		"1": north,
		"2": await newPlayer(browser),
		"3": await newPlayer(browser),
		"4": await newPlayer(browser),
	};
	for (const seat of ["2", "3", "4"] as const) {
		await takeSeat(players[seat].page, key, seat);
	}
	return { key, players };
}

/** Versioned log (R3): sequence numbers 1..n without a gap, and no entry id twice. */
function expectWellFormed(lines: readonly TranscriptLine[]) {
	expect(lines.map((line) => line.seq)).toEqual(
		lines.map((_, index) => index + 1),
	);
	expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
}

/** Every page holds the same log as `reference`, which holds at least `atLeast` entries. */
async function expectSameLog(
	reference: Page,
	pages: readonly Page[],
	atLeast: number,
) {
	await expect
		.poll(async () => (await transcript(reference)).length, {
			timeout: CONNECT_MS,
		})
		.toBeGreaterThanOrEqual(atLeast);
	const expected = await transcript(reference);
	expectWellFormed(expected);
	for (const page of pages) {
		await expect
			.poll(() => transcript(page), { timeout: CONNECT_MS })
			.toEqual(expected);
	}
	return expected;
}

/** Closes the page without unload handlers, as a crash or a killed mobile tab does. */
async function crash(player: Player) {
	await player.page.close({ runBeforeUnload: false });
}

/** The player opens their own URL again in a new tab. */
async function reopen(player: Player, key: string, seat: Seat) {
	player.page = await openPage(player.context);
	await openTable(player.page, key, seat);
}

/**
 * Right after a crash the player opens the shared link in a new tab and takes the seat back. The host still counts
 * the crashed page as connected, so it refuses the own URL of the seat until it sees the seat offline; the lobby
 * offers the seat again after the seat grace, and the page of the same browser takes it, as the lobby does when it
 * offers one seat. A sent claim is not yet a bound seat, because the host can still refuse it, so the page claims
 * again until it holds the seat.
 */
async function reopenAfterCrash(player: Player, key: string, seat: Seat) {
	player.page = await openPage(player.context);
	await openTable(player.page, key);
	const page = player.page;
	await expect
		.poll(
			async () => {
				const current = await view(page);
				if (current?.seat === seat) return seat;
				if (current?.seat === null) await choose(page, seat);
				return current?.seat ?? null;
			},
			{
				timeout: HOST_LOST_MS + SEAT_GRACE_MS + CONNECT_MS,
				intervals: [2_000],
			},
		)
		.toBe(seat);
}

async function waitForButton(page: Page) {
	await expect
		.poll(
			async () => {
				const election = (await view(page))?.election;
				return election?.phase === "waiting-for-host" ? election.button : null;
			},
			{ timeout: BUTTON_MS },
		)
		.not.toBeNull();
	const election = (await view(page))?.election;
	return election?.phase === "waiting-for-host" ? election.button : null;
}

const pagesOf = (players: Record<Seat, Player>, seats: readonly Seat[]) =>
	seats.map((seat) => players[seat].page);

/** The page has passed the ping/echo check with the peers of the three other seats. */
async function expectAllConnected(page: Page) {
	await expect
		.poll(async () => (await view(page))?.allConnected, {
			timeout: CONNECT_MS,
		})
		.toBe(true);
}

async function bindingOf(page: Page, seat: Seat) {
	return (await view(page))?.roster?.peers.find(
		(binding) => binding.seat === seat,
	);
}

/** The host page has a connected peer bound to each of `seats`. */
async function expectBound(host: Page, seats: readonly Seat[]) {
	for (const seat of seats) {
		await expect
			.poll(() => bindingOf(host, seat), { timeout: CONNECT_MS })
			.toBeDefined();
	}
}

/** The host page no longer has a connected peer bound to `seat`. */
async function expectGone(host: Page, seat: Seat) {
	await expect
		.poll(() => bindingOf(host, seat), { timeout: CONNECT_MS })
		.toBeUndefined();
}

function act(page: Page) {
	return page.evaluate(() => (window.ocHarness as Harness).act());
}

function deal(page: Page) {
	return page.evaluate(() => (window.ocHarness as Harness).deal());
}

const SEAT_NAMES = {
	"1": "Player 1",
	"2": "Player 2",
	"3": "Player 3",
	"4": "Player 4",
} as const;

/** The seat that plays first in the dealt hand, from the state that the page holds. */
async function firstPlayer(page: Page): Promise<Seat> {
	const record = (await view(page))?.table;
	const match = record
		? parseRummyState(record.state, record.tableId)?.match
		: undefined;
	if (!match) throw new Error("no hand is dealt");
	const seat = SEATS.find((one) => one === tableSeat(match.hand.turn));
	if (seat === undefined) throw new Error("the first player is not seated");
	return seat;
}

async function commands(page: Page): Promise<number> {
	return (await transcript(page)).filter((line) => line.kind === "cmd").length;
}

async function expectCommands(pages: readonly Page[], count: number) {
	for (const page of pages) {
		await expect
			.poll(() => commands(page), { timeout: CONNECT_MS })
			.toBe(count);
	}
}

/** `page` takes the next game action once its log holds the `count` commands before it; every page gets it. */
async function actInTurn(page: Page, pages: readonly Page[], count: number) {
	await expect.poll(() => commands(page), { timeout: CONNECT_MS }).toBe(count);
	expect(await act(page)).toEqual({ ok: true });
	await expectCommands(pages, count + 1);
}

function callOpen(page: Page) {
	return page.evaluate(() => (window.ocHarness as Harness).callOpen());
}

/** Each page opens its call inbox; the result is each seat's generation. */
async function openInboxes(
	players: Record<Seat, Player>,
): Promise<Record<Seat, number>> {
	const generation = async (seat: Seat) => {
		const self = await callOpen(players[seat].page);
		expect(self.seat).toBe(seat);
		return self.generation;
	};
	return {
		"1": await generation("1"),
		"2": await generation("2"),
		"3": await generation("3"),
		"4": await generation("4"),
	};
}

function callSend(page: Page, to: Seat | null): Promise<string> {
	return page.evaluate(
		(target) => (window.ocHarness as Harness).callSend(target),
		to,
	);
}

function callForge(
	page: Page,
	frame: { to: Seat; toGen: number; fromGen: number; count: number },
): Promise<string> {
	return page.evaluate(
		({ to, toGen, fromGen, count }) =>
			(window.ocHarness as Harness).callForge(to, toGen, fromGen, count),
		frame,
	);
}

function callView(page: Page): Promise<CallView> {
	return page.evaluate(() => (window.ocHarness as Harness).callView());
}

/** The messages of call session `session` that reached the inbox of `page`, as [from, fromGen]. */
async function arrivals(page: Page, session: string) {
	const received = await page.evaluate(() =>
		(window.ocHarness as Harness).callReceived(),
	);
	return received
		.filter((message) => message.session === session)
		.map((message) => [message.from, message.fromGen]);
}

async function expectArrivals(
	page: Page,
	session: string,
	expected: readonly (readonly [Seat, number])[],
) {
	await expect
		.poll(() => arrivals(page, session), { timeout: CONNECT_MS })
		.toEqual(expected);
}

function others(seat: Seat): Seat[] {
	return SEATS.filter((other) => other !== seat);
}

/** The record that the host stores for a `sendMedia` from the seat of `holder`. */
function callStatus(
	version: number,
	video: boolean,
	holder: string,
): StoredCallRecord {
	return {
		version,
		prefs: {
			inCall: true,
			send: { audio: true, video },
			receive: { audio: true, video: true },
		},
		form: "desktop",
		holder,
	};
}

function sendMedia(page: Page, version: number, video: boolean) {
	return page.evaluate(
		({ version, video }) =>
			(window.ocHarness as Harness).sendMedia(version, video),
		{ version, video },
	);
}

async function expectMedia(
	pages: readonly Page[],
	expected: Partial<Record<Seat, StoredCallRecord>>,
) {
	for (const page of pages) {
		await expect
			.poll(() => page.evaluate(() => (window.ocHarness as Harness).media()), {
				timeout: CONNECT_MS,
			})
			.toEqual(expected);
	}
}

test("four players form one table, take seats, and replicate commands", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const { key, players } = await fullTable(browser);
	const pages = pagesOf(players, SEATS);

	// The full mesh: every page has 3 peers that passed the ping/echo check, bound to the other seats.
	for (const page of pages) {
		await expect
			.poll(async () => (await view(page))?.allConnected, {
				timeout: CONNECT_MS,
			})
			.toBe(true);
		const current = await view(page);
		expect(current?.peers).toHaveLength(3);
		expect(current?.hostSeat).toBe("1");
		expect(current?.network?.wrongKey).toBe(0);
	}
	expect((await view(players["1"].page))?.hosting).toBe(true);

	expect(await send(players["2"].page, "hello from east")).toEqual({
		ok: true,
	});
	// Entry 1 is the creator's claim; three seat claims and the command follow.
	const first = await expectSameLog(players["1"].page, pages, 5);
	expect(first.filter((line) => line.kind === "cmd")).toHaveLength(1);

	// R1: a follower reloads and gets its seat and the log back.
	await players["2"].page.reload();
	await players["2"].page.waitForFunction(() => window.ocHarness !== undefined);
	await openTable(players["2"].page, key, "2");
	await expectSeated(players["2"].page, "2", "1");

	// R1: a follower crashes and reopens the link in a new tab.
	await crash(players["3"]);
	await reopenAfterCrash(players["3"], key, "3");
	await expectSeated(players["3"].page, "3", "1");

	expect(await send(players["3"].page, "south is back")).toEqual({ ok: true });
	const second = await expectSameLog(
		players["1"].page,
		pagesOf(players, SEATS),
		first.length + 1,
	);
	expect(second.slice(0, first.length)).toEqual(first);
	expect(second.filter((line) => line.kind === "cmd")).toHaveLength(2);
});

test("the table survives the host and three players leaving", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const { key, players } = await fullTable(browser);
	await expectSameLog(players["1"].page, pagesOf(players, SEATS), 4);

	// The host crashes. With other players connected, the button is enabled, and one click elects a host.
	await crash(players["1"]);
	expect(await waitForButton(players["2"].page)).toEqual({ enabled: true });
	await players["2"].page.evaluate(() => (window.ocHarness as Harness).click());
	await expect
		.poll(async () => (await view(players["2"].page))?.hosting, {
			timeout: CONNECT_MS,
		})
		.toBe(true);
	for (const seat of ["3", "4"] as const) {
		await expectSeated(players[seat].page, seat, "2");
	}
	expect(await send(players["3"].page, "during the host change")).toEqual({
		ok: true,
	});

	// The old host returns, sees the newer term, and follows.
	await reopen(players["1"], key, "1");
	await expectSeated(players["1"].page, "1", "2");
	// The new host counts the players who were connected before its claim, not only the ones who came later.
	await expectBound(players["2"].page, ["1", "3", "4"]);
	const beforeSplit = await expectSameLog(
		players["2"].page,
		pagesOf(players, SEATS),
		5,
	);

	// Three players leave; Player 1 stays alone. Without a witness, Player 1 cannot elect itself (D1).
	for (const seat of ["2", "3", "4"] as const) await crash(players[seat]);
	expect(await waitForButton(players["1"].page)).toEqual({
		enabled: false,
		reason: "witness",
	});

	// Two players return and are the witnesses; Player 1's copy restores the table.
	await reopen(players["3"], key, "3");
	await reopen(players["4"], key, "4");
	await expect
		.poll(
			async () => {
				const election = (await view(players["1"].page))?.election;
				return election?.phase === "waiting-for-host"
					? election.button?.enabled
					: undefined;
			},
			{ timeout: CONNECT_MS },
		)
		.toBe(true);
	await players["1"].page.evaluate(() => (window.ocHarness as Harness).click());
	for (const seat of ["3", "4"] as const) {
		await expectSeated(players[seat].page, seat, "1");
	}

	// The last host returns, sees the newer term, and follows instead of resuming its own.
	await reopen(players["2"], key, "2");
	await expectSeated(players["2"].page, "2", "1");
	await expectBound(players["1"].page, ["2", "3", "4"]);

	expect(await send(players["4"].page, "all back")).toEqual({ ok: true });
	const final = await expectSameLog(
		players["1"].page,
		pagesOf(players, SEATS),
		beforeSplit.length + 1,
	);
	expect(final.slice(0, beforeSplit.length)).toEqual(beforeSplit);
	expect(final.filter((line) => line.kind === "cmd")).toHaveLength(2);
	expect(new Set(final.map((line) => line.term))).toEqual(new Set([1, 2, 3]));
});

test("a page that changes network gets its links back with the same peer and seat", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const { players } = await fullTable(browser);
	const pages = pagesOf(players, SEATS);
	for (const page of pages) await expectAllConnected(page);
	const before = await bindingOf(players["1"].page, "2");
	expect(before).toBeDefined();
	const log = await expectSameLog(players["1"].page, pages, 4);

	// Player 2's links all close, as after a switch from Wi-Fi to cellular; the page and its peer id stay.
	expect(
		await players["2"].page.evaluate(() =>
			(window.ocHarness as Harness).dropLinks(),
		),
	).toEqual({ closed: 3, peersAfter: 0 });

	// The full mesh comes back, Player 2 keeps its seat generation, and nothing in the log changed.
	for (const page of pages) await expectAllConnected(page);
	expect(await bindingOf(players["1"].page, "2")).toEqual(before);
	expect(await send(players["2"].page, "after the network change")).toEqual({
		ok: true,
	});
	const after = await expectSameLog(players["1"].page, pages, log.length + 1);
	expect(after.slice(0, log.length)).toEqual(log);

	// The two-page rooms close once the table room has their links.
	for (const page of pages) {
		await expect
			.poll(async () => (await view(page))?.network?.pairRooms, {
				timeout: CONNECT_MS,
			})
			.toBe(0);
	}
	const repaired = await Promise.all(
		pages.map(async (page) => (await view(page))?.network?.repaired),
	);
	console.error(
		`links repaired through two-page rooms, N E S "4": ${repaired}`,
	);
});

test("a visitor whose first links fail still connects within the connection budget", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const north = await newPlayer(browser);
	const key = await create(north, "1");
	await expectSeated(north.page, "1", "1");

	// Each link that the visitor starts in its first 15 s fails its ICE checks. Trystero reports a failed
	// link about 23 s after the exchange, and the table room tries again only at a later tracker announce.
	// Two repairs can link the visitor: a two-page room after the failure report, or the visitor's rejoin of
	// the table room after 10 s and 30 s alone. A rejoin drops the failure report of the room it leaves.
	const failMs = 15_000;
	const visitor = await newPlayer(browser);
	await visitor.page.evaluate(
		(ms) => (window.ocHarness as Harness).failLinksFor(ms),
		failMs,
	);
	const opened = Date.now();
	await openTable(visitor.page, key);
	await expect
		.poll(async () => (await view(visitor.page))?.lobby !== null, {
			timeout: CONNECT_MS,
		})
		.toBe(true);
	const elapsed = Date.now() - opened;
	// A link from the first 15 s cannot connect, so an earlier lobby would mean that the fault did not apply.
	expect(elapsed).toBeGreaterThan(failMs);

	// The two-page rooms close once the table room has the link.
	for (const page of [north.page, visitor.page]) {
		await expect
			.poll(async () => (await view(page))?.network?.pairRooms, {
				timeout: CONNECT_MS,
			})
			.toBe(0);
	}
	const network = (await view(visitor.page))?.network;
	console.error(
		`visitor lobby after ${elapsed} ms; links repaired through two-page rooms: ${network?.repaired}; rejoins: ${network?.rejoins}`,
	);
});

test("a latecomer whose first offers reach no page that answers rejoins and connects", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const north = await newPlayer(browser);
	const key = await create(north, "1");
	await expectSeated(north.page, "1", "1");
	const east = await newPlayer(browser);
	await takeSeat(east.page, key, "2");

	// The trackers send each offer to a few pages, and those can be pages that cannot answer: a frozen tab, or
	// a tab that left the room but keeps its tracker sockets (the full2 seat-timeout failure). For its first
	// 8 s, the latecomer's offers reach no page, and no offer reaches it. Player 1 and Player 2 have their link, so
	// they do not rejoin. The trackers' announce interval is 120 s, so within the budget only the latecomer's
	// rejoin after 10 s alone can send a new offer.
	const withholdMs = 8_000;
	const budgetMs = 30_000;
	const context = await browser.newContext();
	contexts.push(context);
	await withholdOffers(context, buildTrackerUrls(), withholdMs);
	const late = await openPage(context);
	const opened = Date.now();
	await openTable(late, key);
	await expect
		.poll(async () => (await view(late))?.lobby !== null, {
			timeout: budgetMs,
		})
		.toBe(true);
	const elapsed = Date.now() - opened;
	// No offer passes in the first 8 s, so an earlier lobby would mean that the fault did not apply.
	expect(elapsed).toBeGreaterThan(withholdMs);
	const network = (await view(late))?.network;
	console.error(
		`latecomer lobby after ${elapsed} ms; rejoins: ${network?.rejoins}; links repaired through two-page rooms: ${network?.repaired}`,
	);
});

test("game actions wait for every player (R4)", async ({ browser }) => {
	test.setTimeout(300_000);
	const { key, players } = await fullTable(browser);
	const pages = pagesOf(players, SEATS);
	for (const page of pages) await expectAllConnected(page);

	// A quiet table: no command for longer than the 6 s presence window. All players are still there, so the
	// host's deal lands.
	await players["1"].page.waitForTimeout(8_000);
	await expectCommands(pages, 0);
	expect(await deal(players["1"].page)).toEqual({ ok: true });
	await expectCommands(pages, 1);

	// The first dealer is random, so the first player is too. A seat that is neither the host (Player 1) nor the
	// first player leaves, and the first player's draw waits for it.
	const first = await firstPlayer(players["1"].page);
	const [gone, idle] = SEATS.filter((seat) => seat !== "1" && seat !== first);
	if (gone === undefined || idle === undefined)
		throw new Error("no seat to leave");
	await crash(players[gone]);
	await expectGone(players[first].page, gone);
	expect(
		await act(players[idle].page),
		"the idle seat is not the actor",
	).toBeNull();
	expect(await act(players[first].page)).toEqual({ ok: true });
	await expect
		.poll(
			async () =>
				(await view(players[first].page))?.outbox.map((item) => item.waiting),
			{ timeout: CONNECT_MS },
		)
		.toEqual([`Waiting for ${SEAT_NAMES[gone]} to come back`]);
	expect(await commands(players[first].page)).toBe(1);

	// The seat returns, and the stored draw lands without a new click.
	await reopen(players[gone], key, gone);
	await expectSeated(players[gone].page, gone, "1");
	const all = pagesOf(players, SEATS);
	await expectCommands(all, 2);
	expect((await view(players[first].page))?.outbox).toEqual([]);

	// The first player goes on with the turn.
	await actInTurn(players[first].page, all, 2);

	for (const page of all) expect((await view(page))?.failures).toEqual([]);
	const log = await transcript(players["1"].page);
	expectWellFormed(log);
	expect(new Set(log.map((line) => line.term))).toEqual(new Set([1]));
});

test("call signaling goes over the data channels, and only from bound seats (P7)", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const { key, players } = await fullTable(browser);
	const pages = pagesOf(players, SEATS);
	for (const page of pages) await expectAllConnected(page);
	const gens = await openInboxes(players);

	// Each page sees every seat held at its generation, and the other three online.
	for (const seat of SEATS) {
		await expect
			.poll(() => callView(players[seat].page), { timeout: CONNECT_MS })
			.toEqual({
				self: { seat, generation: gens[seat] },
				holders: gens,
				online: others(seat),
			});
	}

	// A message to all reaches the three other inboxes, with the sender's seat from the roster.
	const all = await callSend(players["1"].page, null);
	for (const seat of others("1")) {
		await expectArrivals(players[seat].page, all, [["1", gens["1"]]]);
	}
	expect(await arrivals(players["1"].page, all)).toEqual([]);

	// An addressed message reaches only its seat. Each data channel keeps its order, so once Player 2's next message
	// to all has arrived, the addressed one would have arrived first if it had been sent there.
	const direct = await callSend(players["2"].page, "3");
	const marker = await callSend(players["2"].page, null);
	for (const seat of others("2")) {
		await expectArrivals(players[seat].page, marker, [["2", gens["2"]]]);
	}
	await expectArrivals(players["3"].page, direct, [["2", gens["2"]]]);
	for (const seat of ["1", "4"] as const) {
		expect(await arrivals(players[seat].page, direct)).toEqual([]);
	}

	// Raw frames from Player 4's page: a wrong sender or receiver generation is dropped; the correct one, sent last on
	// the same channel, arrives, so the two before it were received and dropped.
	const wrongFrom = await callForge(players["4"].page, {
		to: "1",
		toGen: gens["1"],
		fromGen: gens["4"] + 1,
		count: 1,
	});
	const wrongTo = await callForge(players["4"].page, {
		to: "1",
		toGen: gens["1"] + 1,
		fromGen: gens["4"],
		count: 1,
	});
	const correct = await callForge(players["4"].page, {
		to: "1",
		toGen: gens["1"],
		fromGen: gens["4"],
		count: 1,
	});
	await expectArrivals(players["1"].page, correct, [["4", gens["4"]]]);
	expect(await arrivals(players["1"].page, wrongFrom)).toEqual([]);
	expect(await arrivals(players["1"].page, wrongTo)).toEqual([]);

	// A flood of 30 from one seat: Player 1 takes 20 in the window, and Player 2 still gets through.
	await players["1"].page.waitForTimeout(1_500);
	const flood = await callForge(players["4"].page, {
		to: "1",
		toGen: gens["1"],
		fromGen: gens["4"],
		count: 30,
	});
	const during = await callSend(players["2"].page, "1");
	await expectArrivals(players["1"].page, during, [["2", gens["2"]]]);
	await players["1"].page.waitForTimeout(1_500);
	const later = await callForge(players["4"].page, {
		to: "1",
		toGen: gens["1"],
		fromGen: gens["4"],
		count: 1,
	});
	await expectArrivals(players["1"].page, later, [["4", gens["4"]]]);
	expect(await arrivals(players["1"].page, flood)).toHaveLength(20);

	// A visitor without a seat has a working link to Player 1, but its frames never reach Player 1's inbox.
	const visitor = await newPlayer(browser);
	await openTable(visitor.page, key);
	await expect
		.poll(
			async () =>
				(await view(players["1"].page))?.peers
					.filter((peer) => peer.seat === null)
					.map((peer) => peer.check?.state),
			{ timeout: CONNECT_MS },
		)
		.toEqual(["ready"]);
	const stray = await callForge(visitor.page, {
		to: "1",
		toGen: gens["1"],
		fromGen: 1,
		count: 3,
	});
	await players["1"].page.waitForTimeout(3_000);
	expect(await arrivals(players["1"].page, stray)).toEqual([]);
});

test("call signaling and the call status come back after a network change and a reload (P7, R2)", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const { key, players } = await fullTable(browser);
	const pages = pagesOf(players, SEATS);
	for (const page of pages) await expectAllConnected(page);
	const gens = await openInboxes(players);
	await expect
		.poll(async () => (await callView(players["1"].page)).online, {
			timeout: CONNECT_MS,
		})
		.toEqual(others("1"));

	// Player 2's links drop, as after a switch from Wi-Fi to cellular. Player 1 sees Player 2 leave and come back, and
	// Player 2's inbox stays open through it.
	await players["2"].page.evaluate(() =>
		(window.ocHarness as Harness).dropLinks(),
	);
	for (const page of pages) await expectAllConnected(page);
	await expect
		.poll(async () => (await callView(players["1"].page)).online, {
			timeout: CONNECT_MS,
		})
		.toEqual(others("1"));
	const history = await players["1"].page.evaluate(() =>
		(window.ocHarness as Harness).callOnlineHistory(),
	);
	expect(
		history.slice(history.indexOf("ESW")).some((seats) => !seats.includes("2")),
		`Player 1's online sets: ${history}`,
	).toBe(true);
	expect(
		await players["2"].page.evaluate(() =>
			(window.ocHarness as Harness).callEnded(),
		),
	).toBeNull();
	const toEast = await callSend(players["1"].page, "2");
	await expectArrivals(players["2"].page, toEast, [["1", gens["1"]]]);
	const fromEast = await callSend(players["2"].page, null);
	for (const seat of others("2")) {
		await expectArrivals(players[seat].page, fromEast, [["2", gens["2"]]]);
	}

	// R2: Player 2's call status is a versioned record in every replica; an equal version never replaces it. The host
	// stores it with the holder of Player 2's seat, which only Player 2's own browser knows first-hand.
	const eastHolder = await players["2"].page.evaluate(() =>
		(window.ocHarness as Harness).holder(),
	);
	expect(await sendMedia(players["2"].page, 1, true)).toEqual({ ok: true });
	await expectMedia(pages, { "2": callStatus(1, true, eastHolder) });
	expect(await sendMedia(players["2"].page, 1, false)).toEqual({ ok: true });
	await expect
		.poll(
			async () =>
				(await view(players["2"].page))?.failures.map((failure) => [
					failure.status,
					failure.reason,
				]),
			{ timeout: CONNECT_MS },
		)
		.toEqual([["rejected", "a newer call status is stored"]]);
	expect(await sendMedia(players["2"].page, 2, false)).toEqual({ ok: true });
	await expectMedia(pages, { "2": callStatus(2, false, eastHolder) });

	// After a reload, Player 2 reads its call status from its own replica. Its own URL binds the seat again at the
	// generation that it holds, and its new inbox receives.
	await players["2"].page.reload();
	await players["2"].page.waitForFunction(() => window.ocHarness !== undefined);
	await openTable(players["2"].page, key, "2");
	await expectSeated(players["2"].page, "2", "1");
	await expectMedia([players["2"].page], {
		"2": callStatus(2, false, eastHolder),
	});
	const reopened = await callOpen(players["2"].page);
	expect(reopened.generation).toBe(gens["2"]);
	await expect
		.poll(() => callView(players["1"].page), { timeout: CONNECT_MS })
		.toEqual({
			self: { seat: "1", generation: gens["1"] },
			holders: { ...gens, "2": reopened.generation },
			online: others("1"),
		});
	const afterReload = await callSend(players["1"].page, "2");
	await expectArrivals(players["2"].page, afterReload, [["1", gens["1"]]]);
});

test("a page with another key never becomes a peer", async ({ browser }) => {
	const north = await newPlayer(browser);
	const key = await create(north, "1");
	await expectSeated(north.page, "1", "1");
	const stranger = await newPlayer(browser);
	await stranger.page.evaluate(
		(link) => (window.ocHarness as Harness).wrongKeyJoin(link),
		key,
	);
	await expect
		.poll(
			async () => {
				const table = await view(north.page);
				const other = await stranger.page.evaluate(() =>
					(window.ocHarness as Harness).strangerView(),
				);
				return (table?.network?.wrongKey ?? 0) + (other?.network.wrongKey ?? 0);
			},
			{ timeout: CONNECT_MS },
		)
		.toBeGreaterThanOrEqual(1);
	expect((await view(north.page))?.peers).toEqual([]);
	expect(
		(
			await stranger.page.evaluate(() =>
				(window.ocHarness as Harness).strangerView(),
			)
		)?.peers,
	).toBe(0);
});

test("the receive cap drops an oversize control message and the link keeps working", async ({
	browser,
}) => {
	const north = await newPlayer(browser);
	const key = await create(north, "1");
	await expectSeated(north.page, "1", "1");
	const sender = await newPlayer(browser);
	expect(
		await sender.page.evaluate(
			(link) => (window.ocHarness as Harness).oversizeThenPing(link),
			key,
		),
	).toBe(true);
	expect(
		(await view(north.page))?.network?.dropped.oversize,
	).toBeGreaterThanOrEqual(1);
});

test("a second tab cannot take a seat from an active same-browser tab", async ({
	browser,
}) => {
	const north = await newPlayer(browser);
	const key = await create(north, "1");
	await expectSeated(north.page, "1", "1");
	const east = await newPlayer(browser);
	await takeSeat(east.page, key, "2");

	const second = await openPage(east.context);
	await openTable(second, key);
	await expect
		.poll(async () => (await view(second))?.heldElsewhere, {
			timeout: CONNECT_MS,
		})
		.toEqual(["2"]);
	expect(
		await second.evaluate(() => (window.ocHarness as Harness).choose("2")),
	).toEqual({ ok: false, reason: "held-elsewhere" });
	await expectSeated(east.page, "2", "1");
	expect(await send(east.page, "still active")).toEqual({ ok: true });
	await expectSameLog(north.page, [east.page], 3);
});

test("a claim for a taken seat fails and the page stays a visitor", async ({
	browser,
}) => {
	const north = await newPlayer(browser);
	const key = await create(north, "1");
	await expectSeated(north.page, "1", "1");
	const east = await newPlayer(browser);
	await takeSeat(east.page, key, "2");

	const late = await newPlayer(browser);
	await openTable(late.page, key);
	await expect
		.poll(async () => (await view(late.page))?.lobby !== null, {
			timeout: CONNECT_MS,
		})
		.toBe(true);
	expect(await choose(late.page, "2")).toEqual({ ok: true });
	await expect
		.poll(async () => {
			const current = await view(late.page);
			return [current?.seatError, current?.seat, current?.lobby !== null];
		})
		.toEqual(["taken", null, true]);
	expect(await choose(late.page, "3")).toEqual({ ok: true });
	await expectSeated(late.page, "3", "1");
});
