/** Expected failure codes, plus `network` (retry later) and `server` (unexpected response). */
export type FailureCode =
	| "unauthenticated"
	| "invalid"
	| "unavailable"
	| "taken"
	| "superseded"
	| "conflict"
	| "not_found"
	| "rejected"
	| "accepted"
	| "rate_limited"
	| "network"
	| "server";

export interface Failure {
	readonly ok: false;
	readonly code: FailureCode;
	readonly detail?: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

/** Failures worth retrying with the same arguments; every operation is idempotent for its inputs. */
export function isTransient(failure: Failure): boolean {
	return (
		failure.code === "network" ||
		failure.code === "server" ||
		failure.code === "rate_limited"
	);
}
