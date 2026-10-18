# ADR 0003: Call signaling through a database function into private per-holder inboxes

Status: accepted (2026-10-18); amended by [ADR 0004](0004-p2p-table-elected-host.md) (2026-10-19).
The call messages now go over the table's WebRTC data channels, and the receiver takes the sender's seat from the host's roster.
The consent rules of this ADR stay; the database function and the inboxes are no longer used.

## Context

The room call (call/layout handover §5) needs a signaling path for WebRTC: join announcements, preferences, offers, answers and ICE candidates.
ICE candidates contain IP addresses, so they must reach only the addressed peer.
The handover requires that a member cannot send as another seat, and that a superseded tab cannot keep sending.

Supabase Realtime Authorization uses row-level security on `realtime.messages`: SELECT gives the right to receive on a private topic, and INSERT gives the right to send.
Realtime computes these rights at join time and caches them for the connection until a new access token arrives.
So an INSERT policy that checks the seat generation does not see a takeover while the old connection stays open.

The owner chose option B, "every message through the database" (decision D1, 2026-10-18), with the costs below stated in the option:

| Option | What it gives | What it costs |
| --- | --- | --- |
| A. Private per-seat topics with an INSERT policy | Clients broadcast directly. | Send rights stay cached per connection, so a superseded tab can send until it reconnects. |
| **B. A database function sends (chosen)** | The seat and generation are checked on every message. | One HTTP request and one database row per delivery. The rows stay in `realtime.messages` for 72 hours to 4 days. |
| C. A public room topic with the sender in the payload | No SQL. | Any link holder can claim to be any seat; this does not meet the handover. |

## Decision

Migration `supabase/migrations/20261018000002_call_signaling.sql`:

- Each seat holder in a call receives on its own private **inbox** topic `call:<roomId>:<seat>:<generation>`, event `call`.
- The SELECT policy "call: the inbox holder receives" on `realtime.messages` lets only the current holder of that seat at that generation, in an unexpired room, join and receive.
  `private.can_receive_call` checks the topic against a strict pattern before the integer cast, so a malformed topic gives "refused" and not an error inside the policy.
- There is no INSERT policy, so no client can publish to any inbox through the WebSocket or the REST broadcast API.
- `public.send_call_signal(room, seat, generation, to, message)` is the only writer.
  It checks the caller's seat and generation with `private.holds_seat` on every message.
  It sets `v`, `roomId`, `from`, `fromGen` and `toGen` itself and writes one message to the current inbox of each target.
  `to` null means every other current holder; offers, answers and ICE batches must name `to`.
  It validates the message: a JSON object of at most 49 152 octets (48 KiB) with a known `type`.
  It does not count as room activity.
- **Invariant:** no `public` function or trigger passes a caller-controlled topic to `realtime.send`.
  `send_call_signal` is the only caller, and it builds the topic from stored rows.
  Review each later migration against this invariant.
- **Deliberate deviation from handover §5:** there is no call presence.
  Presence on private topics needs a second pair of policies and has its own project limit of 20 messages per second.
  The room presence that already exists gives the online signal, and the `join` and `resync` messages give discovery.
  Do not "fix" this by adding call presence without a new decision.

Why one inbox per recipient and not one room topic for B: offers, answers and candidates reach only the addressed peer; a superseded holder's old inbox gets no new messages, because the function always writes to the current generation; each client has one call channel instead of four.

Hosted evidence (2026-10-18, `tests/integration/call-signal.test.ts`, details in [test results of the Supabase version](../test-results-supabase.md)):

- Before the apply (P0), the function did not exist and a holder's private join was refused.
- After the apply, P1–P11 pass, and each refusal has an allowed control.
  A forged sender seat, a stranger, an old generation and a released seat get `superseded` or a refused join, and nothing is delivered.
  A REST publish with `private=true` is refused with a session and with the publishable key alone; the same publish to a public namesake topic is delivered.
  The Data API does not expose `realtime.send` or `realtime.messages` (PGRST106).
- From the start of the function call to the delivery at the receiver: median 71 ms, maximum 94 ms over 10 trials.

Facts found by the probe that the client (increment C4) must handle:

- `realtime.send` adds the stored message's `id` to the payload, so the received envelope has the keys `from`, `fromGen`, `id`, `message`, `roomId`, `toGen` and `v`.
- A refused join takes about 4 s (median 4059 ms over 6 trials).
  Six parallel refused joins on one connection gave 2 refusals and 4 client timeouts (10 s); one at a time, all 6 were refusals.
  My inference: the server answers the joins of one connection in order.
- After a refused join, realtime-js 2.118.0 tries again (2 CHANNEL_ERROR statuses in 12 s, state `joining`), so the client must remove the channel itself after the first refusal.

## Consequences

- Every call message costs one RPC and one database transaction; a four-player join sends about 34 messages (an estimate; increment C5b measures it).
  All rooms share the Free plan's 100 Realtime messages per second, and the database has no rate limit for call messages (the players are trusted).
- **Retention (residual risk R6):** the stored messages, including SDP and ICE candidates with IP addresses, stay in `realtime.messages` for 72 hours to 4 days.
  Project administrators can read them; clients cannot.
- `realtime.send` catches its own errors, so the sender cannot see a lost message.
  The client recovers with one addressed `resync` per silent seat (call/layout plan §4.4).
- The policy applies to every private channel of the project.
  This project had no other private channels when the migration was applied.
- A refused join delays later joins on the same connection by about 4 s, if the inference above is correct.
  The client joins only its own inbox, which is allowed while it holds the seat.

Rollback (owner approval required, applied in the SQL Editor):

```sql
begin;
drop policy "call: the inbox holder receives" on realtime.messages;
drop function public.send_call_signal(text, text, integer, text, jsonb);
drop function private.can_receive_call(text);
commit;
```

## Alternatives Considered

- **A. Private per-seat topics with an INSERT policy.** Faster, but send rights are cached per connection, so a superseded tab can send until it reconnects.
- **C. A public room topic with the sender in the payload.** No SQL, but any link holder can send as any seat; it does not meet the handover.
- **One room topic for B.** Fewer topics, but every member receives every candidate, and a superseded holder keeps receiving until it leaves.
- **Realtime replay instead of `resync`.** Recovery from stored messages after a reconnect. Rejected: more moving parts for the same recovery, and replay needs a stored-message position per client.
