import { isNonNegativeInteger, isObject } from "../protocol";
import { isTag } from "./keys";
import { MAX_LOG_ENTRIES, MAX_TERM } from "./limits";

/**
 * Host authority and log position. One authority writes each log entry once, at
 * the end of its own log, so two logs with the same (seq, auth) entry are equal up to that entry.
 */

export interface Authority {
	readonly term: number;
	/** Holder and seat of the host (`keys.makeTag`). */
	readonly tag: string;
	/** Incarnation: increased on every claim and resume, so two tabs with one tag differ. */
	readonly inc: number;
}

export interface Position {
	/** The number of entries in the log. */
	readonly rev: number;
	/** The authority of entry `rev`; null for an empty log. */
	readonly lastAuth: Authority | null;
}

export const EMPTY_POSITION: Position = { rev: 0, lastAuth: null };

function isCounter(value: unknown, max: number): value is number {
	return isNonNegativeInteger(value) && value <= max;
}

export function parseAuthority(value: unknown): Authority | undefined {
	if (!isObject(value)) return undefined;
	const { term, tag, inc } = value;
	if (!isCounter(term, MAX_TERM) || term < 1) return undefined;
	if (!isTag(tag) || !isCounter(inc, MAX_TERM) || inc < 1) return undefined;
	return { term, tag, inc };
}

export function parsePosition(value: unknown): Position | undefined {
	if (!isObject(value) || !isCounter(value.rev, MAX_LOG_ENTRIES)) {
		return undefined;
	}
	const { rev } = value;
	if (rev === 0) return value.lastAuth === null ? EMPTY_POSITION : undefined;
	const lastAuth = parseAuthority(value.lastAuth);
	return lastAuth && { rev, lastAuth };
}

/** Positive when `a` beats `b`: higher term, then lower tag, then higher incarnation. Null loses to any. */
export function compareAuthority(
	a: Authority | null,
	b: Authority | null,
): number {
	if (a === null || b === null)
		return (a === null ? 0 : 1) - (b === null ? 0 : 1);
	if (a.term !== b.term) return a.term - b.term;
	if (a.tag !== b.tag) return a.tag < b.tag ? 1 : -1;
	return a.inc - b.inc;
}

export function sameAuthority(
	a: Authority | null,
	b: Authority | null,
): boolean {
	return compareAuthority(a, b) === 0;
}

/** Positive when log position `a` is better: a better last authority, then more entries. */
export function comparePosition(a: Position, b: Position): number {
	const byAuthority = compareAuthority(a.lastAuth, b.lastAuth);
	return byAuthority !== 0 ? byAuthority : a.rev - b.rev;
}
