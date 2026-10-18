import type { Seat } from "../protocol";
import { derivePairRoomId } from "./keys";
import {
	MAX_PAIR_ROOMS,
	PAIR_RETRY_MAX_MS,
	PAIR_RETRY_MS,
	PAIR_TIMEOUT_MS,
} from "./limits";

/**
 * Two-page Trystero rooms that repair the table's mesh (deviation from plan §4.2, "one joinRoom per page").
 * A tracker sends each announce, with one shared offer, to a few peers and repeats it only every 120 s, so in a
 * room of four pages some links stay missing for minutes. Two pages that miss each other join a room that only
 * they can name, and it connects during Trystero's first announces. Trystero shares one connection per peer
 * between the rooms of a page, so the table room attaches to the new connection; the pair room is left when the
 * table room has admitted the peer.
 *
 * A pair is named by two peer ids (a neighbour, usually the host, listed the other peer) or by two seats (a
 * seated page misses the peer of another held seat: at a new page load, after a reload of the other page, or
 * after a network change). No connection detail is stored: the seats are in the replica already.
 */

export function peerRendezvous(a: string, b: string): string {
	return a < b ? `peer|${a}|${b}` : `peer|${b}|${a}`;
}

export function seatRendezvous(a: Seat, b: Seat): string {
	return a < b ? `seat|${a}|${b}` : `seat|${b}|${a}`;
}

/** The wait after `failures` pair rooms in a row without a link: 30 s, doubling, at most 120 s. */
export function pairRetryMs(failures: number): number {
	return Math.min(
		PAIR_RETRY_MAX_MS,
		PAIR_RETRY_MS * 2 ** Math.max(0, failures - 1),
	);
}

/** The part of a Trystero room that a pair needs. */
export interface PairRoom {
	onPeerJoin: ((peerId: string) => void) | null;
	leave(): Promise<void>;
}

export interface RendezvousDeps {
	/** The link key K; the pair room names derive from it. Never logged. */
	readonly key: string;
	/** Joins the Trystero room `roomId` with the table room's settings and password. */
	readonly join: (roomId: string) => PairRoom;
}

export interface RendezvousCounts {
	/** Pair rooms open now. */
	readonly open: number;
	/** Peers that a pair room connected and the table room then admitted. */
	readonly repaired: number;
	/** Pair rooms closed after PAIR_TIMEOUT_MS without a link. */
	readonly timeouts: number;
	/** Of those, rooms that had connected their peer, which the table room did not admit. */
	readonly unattached: number;
}

interface Pair {
	room: PairRoom | null;
	openedAt: number;
	/** The peer that this pair's room connected. While the table room has it, the pair needs no room. */
	found: string | null;
	failures: number;
	retryAt: number;
	/** What the caller knows of the other side, such as the peer bound to the other seat. */
	epoch: string;
}

export class Rendezvous {
	readonly #deps: RendezvousDeps;
	readonly #pairs = new Map<string, Pair>();
	readonly #roomIds = new Map<string, string>();
	readonly #deriving = new Set<string>();
	#repaired = 0;
	#timeouts = 0;
	#unattached = 0;
	#closed = false;

	constructor(deps: RendezvousDeps) {
		this.#deps = deps;
	}

	/**
	 * Opens a room for each wanted pair that has no link, and closes the rooms that did their work, timed out or
	 * are no longer wanted. `wanted` maps each pair to its epoch: when the epoch changes, for example because the
	 * other seat has a new page, the pair's retries start again and an open room gets a full PAIR_TIMEOUT_MS, so
	 * both sides are in the room at the same time. `admitted` holds the table room's peers. True when a count
	 * changed.
	 */
	tick(
		now: number,
		wanted: ReadonlyMap<string, string>,
		admitted: ReadonlySet<string>,
	): boolean {
		if (this.#closed) return false;
		let changed = false;
		for (const [name, pair] of this.#pairs) {
			if (wanted.has(name)) continue;
			// A peer pair stops being wanted as soon as the table room admits the peer.
			if (pair.room && pair.found !== null && admitted.has(pair.found)) {
				this.#repaired++;
			}
			changed = this.#close(pair) || changed;
			this.#pairs.delete(name);
			this.#roomIds.delete(name);
		}
		for (const [name, epoch] of wanted) {
			const pair = this.#pair(name, epoch);
			if (pair.epoch !== epoch) {
				pair.epoch = epoch;
				pair.failures = 0;
				pair.retryAt = 0;
				pair.openedAt = now;
			}
			const linked = pair.found !== null && admitted.has(pair.found);
			if (pair.room) {
				if (linked) {
					this.#repaired++;
					pair.failures = 0;
					pair.retryAt = 0;
					changed = this.#close(pair) || changed;
				} else if (now - pair.openedAt >= PAIR_TIMEOUT_MS) {
					this.#timeouts++;
					if (pair.found !== null) this.#unattached++;
					pair.failures++;
					pair.retryAt = now + pairRetryMs(pair.failures);
					pair.found = null;
					changed = this.#close(pair) || changed;
				}
				continue;
			}
			if (linked) continue;
			pair.found = null;
			if (now < pair.retryAt || this.#openRooms() >= MAX_PAIR_ROOMS) continue;
			const roomId = this.#roomId(name);
			if (roomId === undefined) continue;
			const room = this.#deps.join(roomId);
			pair.room = room;
			pair.openedAt = now;
			room.onPeerJoin = (peer) => {
				pair.found = peer;
			};
			changed = true;
		}
		return changed;
	}

	counts(): RendezvousCounts {
		return {
			open: this.#openRooms(),
			repaired: this.#repaired,
			timeouts: this.#timeouts,
			unattached: this.#unattached,
		};
	}

	close(): void {
		this.#closed = true;
		for (const pair of this.#pairs.values()) this.#close(pair);
		this.#pairs.clear();
	}

	// -------------------------------------------------------------------------------------------------------

	#pair(name: string, epoch: string): Pair {
		const known = this.#pairs.get(name);
		if (known) return known;
		const pair: Pair = {
			room: null,
			openedAt: 0,
			found: null,
			failures: 0,
			retryAt: 0,
			epoch,
		};
		this.#pairs.set(name, pair);
		return pair;
	}

	/** The room id, or undefined while SHA-256 derives it; a later tick opens the room. */
	#roomId(name: string): string | undefined {
		const known = this.#roomIds.get(name);
		if (known !== undefined || this.#deriving.has(name)) return known;
		this.#deriving.add(name);
		void derivePairRoomId(this.#deps.key, name).then((roomId) => {
			this.#deriving.delete(name);
			if (this.#pairs.has(name)) this.#roomIds.set(name, roomId);
		});
		return undefined;
	}

	#openRooms(): number {
		let open = 0;
		for (const pair of this.#pairs.values()) if (pair.room) open++;
		return open;
	}

	#close(pair: Pair): boolean {
		const room = pair.room;
		if (!room) return false;
		pair.room = null;
		room.onPeerJoin = null;
		void room.leave();
		return true;
	}
}
