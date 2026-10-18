# ADR 0001: Room link as the only key, plain JSON state, RPC-only writes

Status: accepted (2026-10-18); superseded by [ADR 0004](0004-p2p-table-elected-host.md) (2026-10-19).
The trust model stays: the link is the only key, and the players do not cheat.
The Supabase tables, the row-level security and the RPC functions are no longer used.

## Context

The handover (`bridge-connection-test-handover.md`) asks for per-seat bearer tokens, hashed token storage, private hands and a host-only checkpoint.
The owner decided on 2026-10-18 that players do not cheat, so the game state can be plain JSON that every room member can read.
The owner also decided that one room link is the key: the creator predefines a name per seat, and a visitor picks a seat.
The picker shows only available seats.
A seat becomes available again when its holder is unseen for up to 3 minutes, or when the host releases it.
Reopening the link in the same browser must give the same seat back, for example after Android suspends the tab.

Strangers who do not have a link must stay locked out.
The project is a Supabase Free project with a public publishable key, so any security property must hold against arbitrary calls with that key.

## Decision

- The room ID is 128 bits from the platform CSPRNG (22 base64url characters) and is the only capability.
  There are no seat tokens, so nothing is hashed or stored as a secret.
- The full room state is one `jsonb` column on `public.rooms`, written only by the host through `commit_command`.
  The commands table doubles as the event log: an accepted command carries the host-built event and `event_seq` equal to the revision it produced.
- Clients never write tables.
  Every change is a `SECURITY DEFINER` function with an empty `search_path`, explicit `EXECUTE` grants to `authenticated` only, and expected outcomes returned as JSON codes (`taken`, `superseded`, `conflict`, `unavailable`, `invalid`, `rate_limited`).
- Read access is row-level security on all four tables through `private.is_member`, which checks a permanent `room_members` row and room expiry.
  The membership row stays after a takeover, so an evicted tab still receives the seat UPDATE that tells it to become read-only.
- `claim_seat` enforces availability in the database: unclaimed, already held by the caller, unseen for `seatTimeoutSec` (30–180 s, default 180), or released by the host.
  The holding tab sends `heartbeat` every minute (more often for short timeouts); the same call records the delivered revision.
- Each claim creates a new seat generation, and every write checks (seat, user, generation), so exactly one tab can act for a seat.
- Rooms expire 24 hours after the last activity in database time; a pg_cron job deletes expired rooms every 15 minutes, and the cascade removes their rows.

## Consequences

- Any room member can read every hand through the API; the UI shows only the own hand and the exposed dummy.
  The owner accepted this.
- A link holder can take an unattended seat (unseen for the timeout), including the host seat.
  This is how a player recovers on another device without the host.
- Seat heartbeats produce one seats UPDATE per seat per minute in Realtime; this is well inside the Free quota for four players.
- A former seat holder keeps read access to that room until it expires.
- Realtime postgres_changes delivers only rows that the subscriber may select, so the design depends on RLS-filtered Realtime.
  Increment 3 tests this on the hosted project; the fallback is database Broadcast to a `room:<id>` topic.

## Alternatives Considered

- **Per-seat tokens (handover):** stronger seat binding, but the owner rejected tokens as unnecessary for trusted players, and they add hashing, storage and recovery links.
- **Separate events table and private per-seat views:** needed only to hide hands; it doubles the writes and the RLS surface without an owner-requested benefit.
- **Presence-only availability:** Realtime presence is not visible to the database, so `claim_seat` could not enforce it; a heartbeat column can.
- **Direct table writes with RLS insert/update policies:** fewer functions, but the invariants (revision order, generation checks, idempotent commit) need row locks and multi-row updates that policies cannot express.
