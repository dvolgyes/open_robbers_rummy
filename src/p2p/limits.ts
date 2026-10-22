/** Every timer and cap of the peer-to-peer table (plan §5). In-page timers use `performance.now()`. */

// Election (plan §4.4).
/** Every page sends a beat this often; a host, or a seat's peer, is offline after HOST_LOST_MS without one. */
export const BEAT_MS = 10_000;
export const HOST_LOST_MS = 20_000;
/** A seat whose holder has been unseen this long is free for any other browser (plan §4.6). A fixed limit, not a setting. */
export const SEAT_HOLD_MS = 180_000;
/** A seat whose holder has been offline this long is free. Covers a short WebRTC drop: Trystero reports a leave only after its 5 s disconnect timer, and a page that returns is found again by re-announcement. */
export const SEAT_GRACE_MS = 15_000;
export const BUTTON_MS = 10_000;
export const VOLUNTEER_MS = 30_000;
export const STAGGER_MS = 1_500;
export const CLAIM_PULL_MS = 3_000;
export const RESUME_ONLINE_MS = 3_000;
/** A timer tick this late means the tab was frozen; the absence clock starts again. */
export const LATE_TICK_MS = 5_000;
/** The controller steps the election at least this often. */
export const TICK_MS = 500;

// Connection checks and failure states (plan §4.9).
export const PING_COUNT = 3;
export const PING_TIMEOUT_MS = 5_000;
export const NOBODY_MS = 10_000;
export const CONNECTION_FAILED_MS = 20_000;
export const MAX_PEERS = 12;

// Mesh repair (src/p2p/rendezvous.ts). Trackers re-announce a room only every 120 s, so a missing link is
// repaired in a two-page room, which connects during Trystero's first announces.
/** Each page sends its peer list this often, and at once when the list changes. */
export const LINKS_MS = 5_000;
/** A peer that a neighbour listed stays a repair target this long without a new list. */
export const LINK_TARGET_MS = 30_000;
export const MAX_PAIR_ROOMS = 4;
export const PAIR_TIMEOUT_MS = 30_000;
export const PAIR_RETRY_MS = 30_000;
export const PAIR_RETRY_MAX_MS = 120_000;
/**
 * A page without links leaves and joins the table room again after this long alone, for a new offer and
 * Trystero's first announces: 10 s, doubling, at most 60 s. Each tracker sends an offer to a few peers only, and
 * they can be frozen pages or pages that left the room.
 */
export const REJOIN_MS = 10_000;
export const REJOIN_MAX_MS = 60_000;

// Replication (plan §4.5).
export const ACK_DEBOUNCE_MS = 1_000;
export const GAP_WAIT_MS = 1_500;
export const SYNC_TIMEOUT_MS = 5_000;
export const ROSTER_COALESCE_MS = 1_000;
/** Visitors get the lobby again this often, because seats time out without a message. */
export const LOBBY_REFRESH_MS = 5_000;
export const RESULT_TIMEOUT_MS = 10_000;
/** A command that waits for absent players goes again this often, so it lands soon after they come back. */
export const WAITING_RETRY_MS = 2_000;
export const EARLY_ENTRIES = 64;

// Expiry (plan §4.7).
export const TABLE_IDLE_MS = 24 * 60 * 60 * 1_000;
export const CLEANUP_MS = 60_000;
export const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1_000;

// Trystero receive caps, checked before a message is buffered (plan §4.2).
export const MAX_RECEIVE_BYTES = 1024 * 1024;
export const CTL_BYTES = 8 * 1024;
export const LOG_BYTES = 256 * 1024;
export const CALL_BYTES = 64 * 1024;
export const MESH_BYTES = 2 * 1024;

// Field caps (plan §5). MAX_PAGE_BYTES bounds a whole sync page, including the state on its last page, so a page
// fits in LOG_BYTES; an entry message (payload, event and state) fits as well.
export const MAX_PAYLOAD_BYTES = 4_096;
export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_STATE_BYTES = 128 * 1024;
export const MAX_PAGE_ENTRIES = 200;
export const MAX_PAGE_BYTES = 192 * 1024;
export const MAX_REASON_LENGTH = 200;
export const MAX_PENDING_PER_SEAT = 50;
export const MAX_OUTBOX = 50;
export const MAX_LOG_ENTRIES = 20_000;
export const MAX_TERM = 2 ** 31 - 1;
/** Nesting depth of a payload, event or state; a canasta match state uses about 6. */
export const MAX_JSON_DEPTH = 32;

// Rate limits (plan §5).
export const CTL_PER_SECOND = 50;
