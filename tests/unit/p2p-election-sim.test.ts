import { describe, expect, it } from "vitest";
import {
	type Authority,
	compareAuthority,
	comparePosition,
	EMPTY_POSITION,
	type Position,
	sameAuthority,
} from "../../src/p2p/authority";
import {
	type ElectionEffect,
	type ElectionEvent,
	type ElectionState,
	electionView,
	followedHost,
	initElection,
	type Seating,
	type SelfFacts,
	stepElection,
} from "../../src/p2p/election";
import { makeTag } from "../../src/p2p/keys";
import {
	BEAT_MS,
	CLAIM_PULL_MS,
	CTL_PER_SECOND,
	HOST_LOST_MS,
	STAGGER_MS,
	TICK_MS,
	VOLUNTEER_MS,
} from "../../src/p2p/limits";
import { type Beat, frame, parseCtl } from "../../src/p2p/wire";
import { SEATS, type Seat } from "../../src/protocol";
import { TABLE } from "./p2p-fixtures";

/**
 * Seeded simulation of the host election (plan §8, P4). 4–6 browsers share one table: four hold the seats, the
 * others are visitors. A noisy phase brings link loss, partitions, freezes, clicks, reloads and tab duplicates; a
 * quiet phase then keeps the links fixed, and in half of the seeds every host closes as it starts. The simulation
 * plays the controllers: it delivers beats with delays, runs
 * the claim pull and the store, and keeps one replica per browser. It checks these invariants:
 *
 * (a) a claim of a new term has a witness: a beat from another browser in the last HOST_LOST_MS;
 * (b) the authorities that a page follows never get worse, nor those of a browser with a persistent replica;
 * (c) in the quiet phase, two hosts in one group of diameter ≤ 2 overlap for at most OVERLAP_MS;
 * (d) such a group with an eligible page and a witness has a host from LIVE_MS after the quiet phase starts;
 * (e) at the end, that group has one host, and every other page in it follows the host or knows of it;
 * (f) no two pages host the same authority;
 * (g) a page hosts, and appends entries, only as the authority that its replica stores;
 * (h) a page follows only a peer that hosted that authority;
 * (i) a page sends at most CTL_PER_SECOND beats in one second, the receive rate limit; a storm ends the run;
 *
 * and every beat passes the wire validator. A violation names its seed, so the run replays.
 */

const SEEDS = 500;
const MIN_DELAY_MS = 5;
const MAX_DELAY_MS = 150;
const TICK_JITTER_MS = 100;
const STORE_MS = 5;
/** Only in the noisy phase; a failed write makes the page ineligible until it reloads. */
const STORE_FAILURE = 0.02;
const APPEND_CHANCE = 0.25;
const CHECK_MS = 250;

type Range = readonly [number, number];
const LOAD_MS: Range = [500, 3_000];
const DUPLICATE_MS: Range = [300, 1_500];
const ONLINE_MS: Range = [100, 300];
const CONNECT_MS: Range = [300, 900];
const LEAVE_MS: Range = [200, 4_000];
const PULL_MS: Range = [20, 400];
const START_MS: Range = [200, 5_000];
const NOISY_MS: Range = [60_000, 120_000];
const DISTURB_MS: Range = [1_000, 5_000];
const OUTAGE_MS: Range = [2_000, 30_000];
const PARTITION_MS: Range = [8_000, 45_000];
const FREEZE_MS: Range = [5_000, 40_000];

/** A page that loads or connects as the quiet phase starts is in the mesh by then. */
const SETTLE_MS = LOAD_MS[1] + CONNECT_MS[1] + 100;
/** Two beat periods and two deliveries: from one host through a shared neighbour to the other host. */
const OVERLAP_MS = 2 * (BEAT_MS + TICK_MS + TICK_JITTER_MS + MAX_DELAY_MS);

/** Two ticks of the absence clock, the store, and two deliveries: the claim beat and the host beat. */
const SLACK_MS = 2 * (TICK_MS + TICK_JITTER_MS) + STORE_MS + 2 * MAX_DELAY_MS;
/**
 * Evidence of an old host expires, the absence clock reaches the volunteer time of the last of the three other
 * seats, and the claim pull ends.
 */
const LIVE_MS =
	SETTLE_MS +
	HOST_LOST_MS +
	VOLUNTEER_MS +
	STAGGER_MS * (SEATS.length - 1) +
	CLAIM_PULL_MS +
	SLACK_MS;

const HOLDER_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

interface Stats {
	/** Claims of a new term, by a click or by the automatic volunteer. */
	claims: number;
	resumes: number;
	clickClaims: number;
	hosts: number;
	stepDowns: number;
	storeFailures: number;
	pulls: number;
	reloads: number;
	duplicates: number;
	freezes: number;
	partitions: number;
	/** Hosts that close for good as the quiet phase starts, so that the others must elect. */
	hostCrashes: number;
	/** Claims of a new term in the quiet phase. */
	quietClaims: number;
	/** Pairs of hosts seen together in one group of diameter ≤ 2 in the quiet phase. */
	quietOverlaps: number;
	/** Groups at the end with diameter 2 that must have a host. */
	twoHopGroups: number;
}

function emptyStats(): Stats {
	return {
		claims: 0,
		resumes: 0,
		clickClaims: 0,
		hosts: 0,
		stepDowns: 0,
		storeFailures: 0,
		pulls: 0,
		reloads: 0,
		duplicates: 0,
		freezes: 0,
		partitions: 0,
		hostCrashes: 0,
		quietClaims: 0,
		quietOverlaps: 0,
		twoHopGroups: 0,
	};
}

interface Replica {
	pos: Position;
	host: Authority | null;
	inc: number;
}

interface Browser {
	readonly index: number;
	readonly holder: string;
	/** Null for a visitor. */
	readonly seat: Seat | null;
	/** False for a memory replica, which a reload loses. */
	readonly persistent: boolean;
	replica: Replica | null;
	/** The open page; null while a reload is under way. */
	page: Page | null;
	/** The best authority that a page of this browser followed. */
	followed: Authority | null;
}

interface Page {
	/** The Trystero peer id: new on every page load. */
	readonly id: string;
	readonly browser: Browser;
	state: ElectionState;
	alive: boolean;
	frozen: boolean;
	freezes: number;
	ticks: number;
	/** Work that arrived while the page was frozen; it runs in order when the page thaws. */
	queue: (() => void)[];
	writable: boolean;
	readonly connected: Set<Page>;
	/** When this page last received a beat from another browser. */
	witnessAt: number | null;
	followed: Authority | null;
	claimed: Authority | null;
	/** The beats that this page sent in the current second of simulated time. */
	second: number;
	sent: number;
}

interface Group {
	readonly key: string;
	readonly pages: readonly Page[];
	/** 3 stands for any diameter above 2. */
	readonly diameter: number;
}

interface Outage {
	readonly pairs: readonly (readonly [Browser, Browser])[];
	active: boolean;
}

interface Job {
	readonly at: number;
	readonly order: number;
	readonly run: () => void;
}

/** A binary heap of jobs by time; jobs at the same time run in the order they were added. */
class Agenda {
	readonly #heap: Job[] = [];
	#order = 0;

	add(at: number, run: () => void): void {
		const heap = this.#heap;
		heap.push({ at, order: this.#order++, run });
		let i = heap.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (!earlier(heap[i], heap[parent])) break;
			swap(heap, i, parent);
			i = parent;
		}
	}

	/** The next job at or before `until`, removed from the heap. */
	next(until: number): Job | undefined {
		const heap = this.#heap;
		const top = heap[0];
		if (top === undefined || top.at > until) return undefined;
		const last = heap.pop();
		if (last === undefined || heap.length === 0) return top;
		heap[0] = last;
		let i = 0;
		while (true) {
			const left = 2 * i + 1;
			let least = i;
			if (earlier(heap[left], heap[least])) least = left;
			if (earlier(heap[left + 1], heap[least])) least = left + 1;
			if (least === i) return top;
			swap(heap, i, least);
			i = least;
		}
	}
}

function earlier(a: Job | undefined, b: Job | undefined): boolean {
	if (a === undefined || b === undefined) return false;
	return a.at < b.at || (a.at === b.at && a.order < b.order);
}

function swap<T>(items: T[], i: number, j: number): void {
	const a = items[i];
	const b = items[j];
	if (a === undefined || b === undefined) return;
	items[i] = b;
	items[j] = a;
}

/** mulberry32: a small seeded generator, so that a seed replays the same run. */
function generator(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		swap(out, i, Math.floor(random() * (i + 1)));
	}
	return out;
}

function randomHolder(random: () => number): string {
	let holder = "";
	for (let i = 0; i < 16; i++) {
		holder += HOLDER_ALPHABET.charAt(Math.floor(random() * 64));
	}
	return holder;
}

function selfFacts(browser: Browser, writable: boolean): SelfFacts {
	const { seat, replica } = browser;
	const seating: Seating | null =
		seat === null || replica === null
			? null
			: {
					seat,
					pos: replica.pos,
					host: replica.host,
					inc: replica.inc,
					bound: true,
					persistent: browser.persistent,
					writable,
				};
	return { holder: browser.holder, seating };
}

function termKey(auth: Authority): string {
	return `${auth.term}/${auth.tag}`;
}

function authKey(auth: Authority): string {
	return `${auth.term}/${auth.tag}/${auth.inc}`;
}

function pairKey(a: Browser, b: Browser): string {
	return a.index < b.index ? `${a.index}-${b.index}` : `${b.index}-${a.index}`;
}

function isHosting(page: Page): boolean {
	return page.state.mode.kind === "hosting";
}

function isEligible(page: Page): boolean {
	return page.browser.seat !== null && page.browser.persistent && page.writable;
}

function diameterOf(
	pages: readonly Page[],
	edge: (a: Page, b: Page) => boolean,
): number {
	let diameter = 0;
	for (const a of pages) {
		for (const b of pages) {
			if (a === b) continue;
			if (edge(a, b)) {
				diameter = Math.max(diameter, 1);
			} else if (pages.some((c) => edge(a, c) && edge(c, b))) {
				diameter = 2;
			} else {
				return 3;
			}
		}
	}
	return diameter;
}

class World {
	readonly violations: string[] = [];
	readonly #seed: number;
	readonly #stats: Stats;
	readonly #random: () => number;
	readonly #agenda = new Agenda();
	readonly #browsers: Browser[] = [];
	/** Outages per browser pair; a link is up when its count is 0. */
	readonly #down = new Map<string, number>();
	readonly #outages: Outage[] = [];
	/** The last delivery time per directed page pair: a data channel keeps order. */
	readonly #fifo = new Map<string, number>();
	readonly #hostedBy = new Map<string, string>();
	readonly #claimedTerms = new Set<string>();
	readonly #overlaps = new Map<string, number>();
	readonly #reported = new Set<string>();
	readonly #hostless = new Map<string, number>();
	#now = 0;
	#pages = 0;
	#quiet = false;
	#quietAt = 0;
	#endAt = 0;
	/** A beat storm ends the run, whose later state proves nothing. */
	#stopped = false;

	constructor(seed: number, stats: Stats) {
		this.#seed = seed;
		this.#stats = stats;
		this.#random = generator(seed);
	}

	run(): void {
		const size = 4 + this.#int(3);
		const seats = shuffled(SEATS, this.#random);
		const weak = this.#random() < 0.3 ? 1 + this.#int(3) : -1;
		const holders = new Set<string>();
		for (let index = 0; index < size; index++) {
			let holder = randomHolder(this.#random);
			while (holders.has(holder)) holder = randomHolder(this.#random);
			holders.add(holder);
			this.#browsers.push({
				index,
				holder,
				seat: seats[index] ?? null,
				persistent: index !== weak,
				replica: null,
				page: null,
				followed: null,
			});
		}
		const creator = this.#browser(0);
		if (creator.seat === null) throw new Error("the creator needs a seat");
		const first: Authority = {
			term: 1,
			tag: makeTag(creator.holder, creator.seat),
			inc: 1,
		};
		for (const browser of this.#browsers) {
			if (browser.seat === null) continue;
			browser.replica = {
				pos: { rev: 1, lastAuth: first },
				host: first,
				inc: browser === creator ? 1 : 0,
			};
		}
		this.#claimedTerms.add(termKey(first));
		this.#open(creator, true);
		for (const browser of this.#browsers) {
			if (browser === creator) continue;
			this.#after(this.#between(...START_MS), () => this.#open(browser, false));
		}
		this.#quietAt = this.#between(...NOISY_MS);
		this.#endAt = this.#quietAt + LIVE_MS + 5_000;
		this.#after(START_MS[1], () => this.#disturb());
		this.#after(this.#quietAt, () => this.#beginQuiet());
		while (!this.#stopped) {
			const job = this.#agenda.next(this.#endAt);
			if (job === undefined) break;
			this.#now = job.at;
			job.run();
		}
		if (this.#stopped) return;
		this.#now = this.#endAt;
		this.#finish();
	}

	#open(browser: Browser, creator: boolean): void {
		const init = initElection({
			now: this.#now,
			self: selfFacts(browser, true),
			creator,
		});
		const page: Page = {
			id: `p${++this.#pages}`,
			browser,
			state: init.state,
			alive: true,
			frozen: false,
			freezes: 0,
			ticks: 0,
			queue: [],
			writable: true,
			connected: new Set(),
			witnessAt: null,
			followed: null,
			claimed: null,
			second: 0,
			sent: 0,
		};
		browser.page = page;
		this.#handle(page, init.effects);
		this.#after(this.#between(...ONLINE_MS), () =>
			this.#toPage(page, () =>
				this.#step(page, { type: "network", now: this.#now, online: true }),
			),
		);
		this.#startTicks(page, this.#between(0, TICK_MS));
		for (const other of this.#alivePages()) {
			if (other !== page) this.#connectLater(page, other);
		}
	}

	#step(page: Page, event: ElectionEvent): void {
		if (!page.alive) return;
		const next = stepElection(page.state, event);
		page.state = next.state;
		this.#handle(page, next.effects);
	}

	#handle(page: Page, effects: readonly ElectionEffect[]): void {
		for (const effect of effects) {
			switch (effect.type) {
				case "beat":
					this.#beat(page, effect.to, effect.beat);
					break;
				case "pull":
					this.#pull(page, effect.auth, effect.peer);
					break;
				case "store":
					this.#store(page, effect.auth);
					break;
				case "host":
					this.#host(page, effect.auth);
					break;
				case "step-down":
					this.#stats.stepDowns++;
					break;
				case "follow":
					if (effect.host)
						this.#follow(page, effect.host.auth, effect.host.peer);
					break;
			}
		}
	}

	/** Checks the rate (i), validates the beat, checks a claim (a), and sends it over the links that are up. */
	#beat(page: Page, to: string | null, beat: Beat): void {
		if (this.#stopped) return;
		const second = Math.floor(this.#now / 1_000);
		if (second !== page.second) {
			page.second = second;
			page.sent = 0;
		}
		if (++page.sent > CTL_PER_SECOND) {
			this.#violate(
				`${page.id} sends over ${CTL_PER_SECOND} beats in one second`,
			);
			this.#stopped = true;
			return;
		}
		const parsed = parseCtl(frame(TABLE, beat), TABLE);
		if (!parsed.ok) {
			this.#violate(`${page.id} sent a beat that is ${parsed.reason}`);
		}
		if (
			beat.role === "claiming" &&
			beat.auth &&
			!sameAuthority(beat.auth, page.claimed)
		) {
			page.claimed = beat.auth;
			this.#claimed(page, beat.auth);
		}
		for (const target of page.connected) {
			if (to !== null && target.id !== to) continue;
			if (!this.#linked(page.browser, target.browser)) continue;
			const key = `${page.id}>${target.id}`;
			const at = Math.max(
				this.#now + this.#between(MIN_DELAY_MS, MAX_DELAY_MS),
				this.#fifo.get(key) ?? 0,
			);
			this.#fifo.set(key, at);
			this.#agenda.add(at, () => this.#deliver(page, target, beat));
		}
	}

	#claimed(page: Page, auth: Authority): void {
		const host = page.state.self.seating?.host ?? null;
		const key = termKey(auth);
		if (host !== null && host.tag === auth.tag && host.term === auth.term) {
			this.#stats.resumes++;
			if (!this.#claimedTerms.has(key)) {
				this.#violate(`${page.id} resumed ${key}, which nobody claimed`);
			}
			return;
		}
		this.#stats.claims++;
		if (this.#quiet) this.#stats.quietClaims++;
		this.#claimedTerms.add(key);
		if (page.witnessAt === null || this.#now - page.witnessAt >= HOST_LOST_MS) {
			this.#violate(`${page.id} claimed ${key} without a witness`);
		}
	}

	#deliver(from: Page, target: Page, beat: Beat): void {
		if (!target.connected.has(from)) return;
		if (!this.#linked(from.browser, target.browser)) return;
		this.#toPage(target, () => {
			if (from.browser !== target.browser) target.witnessAt = this.#now;
			this.#step(target, {
				type: "beat",
				now: this.#now,
				peer: from.id,
				beat,
			});
			const followed = followedHost(target.state);
			if (followed?.peer === from.id && beat.role === "host" && beat.pos) {
				this.#adopt(target, beat.pos);
			}
		});
	}

	/** A follower takes the log of the host it follows (extend or replace, plan §4.5). */
	#adopt(page: Page, pos: Position): void {
		const { replica } = page.browser;
		if (replica === null) return;
		if (
			replica.pos.rev === pos.rev &&
			sameAuthority(replica.pos.lastAuth, pos.lastAuth)
		) {
			return;
		}
		replica.pos = pos;
		this.#refresh(page);
	}

	#refresh(page: Page): void {
		this.#step(page, {
			type: "self",
			now: this.#now,
			self: selfFacts(page.browser, page.writable),
		});
	}

	/** The claim pull takes a strictly better log; with no answer, the claim deadline takes over. */
	#pull(page: Page, auth: Authority, peer: string): void {
		this.#after(this.#between(...PULL_MS), () => {
			const target = [...page.connected].find((other) => other.id === peer);
			if (target === undefined || !target.alive || target.frozen) return;
			if (!this.#linked(page.browser, target.browser)) return;
			const pos = target.browser.replica?.pos ?? null;
			this.#toPage(page, () => {
				const { mode } = page.state;
				if (
					mode.kind !== "claiming" ||
					mode.storing ||
					!sameAuthority(mode.auth, auth)
				) {
					return;
				}
				this.#stats.pulls++;
				const { replica } = page.browser;
				if (pos && replica && comparePosition(pos, replica.pos) > 0) {
					replica.pos = pos;
					this.#refresh(page);
				}
				this.#step(page, { type: "pulled", now: this.#now, auth });
			});
		});
	}

	/**
	 * The store keeps the better of the stored host and the claim, as a follower does, so the late write of a claim
	 * that lost changes nothing. The transaction completes while the page is frozen; the page hears of it on thaw.
	 */
	#store(page: Page, auth: Authority): void {
		this.#after(STORE_MS, () => {
			const { browser } = page;
			const { replica } = browser;
			if (browser.page !== page) return;
			if (replica === null) {
				this.#violate(`${page.id} stores a claim without a replica`);
				return;
			}
			const failed = !this.#quiet && this.#random() < STORE_FAILURE;
			const written = !failed && compareAuthority(auth, replica.host) > 0;
			if (written) {
				replica.host = auth;
				replica.inc = Math.max(replica.inc, auth.inc);
			}
			this.#toPage(page, () => {
				if (failed) {
					page.writable = false;
					this.#stats.storeFailures++;
				}
				this.#refresh(page);
				this.#step(page, {
					type: "stored",
					now: this.#now,
					auth,
					ok: written,
				});
			});
		});
	}

	/** (f) and (g). */
	#host(page: Page, auth: Authority): void {
		this.#stats.hosts++;
		const key = authKey(auth);
		const owner = this.#hostedBy.get(key);
		if (owner !== undefined && owner !== page.id) {
			this.#violate(`${page.id} hosts ${key}, which ${owner} hosted`);
		}
		this.#hostedBy.set(key, page.id);
		if (!sameAuthority(page.browser.replica?.host ?? null, auth)) {
			this.#violate(`${page.id} hosts ${key} before its replica stores it`);
		}
	}

	/** (b) and (h); the follower keeps the best followed authority as its replica's host (plan P5). */
	#follow(page: Page, auth: Authority, peer: string): void {
		const key = authKey(auth);
		if (this.#hostedBy.get(key) !== peer) {
			this.#violate(
				`${page.id} follows ${peer} as ${key}, which it never hosted`,
			);
		}
		if (compareAuthority(auth, page.followed) < 0) {
			this.#violate(`${page.id} follows ${key} after a better authority`);
		}
		page.followed = auth;
		const { browser } = page;
		const { replica } = browser;
		if (replica === null) return;
		if (browser.persistent) {
			if (compareAuthority(auth, browser.followed) < 0) {
				this.#violate(
					`browser ${browser.index} follows ${key} after a better authority`,
				);
			}
			browser.followed = auth;
		}
		if (compareAuthority(auth, replica.host) > 0) {
			replica.host = auth;
			this.#refresh(page);
		}
	}

	#startTicks(page: Page, delay: number): void {
		const ticks = ++page.ticks;
		const tick = (): void => {
			if (!page.alive || page.frozen || page.ticks !== ticks) return;
			this.#tick(page);
			this.#after(TICK_MS + this.#between(0, TICK_JITTER_MS), tick);
		};
		this.#after(delay, tick);
	}

	#tick(page: Page): void {
		this.#step(page, { type: "tick", now: this.#now });
		if (isHosting(page) && this.#random() < APPEND_CHANCE) this.#append(page);
	}

	/** A host commits one entry: (g) its replica must store it as the host. */
	#append(page: Page): void {
		const { mode } = page.state;
		const { replica } = page.browser;
		if (mode.kind !== "hosting" || replica === null) return;
		if (!sameAuthority(replica.host, mode.auth)) {
			this.#violate(
				`${page.id} appends as ${authKey(mode.auth)}, but its replica stores another host`,
			);
			return;
		}
		replica.pos = { rev: replica.pos.rev + 1, lastAuth: mode.auth };
		this.#refresh(page);
	}

	#toPage(page: Page, work: () => void): void {
		if (!page.alive) return;
		if (page.frozen) page.queue.push(work);
		else work();
	}

	#linked(a: Browser, b: Browser): boolean {
		return (this.#down.get(pairKey(a, b)) ?? 0) === 0;
	}

	#setDown(a: Browser, b: Browser, count: number): void {
		const was = this.#linked(a, b);
		this.#down.set(pairKey(a, b), count);
		const pa = a.page;
		const pb = b.page;
		if (pa === null || pb === null) return;
		if (was && count > 0 && pa.connected.has(pb)) {
			this.#after(this.#between(...LEAVE_MS), () => {
				if (!this.#linked(a, b)) this.#disconnect(pa, pb);
			});
		}
		if (!was && count === 0 && !pa.connected.has(pb)) {
			this.#connectLater(pa, pb);
		}
	}

	#connectLater(a: Page, b: Page): void {
		this.#after(this.#between(...CONNECT_MS), () => this.#connect(a, b));
	}

	#connect(a: Page, b: Page): void {
		if (!a.alive || !b.alive || a.connected.has(b)) return;
		if (!this.#linked(a.browser, b.browser)) return;
		// Signalling runs in the pages, so a frozen page connects after it thaws.
		if (a.frozen || b.frozen) return;
		a.connected.add(b);
		b.connected.add(a);
		this.#step(a, { type: "join", now: this.#now, peer: b.id });
		this.#step(b, { type: "join", now: this.#now, peer: a.id });
	}

	#disconnect(a: Page, b: Page): void {
		if (!a.connected.has(b)) return;
		a.connected.delete(b);
		b.connected.delete(a);
		this.#toPage(a, () =>
			this.#step(a, { type: "leave", now: this.#now, peer: b.id }),
		);
		this.#toPage(b, () =>
			this.#step(b, { type: "leave", now: this.#now, peer: a.id }),
		);
	}

	#kill(page: Page): void {
		page.alive = false;
		page.frozen = false;
		page.queue = [];
		if (page.browser.page === page) page.browser.page = null;
		for (const other of page.connected) {
			this.#after(this.#between(...LEAVE_MS), () =>
				this.#disconnect(page, other),
			);
		}
	}

	#forgetMemory(browser: Browser): void {
		if (!browser.persistent && browser.replica) {
			browser.replica = { pos: EMPTY_POSITION, host: null, inc: 0 };
		}
	}

	#reload(page: Page): void {
		const { browser } = page;
		this.#stats.reloads++;
		this.#kill(page);
		this.#after(this.#between(...LOAD_MS), () => {
			if (browser.page !== null) return;
			this.#forgetMemory(browser);
			this.#open(browser, false);
		});
	}

	/** A second tab tries the seat, but the active tab keeps it. */
	#duplicate(page: Page): void {
		const { browser } = page;
		this.#after(this.#between(...DUPLICATE_MS), () => {
			if (browser.page !== page) return;
			this.#stats.duplicates++;
		});
	}

	#freeze(page: Page): void {
		this.#stats.freezes++;
		page.frozen = true;
		const freezes = ++page.freezes;
		this.#after(this.#between(...FREEZE_MS), () => {
			if (page.freezes === freezes) this.#thaw(page);
		});
	}

	/** The late timer and the queued messages run in either order. */
	#thaw(page: Page): void {
		if (!page.alive || !page.frozen) return;
		page.frozen = false;
		const queued = page.queue;
		page.queue = [];
		const tickFirst = this.#random() < 0.5;
		if (tickFirst) this.#tick(page);
		for (const work of queued) work();
		if (!tickFirst) this.#tick(page);
		this.#startTicks(page, TICK_MS);
		for (const other of this.#alivePages()) {
			if (other !== page && !page.connected.has(other)) {
				this.#connectLater(page, other);
			}
		}
	}

	#click(page: Page): void {
		const before = page.claimed;
		this.#step(page, { type: "click", now: this.#now });
		if (page.claimed !== before) this.#stats.clickClaims++;
	}

	#disturb(): void {
		if (this.#quiet) return;
		const roll = this.#random();
		const page = this.#pick(this.#alivePages());
		if (roll < 0.3) {
			this.#outage([this.#randomPair()], OUTAGE_MS);
		} else if (roll < 0.4) {
			this.#partition();
		} else if (page !== undefined) {
			if (roll < 0.75 && !page.frozen) {
				if (roll < 0.55) this.#freeze(page);
				else this.#click(page);
			} else if (roll >= 0.75 && roll < 0.85) {
				this.#reload(page);
			} else if (roll >= 0.85 && roll < 0.93) {
				if (page.browser.seat !== null) this.#duplicate(page);
			} else if (roll >= 0.93 && !page.frozen) {
				this.#step(page, { type: "wake", now: this.#now });
			}
		}
		this.#after(this.#between(...DISTURB_MS), () => this.#disturb());
	}

	#outage(pairs: readonly (readonly [Browser, Browser])[], range: Range): void {
		const outage: Outage = { pairs, active: true };
		this.#outages.push(outage);
		for (const [a, b] of pairs) this.#setDown(a, b, this.#downCount(a, b) + 1);
		this.#after(this.#between(...range), () => {
			if (!outage.active) return;
			outage.active = false;
			for (const [a, b] of pairs) {
				this.#setDown(a, b, this.#downCount(a, b) - 1);
			}
		});
	}

	#partition(): void {
		this.#stats.partitions++;
		const order = shuffled(this.#browsers, this.#random);
		const cut = 1 + this.#int(order.length - 1);
		const pairs: [Browser, Browser][] = [];
		for (const a of order.slice(0, cut)) {
			for (const b of order.slice(cut)) pairs.push([a, b]);
		}
		this.#outage(pairs, PARTITION_MS);
	}

	/**
	 * Disturbances stop and frozen pages thaw; half of the seeds keep a quarter of the links down for good, and
	 * half of the seeds close every host page for good.
	 */
	#beginQuiet(): void {
		this.#quiet = true;
		for (const outage of this.#outages) outage.active = false;
		const sparse = this.#random() < 0.5;
		for (const a of this.#browsers) {
			for (const b of this.#browsers) {
				if (a.index >= b.index) continue;
				this.#setDown(a, b, sparse && this.#random() < 0.25 ? 1 : 0);
			}
		}
		for (const browser of this.#browsers) {
			if (browser.page?.frozen) this.#thaw(browser.page);
		}
		if (this.#random() < 0.5) {
			for (const page of this.#alivePages().filter(isHosting)) {
				this.#stats.hostCrashes++;
				this.#kill(page);
			}
		}
		this.#check();
	}

	/** (c) and the samples for (d), every CHECK_MS of the quiet phase. */
	#check(): void {
		const settled = this.#quietAt + SETTLE_MS;
		const overlapping = new Set<string>();
		for (const group of this.#groups()) {
			if (group.diameter > 2) continue;
			const hosts = group.pages.filter(isHosting);
			for (const [i, a] of hosts.entries()) {
				for (const b of hosts.slice(i + 1)) {
					const key = `${a.id}+${b.id}`;
					overlapping.add(key);
					let since = this.#overlaps.get(key);
					if (since === undefined) {
						since = this.#now;
						this.#overlaps.set(key, since);
						this.#stats.quietOverlaps++;
					}
					const together = this.#now - Math.max(since, settled);
					if (together > OVERLAP_MS && !this.#reported.has(key)) {
						this.#reported.add(key);
						this.#violate(`${key} host one group for over ${OVERLAP_MS} ms`);
					}
				}
			}
			if (
				hosts.length === 0 &&
				this.#now >= settled &&
				this.#qualifies(group)
			) {
				this.#hostless.set(group.key, this.#now);
			}
		}
		for (const key of this.#overlaps.keys()) {
			if (!overlapping.has(key)) this.#overlaps.delete(key);
		}
		if (this.#now + CHECK_MS <= this.#endAt) {
			this.#after(CHECK_MS, () => this.#check());
		}
	}

	/** (d) and (e). */
	#finish(): void {
		const live = this.#quietAt + LIVE_MS;
		for (const group of this.#groups()) {
			if (group.diameter > 2) continue;
			const hosts = group.pages.filter(isHosting);
			if (hosts.length > 1) {
				this.#violate(`group ${group.key} ends with ${hosts.length} hosts`);
			}
			if (!this.#qualifies(group)) continue;
			if (group.diameter === 2) this.#stats.twoHopGroups++;
			const [host] = hosts;
			if (host === undefined || host.state.mode.kind !== "hosting") {
				this.#violate(`group ${group.key} ends without a host`);
				continue;
			}
			const hostless = this.#hostless.get(group.key);
			if (hostless !== undefined && hostless >= live) {
				this.#violate(
					`group ${group.key} has no host at ${Math.round(hostless)} ms, after the bound ${Math.round(live)} ms`,
				);
			}
			const { auth } = host.state.mode;
			for (const page of group.pages) {
				if (page === host) continue;
				const knows = page.connected.has(host)
					? sameAuthority(followedHost(page.state)?.auth ?? null, auth)
					: electionView(page.state).phase === "host-unreachable" &&
						sameAuthority(page.state.known, auth);
				if (!knows) {
					this.#violate(`${page.id} neither follows nor knows host ${host.id}`);
				}
			}
		}
	}

	#qualifies(group: Group): boolean {
		return group.pages.length >= 2 && group.pages.some(isEligible);
	}

	/** The connected groups of open pages, over the links that are up. */
	#groups(): Group[] {
		const edge = (a: Page, b: Page): boolean =>
			a.connected.has(b) && this.#linked(a.browser, b.browser);
		const seen = new Set<Page>();
		const groups: Group[] = [];
		for (const start of this.#alivePages()) {
			if (seen.has(start)) continue;
			seen.add(start);
			const members: Page[] = [];
			const stack = [start];
			for (let page = stack.pop(); page; page = stack.pop()) {
				members.push(page);
				for (const other of page.connected) {
					if (other.alive && !seen.has(other) && edge(page, other)) {
						seen.add(other);
						stack.push(other);
					}
				}
			}
			members.sort((a, b) => (a.id < b.id ? -1 : 1));
			groups.push({
				key: members.map((page) => page.id).join(","),
				pages: members,
				diameter: diameterOf(members, edge),
			});
		}
		return groups;
	}

	#alivePages(): Page[] {
		return this.#browsers.flatMap((browser) =>
			browser.page?.alive ? [browser.page] : [],
		);
	}

	#downCount(a: Browser, b: Browser): number {
		return this.#down.get(pairKey(a, b)) ?? 0;
	}

	#randomPair(): readonly [Browser, Browser] {
		const count = this.#browsers.length;
		const a = this.#int(count);
		const b = (a + 1 + this.#int(count - 1)) % count;
		return [this.#browser(a), this.#browser(b)];
	}

	#browser(index: number): Browser {
		const browser = this.#browsers[index];
		if (browser === undefined) throw new Error(`no browser ${index}`);
		return browser;
	}

	#after(delay: number, run: () => void): void {
		this.#agenda.add(this.#now + delay, run);
	}

	#between(low: number, high: number): number {
		return low + this.#random() * (high - low);
	}

	#int(count: number): number {
		return Math.floor(this.#random() * count);
	}

	#pick<T>(items: readonly T[]): T | undefined {
		return items[this.#int(items.length)];
	}

	#violate(message: string): void {
		if (this.violations.length >= 5) return;
		this.violations.push(
			`seed ${this.#seed} at ${Math.round(this.#now)} ms: ${message}`,
		);
	}
}

/** Runs one seed; an error from the reducer names the seed. */
function simulate(seed: number, stats: Stats): readonly string[] {
	const world = new World(seed, stats);
	try {
		world.run();
	} catch (error) {
		throw new Error(`seed ${seed}: ${String(error)}`, { cause: error });
	}
	return world.violations;
}

describe("election simulation", () => {
	it(`keeps the election invariants for ${SEEDS} seeds`, () => {
		const stats = emptyStats();
		const violations: string[] = [];
		for (let seed = 1; seed <= SEEDS; seed++) {
			violations.push(...simulate(seed, stats));
		}
		expect(violations).toEqual([]);
		// Every disturbance and every rule must occur, or the invariants could hold trivially.
		for (const [name, count] of Object.entries(stats)) {
			expect(count, name).toBeGreaterThan(0);
		}
	}, 300_000);
});
