# ADR 0004: Peer-to-peer table with an elected host

Status: accepted (2026-10-19).
It supersedes [ADR 0001](0001-room-link-access-and-json-state.md) and amends [ADR 0003](0003-call-signaling-authorization.md).
Room URL setup and post-expiry bootstrap are amended by [ADR 0005](0005-reusable-room-link-bootstrap.md).
Amended for canasta on 2026-10-22: the table identifier prefix is now `open-canasta|table|`, and every game action needs all four seats (see the notes under Presence and the table identifier).

## Context

Until commit 09d887a, a hosted Supabase project kept the table state and relayed every command and call message.
The owner decided on 2026-10-19 to remove Supabase: the players find each other without a server of ours, and the game and the call go over WebRTC.
The owner set these targets:

- The creator gets one link, and all players use the same link.
- A person who opens the link takes a free seat.
- If no host is found in 10 s, the page shows a **Make me the host** button.
- If two hosts show up, a tiebreak picks one.
- If there is no host after 30 s, a player volunteers automatically.
- Connection loss and reconnection are tested; one remaining player is enough to restore the table, including the call status.
- Moves and settings are versioned, so a resend never doubles a move and nothing goes missing.
- A game action needs all players present; dummy may be away during the play, but a new deal waits for dummy.

The trust model of ADR 0001 stays: the players do not cheat, and the link is the only key.
The handover `bridge-supabase-to-p2p-migration.md` permits public WebTorrent trackers and public STUN servers, and forbids our own server, TURN and paid relays.

The discovery spike (`spikes/p2p-discovery`, commits c770ee1, 0be6ebe and 09d887a) gave this evidence:

- Cold discovery through the public trackers: 22 of 22 trials in less than 0.4 s.
- Rediscovery after a reload: 0.3–0.6 s.
- A wrong password does not connect.
- Established links survive a tracker outage.
- An Android phone on 4G connected directly to a desktop without TURN.

## Decision

Link and identity:

- The link is `<page>#v=p2p-v1&k=<K>`, where K is 32 bytes from the platform CSPRNG in base64url.
  The fragment never reaches the web server, and the code never logs K.
- The table identifier is the first 22 characters of base64url(SHA-256("libre-bridge|table|" + K)).
  Canasta amendment (2026-10-22): the prefix is now `"open-canasta|table|"` (`src/p2p/keys.ts`), so a bridge link and a canasta link never meet at the same table.
  SHA-256 derives identifiers only; there is no custom cryptography.
- Each browser has a random client identifier per table in localStorage.
  Only the host receives it, and the host derives the seat holder from it, so a player cannot copy another player's holder from the roster.

Transport:

- Trystero 0.26.0 (`@trystero-p2p/torrent`, pinned exactly) joins one room per table through the public WebTorrent trackers, with K as the room password.
  The trackers see only an info hash that Trystero derives from the app name and the table identifier, the clients' IP addresses and encrypted session descriptions.
- The pages form a full mesh of WebRTC data channels.
  Four actions carry all traffic: `lb-ctl` (control, 8 KiB), `lb-log` (log replication, 256 KiB), `lb-call` (call signaling, 64 KiB) and `lb-mesh` (peer lists for the mesh repair, 2 KiB).
  Every received message passes a validator before any use.
- Mesh repair (a deviation from one room per page): a tracker sends each announce to a few peers and repeats it only every 120 s, so in a room of four pages a link can stay missing for minutes.
  Two pages that miss each other join a Trystero room for only the two of them, which connects during the first announces.
  The pair is named by two peer identifiers (a neighbour listed the other peer, or the first WebRTC exchange failed) or by two seats (a seated page misses the page of another held seat).
  The pair room name is a SHA-256 hash of K and the pair name, so only key holders can name it.
  Trystero shares one connection per peer between the rooms of a page, so the table room attaches to the new connection, and the page then leaves the pair room.
  A pair room without a link closes after 30 s, and the next one opens after 30 s, doubling up to 120 s.
  When the roster binds the other seat to a new page, the seat pair starts again without the wait, so both pages are in the room at the same time.
  No connection detail is stored.
- Rejoin (also a deviation): a page without any link has no neighbour list and, as a visitor, no seat pair.
  After 10 s alone with a tracker open, it leaves the table room and joins it again with the same peer identifier, which makes a new offer and repeats Trystero's first announces; the wait doubles up to 60 s.
  The trackers send each offer to a few pages only, and they can be pages that cannot answer: a frozen tab, or a tab that left the room but keeps its tracker sockets.
  A rejoin drops the handshakes in progress in the room that the page leaves.
- The ICE servers are only the configured STUN servers (`VITE_STUN_URLS`); TURN URLs are refused.

State:

- Every seated browser keeps a full replica of the table in IndexedDB: the config, the log of entries, the latest state and the seats.
- The host orders the commands.
  Each log entry has a sequence number and the authority (term, tag, incarnation) of the host that wrote it.
  A follower applies only the next entry whose previous authority matches its own last entry, and fills a gap with a sync request, never with a resend.
- A guest command goes into the IndexedDB outbox before it is sent and keeps its identifier on every resend; the host deduplicates by that identifier.
- Each seat's call status (in the call, the four switches, the device form) is a versioned record in the replicated state.
  The page sends it as a command through the outbox, like a move; the host keeps it only when its version is higher than the stored one, and stores the seat holder with it.
  After a reload or a crash, a page restores only a record of its own holder, once.
  It joins the call on its own only when the browser already allows every device that the record sends; otherwise it offers "Rejoin the call".
- A table expires 24 hours after its last activity on each device; a tombstone keeps an expired link expired for 30 days.

Host election (a pure reducer, `src/p2p/election.ts`):

- Every page sends a beat every 10 s; a host counts as offline 20 s after its last beat.
- The button shows after 10 s without a host.
  It is enabled only when the page holds a seat, stores the table in IndexedDB, and a **witness** is connected: another browser at the table.
- At 30 s plus 1.5 s per rank, an eligible page with a witness volunteers automatically.
  The page with the best copy of the log has the first rank.
- A new host takes a term one above every term it knows, pulls a strictly better log from a connected peer first, and then stores its claim.
- Tiebreak: the higher term wins; for equal terms, the lower tag (holder and seat) wins; for equal tags, the higher incarnation wins.
  The entries of the losing host that the winner does not have are undone, and their senders see "Undone after a host change".
- The creator hosts term 1 at once, and a host that reloads resumes its own term without a witness.

Presence (owner requirement R4):

- A seat is present when its page is bound at the current seat generation, is connected to the host, and the host heard from it in the last 20 s, or when it is the host's own seat.
  The 20 s rule is necessary because a frozen page keeps its WebRTC link.
- A deal and a bid need all four seats; a card needs all seats except dummy.
  The host checks this in the bridge module and refuses with a reason such as "Waiting for South to come back"; the page disables the controls and shows the same text.
  Canasta amendment (2026-10-22): canasta has no dummy, so every game action, including the deal of the next hand, needs all four seats (`src/game/canasta.ts`).

Call signaling (amends ADR 0003):

- Call messages go over the `lb-call` data channel action to the peer bound to the target seat, never through a tracker or a database.
- The receiver takes the sender seat and generation from the host's roster binding of the sending peer, never from the message.
  A message from an unbound peer or an old generation is dropped.
- During a host change, the call keeps the last roster that it had, so the call between the remaining seats goes on.
- The consent rules of ADR 0003 and the call/layout handover stay: a receiver can ask its partner not to send video or audio, and the partner then sends no track for that pair.

## Consequences

- There is no server and no database: the app is a static site that needs only HTTPS hosting.
  The Supabase quotas and the stored call messages (ADR 0003, risk R6) no longer apply.
- Every seated browser stores all four hands; a player can read them with the developer tools, as with the database before.
- Peers see each other's IP addresses (WebRTC), and the trackers see the IP addresses of the clients that join.
- A tracker outage blocks new joins; the connected pages continue.
- Without TURN, a player without a direct path to the host cannot act.
- Residual risks of the election, accepted by the owner as the default D1:
  - Two browsers cut off together, or one browser and a newcomer, can start a new term.
    When the groups meet again, the entries of the losing group since the split are undone.
    Few entries are at risk, because the deal and the auction need all four seats.
  - Peers more than two links apart can each see a different host, because host reports are not relayed.
- A browser that refuses to store data can take a seat and play with a memory replica, but it cannot create a table or become the host.
- After expiry or loss of every local replica, the room link can seed a fresh session from the setup values; the old game state is not restored (ADR 0005).
- A device clock change moves that device's local expiry.
- Updates of Trystero are manual.
- Rollback: the local tag `supabase-last` points at the last Supabase version (09d887a); `git checkout supabase-last` restores it.
  The hosted Supabase project and its data were not changed.

## Alternatives Considered

- **Keep Supabase for discovery only.** Proven, but it keeps a hosted dependency, its quotas and the stored call messages, which the owner wanted to remove.
- **Nostr relays for discovery.** Also serverless for us and acceptable to the owner; not needed, because the WebTorrent trackers passed the spike.
  It stays an option for redundancy.
- **Three private invite links and a fixed host (the handover's design).** No election, but the owner asked for one shared link and an automatic host.
- **A majority vote for a new host.** Safer against split groups, but a table with two connected players could never continue; the owner accepted one witness (D3).
- **Store the last connection's details and try them first after a reconnection.** Session descriptions and ICE candidates contain IP addresses, which the project does not store, and a network change makes them stale.
  The seat-pair rooms and the rejoin of a page without links reconnect pages during the first tracker announces, without stored details.
- **Seat-specific projections of the state.** They would hide the other hands, but every seated browser must hold the full state to become the host.
