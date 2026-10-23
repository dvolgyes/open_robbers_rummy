# Open Robber's Rummy

Robber's Rummy for 2 to 6 players in the browser, peer to peer.
Public WebTorrent trackers make the first contact; WebRTC carries the game, the chat, and the call.
There is no game server; one seated browser is the elected host (ADR 0001).

## Commands

```sh
npm install
npm run dev                          # Vite development server
npm run typecheck                    # tsc for src, tests and scripts
npx vitest run --project unit        # fast unit tests (Node)
npm test                             # unit and browser projects (headless Chrome)
npx playwright test                  # end-to-end tests; builds the app, serves ports 4173 and 4174
npx biome check --write <files>      # format and lint
pre-commit run --all-files           # every hook, including the layer checks
npm run bot -- <table-url> --user <name>  # solver bot CLI
npm run bot -- <table-url> --random   # a bot that picks random legal options
```

The end-to-end tests use public trackers and run with one worker.
Free the ports with `lsof -ti:4173,4174 | xargs -r kill` when a run was interrupted.
Never print, log, or commit the OpenRouter key from `.env`.

## Module map

Each layer imports only the layers below it ([ADR 0004](docs/adr/0004-module-boundaries.md)).
The `layer-*` hooks in `.pre-commit-config.yaml` refuse imports in the wrong direction.

| Folder | Responsibility |
| --- | --- |
| `src/rummy/` | Pure rules engine: cards, melds, rule presets, hand flow, legal actions, penalties, seat views. No DOM, no network. |
| `src/call/` | Voice and video call. |
| `src/game/` | `GameModule` adapter from the engine to the table (`rummy.ts`), and the chat. |
| `src/p2p/` | Trackers, WebRTC mesh, host election, replicated log, seats and bot seats. |
| `src/bot/` | Meld solver, bot turn policy and its worker, host bot runner, CLI; the OpenRouter clients are kept but not wired. |
| `src/ui/` | Screens: create, join, lobby, table page. |
| `src/*.ts` | Shared root files; they import no layer folder. `main.ts` is the entry point. |

## Rules

The engine plays Robber's Rummy in three presets: `gamerules`, `wikipedia` and `machiavelli` ([ADR 0005](docs/adr/0005-robbers-rummy-engine-and-solver-bots.md)).
Every value that a preset or the table setup changes is in `RummyRules` (`src/rummy/rules.ts`).
`applyAction` is the only authority; `legalActions` lists every action except `play`, which the draft editor and the solver build.
A stored hand whose rules differ from `rulesFor(preset, jokers, assist)` does not parse, so a rule change makes old saved tables unreadable.

## Conventions

- TypeScript ESM with `noUncheckedIndexedAccess`; Biome formats with tabs.
- Test files live in `tests/unit`, `tests/browser`, and `tests/e2e`.
- A behavior change starts with a failing test.
- ADRs are in `docs/adr/`; amend an ADR in place with a dated note when a later change alters it.
