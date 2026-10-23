# ADR 0002: Reusable table links bootstrap an expired table

Status: accepted (2026-10-20).
Amended on 2026-10-22: a page that has a host's lobby claims the host seat from that host and never seeds a table.
Before this note, a new browser that chose the configured host seat from a live host's lobby started a second table with itself as host, and the live host then refused it as superseded.

## Context

ADR 0001 stores table state in each player's browser and expires an idle table after 24 hours.
The table URL already carries the player names, the host seat, the table rules and the table key.
The player-specific URL carries `selected_player`, while the shared URL omits it.
The host needs to reopen a weekly table even when its local copy has expired or is missing.

## Decision

A complete table setup in the URL allows the page to clear its local expiry tombstone when it has no local replica.
The page shows every seat in play while no host lobby is available.
When a page selects the configured host seat, it seeds the local replica from the URL setup and starts hosting.
Other pages can select seats and wait for that host.
The table link omits `selected_player`; a player's own URL keeps it for reload.

## Consequences

The same table URL can start a fresh session after local expiry or data loss.
The fresh session loses the old hand, scores, and seat claims.
The table key remains a bearer capability, so anyone with the link can select the host seat and bootstrap the table.
The existing trusted-player model and host-election tie-break govern simultaneous host attempts.
The host bootstrap requires persistent browser storage.

## Alternatives Considered

- Keep expired tables permanently expired and require a new table key each week.
  This preserves separation between sessions but requires the host to create and redistribute a new link.
- Keep a create screen without a table key as the reusable link.
  This avoids table revival but does not let players join the same waiting table from that link.
