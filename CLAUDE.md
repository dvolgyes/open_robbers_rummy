# Open Canasta

Four-player partnership canasta in the browser, peer to peer.
Public WebTorrent trackers make the first contact; WebRTC carries the game, the chat, and the call.
There is no game server; one seated browser is the elected host (ADR 0004).

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
npm run bot -- <room-url> --user <name> --model <id>  # LLM bot CLI; reads OPENROUTER_API_KEY from .env
npm run bot -- <room-url> --random   # a bot that picks random legal options and needs no key
```

The end-to-end tests use public trackers and run with one worker.
Free the ports with `lsof -ti:4173,4174 | xargs -r kill` when a run was interrupted.
Never print, log, or commit the OpenRouter key from `.env`.

## Module map

Each layer imports only the layers below it ([ADR 0008](docs/adr/0008-module-boundaries.md)).
The `layer-*` hooks in `.pre-commit-config.yaml` refuse imports in the wrong direction.

| Folder | Responsibility |
| --- | --- |
| `src/canasta/` | Pure rules engine: cards, melds, legal actions, scoring, match flow, seat views. No DOM, no network. |
| `src/call/` | Voice and video call. |
| `src/game/` | `GameModule` adapter from the engine to the table (`canasta.ts`), and the chat. |
| `src/p2p/` | Trackers, WebRTC mesh, host election, replicated log, seats and bot seats. |
| `src/bot/` | OpenRouter client, prompt, indexed-choice decision model, heuristic fallback, CLI. |
| `src/ui/` | Screens: create, join, room, table. |
| `src/*.ts` | Shared root files; they import no layer folder. `main.ts` is the entry point. |

The bot prompt template is `public/bot-prompts/turn.txt`; the browser and the CLI both read it.

## Rules

The engine follows classic partnership canasta as Pagat states it ([ADR 0007](docs/adr/0007-canasta-engine-written-here.md)).
Every value that a variant changes is in `CLASSIC_RULES` (`src/canasta/rules.ts`).
`applyAction` is the only authority; `legalActions` keeps only the candidates that it accepts.
A stored match that does not use `CLASSIC_RULES` does not parse, so a rule change makes old saved tables unreadable.

## Conventions

- TypeScript ESM with `noUncheckedIndexedAccess`; Biome formats with tabs.
- Test files live in `tests/unit`, `tests/browser`, and `tests/e2e`.
- A behavior change starts with a failing test.
- ADRs are in `docs/adr/`; amend an ADR in place with a dated note when a later change alters it.
