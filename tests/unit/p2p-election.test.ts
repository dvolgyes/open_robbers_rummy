import { describe, expect, it } from "vitest";
import type { Authority, Position } from "../../src/p2p/authority";
import {
	type ElectionEffect,
	type ElectionEvent,
	type ElectionState,
	type ElectionView,
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
	BUTTON_MS,
	CLAIM_PULL_MS,
	HOST_LOST_MS,
	LATE_TICK_MS,
	MAX_TERM,
	NOBODY_MS,
	RESUME_ONLINE_MS,
	STAGGER_MS,
	TICK_MS,
	VOLUNTEER_MS,
} from "../../src/p2p/limits";
import { type Beat, frame, parseCtl } from "../../src/p2p/wire";
import type { Seat } from "../../src/protocol";
import { AUTH_1, AUTH_2, HOLDER_E, HOLDER_N, TABLE } from "./p2p-fixtures";

const HOLDER_S = "SSSSSSSSSSSSSSSS";
const HOLDER_W = "zzzzzzzzzzzzzzzz";
const VISITOR = "vvvvvvvvvvvvvvvv";
const TAG_W = makeTag(HOLDER_W, "W");
/** Same term as AUTH_2 with a higher tag, so AUTH_2 beats it. */
const AUTH_S2: Authority = { term: 2, tag: makeTag(HOLDER_S, "S"), inc: 1 };
/** AUTH_2 after a resume: the higher incarnation beats AUTH_2. */
const AUTH_E2_RESUMED: Authority = { ...AUTH_2, inc: 2 };
const POS: Position = { rev: 1, lastAuth: AUTH_1 };

interface Report {
	readonly auth: Authority;
	readonly seenAgoMs: number;
}

interface Source {
	readonly peer: string;
	readonly beat: Beat;
}

function seating(seat: Seat, overrides: Partial<Seating> = {}): Seating {
	return {
		seat,
		pos: POS,
		host: AUTH_1,
		inc: 0,
		bound: true,
		persistent: true,
		writable: true,
		...overrides,
	};
}

function facts(holder: string, seat: Seating | null): SelfFacts {
	return { holder, seating: seat };
}

function leaderBeat(
	auth: Authority,
	role: "host" | "claiming" = "host",
	pos: Position = { rev: 1, lastAuth: auth },
): Beat {
	const [holder = "", seat] = auth.tag.split(".");
	return { k: "beat", role, auth, pos, holder, seat: seat as Seat, elig: true };
}

function followerBeat(
	holder: string,
	seat: Seat,
	options: { report?: Report; pos?: Position; elig?: boolean } = {},
): Beat {
	return {
		k: "beat",
		role: "follower",
		holder,
		seat,
		pos: options.pos ?? POS,
		elig: options.elig ?? true,
		...options.report,
	};
}

function visitorBeat(holder: string, report?: Report): Beat {
	return { k: "beat", role: "visitor", holder, elig: false, ...report };
}

/** A report from a page that never had a beat from `auth` itself. */
function hearsay(auth: Authority): Report {
	return { auth, seenAgoMs: MAX_TERM };
}

function ofType<T extends ElectionEffect["type"]>(
	effects: readonly ElectionEffect[],
	type: T,
): Extract<ElectionEffect, { type: T }>[] {
	return effects.filter(
		(effect): effect is Extract<ElectionEffect, { type: T }> =>
			effect.type === type,
	);
}

function expectWireBeats(effects: readonly ElectionEffect[]): void {
	for (const effect of ofType(effects, "beat")) {
		expect(parseCtl(frame(TABLE, effect.beat), TABLE).ok).toBe(true);
	}
}

/** One page's election, stepped like the controller does. Every beat it emits must pass the wire validator. */
class Page {
	state: ElectionState;
	readonly initial: readonly ElectionEffect[];

	constructor(
		self: SelfFacts,
		options: { creator?: boolean; online?: boolean } = {},
	) {
		const init = initElection({
			now: 0,
			self,
			creator: options.creator ?? false,
		});
		this.state = init.state;
		this.initial = init.effects;
		expectWireBeats(init.effects);
		if (options.online ?? true) {
			this.step({ type: "network", now: 0, online: true });
		}
	}

	get now(): number {
		return this.state.now;
	}

	get view(): ElectionView {
		return electionView(this.state);
	}

	get mode(): string {
		return this.state.mode.kind;
	}

	step(event: ElectionEvent): readonly ElectionEffect[] {
		const next = stepElection(this.state, event);
		this.state = next.state;
		expectWireBeats(next.effects);
		return next.effects;
	}

	hear(peer: string, beat: Beat, now = this.now): readonly ElectionEffect[] {
		return this.step({ type: "beat", now, peer, beat });
	}

	tick(now: number): readonly ElectionEffect[] {
		return this.step({ type: "tick", now });
	}

	/** Ticks every TICK_MS for `ms`; each source beats on the first tick and every BEAT_MS after it. */
	run(ms: number, sources: readonly Source[] = []): ElectionEffect[] {
		const start = this.now;
		const out: ElectionEffect[] = [];
		for (let t = start + TICK_MS; t <= start + ms; t += TICK_MS) {
			if ((t - start - TICK_MS) % BEAT_MS === 0) {
				for (const { peer, beat } of sources) {
					out.push(...this.hear(peer, beat, t));
				}
			}
			out.push(...this.tick(t));
		}
		return out;
	}
}

function west(overrides: Partial<Seating> = {}): Page {
	return new Page(facts(HOLDER_W, seating("W", overrides)));
}

function creator(): Page {
	return new Page(facts(HOLDER_N, seating("N", { inc: 1 })), {
		creator: true,
	});
}

const VISITOR_WITNESS: Source = {
	peer: "pV",
	beat: visitorBeat(VISITOR, hearsay(AUTH_1)),
};

describe("following a host (rules 1–3)", () => {
	it("follows the best authority that a host beat shows", () => {
		const page = west();
		expect(page.hear("pS", leaderBeat(AUTH_S2), 100)).toContainEqual({
			type: "follow",
			host: { auth: AUTH_S2, peer: "pS" },
		});
		expect(ofType(page.hear("pE", leaderBeat(AUTH_2), 200), "follow")).toEqual([
			{ type: "follow", host: { auth: AUTH_2, peer: "pE" } },
		]);
		const resumed = page.hear("pE2", leaderBeat(AUTH_E2_RESUMED), 300);
		expect(ofType(resumed, "follow")).toEqual([
			{ type: "follow", host: { auth: AUTH_E2_RESUMED, peer: "pE2" } },
		]);
		expect(ofType(page.hear("pN", leaderBeat(AUTH_1), 400), "follow")).toEqual(
			[],
		);
		expect(followedHost(page.state)).toEqual({
			auth: AUTH_E2_RESUMED,
			peer: "pE2",
		});
		expect(page.view).toEqual({ phase: "live" });
	});

	it("never goes back to an authority older than one it knows", () => {
		const page = west({ pos: { rev: 3, lastAuth: AUTH_2 } });
		page.hear("pN", leaderBeat(AUTH_1), 100);
		expect(followedHost(page.state)).toBeNull();
		expect(page.view).toMatchObject({ phase: "waiting-for-host" });
	});

	it("loses a host whose last beat is HOST_LOST_MS old", () => {
		const page = west();
		page.hear("pN", leaderBeat(AUTH_1), 1_000);
		page.tick(1_000 + HOST_LOST_MS - 1);
		expect(page.view).toEqual({ phase: "live" });
		expect(page.tick(1_000 + HOST_LOST_MS)).toContainEqual({
			type: "follow",
			host: null,
		});
		expect(page.view).toMatchObject({ phase: "waiting-for-host" });
	});

	it("shows an unreachable host while a peer reports a fresh beat from it", () => {
		const page = west();
		const report = { auth: AUTH_1, seenAgoMs: 1_000 };
		page.hear("pE", followerBeat(HOLDER_E, "E", { report }), 100);
		expect(page.view).toEqual({ phase: "host-unreachable" });
		expect(followedHost(page.state)).toBeNull();
		page.tick(100 + HOST_LOST_MS - 1_000 - 1);
		expect(page.view).toEqual({ phase: "host-unreachable" });
		page.tick(100 + HOST_LOST_MS - 1_000);
		expect(page.view).toMatchObject({ phase: "waiting-for-host" });
	});

	it("shows a claimer as becoming host and a host to an unseated page as the lobby", () => {
		const page = west();
		page.hear("pE", leaderBeat(AUTH_2, "claiming"), 100);
		expect(page.view).toEqual({ phase: "becoming-host", self: false });
		expect(followedHost(page.state)).toBeNull();
		const visitor = new Page(facts(VISITOR, null));
		visitor.hear("pE", leaderBeat(AUTH_2), 100);
		expect(visitor.view).toEqual({ phase: "lobby" });
	});
});

describe("stepping down (rule 4)", () => {
	it("steps down at a beat from a better host and follows it", () => {
		const page = creator();
		const effects = page.hear("pE", leaderBeat(AUTH_2), 100);
		expect(ofType(effects, "step-down")).toEqual([
			{ type: "step-down", auth: AUTH_1 },
		]);
		expect(ofType(effects, "beat")[0]?.beat).toMatchObject({
			role: "follower",
			auth: AUTH_2,
			seenAgoMs: 0,
		});
		expect(ofType(effects, "follow")).toEqual([
			{ type: "follow", host: { auth: AUTH_2, peer: "pE" } },
		]);
	});

	it("steps down at a report of a better authority", () => {
		const page = creator();
		const report = { auth: AUTH_2, seenAgoMs: 1_000 };
		const effects = page.hear("pS", followerBeat(HOLDER_S, "S", { report }));
		expect(ofType(effects, "step-down")).toHaveLength(1);
		expect(page.view).toEqual({ phase: "host-unreachable" });
	});

	it("steps down at a log position written by a better authority", () => {
		const page = creator();
		const pos = { rev: 5, lastAuth: AUTH_2 };
		const effects = page.hear(
			"pS",
			followerBeat(HOLDER_S, "S", { report: hearsay(AUTH_1), pos }),
		);
		expect(ofType(effects, "step-down")).toHaveLength(1);
		expect(page.view).toMatchObject({ phase: "waiting-for-host" });
	});

	it("keeps hosting at a beat from a worse authority", () => {
		const page = new Page(
			facts(HOLDER_E, seating("E", { host: AUTH_2, inc: 1 })),
			{ creator: true },
		);
		expect(ofType(page.hear("pN", leaderBeat(AUTH_1)), "step-down")).toEqual(
			[],
		);
		expect(page.view).toEqual({ phase: "host" });
	});

	it("steps down when the page stops being eligible", () => {
		const page = creator();
		const broken = facts(HOLDER_N, seating("N", { inc: 1, writable: false }));
		const effects = page.step({ type: "self", now: 100, self: broken });
		expect(ofType(effects, "step-down")).toEqual([
			{ type: "step-down", auth: AUTH_1 },
		]);
		expect(page.mode).toBe("idle");
	});

	it("lets the newer of two tabs with the same tag win; the old tab steps down and is superseded", () => {
		const old = creator();
		const fresh = new Page(facts(HOLDER_N, seating("N", { inc: 1 })));
		fresh.run(RESUME_ONLINE_MS);
		const resumed = { ...AUTH_1, inc: 2 };
		expect(fresh.state.mode).toMatchObject({ kind: "claiming", auth: resumed });
		fresh.step({ type: "stored", now: fresh.now, auth: resumed, ok: true });
		expect(fresh.view).toEqual({ phase: "host" });

		expect(fresh.hear("old", leaderBeat(AUTH_1))).not.toContainEqual(
			expect.objectContaining({ type: "step-down" }),
		);
		const effects = old.hear("fresh", leaderBeat(resumed), fresh.now);
		expect(ofType(effects, "step-down")).toEqual([
			{ type: "step-down", auth: AUTH_1 },
		]);
		expect(ofType(effects, "follow")).toEqual([]);
		expect(old.step({ type: "lock-lost", now: old.now })).toEqual([]);
		expect(old.view).toEqual({ phase: "superseded" });
	});

	it("makes a host that loses its seat lock superseded, and ignores every later event", () => {
		const page = creator();
		expect(page.step({ type: "lock-lost", now: 100 })).toEqual([
			{ type: "step-down", auth: AUTH_1 },
		]);
		expect(page.view).toEqual({ phase: "superseded" });
		expect(page.run(VOLUNTEER_MS, [VISITOR_WITNESS])).toEqual([]);
		expect(page.step({ type: "join", now: page.now, peer: "pX" })).toEqual([]);
		expect(page.view).toEqual({ phase: "superseded" });
	});
});

describe("the absence clock (rule 5)", () => {
	function absent(page: Page): number {
		return page.state.absentMs;
	}

	it("counts online time without host evidence", () => {
		const page = west();
		page.run(4_000);
		expect(absent(page)).toBe(4_000);
		expect(page.view).toMatchObject({ phase: "waiting-for-host" });
	});

	it("stops while offline and starts again when the page is back online", () => {
		const page = west();
		page.run(4_000);
		page.step({ type: "network", now: 4_000, online: false });
		page.run(4_000);
		expect(absent(page)).toBe(4_000);
		expect(page.view).toEqual({ phase: "connecting" });
		page.step({ type: "network", now: 8_000, online: true });
		expect(absent(page)).toBe(0);
	});

	it("starts again on wake and stays at zero while host evidence is fresh", () => {
		const page = west();
		page.run(4_000);
		page.step({ type: "wake", now: 4_000 });
		expect(absent(page)).toBe(0);
		page.run(4_000);
		page.hear("pE", leaderBeat(AUTH_2, "claiming"));
		expect(absent(page)).toBe(0);
		page.run(HOST_LOST_MS - TICK_MS);
		expect(absent(page)).toBe(0);
		page.run(TICK_MS);
		expect(absent(page)).toBeGreaterThan(0);
	});

	it("starts again after a tick more than LATE_TICK_MS late", () => {
		const page = west();
		page.run(1_000);
		page.tick(page.now + LATE_TICK_MS);
		expect(absent(page)).toBe(1_000 + LATE_TICK_MS);
		page.tick(page.now + LATE_TICK_MS + 1);
		expect(absent(page)).toBe(0);
	});
});

describe("the Make me the host button (rules 6–7)", () => {
	it("appears after BUTTON_MS and is enabled with a witness", () => {
		const page = west();
		page.run(BUTTON_MS - TICK_MS, [VISITOR_WITNESS]);
		expect(page.view).toEqual({
			phase: "waiting-for-host",
			absentMs: BUTTON_MS - TICK_MS,
			button: null,
		});
		page.step({ type: "click", now: page.now });
		expect(page.mode).toBe("idle");
		page.run(TICK_MS, [VISITOR_WITNESS]);
		expect(page.view).toEqual({
			phase: "waiting-for-host",
			absentMs: BUTTON_MS,
			button: { enabled: true },
		});
		const effects = page.step({ type: "click", now: page.now });
		const claim = { term: 2, tag: TAG_W, inc: 1 };
		expect(page.state.mode).toMatchObject({ kind: "claiming", auth: claim });
		expect(ofType(effects, "beat")[0]?.beat).toMatchObject({
			role: "claiming",
			auth: claim,
		});
		expect(page.view).toEqual({ phase: "becoming-host", self: true });
	});

	it.each([
		["witness", {}, []],
		["storage", { persistent: false }, [VISITOR_WITNESS]],
		["storage", { writable: false }, [VISITOR_WITNESS]],
		["seat", { bound: false }, [VISITOR_WITNESS]],
		[
			"limit",
			{ host: { ...AUTH_1, term: MAX_TERM }, pos: POS },
			[VISITOR_WITNESS],
		],
		["limit", { inc: MAX_TERM }, [VISITOR_WITNESS]],
	] as const)("is disabled for %s (%j)", (reason, overrides, sources) => {
		const page = west(overrides);
		page.run(VOLUNTEER_MS + STAGGER_MS * 4, sources);
		expect(page.view).toEqual({
			phase: "waiting-for-host",
			absentMs: VOLUNTEER_MS + STAGGER_MS * 4,
			button: { enabled: false, reason },
		});
		page.step({ type: "click", now: page.now });
		expect(page.mode).toBe("idle");
	});

	it("does not count another tab of the same browser as a witness", () => {
		const page = west();
		const sibling = { peer: "pW2", beat: visitorBeat(HOLDER_W) };
		page.run(BUTTON_MS, [sibling]);
		expect(page.view).toMatchObject({
			button: { enabled: false, reason: "witness" },
		});
	});

	it("is disabled for an unseated page, which shows nobody-here when it is alone", () => {
		const visitor = new Page(facts(VISITOR, null));
		visitor.run(NOBODY_MS - TICK_MS);
		expect(visitor.view).toMatchObject({ phase: "waiting-for-host" });
		visitor.run(TICK_MS);
		expect(visitor.view).toEqual({ phase: "nobody-here" });
		const witness = { peer: "pE", beat: followerBeat(HOLDER_E, "E") };
		visitor.run(BEAT_MS, [witness]);
		expect(visitor.view).toMatchObject({
			button: { enabled: false, reason: "seat" },
		});
	});
});

describe("the automatic volunteer (rule 8)", () => {
	it("does not elect an automated client that cannot deal boards", () => {
		const bot = new Page({
			...facts(HOLDER_W, seating("W")),
			hostEligible: false,
		});
		const effects = bot.run(VOLUNTEER_MS + 4 * STAGGER_MS);

		expect(bot.mode).toBe("idle");
		expect(bot.view).toMatchObject({
			phase: "waiting-for-host",
			button: { enabled: false, reason: "ineligible" },
		});
		expect(
			ofType(effects, "beat").every((effect) => effect.beat.elig === false),
		).toBe(true);
	});

	it("claims at VOLUNTEER_MS when no eligible peer goes first", () => {
		const page = west();
		page.run(VOLUNTEER_MS - TICK_MS, [VISITOR_WITNESS]);
		expect(page.mode).toBe("idle");
		page.run(TICK_MS, [VISITOR_WITNESS]);
		expect(page.mode).toBe("claiming");
	});

	it("waits one STAGGER_MS per eligible peer with a better position or a lower tag", () => {
		const page = west();
		const equal = {
			peer: "pN",
			beat: followerBeat(HOLDER_N, "N", { report: hearsay(AUTH_1) }),
		};
		const ahead = {
			peer: "pS",
			beat: followerBeat(HOLDER_S, "S", {
				report: hearsay(AUTH_1),
				pos: { rev: 2, lastAuth: AUTH_1 },
			}),
		};
		const behind = {
			peer: "pE",
			beat: followerBeat(HOLDER_E, "E", {
				report: hearsay(AUTH_1),
				pos: { rev: 0, lastAuth: null },
			}),
		};
		const notEligible = {
			peer: "pE2",
			beat: followerBeat(HOLDER_E, "E", {
				report: hearsay(AUTH_1),
				pos: { rev: 9, lastAuth: AUTH_1 },
				elig: false,
			}),
		};
		const sources = [equal, ahead, behind, notEligible];
		page.run(VOLUNTEER_MS + 2 * STAGGER_MS - TICK_MS, sources);
		expect(page.mode).toBe("idle");
		page.run(TICK_MS, sources);
		expect(page.mode).toBe("claiming");
	});
});

describe("a claim (rule 9)", () => {
	function clicked(page: Page, sources: readonly Source[]): ElectionEffect[] {
		page.run(BUTTON_MS, sources);
		return [...page.step({ type: "click", now: page.now })];
	}

	it("takes the next term above every known authority and the next incarnation", () => {
		const page = west({ inc: 3 });
		const known = { term: 5, tag: makeTag(HOLDER_S, "S"), inc: 2 };
		const effects = clicked(page, [
			{
				peer: "pE",
				beat: followerBeat(HOLDER_E, "E", { report: hearsay(known) }),
			},
		]);
		const claim = { term: 6, tag: TAG_W, inc: 4 };
		expect(ofType(effects, "store")).toEqual([{ type: "store", auth: claim }]);
		expect(ofType(effects, "pull")).toEqual([]);
	});

	it("pulls from the peer with a strictly better position, then stores at the deadline", () => {
		const page = west();
		const better = {
			peer: "pN",
			beat: followerBeat(HOLDER_N, "N", {
				report: hearsay(AUTH_1),
				pos: { rev: 3, lastAuth: AUTH_1 },
			}),
		};
		const equal = {
			peer: "pE",
			beat: followerBeat(HOLDER_E, "E", { report: hearsay(AUTH_1) }),
		};
		const effects = clicked(page, [equal, better]);
		const claim = { term: 2, tag: TAG_W, inc: 1 };
		expect(ofType(effects, "pull")).toEqual([
			{ type: "pull", auth: claim, peer: "pN" },
		]);
		expect(ofType(effects, "store")).toEqual([]);
		expect(ofType(page.run(CLAIM_PULL_MS - TICK_MS), "store")).toEqual([]);
		expect(ofType(page.run(TICK_MS), "store")).toEqual([
			{ type: "store", auth: claim },
		]);
		expect(ofType(page.run(CLAIM_PULL_MS), "store")).toEqual([]);
	});

	it("stores when the pull for this claim is over, and ignores the result of another claim", () => {
		const page = west();
		const better = {
			peer: "pN",
			beat: followerBeat(HOLDER_N, "N", {
				pos: { rev: 3, lastAuth: AUTH_1 },
			}),
		};
		clicked(page, [better]);
		const claim = { term: 2, tag: TAG_W, inc: 1 };
		const other = { ...claim, inc: 7 };
		expect(page.step({ type: "pulled", now: page.now, auth: other })).toEqual(
			[],
		);
		expect(
			page.step({ type: "stored", now: page.now, auth: claim, ok: true }),
		).toEqual([]);
		expect(page.step({ type: "pulled", now: page.now, auth: claim })).toEqual([
			{ type: "store", auth: claim },
		]);
		expect(
			page.step({ type: "stored", now: page.now, auth: other, ok: true }),
		).toEqual([]);
		expect(page.mode).toBe("claiming");
	});

	it("starts hosting when the claim is stored", () => {
		const page = west();
		clicked(page, [VISITOR_WITNESS]);
		const claim = { term: 2, tag: TAG_W, inc: 1 };
		const effects = page.step({
			type: "stored",
			now: page.now,
			auth: claim,
			ok: true,
		});
		expect(effects[0]).toEqual({ type: "host", auth: claim });
		expect(ofType(effects, "beat")[0]?.beat).toMatchObject({
			role: "host",
			auth: claim,
			seat: "W",
			elig: true,
		});
		expect(page.view).toEqual({ phase: "host" });
	});

	it("goes back to waiting when the store fails", () => {
		const page = west();
		clicked(page, [VISITOR_WITNESS]);
		const claim = { term: 2, tag: TAG_W, inc: 1 };
		const effects = page.step({
			type: "stored",
			now: page.now,
			auth: claim,
			ok: false,
		});
		expect(ofType(effects, "host")).toEqual([]);
		expect(page.view).toEqual({
			phase: "waiting-for-host",
			absentMs: BUTTON_MS,
			button: { enabled: true },
		});
	});

	it("lets the lower tag win two claims for the same term", () => {
		const south = new Page(facts(HOLDER_S, seating("S")));
		const east = new Page(facts(HOLDER_E, seating("E")));
		const southClaim = { term: 2, tag: makeTag(HOLDER_S, "S"), inc: 1 };
		const eastClaim = { term: 2, tag: makeTag(HOLDER_E, "E"), inc: 1 };
		south.run(BUTTON_MS, [{ peer: "east", beat: followerBeat(HOLDER_E, "E") }]);
		east.run(BUTTON_MS, [{ peer: "south", beat: followerBeat(HOLDER_S, "S") }]);
		const southEffects = south.step({ type: "click", now: south.now });
		const eastEffects = east.step({ type: "click", now: east.now });
		const southBeat = ofType(southEffects, "beat")[0]?.beat;
		const eastBeat = ofType(eastEffects, "beat")[0]?.beat;
		if (!southBeat || !eastBeat) throw new Error("no claim beat");

		expect(ofType(east.hear("south", southBeat), "step-down")).toEqual([]);
		south.hear("east", eastBeat);
		expect(south.mode).toBe("idle");
		expect(south.view).toEqual({ phase: "becoming-host", self: false });
		south.step({ type: "stored", now: south.now, auth: southClaim, ok: true });
		east.step({ type: "stored", now: east.now, auth: eastClaim, ok: true });
		expect([south.view, east.view]).toEqual([
			{ phase: "becoming-host", self: false },
			{ phase: "host" },
		]);
		expect(south.hear("east", leaderBeat(eastClaim))).toContainEqual({
			type: "follow",
			host: { auth: eastClaim, peer: "east" },
		});
	});
});

describe("resume and create (rules 10–11)", () => {
	const RESUMED = { ...AUTH_1, inc: 2 };

	function host(): Page {
		return new Page(facts(HOLDER_N, seating("N", { inc: 1 })), {
			online: false,
		});
	}

	it("resumes the stored term after RESUME_ONLINE_MS online, without a witness or a pull", () => {
		const page = host();
		page.run(5_000);
		page.step({ type: "network", now: 5_000, online: true });
		expect(page.run(RESUME_ONLINE_MS - TICK_MS)).not.toContainEqual(
			expect.objectContaining({ type: "store" }),
		);
		const effects = page.run(TICK_MS);
		expect(ofType(effects, "store")).toEqual([
			{ type: "store", auth: RESUMED },
		]);
		expect(ofType(effects, "pull")).toEqual([]);
	});

	it("does not resume when a better authority is known", () => {
		const page = host();
		page.step({ type: "network", now: 0, online: true });
		page.hear(
			"pE",
			followerBeat(HOLDER_E, "E", { report: hearsay(AUTH_2) }),
			1_000,
		);
		page.run(RESUME_ONLINE_MS + BUTTON_MS);
		expect(page.mode).toBe("idle");
		expect(page.state.resumePending).toBe(false);
	});

	it("does not resume after a freeze before RESUME_ONLINE_MS more online time", () => {
		const page = host();
		page.step({ type: "network", now: 0, online: true });
		page.run(RESUME_ONLINE_MS - TICK_MS);
		page.tick(page.now + LATE_TICK_MS + 1);
		expect(page.mode).toBe("idle");
		page.run(RESUME_ONLINE_MS - TICK_MS);
		expect(page.mode).toBe("idle");
		page.run(TICK_MS);
		expect(page.state.mode).toMatchObject({ kind: "claiming", auth: RESUMED });
	});

	it("makes the creator host of the stored term 1 at once", () => {
		const page = creator();
		expect(page.initial[0]).toEqual({ type: "host", auth: AUTH_1 });
		expect(ofType(page.initial, "beat")[0]?.beat).toMatchObject({
			role: "host",
			auth: AUTH_1,
		});
		expect(page.view).toEqual({ phase: "host" });
	});

	it("refuses a creator that does not host its own stored authority", () => {
		expect(() =>
			initElection({
				now: 0,
				self: facts(HOLDER_E, seating("E")),
				creator: true,
			}),
		).toThrow(/creator/);
		expect(() =>
			initElection({
				now: 0,
				self: facts(HOLDER_N, seating("N", { persistent: false })),
				creator: true,
			}),
		).toThrow(/creator/);
	});
});

describe("beats", () => {
	it("beats to all every BEAT_MS and at once to a peer that joins", () => {
		const page = west();
		const beats = ofType(page.run(3 * BEAT_MS), "beat");
		expect(beats.map((effect) => effect.to)).toEqual([null, null, null]);
		expect(page.step({ type: "join", now: page.now, peer: "pX" })).toEqual([
			{ type: "beat", to: "pX", beat: expect.objectContaining({ k: "beat" }) },
		]);
	});

	it("reports the age of the last direct beat from the known authority, in whole milliseconds", () => {
		const page = west();
		const [first] = ofType(page.run(BEAT_MS), "beat");
		expect(first?.beat).toEqual({
			k: "beat",
			role: "follower",
			holder: HOLDER_W,
			seat: "W",
			pos: POS,
			elig: true,
			auth: AUTH_1,
			seenAgoMs: MAX_TERM,
		});
		page.hear("pN", leaderBeat(AUTH_1), BEAT_MS + 500);
		const [later] = ofType(page.tick(2 * BEAT_MS + 0.75), "beat");
		expect(later?.beat).toMatchObject({
			auth: AUTH_1,
			seenAgoMs: BEAT_MS - 500,
		});
	});

	it("sends a visitor beat without a seat, and with a report once it knows an authority", () => {
		const page = new Page(facts(VISITOR, null));
		expect(ofType(page.run(BEAT_MS), "beat")[0]?.beat).toEqual({
			k: "beat",
			role: "visitor",
			holder: VISITOR,
			elig: false,
		});
		page.hear("pE", followerBeat(HOLDER_E, "E", { report: hearsay(AUTH_2) }));
		expect(ofType(page.run(BEAT_MS), "beat")[0]?.beat).toEqual({
			k: "beat",
			role: "visitor",
			holder: VISITOR,
			elig: false,
			auth: AUTH_2,
			seenAgoMs: MAX_TERM,
		});
	});

	it("rejects time that goes back", () => {
		const page = west();
		page.tick(1_000);
		expect(() => page.tick(999)).toThrow(/time/);
	});
});
