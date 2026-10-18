// Layers 2 and 3 of the discovery probe: Trystero 0.26.0 in real Chrome, first two peers, then a table of four.
// Each peer is its own browser context, so it has its own page and its own Trystero `selfId`.
// The results (times, counts, states; no SDP and no addresses) go to probe-results/<date>.json.

import { mkdirSync, writeFileSync } from "node:fs";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

// `defaultRelayUrls` of @trystero-p2p/torrent 0.26.0, in its order. Trystero uses the first 3.
const TRACKERS = [
	"wss://open.ftorrent.com",
	"wss://tracker.webtorrent.dev",
	"wss://tracker.openwebtorrent.com",
	"wss://tracker.btorrent.xyz",
	"wss://tracker.files.fm:7073/announce",
];
const DEFAULTS = TRACKERS.slice(0, 3);
// The falsifier: two peers that do not find each other within this time count as "discovery failed".
const DISCOVERY_MS = 30_000;
const ECHO_MS = 5_000;
const TRIALS = Number(process.env.PROBE_TRIALS ?? 10);

const results: Record<string, unknown> = {
	date: new Date().toISOString(),
	trials: TRIALS,
};
const pageErrors: string[] = [];
const trysteroWarnings: Record<string, number> = {};

const random = (bytes: number): string =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");

type Peer = { context: BrowserContext; page: Page };

async function load(page: Page, block: string[]): Promise<void> {
	await page.waitForFunction(() => window.probe !== undefined);
	await page.evaluate((urls) => window.probe.block(urls), block);
}

async function openPeer(browser: Browser, block: string[] = []): Promise<Peer> {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		const text = message.text();
		if (/trystero/i.test(text))
			trysteroWarnings[text] = (trysteroWarnings[text] ?? 0) + 1;
	});
	await page.goto("/");
	await load(page, block);
	return { context, page };
}

const join = (
	page: Page,
	name: string,
	roomId: string,
	password: string,
	urls?: string[],
) =>
	page.evaluate(([n, r, p, u]) => window.probe.join(n, r, p, u), [
		name,
		roomId,
		password,
		urls,
	] as const);
const waitPeers = (
	page: Page,
	name: string,
	count: number,
	timeoutMs: number,
) =>
	page.evaluate(([n, c, t]) => window.probe.waitPeers(n, c, t), [
		name,
		count,
		timeoutMs,
	] as const);
const waitPeer = (
	page: Page,
	name: string,
	peerId: string,
	timeoutMs: number,
) =>
	page.evaluate(([n, id, t]) => window.probe.waitPeer(n, id, t), [
		name,
		peerId,
		timeoutMs,
	] as const);
const waitGone = (
	page: Page,
	name: string,
	peerId: string,
	timeoutMs: number,
) =>
	page.evaluate(([n, id, t]) => window.probe.waitGone(n, id, t), [
		name,
		peerId,
		timeoutMs,
	] as const);
const echoAll = (page: Page, name: string) =>
	page.evaluate(([n, t]) => window.probe.echoAll(n, t), [
		name,
		ECHO_MS,
	] as const);
const selfId = (page: Page) => page.evaluate(() => window.probe.selfId);
const relays = (page: Page) => page.evaluate(() => window.probe.relays());
const errors = (page: Page, name: string) =>
	page.evaluate((n) => window.probe.events(n).errors, name);

type Trial = {
	found: boolean;
	joinMs: number | null;
	echoMs: number | null;
	pingMs: number | null;
	relays: Record<string, number>;
	errors: string[];
};

/** Two fresh peers join one fresh room. They must find each other and exchange a nonce over the data channel. */
async function pairTrial(
	browser: Browser,
	urls?: string[],
	block: string[] = [],
): Promise<Trial> {
	const peers = [
		await openPeer(browser, block),
		await openPeer(browser, block),
	];
	const room = random(16);
	const password = random(32);
	try {
		for (const { page } of peers)
			await join(page, "pair", room, password, urls);
		const times = await Promise.all(
			peers.map(({ page }) => waitPeers(page, "pair", 1, DISCOVERY_MS)),
		);
		const found = times.every((ms) => ms !== null);
		const [first] = peers as [Peer, Peer];
		const echo = found ? await echoAll(first.page, "pair") : null;
		const pingMs = echo
			? await first.page.evaluate(() => window.probe.maxPing("pair"))
			: null;
		return {
			found: found && echo !== null,
			joinMs: found ? Math.max(...(times as number[])) : null,
			echoMs: echo?.maxMs ?? null,
			pingMs,
			relays: await relays(first.page),
			errors: (
				await Promise.all(peers.map(({ page }) => errors(page, "pair")))
			).flat(),
		};
	} finally {
		for (const { context } of peers) await context.close();
	}
}

const summarize = (trials: Trial[]) => {
	const joins = trials
		.flatMap((t) => (t.joinMs === null ? [] : [t.joinMs]))
		.sort((a, b) => a - b);
	const max = (key: "echoMs" | "pingMs") =>
		Math.max(0, ...trials.flatMap((t) => (t[key] === null ? [] : [t[key]])));
	return {
		found: `${trials.filter((t) => t.found).length}/${trials.length}`,
		medianJoinMs: joins[Math.floor(joins.length / 2)] ?? null,
		maxJoinMs: joins.at(-1) ?? null,
		maxEchoMs: max("echoMs"),
		maxPingMs: max("pingMs"),
	};
};

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
	results.trysteroConsole = trysteroWarnings;
	results.pageErrors = pageErrors;
	const dir = process.env.PROBE_OUT ?? "probe-results";
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		`${dir}/discovery-${String(results.date).replaceAll(":", "-")}.json`,
		JSON.stringify(results, null, "\t"),
	);
});

test("1 the page is a secure context and Trystero has the expected default trackers", async ({
	browser,
}) => {
	const peer = await openPeer(browser);
	const info = await peer.page.evaluate(() => ({
		secure: window.probe.secure,
		urls: window.probe.defaultRelayUrls,
	}));
	await peer.context.close();
	expect(info.secure).toBe(true);
	expect(info.urls).toEqual(TRACKERS);
});

test("2 the STUN server gives a server-reflexive candidate", async ({
	browser,
}) => {
	const peer = await openPeer(browser);
	const types = await peer.page.evaluate(() =>
		window.probe.candidateTypes(10_000),
	);
	await peer.context.close();
	results.candidateTypes = types;
	expect(types.srflx ?? 0).toBeGreaterThan(0);
});

test("3 two fresh peers find each other through the default trackers, in every trial", async ({
	browser,
}) => {
	const trials: Trial[] = [];
	for (let i = 0; i < TRIALS; i++) trials.push(await pairTrial(browser));
	results.defaultTrackers = { summary: summarize(trials), trials };
	expect(summarize(trials).found).toBe(`${TRIALS}/${TRIALS}`);
});

test("4 each tracker alone", async ({ browser }) => {
	const single: Record<string, unknown> = {};
	for (const url of TRACKERS) {
		const trials = [
			await pairTrial(browser, [url]),
			await pairTrial(browser, [url]),
		];
		single[url] = {
			...summarize(trials),
			socketStates: trials.map((t) => t.relays[url] ?? null),
		};
	}
	results.singleTracker = single;
	for (const url of DEFAULTS)
		expect((single[url] as { found: string }).found, url).toBe("2/2");
});

test("5 a wrong password finds no peer and reports a password error", async ({
	browser,
}) => {
	const peers = [await openPeer(browser), await openPeer(browser)];
	const room = random(16);
	for (const { page } of peers) await join(page, "pair", room, random(32));
	const times = await Promise.all(
		peers.map(({ page }) => waitPeers(page, "pair", 1, DISCOVERY_MS)),
	);
	const seen = (
		await Promise.all(peers.map(({ page }) => errors(page, "pair")))
	).flat();
	for (const { context } of peers) await context.close();
	results.wrongPassword = { times, errors: [...new Set(seen)] };
	expect(times).toEqual([null, null]);
	expect(seen.some((error) => /password/i.test(error))).toBe(true);
});

test("6 discovery with blocked trackers", async ({ browser }) => {
	const run = async (block: string[], count: number) => {
		const trials: Trial[] = [];
		for (let i = 0; i < count; i++)
			trials.push(await pairTrial(browser, undefined, block));
		return summarize(trials);
	};
	const blocked = {
		firstBlocked: await run(DEFAULTS.slice(0, 1), 3),
		firstTwoBlocked: await run(DEFAULTS.slice(0, 2), 3),
		allThreeBlocked: await run(DEFAULTS, 1),
	};
	results.blockedTrackers = blocked;
	expect(blocked.firstBlocked.found).toBe("3/3");
	expect(blocked.firstTwoBlocked.found).toBe("3/3");
	// The control: with all 3 blocked, Trystero does not fall back to trackers 4 and 5, so nothing is found.
	expect(blocked.allThreeBlocked.found).toBe("0/1");
});

test.describe("a table of four: the West host is in three pair rooms, each guest only in its own", () => {
	const table = random(16);
	const SEATS = ["N", "E", "S"] as const;
	type Seat = (typeof SEATS)[number];
	const secrets = { N: random(32), E: random(32), S: random(32) };
	const roomOf = (seat: Seat) => `${table}/game/${seat}`;
	const table4: Record<string, unknown> = {};
	let host: Peer;
	const guests = {} as Record<Seat, Peer>;

	const joinHost = async (page: Page) => {
		for (const seat of SEATS)
			await join(page, seat, roomOf(seat), secrets[seat]);
		await page.evaluate((names) => window.probe.host(names), [...SEATS]);
	};
	const hostEchoes = () =>
		Promise.all(SEATS.map((seat) => echoAll(host.page, seat)));

	test.beforeAll(async ({ browser }) => {
		host = await openPeer(browser);
		for (const seat of SEATS) guests[seat] = await openPeer(browser);
	});

	test.afterAll(async () => {
		results.table = table4;
		for (const peer of [host, ...Object.values(guests)])
			await peer?.context.close();
	});

	test("7 the host finds the three guests; a message and three replies give one transcript in all four", async () => {
		await joinHost(host.page);
		for (const seat of SEATS)
			await join(guests[seat].page, seat, roomOf(seat), secrets[seat]);
		const hostJoinMs = await Promise.all(
			SEATS.map((seat) => waitPeers(host.page, seat, 1, DISCOVERY_MS)),
		);
		const guestJoinMs = await Promise.all(
			SEATS.map((seat) => waitPeers(guests[seat].page, seat, 1, DISCOVERY_MS)),
		);
		expect([...hostJoinMs, ...guestJoinMs].every((ms) => ms !== null)).toBe(
			true,
		);
		const echoes = await hostEchoes();
		expect(echoes.every((echo) => echo?.peers === 1)).toBe(true);

		await host.page.evaluate(() => window.probe.hostSay("test message"));
		for (const seat of SEATS) {
			await guests[seat].page.waitForFunction(
				(n) => window.probe.lines(n).length >= 1,
				seat,
			);
			await guests[seat].page.evaluate(
				([n, text]) => window.probe.say(n, text),
				[seat, `reply from ${seat}`] as const,
			);
		}
		await host.page.waitForFunction(() => window.probe.lines("N").length >= 4);
		for (const seat of SEATS)
			await guests[seat].page.waitForFunction(
				(n) => window.probe.lines(n).length >= 4,
				seat,
			);
		const hostLines = await host.page.evaluate(() => window.probe.lines("N"));
		for (const seat of SEATS) {
			expect(
				await guests[seat].page.evaluate((n) => window.probe.lines(n), seat),
			).toEqual(hostLines);
		}
		expect(hostLines.map((line) => line.seq)).toEqual([1, 2, 3, 4]);
		expect(hostLines.map((line) => line.from).sort()).toEqual([
			"E",
			"N",
			"S",
			"host",
		]);
		table4.join = {
			hostJoinMs,
			guestJoinMs,
			echoMs: echoes.map((echo) => echo?.maxMs ?? null),
			// On one machine this is expected to be host/host: the probe does not test NAT traversal.
			pathTypes: await Promise.all(
				SEATS.map((seat) =>
					host.page.evaluate((n) => window.probe.pathTypes(n), seat),
				),
			),
		};
	});

	test("8 a guest that already shares a connection with the host enters another pair room with a wrong password", async () => {
		// A shared peer connection finds rooms by SHA-256("Trystero:appId:roomId"), without the password.
		// The first run falsified the prediction that the host's room E then admits North:
		// the overlapping-room challenge (handshake.mjs) checks the password. The test now pins that.
		const north = await selfId(guests.N.page);
		const hostId = await selfId(host.page);
		await join(guests.N.page, "intrude", roomOf("E"), random(32));
		const hostSeesNorthInE = await waitPeer(
			host.page,
			"E",
			north,
			DISCOVERY_MS,
		);
		const northSeesHost = await waitPeer(
			guests.N.page,
			"intrude",
			hostId,
			2_000,
		);
		let forgedAsEast = false;
		if (northSeesHost !== null) {
			await guests.N.page.evaluate(() =>
				window.probe.say("intrude", "forged by North"),
			);
			forgedAsEast = await host.page
				.waitForFunction(
					() =>
						window.probe
							.lines("N")
							.some(
								(line) => line.from === "E" && line.text === "forged by North",
							),
					undefined,
					{ timeout: ECHO_MS },
				)
				.then(
					() => true,
					() => false,
				);
		}
		table4.sharedPeer = {
			hostSeesNorthInEastRoomMs: hostSeesNorthInE,
			northSeesHostMs: northSeesHost,
			forgedAsEast,
			northErrors: await errors(guests.N.page, "intrude"),
			hostErrorsInEastRoom: await errors(host.page, "E"),
		};
		await guests.N.page.evaluate(() => window.probe.leave("intrude"));
		expect(hostSeesNorthInE).toBeNull();
		expect(forgedAsEast).toBe(false);
	});

	test("9 a guest reload: the host finds the new guest page and drops the old one", async () => {
		const oldEast = await selfId(guests.E.page);
		const t0 = Date.now();
		await guests.E.page.reload();
		await load(guests.E.page, []);
		await join(guests.E.page, "E", roomOf("E"), secrets.E);
		const newEast = await selfId(guests.E.page);
		const found = await waitPeer(host.page, "E", newEast, DISCOVERY_MS);
		const reloadToLinkMs = Date.now() - t0;
		const echo = await echoAll(guests.E.page, "E");
		const oldGoneMs = await waitGone(host.page, "E", oldEast, 60_000);
		table4.guestReload = {
			found,
			reloadToLinkMs,
			echoMs: echo?.maxMs ?? null,
			oldGoneAfterLinkMs: oldGoneMs,
		};
		expect(found).not.toBeNull();
		expect(echo?.peers).toBe(1);
	});

	test("10 a host reload: all three guests find the new host page", async () => {
		const oldHost = await selfId(host.page);
		const t0 = Date.now();
		await host.page.reload();
		await load(host.page, []);
		await joinHost(host.page);
		const newHost = await selfId(host.page);
		const found = await Promise.all(
			SEATS.map((seat) =>
				waitPeer(guests[seat].page, seat, newHost, DISCOVERY_MS),
			),
		);
		const reloadToLinksMs = Date.now() - t0;
		const echoes = await hostEchoes();
		const oldGoneMs = await Promise.all(
			SEATS.map((seat) => waitGone(guests[seat].page, seat, oldHost, 60_000)),
		);
		table4.hostReload = {
			found,
			reloadToLinksMs,
			echoMs: echoes.map((echo) => echo?.maxMs ?? null),
			oldGoneAfterLinksMs: oldGoneMs,
		};
		expect(found.every((ms) => ms !== null)).toBe(true);
		expect(echoes.every((echo) => echo?.peers === 1)).toBe(true);
	});

	test("11 the trackers go away after connection: the links stay, a reloaded guest waits, then recovers", async () => {
		const everyone = [host, ...SEATS.map((seat) => guests[seat])];
		for (const { page } of everyone) {
			await page.evaluate((urls) => window.probe.block(urls), TRACKERS);
			await page.evaluate(() => window.probe.dropRelays());
		}
		await host.page.waitForTimeout(3_000);
		const states = await relays(host.page);
		const echoes = await hostEchoes();

		await guests.S.page.reload();
		await load(guests.S.page, TRACKERS);
		await join(guests.S.page, "S", roomOf("S"), secrets.S);
		const south = await selfId(guests.S.page);
		const whileBlocked = await waitPeer(host.page, "S", south, 20_000);

		for (const { page } of everyone)
			await page.evaluate(() => window.probe.block([]));
		const afterUnblock = await waitPeer(host.page, "S", south, 150_000);
		table4.trackersLost = {
			hostSocketStates: states,
			echoMsWithoutTrackers: echoes.map((echo) => echo?.maxMs ?? null),
			reloadedGuestFoundWhileBlocked: whileBlocked,
			reloadedGuestFoundAfterUnblockMs: afterUnblock,
		};
		expect(Object.values(states).every((state) => state !== 1)).toBe(true);
		expect(echoes.every((echo) => echo?.peers === 1)).toBe(true);
		expect(whileBlocked).toBeNull();
		expect(afterUnblock).not.toBeNull();
	});
});

test("12 no page had an uncaught error", () => {
	expect(pageErrors).toEqual([]);
});
