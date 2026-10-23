# ADR 0004: One-way module boundaries, enforced by pre-commit hooks

Status: accepted (2026-10-22)

## Context

The game has a rules engine, a peer-to-peer table, a call, solver bots and screens.
The rules engine and the solver must run in the browser, in a web worker, in Node tests and in the bot CLI.
A rules engine that imports transport or screen code cannot run in those places without that code.
Seat helpers and link parsers are needed by more than one layer, so they tend to drift into the wrong folder.
A reviewer can see a wrong import in one file, but not a slow drift across many files.

## Decision

- The source tree has these layers. Each layer may import only the layers below it.

  | Folder | Responsibility | May import |
  | --- | --- | --- |
  | `src/rummy/` | Pure rules engine: cards, melds, rule presets, hand flow, legal actions, penalties, seat views | Nothing outside itself |
  | `src/call/` | Voice and video call | Shared root files |
  | `src/game/` | `GameModule` adapter from the rules to the table, and the chat | `rummy`, `call`, shared root files |
  | `src/p2p/` | Trackers, WebRTC mesh, elected host, replicated log, seats and bot seats | `game`, `call`, shared root files |
  | `src/bot/` | Meld solver, bot turn policy and its worker, pacing, host bot runner, CLI, and the unwired OpenRouter clients | `rummy`, `game`, `p2p`, shared root files |
  | `src/ui/` | Screens | Every layer |

- The shared root files in `src/` (`protocol.ts`, `bookmark.ts`, `session.ts`, `ids.ts`, `random.ts`, `result.ts`, `backoff.ts`, `i18n.ts`, `i18n-translations.ts`, `i18n-rummy.ts`) import no layer folder.
  `src/main.ts` is the entry point and is exempt.
- `src/p2p/` reaches the rules only through the `GameModule` interface in `src/game/module.ts`.
- The bot seat holders are in `src/p2p/bot-seats.ts`, and the room link parser is in `src/bookmark.ts`, so the table and the bot CLI can use them without an upward import.
- Pre-commit `pygrep` hooks (`layer-*` in `.pre-commit-config.yaml`) refuse a relative import or a dynamic import that crosses a boundary in the wrong direction.
  Each hook was checked against a planted violation.
- The replicated table state holds every hand and the stock, as ADR 0001 requires so that any seated browser can become the host.
  The table screen hides the other hands and the stock, but a player who reads the browser's storage or the network messages can see them.
  The owner accepted this risk on 2026-10-22: the game is for friends, and the players are trusted not to cheat.

## Consequences

- The rules engine runs in the browser, in Node, and in the bot CLI with no DOM and no network.
- Another game can replace `src/rummy/` and `src/game/rummy.ts` and keep `src/p2p/`, `src/call/`, and most of `src/ui/`.
- The hooks match import text, not resolved paths.
  An import through an alias or a long `../../` path is not detected.
  The project uses no path aliases, and no file in `src/` is deeper than one folder, so both forms are absent now.
- Hidden information is a matter of trust, not of protection.
  If the game is offered to strangers, this residual risk must be reopened.
  A fix needs a dealer that holds the stock and sends each seat only its own view, which conflicts with host failover in ADR 0001.
  The owner of that decision is the project owner.

## Alternatives Considered

- **Biome `noRestrictedImports` with per-folder overrides.** It would report the error in the editor.
  It needs one override for each folder and a pattern syntax that changed between Biome versions.
  The repository already uses a `pygrep` hook for HTML sinks, so the hooks follow that pattern.
- **A dependency-graph tool such as dependency-cruiser.** It resolves real paths, but it adds a dependency for six rules.
- **Separate npm packages for each layer.** They give hard boundaries, but the owner chose one package with internal folders.
- **Projections of the state for each seat.** ADR 0001 rejected them because every seated browser must be able to become the host.
