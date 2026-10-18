import type { Seat } from "../protocol";
import {
	type Authority,
	compareAuthority,
	comparePosition,
	type Position,
	sameAuthority,
} from "./authority";
import { makeTag } from "./keys";
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
	VOLUNTEER_MS,
} from "./limits";
import type { Beat } from "./wire";

/**
 * Host election (plan §4.4) as a pure reducer: `stepElection` takes the state and one event and returns the next
 * state and the effects for the controller. Times are `performance.now()` values of this page, and the controller
 * steps the election at least every TICK_MS.
 *
 * Every page learns each authority that a beat names, and a follower's beat names the best authority it knows.
 * As with terms in Raft, a host or claimer that learns of a better authority steps down, and a page follows only
 * the best authority it knows, so the hosts a page follows never get worse.
 */

/** This page's seat and replica. The controller sets it only while the page holds the seat lock. */
export interface Seating {
	readonly seat: Seat;
	readonly pos: Position;
	/** The host authority stored in the replica. */
	readonly host: Authority | null;
	/** The stored incarnation counter; a claim or a resume uses a higher value. */
	readonly inc: number;
	/** The replica binds the seat to this page's holder. */
	readonly bound: boolean;
	/** The replica is in IndexedDB, not in memory. */
	readonly persistent: boolean;
	/** No storage write has failed. */
	readonly writable: boolean;
}

export interface SelfFacts {
	readonly holder: string;
	readonly seating: Seating | null;
	/** An automated client that cannot deal a board sets this to false. */
	readonly hostEligible?: boolean;
}

interface Heard {
	readonly beat: Beat;
	readonly at: number;
}

export type ElectionMode =
	| { readonly kind: "idle" }
	| {
			readonly kind: "claiming";
			readonly auth: Authority;
			readonly since: number;
			/** The claim pull is over and the store effect is out. */
			readonly storing: boolean;
	  }
	| { readonly kind: "hosting"; readonly auth: Authority }
	| { readonly kind: "superseded" };

export interface ElectionState {
	readonly now: number;
	readonly self: SelfFacts;
	/** A tracker socket is open or a peer is connected. */
	readonly online: boolean;
	/** Online time since the page started or thawed (rule 10). */
	readonly onlineMs: number;
	/** The absence clock (rule 5). */
	readonly absentMs: number;
	/** The last beat of each peer, only while it is younger than HOST_LOST_MS. */
	readonly heard: ReadonlyMap<string, Heard>;
	readonly mode: ElectionMode;
	/** The best authority this page knows of: from its replica, its own claims and every beat. */
	readonly known: Authority | null;
	/** When this page last received a beat from `known` itself. */
	readonly knownSeenAt: number | null;
	/** The replica names this page's tag as host and the resume check has not run yet (rule 10). */
	readonly resumePending: boolean;
	readonly lastBeatAt: number | null;
}

export type ElectionEvent =
	| { readonly type: "tick"; readonly now: number }
	| {
			readonly type: "beat";
			readonly now: number;
			readonly peer: string;
			readonly beat: Beat;
	  }
	| {
			readonly type: "join" | "leave";
			readonly now: number;
			readonly peer: string;
	  }
	| { readonly type: "network"; readonly now: number; readonly online: boolean }
	/** `visibilitychange` to visible, `pageshow`, or the browser's `online` event. */
	| { readonly type: "wake"; readonly now: number }
	| { readonly type: "self"; readonly now: number; readonly self: SelfFacts }
	| { readonly type: "click"; readonly now: number }
	/** The claim pull for `auth` is over, whether or not it brought entries. */
	| { readonly type: "pulled"; readonly now: number; readonly auth: Authority }
	| {
			readonly type: "stored";
			readonly now: number;
			readonly auth: Authority;
			readonly ok: boolean;
	  }
	| { readonly type: "lock-lost"; readonly now: number };

export interface Followed {
	readonly auth: Authority;
	readonly peer: string;
}

export type ElectionEffect =
	/** Send the beat to one peer, or to all peers when `to` is null. */
	| { readonly type: "beat"; readonly to: string | null; readonly beat: Beat }
	/** Pull the entries after this replica's position from `peer`, before the claim is stored. */
	| { readonly type: "pull"; readonly auth: Authority; readonly peer: string }
	/** Store `auth` as the host and its incarnation as the counter, in one transaction; answer with `stored`. */
	| { readonly type: "store"; readonly auth: Authority }
	/** Start hosting: accept commands and count every seat holder as seen now. */
	| { readonly type: "host"; readonly auth: Authority }
	/** Stop hosting at once. */
	| { readonly type: "step-down"; readonly auth: Authority }
	/** The host whose entries this page accepts changed. */
	| { readonly type: "follow"; readonly host: Followed | null };

export interface ElectionStep {
	readonly state: ElectionState;
	readonly effects: readonly ElectionEffect[];
}

/** Why this page cannot become the host now (rule 7). */
export type HostBlock = "seat" | "ineligible" | "storage" | "limit" | "witness";

export type HostButton =
	| { readonly enabled: true }
	| { readonly enabled: false; readonly reason: HostBlock };

export type ElectionView =
	| {
			readonly phase:
				| "connecting"
				| "nobody-here"
				| "lobby"
				| "live"
				| "host"
				| "host-unreachable"
				| "superseded";
	  }
	| { readonly phase: "becoming-host"; readonly self: boolean }
	| {
			readonly phase: "waiting-for-host";
			readonly absentMs: number;
			/** Null before BUTTON_MS of absence. */
			readonly button: HostButton | null;
	  };

export interface ElectionInit {
	readonly now: number;
	readonly self: SelfFacts;
	/** The page that created the table hosts the stored term 1 at once (rule 11). */
	readonly creator: boolean;
}

const IDLE: ElectionMode = { kind: "idle" };

type Lead =
	| {
			readonly kind: "direct";
			readonly peer: string;
			readonly role: "host" | "claiming";
	  }
	| { readonly kind: "reported" };

export function initElection(init: ElectionInit): ElectionStep {
	const { now, self, creator } = init;
	const seating = self.seating;
	const tag = ownTag(self);
	const state: ElectionState = {
		now,
		self,
		online: false,
		onlineMs: 0,
		absentMs: 0,
		heard: new Map(),
		mode: IDLE,
		known: better(seating?.host ?? null, seating?.pos.lastAuth ?? null),
		knownSeenAt: null,
		resumePending: !creator && tag !== null && seating?.host?.tag === tag,
		lastBeatAt: null,
	};
	if (!creator) return { state, effects: [] };
	const host = seating?.host ?? null;
	if (host === null || host.tag !== tag || !isEligible(self)) {
		throw new Error("the creator must host its own stored authority");
	}
	const effects: ElectionEffect[] = [{ type: "host", auth: host }];
	const hosting = sendBeat(
		{ ...state, mode: { kind: "hosting", auth: host } },
		effects,
	);
	return { state: hosting, effects };
}

export function stepElection(
	state: ElectionState,
	event: ElectionEvent,
): ElectionStep {
	if (event.now < state.now) throw new Error("election time went back");
	if (state.mode.kind === "superseded") {
		return { state: { ...state, now: event.now }, effects: [] };
	}
	const effects: ElectionEffect[] = [];
	const before = followedHost(state);
	let next = apply(advance(state, event.now), event, effects);
	if (leader(next) !== null) next = { ...next, absentMs: 0 };
	next = decide(next, effects);
	const after = followedHost(next);
	if (!sameFollowed(before, after)) {
		effects.push({ type: "follow", host: after });
	}
	return { state: next, effects };
}

/** The host whose entries this page accepts: the best known authority, hosting, with a beat from it. */
export function followedHost(state: ElectionState): Followed | null {
	const lead = leader(state);
	return lead?.kind === "direct" && lead.role === "host" && state.known
		? { auth: state.known, peer: lead.peer }
		: null;
}

export function electionView(state: ElectionState): ElectionView {
	const { mode } = state;
	if (mode.kind === "superseded") return { phase: "superseded" };
	if (mode.kind === "hosting") return { phase: "host" };
	if (mode.kind === "claiming") return { phase: "becoming-host", self: true };
	if (!state.online) return { phase: "connecting" };
	const lead = leader(state);
	if (lead?.kind === "direct") {
		if (lead.role === "claiming")
			return { phase: "becoming-host", self: false };
		return { phase: state.self.seating ? "live" : "lobby" };
	}
	if (lead?.kind === "reported") return { phase: "host-unreachable" };
	if (
		state.self.seating === null &&
		state.heard.size === 0 &&
		state.absentMs >= NOBODY_MS
	) {
		return { phase: "nobody-here" };
	}
	const block = claimBlock(state);
	return {
		phase: "waiting-for-host",
		absentMs: state.absentMs,
		button:
			state.absentMs < BUTTON_MS
				? null
				: block === null
					? { enabled: true }
					: { enabled: false, reason: block },
	};
}

/** Moves the clocks to `now`, forgets beats older than HOST_LOST_MS, and restarts the clocks after a freeze. */
function advance(state: ElectionState, now: number): ElectionState {
	const dt = now - state.now;
	let heard = state.heard;
	for (const [peer, { at }] of state.heard) {
		if (now - at < HOST_LOST_MS) continue;
		if (heard === state.heard) heard = new Map(state.heard);
		(heard as Map<string, Heard>).delete(peer);
	}
	const moved = { ...state, now, heard };
	if (dt > LATE_TICK_MS) return { ...moved, absentMs: 0, onlineMs: 0 };
	if (!state.online) return moved;
	const absent = state.mode.kind === "idle" && leader(moved) === null;
	return {
		...moved,
		onlineMs: state.onlineMs + dt,
		absentMs: absent ? state.absentMs + dt : state.absentMs,
	};
}

function apply(
	state: ElectionState,
	event: ElectionEvent,
	effects: ElectionEffect[],
): ElectionState {
	switch (event.type) {
		case "tick":
			return state;
		case "beat":
			return learnBeat(state, event.peer, event.beat);
		case "join":
			effects.push({ type: "beat", to: event.peer, beat: beatOf(state) });
			return state;
		case "leave": {
			const heard = new Map(state.heard);
			heard.delete(event.peer);
			return { ...state, heard };
		}
		case "network":
			return {
				...state,
				online: event.online,
				absentMs: event.online && !state.online ? 0 : state.absentMs,
			};
		case "wake":
			return { ...state, absentMs: 0 };
		case "self":
			return learnSelf(state, event.self);
		case "click": {
			const view = electionView(state);
			const enabled =
				view.phase === "waiting-for-host" && view.button?.enabled === true;
			return enabled
				? startClaim(state, newAuthority(state), true, effects)
				: state;
		}
		case "pulled":
			return claimIs(state, event.auth, false)
				? beginStore(state, effects)
				: state;
		case "stored":
			if (!claimIs(state, event.auth, true)) return state;
			if (!event.ok) return sendBeat({ ...state, mode: IDLE }, effects);
			effects.push({ type: "host", auth: event.auth });
			return sendBeat(
				{ ...state, mode: { kind: "hosting", auth: event.auth }, absentMs: 0 },
				effects,
			);
		case "lock-lost":
			if (state.mode.kind === "hosting") {
				effects.push({ type: "step-down", auth: state.mode.auth });
			}
			return { ...state, mode: { kind: "superseded" } };
	}
}

/** Rules 4 and 8–10: step down, finish the claim pull, resume, or volunteer; then the periodic beat. */
function decide(
	state: ElectionState,
	effects: ElectionEffect[],
): ElectionState {
	let next = state;
	const { mode } = state;
	if (mode.kind === "hosting" || mode.kind === "claiming") {
		if (
			compareAuthority(state.known, mode.auth) > 0 ||
			!isEligible(state.self)
		) {
			if (mode.kind === "hosting") {
				effects.push({ type: "step-down", auth: mode.auth });
			}
			return sendBeat({ ...state, mode: IDLE }, effects);
		}
		if (
			mode.kind === "claiming" &&
			!mode.storing &&
			state.now - mode.since >= CLAIM_PULL_MS
		) {
			next = beginStore(state, effects);
		}
	} else if (mode.kind === "idle") {
		next = considerClaim(state, effects);
	}
	if (
		next.mode.kind !== "superseded" &&
		(next.lastBeatAt === null || next.now - next.lastBeatAt >= BEAT_MS)
	) {
		next = sendBeat(next, effects);
	}
	return next;
}

function considerClaim(
	state: ElectionState,
	effects: ElectionEffect[],
): ElectionState {
	const { seating } = state.self;
	if (state.resumePending) {
		if (!state.online || state.onlineMs < RESUME_ONLINE_MS) return state;
		const done = { ...state, resumePending: false };
		const resume = resumeAuthority(done);
		return resume ? startClaim(done, resume, false, effects) : done;
	}
	if (seating === null || claimBlock(state) !== null) return state;
	const due = VOLUNTEER_MS + STAGGER_MS * rank(state, seating);
	return state.absentMs >= due
		? startClaim(state, newAuthority(state), true, effects)
		: state;
}

/** Rule 10: the stored host is this page's tag, and nothing better is known. */
function resumeAuthority(state: ElectionState): Authority | null {
	const { seating } = state.self;
	const host = seating?.host ?? null;
	if (seating === null || host === null || !isEligible(state.self)) return null;
	if (host.tag !== ownTag(state.self) || !sameAuthority(state.known, host)) {
		return null;
	}
	const inc = Math.max(seating.inc, host.inc) + 1;
	return inc > MAX_TERM ? null : { term: host.term, tag: host.tag, inc };
}

/** Rule 9: one term above every known authority, and the next incarnation. */
function newAuthority(state: ElectionState): Authority {
	const { seating } = state.self;
	const tag = ownTag(state.self);
	if (seating === null || tag === null) throw new Error("a claim needs a seat");
	return {
		term: (state.known?.term ?? 0) + 1,
		tag,
		inc: seating.inc + 1,
	};
}

function startClaim(
	state: ElectionState,
	auth: Authority,
	pull: boolean,
	effects: ElectionEffect[],
): ElectionState {
	const claiming = sendBeat(
		{
			...state,
			mode: { kind: "claiming", auth, since: state.now, storing: false },
			known: auth,
			knownSeenAt: null,
		},
		effects,
	);
	const source = pull ? pullSource(claiming) : null;
	if (source === null) return beginStore(claiming, effects);
	effects.push({ type: "pull", auth, peer: source });
	return claiming;
}

function beginStore(
	state: ElectionState,
	effects: ElectionEffect[],
): ElectionState {
	if (state.mode.kind !== "claiming") return state;
	effects.push({ type: "store", auth: state.mode.auth });
	return { ...state, mode: { ...state.mode, storing: true } };
}

function claimIs(
	state: ElectionState,
	auth: Authority,
	storing: boolean,
): boolean {
	const { mode } = state;
	return (
		mode.kind === "claiming" &&
		mode.storing === storing &&
		sameAuthority(mode.auth, auth)
	);
}

function learnBeat(
	state: ElectionState,
	peer: string,
	beat: Beat,
): ElectionState {
	const heard = new Map(state.heard).set(peer, { beat, at: state.now });
	const learned = learn(state, [beat.auth, beat.pos?.lastAuth]);
	const leads = beat.role === "host" || beat.role === "claiming";
	const direct = leads && beat.auth && sameAuthority(beat.auth, learned.known);
	return {
		...learned,
		heard,
		knownSeenAt: direct ? state.now : learned.knownSeenAt,
	};
}

function learnSelf(state: ElectionState, self: SelfFacts): ElectionState {
	if (self.holder !== state.self.holder) {
		throw new Error("the holder of a page cannot change");
	}
	return learn({ ...state, self }, [
		self.seating?.host,
		self.seating?.pos.lastAuth,
	]);
}

function learn(
	state: ElectionState,
	authorities: readonly (Authority | null | undefined)[],
): ElectionState {
	let { known, knownSeenAt } = state;
	for (const auth of authorities) {
		if (auth && compareAuthority(auth, known) > 0) {
			known = auth;
			knownSeenAt = null;
		}
	}
	return { ...state, known, knownSeenAt };
}

/**
 * Evidence for the best known authority (rule 2): a beat from its own page, or a first-hand report that is still
 * younger than HOST_LOST_MS. A page never follows its own tag: a sibling tab with that tag holds the seat lock.
 */
function leader(state: ElectionState): Lead | null {
	const { known } = state;
	if (state.mode.kind !== "idle" || known === null) return null;
	if (known.tag === ownTag(state.self)) return null;
	let direct: { peer: string; role: "host" | "claiming"; at: number } | null =
		null;
	let reported = false;
	for (const [peer, { beat, at }] of state.heard) {
		if (!beat.auth || !sameAuthority(beat.auth, known)) continue;
		if (beat.role === "host" || beat.role === "claiming") {
			if (direct === null || at > direct.at) {
				direct = { peer, role: beat.role, at };
			}
		} else if (
			beat.seenAgoMs !== undefined &&
			beat.seenAgoMs + state.now - at < HOST_LOST_MS
		) {
			reported = true;
		}
	}
	if (direct) return { kind: "direct", peer: direct.peer, role: direct.role };
	return reported ? { kind: "reported" } : null;
}

function claimBlock(state: ElectionState): HostBlock | null {
	const { seating } = state.self;
	if (state.self.hostEligible === false) return "ineligible";
	if (seating === null || !seating.bound) return "seat";
	if (!seating.persistent || !seating.writable) return "storage";
	if ((state.known?.term ?? 0) >= MAX_TERM || seating.inc >= MAX_TERM) {
		return "limit";
	}
	for (const { beat } of state.heard.values()) {
		if (beat.holder !== state.self.holder) return null;
	}
	return "witness";
}

/** Rule 8: the eligible peers with a better position, or an equal position and a lower tag, go first. */
function rank(state: ElectionState, seating: Seating): number {
	const tag = makeTag(state.self.holder, seating.seat);
	const ahead = new Set<string>();
	for (const { beat } of state.heard.values()) {
		if (!beat.elig || beat.seat === undefined || beat.pos === undefined) {
			continue;
		}
		const other = makeTag(beat.holder, beat.seat);
		const order = comparePosition(beat.pos, seating.pos);
		if (other !== tag && (order > 0 || (order === 0 && other < tag))) {
			ahead.add(other);
		}
	}
	return ahead.size;
}

/** The peer with the best position, if it is strictly better than this replica's (rule 9). */
function pullSource(state: ElectionState): string | null {
	let source: string | null = null;
	let best = state.self.seating?.pos;
	if (best === undefined) return null;
	for (const [peer, { beat }] of state.heard) {
		if (beat.pos && comparePosition(beat.pos, best) > 0) {
			source = peer;
			best = beat.pos;
		}
	}
	return source;
}

function sendBeat(
	state: ElectionState,
	effects: ElectionEffect[],
): ElectionState {
	effects.push({ type: "beat", to: null, beat: beatOf(state) });
	return { ...state, lastBeatAt: state.now };
}

function beatOf(state: ElectionState): Beat {
	const { mode } = state;
	const { holder, seating } = state.self;
	if (mode.kind === "hosting" || mode.kind === "claiming") {
		if (seating === null) throw new Error("a host needs a seat");
		return {
			k: "beat",
			role: mode.kind === "hosting" ? "host" : "claiming",
			auth: mode.auth,
			pos: seating.pos,
			holder,
			seat: seating.seat,
			elig: true,
		};
	}
	const report =
		state.known === null
			? {}
			: {
					auth: state.known,
					seenAgoMs:
						state.knownSeenAt === null
							? MAX_TERM
							: Math.min(MAX_TERM, Math.floor(state.now - state.knownSeenAt)),
				};
	if (seating === null) {
		return { k: "beat", role: "visitor", holder, elig: false, ...report };
	}
	return {
		k: "beat",
		role: "follower",
		holder,
		seat: seating.seat,
		pos: seating.pos,
		elig: isEligible(state.self),
		...report,
	};
}

function isEligible(self: SelfFacts): boolean {
	const { seating } = self;
	return (
		self.hostEligible !== false &&
		seating?.bound === true &&
		seating.persistent &&
		seating.writable
	);
}

function ownTag(self: SelfFacts): string | null {
	return self.seating ? makeTag(self.holder, self.seating.seat) : null;
}

function better(a: Authority | null, b: Authority | null): Authority | null {
	return compareAuthority(a, b) >= 0 ? a : b;
}

function sameFollowed(a: Followed | null, b: Followed | null): boolean {
	if (a === null || b === null) return a === b;
	return a.peer === b.peer && sameAuthority(a.auth, b.auth);
}
