import { PING_COUNT, PING_TIMEOUT_MS } from "./limits";
import type { Clock } from "./ports";
import type { Echo, Ping } from "./wire";

/**
 * The connection check: after a peer connects, the page sends PING_COUNT pings with random nonces
 * and expects every matching echo within PING_TIMEOUT_MS. Only then is the peer "ready". The candidate types of
 * the selected pair are read from `getStats()`; no address ever leaves this module.
 */

export type PeerCheck =
	| { readonly state: "checking" }
	| { readonly state: "ready"; readonly rttMs: number }
	| { readonly state: "failed" };

export interface CheckDeps {
	readonly ping: (peer: string, message: Ping) => void;
	readonly clock: Clock;
	/** A random nonce of 8–32 characters from [A-Za-z0-9_-]. */
	readonly nonce: () => string;
	/** A peer's state changed. */
	readonly change: (peer: string) => void;
}

interface Probe {
	readonly started: number;
	readonly sentAt: Map<string, number>;
	readonly rtts: number[];
	result: PeerCheck;
}

export class ConnectionChecks {
	readonly #deps: CheckDeps;
	readonly #probes = new Map<string, Probe>();

	constructor(deps: CheckDeps) {
		this.#deps = deps;
	}

	/** Starts (or restarts, after a reconnect) the check of one peer. */
	start(peer: string): void {
		const now = this.#deps.clock.monotonic();
		const probe: Probe = {
			started: now,
			sentAt: new Map(),
			rtts: [],
			result: { state: "checking" },
		};
		this.#probes.set(peer, probe);
		for (let i = 0; i < PING_COUNT; i++) {
			const n = this.#deps.nonce();
			probe.sentAt.set(n, now);
			this.#deps.ping(peer, { k: "ping", n });
		}
		this.#deps.change(peer);
	}

	/** The reply to a ping from a peer: the same nonce, sent back. */
	static echoOf(ping: Ping): Echo {
		return { k: "echo", n: ping.n };
	}

	/** An echo arrived. Unknown or repeated nonces have no effect. */
	echo(peer: string, echo: Echo): void {
		const probe = this.#probes.get(peer);
		const sentAt = probe?.sentAt.get(echo.n);
		if (probe === undefined || sentAt === undefined) return;
		if (probe.result.state !== "checking") return;
		probe.sentAt.delete(echo.n);
		probe.rtts.push(this.#deps.clock.monotonic() - sentAt);
		if (probe.sentAt.size > 0) return;
		const sorted = [...probe.rtts].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
		probe.result = { state: "ready", rttMs: Math.round(median) };
		this.#deps.change(peer);
	}

	forget(peer: string): void {
		this.#probes.delete(peer);
	}

	/** Marks checks that ran out of time as failed. */
	tick(): void {
		const now = this.#deps.clock.monotonic();
		for (const [peer, probe] of this.#probes) {
			if (
				probe.result.state === "checking" &&
				now - probe.started >= PING_TIMEOUT_MS
			) {
				probe.result = { state: "failed" };
				this.#deps.change(peer);
			}
		}
	}

	state(peer: string): PeerCheck | undefined {
		return this.#probes.get(peer)?.result;
	}

	ready(peer: string): boolean {
		return this.#probes.get(peer)?.result.state === "ready";
	}
}

/** ICE candidate types (RFC 8445 §5.1.1.1); never an address. */
export type CandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";

export interface PathTypes {
	readonly local: CandidateType;
	readonly remote: CandidateType;
}

type StatsEntry = Readonly<Record<string, unknown>>;

const CANDIDATE_TYPES: ReadonlySet<string> = new Set([
	"host",
	"srflx",
	"prflx",
	"relay",
]);

function candidateType(entry: StatsEntry | undefined): CandidateType {
	const type = entry?.candidateType;
	return typeof type === "string" && CANDIDATE_TYPES.has(type)
		? (type as CandidateType)
		: "unknown";
}

/**
 * The candidate types of the selected pair, from a `getStats()` report, or null when no pair is selected yet.
 * Only the `candidateType` field of a candidate is read.
 */
export function selectedPath(report: Iterable<StatsEntry>): PathTypes | null {
	const entries = [...report];
	const byId = new Map<unknown, StatsEntry>(
		entries.map((entry) => [entry.id, entry]),
	);
	const transport = entries.find(
		(entry) =>
			entry.type === "transport" &&
			typeof entry.selectedCandidatePairId === "string",
	);
	const pair =
		(transport && byId.get(transport.selectedCandidatePairId)) ??
		entries.find(
			(entry) =>
				entry.type === "candidate-pair" &&
				entry.nominated === true &&
				entry.state === "succeeded",
		);
	if (pair === undefined) return null;
	return {
		local: candidateType(byId.get(pair.localCandidateId)),
		remote: candidateType(byId.get(pair.remoteCandidateId)),
	};
}

/** Whether STUN found a public address for this page: one of its local candidates is server-reflexive. */
export function hasPublicAddress(report: Iterable<StatsEntry>): boolean {
	for (const entry of report) {
		if (entry.type === "local-candidate" && entry.candidateType === "srflx")
			return true;
	}
	return false;
}

/** Reads the selected path of a connection; a failed `getStats()` gives null. */
export async function connectionPath(connection: RTCPeerConnection): Promise<{
	readonly path: PathTypes | null;
	readonly publicAddress: boolean;
}> {
	const report = await connection.getStats().then(
		(stats) => [...stats.values()] as StatsEntry[],
		() => [] as StatsEntry[],
	);
	return {
		path: selectedPath(report),
		publicAddress: hasPublicAddress(report),
	};
}

/** The nonce source for production: 16 random bytes in base64url (22 characters). */
export function randomNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
