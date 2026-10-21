import { base64url, platformRandomBytes, type RandomBytes } from "../ids";
import { isSeat, type Seat } from "../protocol";

/**
 * Identifiers derived with SHA-256 (plan §4.1, §4.3). They are names, not secrets or signatures: the table key
 * K stays the only secret, and the Trystero password (K) is the only access control at the transport.
 */

const CLIENT_ID_BYTES = 16;
const TABLE_ID_LENGTH = 22;
const HOLDER_LENGTH = 16;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const HOLDER_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const TAG_PATTERN = /^[A-Za-z0-9_-]{16}\.[NESW]$/;

async function digest(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	return base64url(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
	);
}

/** The Trystero room and storage name of the table; it satisfies `isRoomId`. */
export async function deriveTableId(key: string): Promise<string> {
	return (await digest(`open-canasta|table|${key}`)).slice(0, TABLE_ID_LENGTH);
}

/** The Trystero room in which two pages of the table meet (`rendezvous.ts`). Only pages with K can derive it. */
export async function derivePairRoomId(
	key: string,
	name: string,
): Promise<string> {
	return (await digest(`open-canasta|pair|${key}|${name}`)).slice(
		0,
		TABLE_ID_LENGTH,
	);
}

/** The per-browser, per-table identity that seat ownership and host tags use. */
export async function deriveHolder(
	tableId: string,
	clientId: string,
): Promise<string> {
	return (await digest(`oc-holder|${tableId}|${clientId}`)).slice(
		0,
		HOLDER_LENGTH,
	);
}

export function newClientId(
	randomBytes: RandomBytes = platformRandomBytes,
): string {
	const bytes = randomBytes(CLIENT_ID_BYTES);
	if (bytes.length !== CLIENT_ID_BYTES) {
		throw new Error(`expected ${CLIENT_ID_BYTES} random bytes`);
	}
	return base64url(bytes);
}

export function isClientId(value: unknown): value is string {
	return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

export function isHolder(value: unknown): value is string {
	return typeof value === "string" && HOLDER_PATTERN.test(value);
}

/** A host candidate: holder and seat. Tags compare as strings, so every browser orders them the same way. */
export function makeTag(holder: string, seat: Seat): string {
	if (!isHolder(holder) || !isSeat(seat)) throw new Error("invalid host tag");
	return `${holder}.${seat}`;
}

export function isTag(value: unknown): value is string {
	return typeof value === "string" && TAG_PATTERN.test(value);
}

export function tagSeat(tag: string): Seat {
	const seat = tag.slice(-1);
	if (!isTag(tag) || !isSeat(seat)) throw new Error("invalid host tag");
	return seat;
}

export function tagHolder(tag: string): string {
	if (!isTag(tag)) throw new Error("invalid host tag");
	return tag.slice(0, HOLDER_LENGTH);
}
