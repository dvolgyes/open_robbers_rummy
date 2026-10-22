import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legalActions } from "../../src/canasta";
import {
	actionPayload,
	createCanastaModule,
	engineSeat,
	parseCanastaState,
	startPayload,
} from "../../src/game/canasta";
import {
	type ElectionEffect,
	type ElectionEvent,
	type ElectionState,
	initElection,
	type SelfFacts,
	stepElection,
} from "../../src/p2p/election";
import { deriveHolder, makeTag } from "../../src/p2p/keys";
import { TICK_MS } from "../../src/p2p/limits";
import { creationCommit, LocalLog, openLog } from "../../src/p2p/log";
import {
	Replication,
	type ReplicationEvent,
	type Seated,
} from "../../src/p2p/replication";
import type { Entry } from "../../src/p2p/wire";
import type { JsonObject, Seat } from "../../src/protocol";
import { randomBelowFrom } from "../../src/random";
import {
	type Endpoint,
	FakeMesh,
	peerId,
	syncDigest,
	TestStorage,
} from "./fake-mesh";
import { CONFIG, commandId, TABLE } from "./p2p-fixtures";

/**
 * Plan §8, P5: four pages play a hand over the fake mesh with the real election, replication and canasta rules.
 * The host crashes during the play; another page becomes the host after the absence timeout and the hand goes
 * on; the old host reopens on its stored replica, takes its seat back, and the hand finishes. Every message
 * passes the wire validators, so a malformed one fails the run.
 */

const CLIENTS: Readonly<Record<Seat, string>> = {
	N: "clientN-0123456789abcd",
	E: "clientE-0123456789abcd",
	S: "clientS-0123456789abcd",
	W: "clientW-0123456789abcd",
};

function xorshift(seed: number): () => number {
	let x = seed >>> 0 || 1;
	return () => {
		x = (x ^ (x << 13)) >>> 0;
		x = (x ^ (x >>> 17)) >>> 0;
		x = (x ^ (x << 5)) >>> 0;
		return x;
	};
}

/** One browser: its seat, its identity and its storage, which outlive its pages. */
interface Browser {
	readonly seat: Seat;
	readonly holder: string;
	readonly storage: TestStorage;
	page: SimPage | null;
}

interface SimPage {
	readonly peer: string;
	readonly browser: Browser;
	readonly replication: Replication;
	readonly events: ReplicationEvent[];
	election: ElectionState;
	alive: boolean;
	writable: boolean;
}

class Sim {
	readonly mesh = new FakeMesh(TABLE);
	readonly browsers = new Map<Seat, Browser>();
	readonly #random: () => number;
	readonly #seed: number;
	#ids = 0;

	constructor(seed: number) {
		this.#seed = seed;
		this.#random = xorshift(seed);
	}

	get pages(): SimPage[] {
		return [...this.browsers.values()].flatMap((browser) =>
			browser.page?.alive ? [browser.page] : [],
		);
	}

	page(seat: Seat): SimPage {
		const page = this.browsers.get(seat)?.page;
		if (!page) throw new Error(`no page at ${seat}`);
		return page;
	}

	async browser(seat: Seat): Promise<Browser> {
		const browser: Browser = {
			seat,
			holder: await deriveHolder(TABLE, CLIENTS[seat]),
			storage: new TestStorage(),
			page: null,
		};
		this.browsers.set(seat, browser);
		return browser;
	}

	/** The creator at N writes term 1 and hosts it at once. */
	async create(): Promise<SimPage> {
		const browser = await this.browser("N");
		const log = new LocalLog(browser.storage, TABLE, "N");
		const auth = { term: 1, tag: makeTag(browser.holder, "N"), inc: 1 };
		const module = this.#module();
		const written = await log.write(() =>
			creationCommit({
				tableId: TABLE,
				seat: "N",
				holder: browser.holder,
				config: CONFIG,
				state: module.initialState(TABLE, CONFIG),
				auth,
				id: this.#newId(),
				now: this.mesh.clock.wall(),
			}),
		);
		if (!written.ok) throw new Error(written.detail);
		return this.#open(browser, "north", { log, outbox: [] }, true);
	}

	/** A visitor opens the link and chooses `seat`: it holds the seat lock and opens its partition. */
	async visit(seat: Seat, name: string): Promise<SimPage> {
		const browser = await this.browser(seat);
		const page = this.#open(browser, name, null, false);
		const opened = await openLog(browser.storage, TABLE, seat);
		if (!opened.ok) throw new Error(opened.detail);
		page.replication.choose(opened.value);
		this.#watch(page, opened.value.log);
		return page;
	}

	/** A crashed browser opens the link again: a new page on the same storage. */
	async reopen(seat: Seat, name: string): Promise<SimPage> {
		const browser = this.browsers.get(seat);
		if (!browser) throw new Error(`no browser at ${seat}`);
		const opened = await openLog(browser.storage, TABLE, seat);
		if (!opened.ok) throw new Error(opened.detail);
		const page = this.#open(browser, name, opened.value, false);
		for (const other of this.pages) this.mesh.connect(page.peer, other.peer);
		return page;
	}

	/** The page dies without a word; its storage stays. */
	crash(seat: Seat): void {
		const page = this.page(seat);
		page.alive = false;
		this.mesh.remove(page.peer);
	}

	#open(
		browser: Browser,
		name: string,
		seated: Seated | null,
		creator: boolean,
	): SimPage {
		const peer = peerId(name);
		const events: ReplicationEvent[] = [];
		let page: SimPage | null = null;
		const replication = new Replication(
			{
				tableId: TABLE,
				client: CLIENTS[browser.seat],
				self: peer,
				storage: browser.storage,
				send: this.mesh.send(peer),
				clock: this.mesh.clock,
				module: this.#module(),
				newId: () => this.#newId(),
				onEvent: (event) => {
					events.push(event);
					if (page) this.#replicationEvent(page, event);
				},
			},
			seated,
		);
		const now = this.mesh.clock.monotonic();
		const init = initElection({
			now,
			self: this.#facts(browser, replication.log, true),
			creator,
		});
		page = {
			peer,
			browser,
			replication,
			events,
			election: init.state,
			alive: true,
			writable: true,
		};
		browser.page = page;
		const self = page;
		const endpoint: Endpoint = {
			// As in the table controller: a beat goes to the election, and to the host engine, which counts it
			// as presence.
			receiveCtl: (from, message) => {
				if (message.k === "beat")
					this.#step(self, {
						type: "beat",
						now: this.mesh.clock.monotonic(),
						peer: from,
						beat: message,
					});
				self.replication.receiveCtl(from, message);
			},
			receiveLog: (from, message) => self.replication.receiveLog(from, message),
			join: (other) => {
				this.#step(self, {
					type: "join",
					now: this.mesh.clock.monotonic(),
					peer: other,
				});
				self.replication.join(other);
			},
			leave: (other) => {
				this.#step(self, {
					type: "leave",
					now: this.mesh.clock.monotonic(),
					peer: other,
				});
				self.replication.leave(other);
			},
		};
		this.mesh.add(peer, endpoint);
		this.#effects(page, init.effects);
		this.#step(page, { type: "network", now, online: true });
		if (seated) this.#watch(page, seated.log);
		this.mesh.every(peer, TICK_MS, () => {
			this.#step(self, { type: "tick", now: this.mesh.clock.monotonic() });
			self.replication.tick();
			this.#play(self);
		});
		return page;
	}

	#module() {
		return createCanastaModule(randomBelowFrom(xorshift(this.#seed + 7)));
	}

	#newId(): string {
		return commandId(++this.#ids);
	}

	#facts(browser: Browser, log: LocalLog | null, writable: boolean): SelfFacts {
		if (!log) return { holder: browser.holder, seating: null };
		const table = log.table;
		const row = table?.seats.find((seat) => seat.seat === browser.seat);
		return {
			holder: browser.holder,
			seating: {
				seat: browser.seat,
				pos: log.position(),
				host: table?.host ?? null,
				inc: table?.inc ?? 0,
				bound: row?.holder === browser.holder,
				persistent: browser.storage.persistent,
				writable,
			},
		};
	}

	/** The election sees each change of the replica, as the controller's log listener reports it. */
	#watch(page: SimPage, log: LocalLog): void {
		log.subscribe(() => queueMicrotask(() => this.#refresh(page)));
		queueMicrotask(() => this.#refresh(page));
	}

	#refresh(page: SimPage): void {
		this.#step(page, {
			type: "self",
			now: this.mesh.clock.monotonic(),
			self: this.#facts(page.browser, page.replication.log, page.writable),
		});
	}

	#step(page: SimPage, event: ElectionEvent): void {
		if (!page.alive) return;
		const next = stepElection(page.election, event);
		page.election = next.state;
		this.#effects(page, next.effects);
	}

	#effects(page: SimPage, effects: readonly ElectionEffect[]): void {
		for (const effect of effects) {
			if (!page.alive) return;
			if (effect.type === "beat")
				this.mesh.send(page.peer).ctl(effect.to, effect.beat);
			else page.replication.apply(effect);
		}
	}

	#replicationEvent(page: SimPage, event: ReplicationEvent): void {
		queueMicrotask(() => {
			const now = this.mesh.clock.monotonic();
			if (event.type === "pulled")
				this.#step(page, { type: "pulled", now, auth: event.auth });
			else if (event.type === "stored")
				this.#step(page, {
					type: "stored",
					now,
					auth: event.auth,
					ok: event.ok,
				});
			else if (event.type === "storage") {
				page.writable = false;
				this.#refresh(page);
			}
		});
	}

	/** One move when it is this page's turn: the host starts the match; then the seat to act picks a random legal action. */
	#play(page: SimPage): void {
		const command = this.#choose(page);
		if (!command) return;
		void page.replication.submit(command).then((result) => {
			if (!result.ok) throw new Error(`submit failed: ${result.code}`);
		});
	}

	#choose(page: SimPage): JsonObject | null {
		const { replication } = page;
		const table = replication.log?.table;
		if (!page.alive || !table || page.election.mode.kind === "superseded")
			return null;
		if (!replication.engine && !replication.follower.ready) return null;
		if ((replication.outbox?.items.length ?? 1) > 0) return null;
		const state = parseCanastaState(table.state, TABLE);
		if (!state) throw new Error("the table state is not a canasta table");
		const seat = page.browser.seat;
		if (!state.match)
			return page.election.mode.kind === "hosting" ? startPayload(TABLE) : null;
		const { match } = state;
		if (match.settled) return null;
		const actions = legalActions(match.hand, engineSeat(seat));
		if (actions.length === 0) return null;
		const action = actions[this.#random() % actions.length];
		if (!action) throw new Error(`no action for ${seat}`);
		return actionPayload(TABLE, match, state.actions, action);
	}
}

/** Every card of the deck: in hands, the stock, the pile, the melds and the set-aside red threes. */
function cardsIn(state: JsonObject): number {
	const hand = parseCanastaState(state, TABLE)?.match?.hand;
	if (!hand) return 0;
	const onTable = hand.teams.flatMap((team) => [
		...team.melds.flatMap((meld) => meld.cards),
		...team.redThrees,
	]);
	return (
		hand.hands.flat().length +
		hand.stock.length +
		hand.pile.length +
		onTable.length
	);
}

/** An entry without its place in the log. */
function command(entry: Entry | undefined) {
	if (!entry) return undefined;
	const { seq: _seq, auth: _auth, prevAuth: _prevAuth, ...rest } = entry;
	return rest;
}

/** A command without its place in the log, also in its event. */
function placeless(entry: Entry | undefined) {
	const rest = command(entry);
	if (!rest) return undefined;
	const { seq: _seq, ...event } = rest.event;
	return { ...rest, event };
}

function finished(page: SimPage): boolean {
	const state = page.replication.log?.table?.state;
	return state
		? parseCanastaState(state, TABLE)?.match?.settled === true
		: false;
}

let restoreDigest: () => void;
beforeEach(() => {
	restoreDigest = syncDigest();
});
afterEach(() => restoreDigest());

interface Scenario {
	/** The entry whose broadcast the crash follows: the first one after 20 cards from N itself, or from another seat. */
	readonly from: "N" | "other";
	/** 11 ms lets the entry arrive (the mesh delay is 10 ms); 0 ms loses it with the host. */
	readonly crashDelay: number;
	readonly seed: number;
}

describe("four pages play a board across a host crash", () => {
	it("routes autoplay through the followed host and correlates its reply", async () => {
		const sim = new Sim(41);
		const north = await sim.create();
		const east = await sim.visit("E", "eastauto");
		sim.mesh.connectAll();
		await sim.mesh.until(() => east.replication.follower.ready, 10_000);
		const handled: { seat: Seat; enabled: boolean }[] = [];
		north.replication.setAutoplayHandler(async (seat, enabled) => {
			handled.push({ seat, enabled });
			return "enabled";
		});
		let result: string | null = null;
		void east.replication.requestAutoplay(true).then((status) => {
			result = status;
		});
		await sim.mesh.until(() => result !== null, 10_000);
		expect(handled).toEqual([{ seat: "E", enabled: true }]);
		expect(result).toBe("enabled");
	});

	it.each<Scenario>([
		{ from: "other", crashDelay: 11, seed: 1 },
		{ from: "N", crashDelay: 11, seed: 2 },
		{ from: "other", crashDelay: 0, seed: 3 },
		{ from: "other", crashDelay: 0, seed: 4 },
		{ from: "N", crashDelay: 0, seed: 5 },
		{ from: "N", crashDelay: 0, seed: 6 },
	])(
		"the host crashes $crashDelay ms after an entry from $from (seed $seed)",
		async ({ from, crashDelay, seed }) => {
			const sim = new Sim(seed);
			const north = await sim.create();
			await sim.visit("E", "east");
			await sim.visit("S", "south");
			await sim.visit("W", "west");
			sim.mesh.connectAll();

			let lost = null as Entry | null;
			sim.mesh.tap = (sender, _to, message) => {
				if (lost || sender !== north.peer || message.k !== "entry") return;
				if (
					cardsIn(message.state) < 20 ||
					(message.e.seat === "N") !== (from === "N")
				)
					return;
				lost = message.e;
				sim.mesh.after(crashDelay, () => sim.crash("N"));
			};
			await sim.mesh.until(() => lost !== null && !north.alive, 120_000);
			const crashed = lost;
			if (!crashed) throw new Error("the host did not crash");
			expect(sim.pages.map((page) => page.browser.seat)).toEqual([
				"E",
				"S",
				"W",
			]);

			await sim.mesh.until(
				() =>
					sim.pages.some(
						(page) =>
							page.election.mode.kind === "hosting" &&
							page.election.mode.auth.term === 2,
					),
				60_000,
			);
			const reopened = await sim.reopen("N", "north2");
			await sim.mesh.until(() => {
				const pages = sim.pages;
				if (pages.length !== 4 || !pages.every(finished)) return false;
				const [first, ...rest] = pages.map((page) => page.replication.log);
				return rest.every(
					(log) =>
						log?.position().rev === first?.position().rev &&
						log?.entries.length === first?.entries.length,
				);
			}, 300_000);

			const pages = sim.pages;
			const hosts = pages.filter(
				(page) => page.election.mode.kind === "hosting",
			);
			expect(hosts).toHaveLength(1);
			expect(hosts[0]?.browser.seat).not.toBe("N");
			expect(reopened.replication.follower.ready).toBe(true);
			const ownRow = reopened.replication.log?.table?.seats.find(
				(row) => row.seat === "N",
			);
			expect(ownRow?.gen).toBe(1);

			const [reference, ...others] = pages.map((page) => page.replication.log);
			if (!reference?.table) throw new Error("no reference log");
			for (const log of others) {
				expect(log?.entries).toEqual(reference.entries);
				expect(log?.table?.state).toEqual(reference.table.state);
			}
			const ids = reference.entries.map((entry) => entry.id);
			expect(new Set(ids).size).toBe(ids.length);
			const state = parseCanastaState(reference.table.state, TABLE);
			expect(state?.match?.settled).toBe(true);
			expect(cardsIn(reference.table.state)).toBe(108);
			expect(reference.entries.some((entry) => entry.auth.term === 2)).toBe(
				true,
			);

			// An entry that arrived stays; a lost one is replaced. Another seat's command comes back from its outbox
			// to the new host; the old host's own command exists nowhere else, so its page shows it as undone.
			const atCrash = reference.entries[crashed.seq - 1];
			const undone = pages.flatMap((page) =>
				page.events.flatMap((event) =>
					event.type === "undone"
						? [[page.browser.seat, event.entries.map((entry) => entry.id)]]
						: [],
				),
			);
			if (crashDelay > 0) {
				expect(atCrash).toEqual(crashed);
				expect(undone).toEqual([]);
			} else {
				expect(atCrash?.auth.term).toBe(2);
				const resent = reference.entries.find(
					(entry) => entry.id === crashed.id,
				);
				if (from === "N") {
					expect(resent).toBeUndefined();
					expect(undone).toEqual([["N", [crashed.id]]]);
				} else {
					// R4: every canasta action needs all four seats, so the new host keeps the action waiting until North is
					// back. Rebinding the same holder and generation adds no seat entry; the delayed action takes the next
					// log position.
					const back = reference.entries.find(
						(entry) =>
							entry.kind === "seat" && entry.seat === "N" && entry.gen === 2,
					);
					expect(resent?.auth.term).toBe(2);
					expect(back).toBeUndefined();
					expect(resent?.seq).toBe(crashed.seq);
					expect(placeless(resent)).toEqual(placeless(crashed));
					expect(undone).toEqual([]);
				}
			}

			for (const page of pages) {
				expect(
					page.events.filter((event) => event.type === "host-stopped"),
				).toEqual([]);
				expect(
					page.events.filter((event) => event.type === "failed"),
					`${page.browser.seat} had failed commands`,
				).toEqual([]);
			}
		},
		// The limits of the run are in virtual time (`until`). This wall-time budget only allows for a busy CPU,
		// where one run takes from 1 s to 8 s.
		60_000,
	);
});
