# ADR 0005: Reusable room links bootstrap an expired room

Status: accepted (2026-10-20).
Amended on 2026-10-22: a page that has a host's lobby claims the host seat from that host and never seeds a table.
Before this note, a new browser that chose the configured host seat from a live host's lobby started a second table with itself as host, and the live host then refused it as superseded.

## Context

ADR 0004 stores table state in each player's browser and expires an idle table after 24 hours.
The room URL already carries the four player names, the host seat, and the room key.
The player-specific URL carries `selected_player`, while the shared URL omits it.
The host needs to reopen a weekly room even when its local copy has expired or is missing.

## Decision

A complete room setup in the URL allows the page to clear its local expiry tombstone when it has no local replica.
The page shows all four seats while no host lobby is available.
When a page selects the configured host seat, it seeds the local replica from the URL setup and starts hosting.
Other pages can select seats and wait for that host.
The table link omits `selected_player`; a player's own URL keeps it for reload.

## Consequences

The same room URL can start a fresh session after local expiry or data loss.
The fresh session loses the old board, scores, and seat claims.
The room key remains a bearer capability, so anyone with the link can select the host seat and bootstrap the room.
The existing trusted-player model and host-election tie-break govern simultaneous host attempts.
The host bootstrap requires persistent browser storage.

## Alternatives Considered

- Keep expired rooms permanently expired and require a new room key each week.
  This preserves separation between sessions but requires the host to create and redistribute a new link.
- Keep a create screen without a room key as the reusable link.
  This avoids room revival but does not let players join the same waiting room from that link.
