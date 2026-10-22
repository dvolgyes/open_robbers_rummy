# ADR 0008: One-way module boundaries, enforced by pre-commit hooks

Status: accepted (2026-10-22)

## Context

The code came from a bridge game, and the conversion replaced the rules, the table screen, and the bots.
The peer-to-peer table, the seats, the election, the chat, and the call stayed, because both games are four-player partnership games.
The conversion showed where the old code mixed layers:

- `src/p2p/table.ts` imported the bot seat holders from `src/bot/seats.ts`.
- The bot CLI imported the room link parser from `src/ui/bookmark.ts`.
- Rule code and transport code were connected in the old bridge module.

A rules engine that imports transport or screen code cannot run in the bot CLI, in Node tests, or in a later game without that code.
A reviewer can see a wrong import in one file, but not a slow drift across many files.

## Decision

- The source tree has these layers. Each layer may import only the layers below it.

  | Folder | Responsibility | May import |
  | --- | --- | --- |
  | `src/canasta/` | Pure rules engine: cards, melds, legal actions, scoring, player views | Nothing outside itself |
  | `src/call/` | Voice and video call | Shared root files |
  | `src/game/` | `GameModule` adapter from the rules to the table, and the chat | `canasta`, `call`, shared root files |
  | `src/p2p/` | Trackers, WebRTC mesh, elected host, replicated log, seats | `game`, `call`, shared root files |
  | `src/bot/` | OpenRouter client, prompts, decision model, CLI | `canasta`, `game`, `p2p`, shared root files |
  | `src/ui/` | Screens | Every layer |

- The shared root files in `src/` (`protocol.ts`, `bookmark.ts`, `session.ts`, `ids.ts`, `random.ts`, `result.ts`, `backoff.ts`, `i18n.ts`, `i18n-translations.ts`, `i18n-canasta.ts`) import no layer folder.
  `src/main.ts` is the entry point and is exempt.
- `src/p2p/` reaches the rules only through the `GameModule` interface in `src/game/module.ts`.
- To keep these rules, `src/bot/seats.ts` moved to `src/p2p/bot-seats.ts`, and `src/ui/bookmark.ts` moved to `src/bookmark.ts`.
- Pre-commit `pygrep` hooks (`layer-*` in `.pre-commit-config.yaml`) refuse a relative import or a dynamic import that crosses a boundary in the wrong direction.
  Each hook was checked against a planted violation.
- The replicated table state holds every hand and the stock, as ADR 0004 requires so that any seated browser can become the host.
  The table screen hides the other hands and the stock, but a player who reads the browser's storage or the network messages can see them.
  The owner accepted this risk on 2026-10-22: the game is for friends, and the players are trusted not to cheat.

## Consequences

- The rules engine runs in the browser, in Node, and in the bot CLI with no DOM and no network.
- A new game can replace `src/canasta/` and `src/game/canasta.ts` and keep `src/p2p/`, `src/call/`, and most of `src/ui/`.
- The hooks match import text, not resolved paths.
  An import through an alias or a long `../../` path is not detected.
  The project uses no path aliases, and no file in `src/` is deeper than one folder, so both forms are absent now.
- Hidden information is a matter of trust, not of protection.
  If the game is offered to strangers, this residual risk must be reopened.
  A fix needs a dealer that holds the stock and sends each seat only its own view, which conflicts with host failover in ADR 0004.
  The owner of that decision is the project owner.

## Alternatives Considered

- **Biome `noRestrictedImports` with per-folder overrides.** It would report the error in the editor.
  It needs one override for each folder and a pattern syntax that changed between Biome versions.
  The repository already uses a `pygrep` hook for HTML sinks, so the hooks follow that pattern.
- **A dependency-graph tool such as dependency-cruiser.** It resolves real paths, but it adds a dependency for six rules.
- **Separate npm packages for each layer.** They give hard boundaries, but the owner chose one package with internal folders.
- **Projections of the state for each seat.** ADR 0004 rejected them because every seated browser must be able to become the host.
