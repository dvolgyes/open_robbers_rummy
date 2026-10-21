# ADR 0007: Canasta rules engine written in this repository

Status: accepted (2026-10-22)

## Context

The game needs exact classic four-player partnership canasta: two decks with four jokers, wild cards, initial melds by score band, canastas, the frozen pile, red and black threes, and going out.
The plan asked whether an open canasta rules library could be reused, and it preferred a library only when its license and rule fidelity were acceptable.

Evidence, checked on 2026-10-22:

- The npm and PyPI registries have no usable open canasta rules package.
- Hex.pm `canasta` is written in Elixir and cannot run in the browser or in Node without a second runtime.
- `github.com/rvenning/canasta` is a TypeScript rules module.
  Its license is reported as `NOASSERTION`, which means no license file that GitHub can classify.
  Without a license, the code cannot be copied or vendored.

## Decision

- Write the canasta rules engine in `src/canasta/` in this repository.
  It is pure TypeScript with no DOM, network, or randomness other than an injected seed, so the same code runs in the browser, in Node, and in the bot CLI.
- Do not vendor or copy code from `rvenning/canasta`.
  It may be read as a reference for rule questions only, and no code is taken from it.
- Represent the hand as plain immutable data.
  `applyAction` is the only authority: `legalActions` enumerates candidates and keeps only those that `applyAction` accepts.
- Make these rule interpretations, which the rules configuration in `src/canasta/rules.ts` does not yet expose as options:
  - A red three is set aside when dealt or drawn, and it adds or subtracts 100 points according to whether the side has made its initial meld.
  - A black three can be discarded only to go out, or after the stock is exhausted.
  - A pile whose contents include a wild card is frozen, and a frozen pile cannot be extended.
  - Points for the initial meld count only cards taken from the hand, not the pile card.
  - A side below its initial-meld minimum may lay partial melds in a turn.
    It may not discard while a partial meld is on the table; `resetTurn` takes the partial melds back.
    A side that has laid nothing may always discard.
  - When the stock is exhausted, the hand ends after the current turn.

## Consequences

- The project owns about 1,000 lines of rules code.
  Every rule is tested in `tests/unit/canasta-engine.test.ts`, including a random-play run of 2,000 hands that checks card conservation and termination.
- Rule variants are a code change, not a configuration change, until the rules are made options.
  The rules that differ between published variants are listed above, so a reviewer can compare them with the ruleset the players expect.
- A defect in the rules is fixed here, with no upstream to wait for.
- A later change to the rules that alters how a hand is scored changes past results.
  Stored matches must record the rules version before that happens.

## Alternatives Considered

- **Vendor `rvenning/canasta`.** It would save writing the meld and score code, but its license is unknown, and copying unlicensed code is not allowed.
  It stays a reference.
- **Use a library through a wrapper, as ADR 0002 did for bridge.** No suitable package exists, so there is no library to wrap.
- **Build the rules on a server.** The game is serverless and peer-to-peer, so a server would add infrastructure and a trust boundary that the project avoids.
