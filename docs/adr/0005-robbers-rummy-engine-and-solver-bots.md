# ADR 0005: Robber's Rummy engine, rule presets, solver bots, and bot pacing

Status: accepted (2026-10-23).

## Context

The owner asked on 2026-10-22 for a Robber's Rummy table in the browser.
The owner set these requirements:

- 2 to 6 players, each playing alone.
- 2 to 6 jokers, 4 by default.
- The player count, the names, and the table rules are set at table creation and are in the room link.
- The centre of the table shows every meld.
  The other players are in the top row, at most five, and the viewer is at the bottom.
- Each other player shows only a dense card count below the video tile.
- The bots use a constraint solver, not the language model.
  A bot keeps its jokers for the endgame when it can, except at the opening.
- A bot waits until the cards of the last play were shown for at least 5 s, and the new cards have a gold frame.
- The language-model code stays in the repository for later use.

During planning, the owner chose these points:

- At most 6 players.
- Human players arrange the melds by hand.
  A solver **Suggest** button is available only when the table rules allow it.
- Three rule presets, chosen at table creation: the gamerules.com rules, the Wikipedia rules, and a Pagat-style rule set.
- A game is one hand, scored by penalty points.
- The language-model transport stays, but nothing calls it.

On 2026-10-23 the owner allowed the solver to think up to 10 s for one turn.
The owner also asked for a limited search: when the search finds no acceptable play in its time, the bot draws a card; when it finds a partial play, the bot plays it.

Sources, read on 2026-10-22: Wikipedia "Robbers' rummy", the gamerules.com Robber's Rummy page, and Pagat (https://www.pagat.com/rummy/carousel.html and its Machiavelli and Tahiti notes).
The sources do not agree on the deal, the opening, the jokers per meld, the ace, and the turn.

## Decision

### Engine

- The rules engine is in `src/rummy/`.
  It is pure TypeScript with no DOM and no network (ADR 0004).
  The project writes the engine itself; this ADR does not record a search for a rules library.
- The deck is two 52-card decks and the chosen number of jokers.
  A card id names the deck, the rank, and the suit (`"0-10H"`); a joker id is `"JK0"` to `"JK5"`.
- A `play` action gives the complete new table.
  `applyAction` accepts it only when every old table card is still on the table, at least one hand card is added, every meld is valid, and the opening rule and the turn phase allow it.
  Table cards never go back to a hand, and a joker on the table can move to any meld.
- `applyAction` is the only authority.
  `legalActions` gives the draw, end, and pass actions; the UI and the solver build the plays.
- Every value that a preset or the table setup changes is in `RummyRules` (`src/rummy/rules.ts`).

### Rule presets

| Value | `gamerules` | `wikipedia` | `machiavelli` |
| --- | --- | --- | --- |
| Cards dealt | 11 | 13 | 13 |
| Opening | 40 points of new melds from the hand; the table stays as it is | none | none |
| Turn | play, then draw or end; or draw, then play or end; the second step ends the turn | as `gamerules` | a play or a draw ends the turn |
| Jokers in one meld | at most 1 | any number, with at least one natural card | at most 1 |
| Ace | low (A-2-3) or high (Q-K-A) | also around the corner (K-A-2) | low or high |

Common rules:

- A set has 3 or 4 cards of one rank in different suits.
  A run has 3 or more cards of one suit in sequence, and it never holds a rank twice.
- The player after the dealer starts.
  The first dealer is random, and each new game moves the deal to the next seat.
- A player who lays nothing must draw; `end` at the start of a turn is refused.
- Opening points: 2 to 9 count their face value, 10, J, Q, and K count 10, an ace counts 11 when high or in a set and 1 in A-2-3, and a joker counts as the card it stands for.

These choices are not in any source, and the project made them:

- The gamerules.com page makes "around the corner" optional; the `gamerules` preset does not allow it.
- Pagat's Machiavelli has no jokers.
  The `machiavelli` preset takes the limit of one joker per meld from Tahiti, and it lets table jokers move as the other presets do.
- At an empty stock, a player who cannot play passes.
  When every player passes in a row, the hand is blocked, and the players with the lowest penalty win together.
- Penalty points for cards left in a hand: joker 25, ace 15, 10 to K 10, every other card 5.
- A game is one hand.
  After it, any player can ask for a new game through the reset request, which every other present player must approve.

### Seats and room link

- The seats are `"1"` to `"6"`; `seatsOf(config)` gives the seats in play.
  Wire messages always carry six seat rows, so the message shapes stay fixed; the seats that are not in play are never available.
- The room link query holds the names (`p1` to `p6`), the host seat, `rules`, `jokers`, `assist`, and `bot_seats`.
  A link with a wrong value fails closed as an invalid link.
- The link version is `p2p-v2`, the key labels start with `open-robbers-rummy|`, and the browser database is `orr-p2p`.
  A link with another version gets the "other version" message.

### Solver bots

- `src/bot/solver.ts` finds the table arrangement that places the most hand cards, and among those the one that sheds the most penalty points.
  It is exact when it finishes in its budget.
- Two searches share the budget.
  A sweep over the ranks, after van Rijn, Takes, and Vis, "The complexity of Rummikub problems" (2015), keeps only the open runs per suit, so a long table costs no more than a short one; it gets the first half.
  A depth-first search with a memo, which is faster on short tables, gets the rest when the sweep did not finish.
  Both stop early at a play that places every hand card.
- At the budget, each search returns the best complete play that it found; a play that places fewer cards is still a play.
  When there is none, the bot draws.
- The bot policy (`src/bot/policy.ts`) keeps hand jokers back, except at the opening, for a play that empties the hand, and when another player has 3 cards or fewer.
- One decision may search for 5 s (`THINK_MS`), and a turn has at most two decisions, so a turn stays within the owner's 10 s.
  In the browser, the search runs in a module worker, so the call and the table stay responsive.
  The CLI searches for 2 s on its only thread, below the 5 s after which the peers count a late timer as a frozen page.
- The deadline is checked every 1024 nodes.
  A full garbage collection of a large memo can delay the stop by more than a second (measured on 2026-10-23: 1.2 s and 1.4 s in Node).

### Pacing and gold frames

- `lastPlay` in the hand state holds the hand cards of the last play.
  Every viewer sees them with a gold frame until the next play.
- A bot command goes 5 s after the last play that the runner saw, and 1 s after the runner's previous command (`src/bot/pacing.ts`).
  A timer ends the wait, so the runner does not depend on a later change of the table.
  The search runs during the wait.
- A runner that sees a hand for the first time, at its start or after a host change, counts that moment as a play.

### Language-model code

- The OpenRouter clients, the API-key storage, the decision model, and the turn chooser stay in `src/bot/` with their unit tests.
  Nothing in the game calls them, and the create screen does not show their settings.
- The browser keeps a saved key in localStorage under `open-robbers-rummy.openrouter-api-key`.

## Consequences

- A change to a preset makes the stored games of that preset unreadable: a stored hand parses only when its rules equal the current preset values.
- A bot turn takes at least 1 s per command, and at least 5 s after each play.
  A table of six bots that only draw moves at about one turn per 2 s.
- The solver can miss the best play on a dense table when the budget runs out; the bot then plays the best play found.
  `scripts/solver-bench.ts` measures this on seeded positions.
- Assist is an honour rule: the replicated state holds every hand (ADR 0004), and only the UI hides the **Suggest** button.
- The per-turn limit can be passed by the garbage-collection delay above.

## Alternatives Considered

- **Language-model bots.**
  They cost money for each move, wait for the network, and can propose illegal plays.
  The owner chose the solver and kept the model code for later.
- **An integer-programming solver, such as a GLPK build for the browser.**
  It adds a WebAssembly dependency, and the two searches above meet the time limit.
- **The depth-first search alone.**
  It failed the spike: on dense late tables of the `wikipedia` preset with 6 jokers, its p95 time was 3.3 s, and every search stopped at the 400,000-node limit.
- **The sweep alone.**
  It is exact on long tables, but slow on short ones, where the depth-first search finishes quickly.
- **Wait for the next table change instead of a timer.**
  The runner then stalls when nothing else changes, because it acts only on a change.
