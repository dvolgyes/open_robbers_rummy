import {
	isObject,
	isSeat,
	type JsonObject,
	PROTOCOL_VERSION,
	type Seat,
} from "../protocol";
import type { Form } from "./device-class";
import { parsePrefs } from "./messages";
import {
	join,
	MEDIA,
	type Medium,
	type Prefs,
	type Switches,
	samePrefs,
} from "./policy";

/**
 * A seat's call status in the replicated table: in the call or not, the switches, and the form. Every
 * seated browser keeps it with the game state, so a reload, a crash or a host change does not lose it. A change
 * needs a higher version than the stored record; an equal or lower one is refused, so a late resend never wins.
 *
 * The record belongs to the person, not only to the seat: the host stores the holder of the seat with it, and a
 * page restores only a record of its own holder. So a browser that takes a released seat never joins the call,
 * and never opens a microphone, because of the previous player's status.
 */

export interface CallRecord {
	readonly version: number;
	readonly prefs: Prefs;
	readonly form: Form;
}

/** A record as the table stores it. */
export interface StoredCallRecord extends CallRecord {
	/** The holder of the seat when the host stored the record; the command never carries it. */
	readonly holder: string;
}

export type CallRecords = Partial<Record<Seat, StoredCallRecord>>;

export type CallRecordResult =
	| {
			readonly ok: true;
			readonly record: StoredCallRecord;
			readonly records: CallRecords;
	  }
	| { readonly ok: false; readonly reason: string };

/** Holders are short names (src/p2p/keys.ts); the table only needs to compare them. */
const MAX_HOLDER_LENGTH = 64;

function isVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isHolderText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_HOLDER_LENGTH
	);
}

/** A `media` command; the host takes the seat from the sender's binding. */
export function callRecordPayload(
	tableId: string,
	record: CallRecord,
): JsonObject {
	const { prefs } = record;
	return {
		v: PROTOCOL_VERSION,
		tableId,
		type: "media",
		version: record.version,
		prefs: {
			inCall: prefs.inCall,
			send: { audio: prefs.send.audio, video: prefs.send.video },
			receive: { audio: prefs.receive.audio, video: prefs.receive.video },
		},
		form: record.form,
	};
}

export function parseCallRecord(value: unknown): CallRecord | undefined {
	if (!isObject(value) || !isVersion(value.version)) return undefined;
	const prefs = parsePrefs(value.prefs);
	const { form } = value;
	if (prefs === undefined || (form !== "desktop" && form !== "compact")) {
		return undefined;
	}
	return { version: value.version, prefs, form };
}

function parseStoredCallRecord(value: unknown): StoredCallRecord | undefined {
	const record = parseCallRecord(value);
	if (record === undefined || !isObject(value) || !isHolderText(value.holder))
		return undefined;
	return { ...record, holder: value.holder };
}

/** Stored records; a key that is not a seat, or one invalid record, makes the whole value invalid. */
export function parseCallRecords(value: unknown): CallRecords | undefined {
	if (!isObject(value)) return undefined;
	const records: { [S in Seat]?: StoredCallRecord } = {};
	for (const [key, item] of Object.entries(value)) {
		const record = parseStoredCallRecord(item);
		if (!isSeat(key) || record === undefined) return undefined;
		records[key] = record;
	}
	return records;
}

/** The records after a `media` command from `seat`, which `holder` holds. */
export function applyCallRecord(
	records: CallRecords,
	seat: Seat,
	holder: string,
	payload: JsonObject,
): CallRecordResult {
	const parsed = parseCallRecord(payload);
	if (parsed === undefined || !isHolderText(holder)) {
		return { ok: false, reason: "not a valid call status" };
	}
	const stored = records[seat];
	if (stored !== undefined && stored.version >= parsed.version) {
		return { ok: false, reason: "a newer call status is stored" };
	}
	const record = { ...parsed, holder };
	return { ok: true, record, records: { ...records, [seat]: record } };
}

/** The `media` commands among this page's own commands that are not in the log yet. */
export function pendingCallRecords(
	payloads: readonly JsonObject[],
): CallRecord[] {
	return payloads.flatMap((payload) => {
		const record =
			payload.type === "media" ? parseCallRecord(payload) : undefined;
		return record === undefined ? [] : [record];
	});
}

/**
 * This browser's last call status for its seat: the newest of the stored record, when this holder wrote it, and
 * the own records still waiting in the outbox. A record of another holder is never this browser's status.
 */
export function ownCallRecord(
	stored: StoredCallRecord | undefined,
	holder: string,
	pending: readonly CallRecord[],
): CallRecord | undefined {
	const own = stored !== undefined && stored.holder === holder ? [stored] : [];
	let newest: CallRecord | undefined;
	for (const record of [...own, ...pending]) {
		if (newest === undefined || record.version > newest.version)
			newest = record;
	}
	return newest;
}

/**
 * The version for a new record: above the stored one, whoever wrote it, and above each own record still waiting
 * to be sent.
 */
export function nextCallVersion(
	stored: CallRecord | undefined,
	pending: readonly number[],
): number {
	return Math.max(stored?.version ?? 0, ...pending) + 1;
}

/**
 * The record to store for this browser's call status now, or undefined when its newest own record already says
 * the same. A browser that has no record and is outside the call stores nothing.
 */
export function callRecordFor(
	stored: StoredCallRecord | undefined,
	holder: string,
	pending: readonly CallRecord[],
	prefs: Prefs,
	form: Form,
): CallRecord | undefined {
	const own = ownCallRecord(stored, holder, pending);
	const same =
		own === undefined
			? !prefs.inCall
			: samePrefs(own.prefs, prefs) && own.form === form;
	if (same) return undefined;
	const version = nextCallVersion(
		stored,
		pending.map((record) => record.version),
	);
	return { version, prefs, form };
}

export interface CallRestore {
	/** The switches to join with, without the ones this device does not support. */
	readonly selection: Switches;
	/** The devices that the join captures: each medium whose Send switch is on. */
	readonly devices: readonly Medium[];
}

/** How this device joins again from its own record; undefined when the record is outside the call or absent. */
export function callRestore(
	own: CallRecord | undefined,
	form: Form,
): CallRestore | undefined {
	if (own === undefined || !own.prefs.inCall) return undefined;
	const prefs = join(own.prefs, form);
	if (!prefs.inCall) return undefined;
	return {
		selection: { send: prefs.send, receive: prefs.receive },
		devices: MEDIA.filter((medium) => prefs.send[medium]),
	};
}
