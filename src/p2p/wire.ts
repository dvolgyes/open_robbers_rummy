import {
	type CallMessage,
	MAX_GENERATION,
	parseCallMessage,
} from "../call/messages";
import { isCommandId } from "../ids";
import {
	isNonNegativeInteger,
	isObject,
	isSeat,
	type JsonObject,
	MAX_NAME_LENGTH,
	parseRoomConfig,
	type RoomConfig,
	SEATS,
	type Seat,
} from "../protocol";
import {
	type Authority,
	compareAuthority,
	type Position,
	parseAuthority,
	parsePosition,
	sameAuthority,
} from "./authority";
import { isClientId, isHolder, makeTag } from "./keys";
import {
	MAX_EVENT_BYTES,
	MAX_JSON_DEPTH,
	MAX_LOG_ENTRIES,
	MAX_PAGE_BYTES,
	MAX_PAGE_ENTRIES,
	MAX_PAYLOAD_BYTES,
	MAX_PEERS,
	MAX_REASON_LENGTH,
	MAX_STATE_BYTES,
	MAX_TERM,
} from "./limits";

/**
 * Peer-to-peer messages (plan §5). Every message is `{v: 1, t: tableId, k: kind, ...}`. A message from a peer is
 * untrusted until a parser here accepts it: each parser rebuilds the value from the known fields, so unknown
 * fields never pass through. The parsers check structure and size only; who may send what is the receiver's
 * check. Deviation from the plan table: sync replies carry the request number `req`, and the replace snapshot
 * carries no state, because the last page of every sync reply carries it.
 */

export const WIRE_VERSION = 1;

export type Rejection = "malformed" | "incompatible" | "foreign";

export type Parsed<T> =
	| { readonly ok: true; readonly message: T }
	| { readonly ok: false; readonly reason: Rejection };

export type Role = "host" | "claiming" | "follower" | "visitor";

export interface Hello {
	readonly k: "hello";
	/** The sender's link version (`LINK_VERSION`). */
	readonly b: string;
	readonly client: string;
	readonly seat?: Seat;
	readonly gen?: number;
	readonly pos?: Position;
	/** Optional application features supported by this page. */
	readonly features?: readonly string[];
}

export type WelcomeStatus =
	| "bound"
	| "unseated"
	| "superseded"
	| "expired"
	| "incompatible";

export interface Welcome {
	readonly k: "welcome";
	readonly status: WelcomeStatus;
	readonly auth: Authority;
	readonly seat?: Seat;
	readonly gen?: number;
}

export interface LobbySeat {
	readonly seat: Seat;
	/** Free, released, timed out, or held by the receiver's own holder. */
	readonly available: boolean;
	readonly online: boolean;
	readonly mine: boolean;
}

export interface Lobby {
	readonly k: "lobby";
	readonly auth: Authority;
	readonly config: RoomConfig;
	readonly idleMs: number;
	readonly seats: readonly LobbySeat[];
}

export interface ClaimSeat {
	readonly k: "claim-seat";
	readonly req: number;
	readonly seat: Seat;
}

export type SeatCode = "taken" | "invalid" | "expired" | "storage" | "not_host";

export type SeatResult =
	| {
			readonly k: "seat-result";
			readonly req: number;
			readonly ok: true;
			readonly seat: Seat;
			readonly gen: number;
	  }
	| {
			readonly k: "seat-result";
			readonly req: number;
			readonly ok: false;
			readonly code: SeatCode;
	  };

export interface Release {
	readonly k: "release";
	readonly req: number;
	readonly seat: Seat;
}

export type ReleaseCode =
	| "online"
	| "unseated"
	| "invalid"
	| "storage"
	| "not_host";

export type ReleaseResult =
	| { readonly k: "release-result"; readonly req: number; readonly ok: true }
	| {
			readonly k: "release-result";
			readonly req: number;
			readonly ok: false;
			readonly code: ReleaseCode;
	  };

export interface Beat {
	readonly k: "beat";
	readonly role: Role;
	/** For a host or claimer its own authority; otherwise the best authority the sender knows of. */
	readonly auth?: Authority;
	/**
	 * Age of the sender's own last beat from `auth` (MAX_TERM if it never had one); present exactly when a follower
	 * or visitor has `auth`. Never relayed, so it is first-hand host evidence.
	 */
	readonly seenAgoMs?: number;
	readonly pos?: Position;
	readonly holder: string;
	readonly seat?: Seat;
	readonly elig: boolean;
}

export interface Ping {
	readonly k: "ping";
	readonly n: string;
}

export interface Echo {
	readonly k: "echo";
	readonly n: string;
}

export interface Command {
	readonly k: "cmd";
	readonly id: string;
	readonly gen: number;
	readonly payload: JsonObject;
}

export type CommandStatus =
	| "accepted"
	| "rejected"
	/** The game needs a player who is not present; the sender keeps the command and sends it again. */
	| "waiting"
	| "invalid"
	| "superseded"
	| "expired"
	| "storage"
	| "busy"
	| "full"
	| "not_host";

export interface CommandResult {
	readonly k: "result";
	readonly id: string;
	readonly status: CommandStatus;
	/** Present exactly when the command is accepted. */
	readonly seq?: number;
	/** Required for a rejected or waiting command. */
	readonly reason?: string;
}

export interface Ack {
	readonly k: "ack";
	readonly rev: number;
}

export interface SeatHolder {
	readonly seat: Seat;
	readonly holder: string | null;
	/** 0 before the first claim; each claim and release adds 1. */
	readonly gen: number;
}

export interface RosterSeat extends SeatHolder {
	/** The latest revision the seat holder acknowledged. */
	readonly acked: number;
}

export interface Binding {
	readonly peer: string;
	readonly seat: Seat;
	readonly gen: number;
}

export interface Roster {
	readonly k: "roster";
	readonly auth: Authority;
	readonly seats: readonly RosterSeat[];
	/** The peers that hold the current generation of a seat. */
	readonly peers: readonly Binding[];
	/** Bot seats currently controlled inside the host page, without a separate peer connection. */
	readonly bots: readonly Seat[];
	/** This host understands player autoplay requests. */
	readonly autoplay?: boolean;
}

export type AutoplayStatus = "enabled" | "disabled" | "unavailable" | "failed";

export interface AutoplayRequest {
	readonly k: "autoplay-request";
	readonly req: number;
	readonly enabled: boolean;
}

export interface AutoplayResult {
	readonly k: "autoplay-result";
	readonly req: number;
	readonly status: AutoplayStatus;
}

export interface Sync {
	readonly k: "sync";
	readonly req: number;
	/** The requester's position; the reply holds the entries after it. */
	readonly pos: Position;
}

export interface Behind {
	readonly k: "behind";
	readonly req: number;
	/** The responder's position, which is shorter than the request's. */
	readonly pos: Position;
}

export type GoneReason = "expired" | "full";

export interface Gone {
	readonly k: "gone";
	readonly reason: GoneReason;
}

export type CtlMessage =
	| Hello
	| Welcome
	| Lobby
	| ClaimSeat
	| SeatResult
	| Release
	| ReleaseResult
	| Beat
	| Ping
	| Echo
	| Command
	| CommandResult
	| Ack
	| Roster
	| AutoplayRequest
	| AutoplayResult
	| Sync
	| Behind
	| Gone;

export type SeatOp =
	| { readonly type: "claim"; readonly holder: string }
	| { readonly type: "release"; readonly by: Seat };

interface EntryBase {
	readonly seq: number;
	/** The authority that wrote this entry. */
	readonly auth: Authority;
	/** The authority of entry `seq - 1`; null for entry 1. */
	readonly prevAuth: Authority | null;
	readonly id: string;
	/** For a command, the sender's seat; for a seat entry, the seat it changes. */
	readonly seat: Seat;
	/** For a command, the sender's generation; for a seat entry, the seat's new generation. */
	readonly gen: number;
	readonly event: JsonObject;
}

export type Entry =
	| (EntryBase & { readonly kind: "cmd"; readonly payload: JsonObject })
	| (EntryBase & { readonly kind: "seat"; readonly op: SeatOp });

export interface EntryMessage {
	readonly k: "entry";
	readonly e: Entry;
	/** The state after the entry; a deal is random, so followers cannot recompute it. */
	readonly state: JsonObject;
}

export interface Page {
	readonly k: "page";
	readonly req: number;
	/** The authority the responder follows or is; null for a responder without a host. */
	readonly auth: Authority | null;
	/** The position after which `entries` start. */
	readonly base: Position;
	readonly entries: readonly Entry[];
	readonly last: boolean;
	/** The state after the last entry; present exactly on the last page. */
	readonly state?: JsonObject;
}

export interface Snapshot {
	readonly k: "snap";
	readonly req: number;
	readonly auth: Authority | null;
	readonly mode: "replace";
	readonly config: RoomConfig;
	readonly seats: readonly SeatHolder[];
	/** The responder's position; pages from the empty position up to it follow. */
	readonly pos: Position;
	readonly idleMs: number;
}

export type LogMessage = EntryMessage | Page | Snapshot;

export interface CallFrame {
	readonly k: "call";
	readonly to: Seat;
	readonly toGen: number;
	readonly fromGen: number;
	readonly msg: CallMessage;
}

/** The sender's connected peers, so that a receiver finds the links it misses (mesh repair). */
export interface Links {
	readonly k: "links";
	readonly peers: readonly string[];
}

export type MeshMessage = Links;

export type Framed<M> = M & {
	readonly v: typeof WIRE_VERSION;
	readonly t: string;
};

export function frame<M extends { readonly k: string }>(
	tableId: string,
	message: M,
): Framed<M> {
	return { ...message, v: WIRE_VERSION, t: tableId };
}

// ---------------------------------------------------------------------------------------------------------------
// JSON size and depth

/** True when `value` nests at most `maxDepth` levels of arrays and objects. Checked before any serialization. */
export function withinDepth(value: unknown, maxDepth: number): boolean {
	if (typeof value !== "object" || value === null) return true;
	if (maxDepth === 0) return false;
	const children = Array.isArray(value) ? value : Object.values(value);
	return children.every((child) => withinDepth(child, maxDepth - 1));
}

/** UTF-8 length of the JSON text; call only after `withinDepth`. */
export function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isJsonObjectWithin(
	value: unknown,
	maxBytes: number,
): value is JsonObject {
	return (
		isObject(value) &&
		withinDepth(value, MAX_JSON_DEPTH) &&
		jsonBytes(value) <= maxBytes
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Field parsers

const VERSION_PATTERN = /^[A-Za-z0-9.-]{1,16}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;
/** Trystero `selfId`: 20 characters from [0-9A-Za-z]. */
const PEER_ID_PATTERN = /^[0-9A-Za-z]{20}$/;

export function isPeerId(value: unknown): value is string {
	return typeof value === "string" && PEER_ID_PATTERN.test(value);
}

function isIntegerIn(
	value: unknown,
	min: number,
	max: number,
): value is number {
	return isNonNegativeInteger(value) && value >= min && value <= max;
}

function isGeneration(value: unknown): value is number {
	return isIntegerIn(value, 1, MAX_GENERATION);
}

function isSeatGeneration(value: unknown): value is number {
	return isIntegerIn(value, 0, MAX_GENERATION);
}

function isRequest(value: unknown): value is number {
	return isIntegerIn(value, 1, MAX_TERM);
}

function isRevision(value: unknown): value is number {
	return isIntegerIn(value, 0, MAX_LOG_ENTRIES);
}

function isSequence(value: unknown): value is number {
	return isIntegerIn(value, 1, MAX_LOG_ENTRIES);
}

function isDuration(value: unknown): value is number {
	return isIntegerIn(value, 0, Number.MAX_SAFE_INTEGER);
}

function isReason(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_REASON_LENGTH
	);
}

function parseFeatures(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length > 8) return undefined;
	if (
		!value.every(
			(item) => typeof item === "string" && /^[a-z0-9-]{1,32}$/.test(item),
		) ||
		new Set(value).size !== value.length
	)
		return undefined;
	return [...value];
}

function isOneOf<T extends string>(
	values: readonly T[],
	value: unknown,
): value is T {
	return (
		typeof value === "string" && (values as readonly string[]).includes(value)
	);
}

/** An optional field is absent; `null` and other values are not absence. */
function isAbsent(record: JsonObject, key: string): boolean {
	return !Object.hasOwn(record, key) || record[key] === undefined;
}

/** Null for an absent field, undefined for an invalid one. */
function optionalField<T>(
	record: JsonObject,
	key: string,
	parse: (value: unknown) => T | undefined,
): T | null | undefined {
	return isAbsent(record, key) ? null : parse(record[key]);
}

function seatOf(value: unknown): Seat | undefined {
	return isSeat(value) ? value : undefined;
}

function ageOf(value: unknown): number | undefined {
	return isIntegerIn(value, 0, MAX_TERM) ? value : undefined;
}

/** The room configuration with the create form's limits (src/ui/model.ts `checkCreateFields`). */
export function parseTableConfig(value: unknown): RoomConfig | undefined {
	const config = parseRoomConfig(value);
	if (config === undefined) return undefined;
	for (const seat of SEATS) {
		const name = config.names[seat];
		if (name.trim() !== name || Array.from(name).length > MAX_NAME_LENGTH) {
			return undefined;
		}
	}
	return config;
}

/** A list with one item per seat, in `SEATS` order. */
function parseSeatList<T extends { readonly seat: Seat }>(
	value: unknown,
	parseItem: (item: JsonObject) => T | undefined,
): T[] | undefined {
	if (!Array.isArray(value) || value.length !== SEATS.length) return undefined;
	const items: T[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isObject(raw) || raw.seat !== SEATS[index]) return undefined;
		const item = parseItem(raw);
		if (item === undefined) return undefined;
		items.push(item);
	}
	return items;
}

function parseSeatHolder(item: JsonObject): SeatHolder | undefined {
	const { seat, holder, gen } = item;
	if (!isSeat(seat) || !isSeatGeneration(gen)) return undefined;
	if (holder !== null && !isHolder(holder)) return undefined;
	return { seat, holder, gen };
}

/** The holder and generation of each seat, in `SEATS` order. */
export function parseSeatHolders(value: unknown): SeatHolder[] | undefined {
	return parseSeatList(value, parseSeatHolder);
}

function parseRosterSeat(item: JsonObject): RosterSeat | undefined {
	const base = parseSeatHolder(item);
	return base && isRevision(item.acked)
		? { ...base, acked: item.acked }
		: undefined;
}

function parseLobbySeat(item: JsonObject): LobbySeat | undefined {
	const { seat, available, online, mine } = item;
	if (
		!isSeat(seat) ||
		typeof available !== "boolean" ||
		typeof online !== "boolean" ||
		typeof mine !== "boolean"
	) {
		return undefined;
	}
	return { seat, available, online, mine };
}

/** Bindings are unique per peer and per seat, and name the seat's current holder generation. */
function parseBindings(
	value: unknown,
	seats: readonly SeatHolder[],
): Binding[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_PEERS) return undefined;
	const bindings: Binding[] = [];
	const peers = new Set<string>();
	const bound = new Set<Seat>();
	for (const raw of value) {
		if (!isObject(raw)) return undefined;
		const { peer, seat, gen } = raw;
		if (!isPeerId(peer) || !isSeat(seat) || !isGeneration(gen))
			return undefined;
		const holder = seats.find((row) => row.seat === seat);
		if (holder?.holder == null || holder.gen !== gen) return undefined;
		if (peers.has(peer) || bound.has(seat)) return undefined;
		peers.add(peer);
		bound.add(seat);
		bindings.push({ peer, seat, gen });
	}
	return bindings;
}

function parseSeatOp(value: unknown): SeatOp | undefined {
	if (!isObject(value)) return undefined;
	if (value.type === "claim") {
		return isHolder(value.holder)
			? { type: "claim", holder: value.holder }
			: undefined;
	}
	if (value.type === "release") {
		return isSeat(value.by) ? { type: "release", by: value.by } : undefined;
	}
	return undefined;
}

/** One log entry. Authorities never decrease along a log, so `prevAuth` must not beat `auth`. */
export function parseEntry(value: unknown): Entry | undefined {
	if (!isObject(value)) return undefined;
	const { seq, id, seat, gen, kind, event } = value;
	if (
		!isSequence(seq) ||
		!isCommandId(id) ||
		!isSeat(seat) ||
		!isGeneration(gen)
	)
		return undefined;
	const auth = parseAuthority(value.auth);
	if (auth === undefined) return undefined;
	let prevAuth: Authority | null = null;
	if (seq === 1) {
		if (value.prevAuth !== null) return undefined;
	} else {
		const previous = parseAuthority(value.prevAuth);
		if (previous === undefined || compareAuthority(previous, auth) > 0)
			return undefined;
		prevAuth = previous;
	}
	if (!isJsonObjectWithin(event, MAX_EVENT_BYTES)) return undefined;
	const base = { seq, auth, prevAuth, id, seat, gen, event };
	if (kind === "cmd") {
		const { payload } = value;
		return isJsonObjectWithin(payload, MAX_PAYLOAD_BYTES)
			? { ...base, kind, payload }
			: undefined;
	}
	if (kind === "seat") {
		const op = parseSeatOp(value.op);
		return op && { ...base, kind, op };
	}
	return undefined;
}

/** Entries that continue `base` without a gap, each linked to the one before by `prevAuth`. */
function parseEntries(value: unknown, base: Position): Entry[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_PAGE_ENTRIES)
		return undefined;
	const entries: Entry[] = [];
	let previous: Position = base;
	for (const raw of value) {
		const entry = parseEntry(raw);
		if (
			entry === undefined ||
			entry.seq !== previous.rev + 1 ||
			!sameAuthority(entry.prevAuth, previous.lastAuth)
		) {
			return undefined;
		}
		entries.push(entry);
		previous = { rev: entry.seq, lastAuth: entry.auth };
	}
	return entries;
}

function parseOptionalAuthority(value: unknown): Authority | null | undefined {
	return value === null ? null : parseAuthority(value);
}

// ---------------------------------------------------------------------------------------------------------------
// Message parsers: each returns undefined for a malformed message of its kind.

type Parser<T> = (value: JsonObject) => T | undefined;

const WELCOME_STATUSES: readonly WelcomeStatus[] = [
	"bound",
	"unseated",
	"superseded",
	"expired",
	"incompatible",
];
const SEAT_CODES: readonly SeatCode[] = [
	"taken",
	"invalid",
	"expired",
	"storage",
	"not_host",
];
const RELEASE_CODES: readonly ReleaseCode[] = [
	"online",
	"unseated",
	"invalid",
	"storage",
	"not_host",
];
const ROLES: readonly Role[] = ["host", "claiming", "follower", "visitor"];
const COMMAND_STATUSES: readonly CommandStatus[] = [
	"accepted",
	"rejected",
	"waiting",
	"invalid",
	"superseded",
	"expired",
	"storage",
	"busy",
	"full",
	"not_host",
];
const GONE_REASONS: readonly GoneReason[] = ["expired", "full"];

/** An optional seat and generation: both absent, or both valid. */
function parseSeatPair(
	value: JsonObject,
): { seat?: Seat; gen?: number } | undefined {
	if (isAbsent(value, "seat") && isAbsent(value, "gen")) return {};
	const { seat, gen } = value;
	return isSeat(seat) && isGeneration(gen) ? { seat, gen } : undefined;
}

const parseHello: Parser<Hello> = (value) => {
	const { b, client } = value;
	if (typeof b !== "string" || !VERSION_PATTERN.test(b) || !isClientId(client))
		return undefined;
	const pair = parseSeatPair(value);
	if (pair === undefined) return undefined;
	const pos = optionalField(value, "pos", parsePosition);
	const features = optionalField(value, "features", parseFeatures);
	if (pos === undefined || features === undefined) return undefined;
	return {
		k: "hello",
		b,
		client,
		...pair,
		...(pos === null ? {} : { pos }),
		...(features === null ? {} : { features }),
	};
};

const parseWelcome: Parser<Welcome> = (value) => {
	const { status } = value;
	const auth = parseAuthority(value.auth);
	const pair = parseSeatPair(value);
	if (!isOneOf(WELCOME_STATUSES, status) || auth === undefined || !pair)
		return undefined;
	if (status === "bound" && pair.seat === undefined) return undefined;
	return { k: "welcome", status, auth, ...pair };
};

const parseLobby: Parser<Lobby> = (value) => {
	const auth = parseAuthority(value.auth);
	const config = parseTableConfig(value.config);
	const seats = parseSeatList(value.seats, parseLobbySeat);
	const { idleMs } = value;
	if (!auth || !config || !seats || !isDuration(idleMs)) return undefined;
	return { k: "lobby", auth, config, idleMs, seats };
};

const parseClaimSeat: Parser<ClaimSeat> = (value) => {
	const { req, seat } = value;
	return isRequest(req) && isSeat(seat)
		? { k: "claim-seat", req, seat }
		: undefined;
};

const parseSeatResult: Parser<SeatResult> = (value) => {
	const { req, ok, seat, gen, code } = value;
	if (!isRequest(req)) return undefined;
	if (ok === true) {
		return isSeat(seat) && isGeneration(gen)
			? { k: "seat-result", req, ok, seat, gen }
			: undefined;
	}
	return ok === false && isOneOf(SEAT_CODES, code)
		? { k: "seat-result", req, ok, code }
		: undefined;
};

const parseRelease: Parser<Release> = (value) => {
	const { req, seat } = value;
	return isRequest(req) && isSeat(seat)
		? { k: "release", req, seat }
		: undefined;
};

const parseReleaseResult: Parser<ReleaseResult> = (value) => {
	const { req, ok, code } = value;
	if (!isRequest(req)) return undefined;
	if (ok === true) return { k: "release-result", req, ok };
	return ok === false && isOneOf(RELEASE_CODES, code)
		? { k: "release-result", req, ok, code }
		: undefined;
};

/**
 * A host or claimer names its own authority, whose tag is its holder and seat, and is eligible. A follower
 * holds a seat and a replica. A visitor holds neither. `seenAgoMs` comes with a followed authority only.
 */
const parseBeat: Parser<Beat> = (value) => {
	const { role, holder, elig } = value;
	if (!isOneOf(ROLES, role) || !isHolder(holder) || typeof elig !== "boolean")
		return undefined;
	const auth = optionalField(value, "auth", parseAuthority);
	const pos = optionalField(value, "pos", parsePosition);
	const seat = optionalField(value, "seat", seatOf);
	const seen = optionalField(value, "seenAgoMs", ageOf);
	if (auth === undefined || pos === undefined) return undefined;
	if (seat === undefined || seen === undefined) return undefined;
	const leads = role === "host" || role === "claiming";
	if (leads) {
		if (auth === null || seat === null || pos === null || seen !== null)
			return undefined;
		if (!elig || auth.tag !== makeTag(holder, seat)) return undefined;
	} else {
		if ((auth === null) !== (seen === null)) return undefined;
		if (role === "follower" && (seat === null || pos === null))
			return undefined;
		if (role === "visitor" && (seat !== null || pos !== null || elig))
			return undefined;
	}
	return {
		k: "beat",
		role,
		holder,
		elig,
		...(auth === null ? {} : { auth }),
		...(seen === null ? {} : { seenAgoMs: seen }),
		...(pos === null ? {} : { pos }),
		...(seat === null ? {} : { seat }),
	};
};

const parsePing: Parser<Ping> = (value) =>
	typeof value.n === "string" && NONCE_PATTERN.test(value.n)
		? { k: "ping", n: value.n }
		: undefined;

const parseEcho: Parser<Echo> = (value) =>
	typeof value.n === "string" && NONCE_PATTERN.test(value.n)
		? { k: "echo", n: value.n }
		: undefined;

const parseCommand: Parser<Command> = (value) => {
	const { id, gen, payload } = value;
	if (!isCommandId(id) || !isGeneration(gen)) return undefined;
	return isJsonObjectWithin(payload, MAX_PAYLOAD_BYTES)
		? { k: "cmd", id, gen, payload }
		: undefined;
};

const parseCommandResult: Parser<CommandResult> = (value) => {
	const { id, status, seq, reason } = value;
	if (!isCommandId(id) || !isOneOf(COMMAND_STATUSES, status)) return undefined;
	const hasSeq = !isAbsent(value, "seq");
	const hasReason = !isAbsent(value, "reason");
	if (hasSeq !== (status === "accepted")) return undefined;
	if (hasSeq && !isSequence(seq)) return undefined;
	const needsReason = status === "rejected" || status === "waiting";
	if (hasReason ? !isReason(reason) : needsReason) return undefined;
	return {
		k: "result",
		id,
		status,
		...(isSequence(seq) ? { seq } : {}),
		...(isReason(reason) ? { reason } : {}),
	};
};

const parseAck: Parser<Ack> = (value) =>
	isRevision(value.rev) ? { k: "ack", rev: value.rev } : undefined;

const parseRoster: Parser<Roster> = (value) => {
	const auth = parseAuthority(value.auth);
	const seats = parseSeatList(value.seats, parseRosterSeat);
	if (!auth || !seats) return undefined;
	const peers = parseBindings(value.peers, seats);
	const bots =
		value.bots === undefined
			? []
			: Array.isArray(value.bots) &&
					value.bots.every((seat) => isSeat(seat)) &&
					new Set(value.bots).size === value.bots.length &&
					value.bots.every((seat) =>
						seats.some((row) => row.seat === seat && row.holder !== null),
					)
				? [...value.bots]
				: undefined;
	if (
		!peers ||
		!bots ||
		(value.autoplay !== undefined && typeof value.autoplay !== "boolean")
	)
		return undefined;
	return {
		k: "roster",
		auth,
		seats,
		peers,
		bots,
		...(value.autoplay === true ? { autoplay: true } : {}),
	};
};

const parseAutoplayRequest: Parser<AutoplayRequest> = (value) =>
	isRequest(value.req) && typeof value.enabled === "boolean"
		? { k: "autoplay-request", req: value.req, enabled: value.enabled }
		: undefined;

const AUTOPLAY_STATUSES = [
	"enabled",
	"disabled",
	"unavailable",
	"failed",
] as const;

const parseAutoplayResult: Parser<AutoplayResult> = (value) =>
	isRequest(value.req) && isOneOf(AUTOPLAY_STATUSES, value.status)
		? { k: "autoplay-result", req: value.req, status: value.status }
		: undefined;

const parseSync: Parser<Sync> = (value) => {
	const pos = parsePosition(value.pos);
	return isRequest(value.req) && pos
		? { k: "sync", req: value.req, pos }
		: undefined;
};

const parseBehind: Parser<Behind> = (value) => {
	const pos = parsePosition(value.pos);
	return isRequest(value.req) && pos
		? { k: "behind", req: value.req, pos }
		: undefined;
};

const parseGone: Parser<Gone> = (value) =>
	isOneOf(GONE_REASONS, value.reason)
		? { k: "gone", reason: value.reason }
		: undefined;

const parseEntryMessage: Parser<EntryMessage> = (value) => {
	const e = parseEntry(value.e);
	return e && isJsonObjectWithin(value.state, MAX_STATE_BYTES)
		? { k: "entry", e, state: value.state }
		: undefined;
};

/** The whole page, state included, is at most MAX_PAGE_BYTES; the state is present exactly on the last page. */
const parsePage: Parser<Page> = (value) => {
	const { req, last, state } = value;
	const auth = parseOptionalAuthority(value.auth);
	const base = parsePosition(value.base);
	if (
		!isRequest(req) ||
		auth === undefined ||
		!base ||
		typeof last !== "boolean"
	)
		return undefined;
	const entries = parseEntries(value.entries, base);
	if (entries === undefined) return undefined;
	if (last !== !isAbsent(value, "state")) return undefined;
	if (last && !isJsonObjectWithin(state, MAX_STATE_BYTES)) return undefined;
	if (jsonBytes(value) > MAX_PAGE_BYTES) return undefined;
	return isObject(state)
		? { k: "page", req, auth, base, entries, last, state }
		: { k: "page", req, auth, base, entries, last };
};

const parseSnapshot: Parser<Snapshot> = (value) => {
	const { req, mode, idleMs } = value;
	const auth = parseOptionalAuthority(value.auth);
	const config = parseTableConfig(value.config);
	const seats = parseSeatHolders(value.seats);
	const pos = parsePosition(value.pos);
	if (!isRequest(req) || mode !== "replace" || auth === undefined)
		return undefined;
	if (!config || !seats || !pos || pos.rev === 0 || !isDuration(idleMs))
		return undefined;
	return { k: "snap", req, auth, mode, config, seats, pos, idleMs };
};

const parseCallFrame: Parser<CallFrame> = (value) => {
	const { to, toGen, fromGen } = value;
	if (!isSeat(to) || !isGeneration(toGen) || !isGeneration(fromGen))
		return undefined;
	const msg = parseCallMessage(value.msg);
	return msg && { k: "call", to, toGen, fromGen, msg };
};

const parseLinks: Parser<Links> = (value) => {
	const { peers } = value;
	if (!Array.isArray(peers) || peers.length > MAX_PEERS) return undefined;
	if (!peers.every(isPeerId) || new Set(peers).size !== peers.length)
		return undefined;
	return { k: "links", peers: [...peers] };
};

const CTL_PARSERS = new Map<string, Parser<CtlMessage>>([
	["hello", parseHello],
	["welcome", parseWelcome],
	["lobby", parseLobby],
	["claim-seat", parseClaimSeat],
	["seat-result", parseSeatResult],
	["release", parseRelease],
	["release-result", parseReleaseResult],
	["beat", parseBeat],
	["ping", parsePing],
	["echo", parseEcho],
	["cmd", parseCommand],
	["result", parseCommandResult],
	["ack", parseAck],
	["roster", parseRoster],
	["autoplay-request", parseAutoplayRequest],
	["autoplay-result", parseAutoplayResult],
	["sync", parseSync],
	["behind", parseBehind],
	["gone", parseGone],
]);

const LOG_PARSERS = new Map<string, Parser<LogMessage>>([
	["entry", parseEntryMessage],
	["page", parsePage],
	["snap", parseSnapshot],
]);

const CALL_PARSERS = new Map<string, Parser<CallFrame>>([
	["call", parseCallFrame],
]);

const MESH_PARSERS = new Map<string, Parser<MeshMessage>>([
	["links", parseLinks],
]);

/**
 * Checks the common header, then the kind. A message for another table is `foreign`; another wire version or an
 * unknown kind is `incompatible`; anything else that fails is `malformed`.
 */
function parseWith<T>(
	parsers: ReadonlyMap<string, Parser<T>>,
	value: unknown,
	tableId: string,
): Parsed<T> {
	if (!isObject(value) || typeof value.v !== "number")
		return { ok: false, reason: "malformed" };
	if (value.v !== WIRE_VERSION) return { ok: false, reason: "incompatible" };
	if (typeof value.k !== "string" || typeof value.t !== "string")
		return { ok: false, reason: "malformed" };
	if (value.t !== tableId) return { ok: false, reason: "foreign" };
	const parser = parsers.get(value.k);
	if (parser === undefined) return { ok: false, reason: "incompatible" };
	const message = withinDepth(value, MAX_JSON_DEPTH + 4)
		? parser(value)
		: undefined;
	return message === undefined
		? { ok: false, reason: "malformed" }
		: { ok: true, message };
}

export function parseCtl(value: unknown, tableId: string): Parsed<CtlMessage> {
	return parseWith(CTL_PARSERS, value, tableId);
}

export function parseLog(value: unknown, tableId: string): Parsed<LogMessage> {
	return parseWith(LOG_PARSERS, value, tableId);
}

export function parseCall(value: unknown, tableId: string): Parsed<CallFrame> {
	return parseWith(CALL_PARSERS, value, tableId);
}

export function parseMesh(
	value: unknown,
	tableId: string,
): Parsed<MeshMessage> {
	return parseWith(MESH_PARSERS, value, tableId);
}
