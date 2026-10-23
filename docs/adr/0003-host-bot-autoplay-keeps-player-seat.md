# ADR 0003: Host bot autoplay keeps the player's seat

Status: accepted (2026-10-20).

## Context

Host bot controls let the host ask a bot to take the game actions for a seat.
The player who holds that seat can also be in a table call.
Replacing the player's seat holder ends that player's call, although autoplay only needs to take over the game actions.

## Decision

When a host enables a bot for a seat held by a player, keep the player's holder and seat generation.
Bind a private host-local bot actor to that generation and mark the seat as bot controlled.
The host may submit game actions through that local actor while the player's commands are refused.
The player remains bound to the table and can continue sending or receiving call media.
The local table view disables the game actions for the player's seat while the bot controls it.
When the host disables the bot, remove the local actor and restore the player's game controls without changing the seat.
For an unheld seat, the host bot claims its deterministic holder and releases it when disabled.
The host's own seat keeps its existing holder while autoplay runs.

## Consequences

Autoplay does not interrupt an active call or require the player to reclaim their seat afterwards.
The host engine has two bindings for a human seat while its bot is active, but it exposes only the human binding to call routing.
The host engine accepts bot commands only from its local bot command path and rejects game commands from the human peer during automation.
A host that activates a bot for an offline player can still advance that seat's game actions without releasing the player's seat.

## Alternatives Considered

- Replacing the player holder gives the bot exclusive seat ownership but invalidates the player's call and requires a later seat claim.
- Allowing the human and bot to submit actions together risks two actions for one turn.
- Pausing the table while a player is away preserves control boundaries but does not provide autoplay.
