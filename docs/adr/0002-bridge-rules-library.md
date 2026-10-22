# ADR 0002: Bridge rules from @bridge-tools/core behind one adapter

Status: superseded (2026-10-22) by [ADR 0007](0007-canasta-engine-written-here.md); the game is now canasta, and `@bridge-tools/core` is removed.
It was accepted on 2026-10-18.

## Context

Milestone 2 needs exact contract bridge rules: auction legality (insufficient bids, doubles, redoubles), the end of the auction and the declarer, following suit, the trick winner, the 16-board dealer and vulnerability cycle, and duplicate scoring.
Errors in these rules are easy to make and hard for players to notice, for example the insult bonus or doubled undertricks.
The approved plan allowed one spike of `@bridge-tools/core@0.3.1` (MIT) against the pinned cases, and an owned engine if the spike failed.
Adoption needed three conditions: all pinned cases pass through our adapter, the library bundles for the browser, and the stored state stays plain JSON.

Evidence about the package, checked on 2026-10-18:

- The npm package was last modified on 2024-08-24, and its unpacked size is 100 KB.
  Its `package.json` declares no runtime or peer dependencies, and its only scripts are `lint`, `build` and `test` (no install scripts).
- Its repository `aaron-hutton/bridge-tools` is not archived, had 0 open issues, and its last push was on 2025-05-17.
  It has one maintainer.
  The earlier repository `bridge-tools/core` is archived.
- The package declares 100 % test coverage thresholds in its own configuration.

## Decision

- Use `@bridge-tools/core`, pinned to exactly 0.3.1, for auction legality, auction end, the final contract, playable cards, the trick winner, the dealer and vulnerability of a board, and the score.
- `src/bridge/rules.ts` is the only module that imports the library.
  It converts our values to the library's types and back, so library types never leave that file.
- The stored board is our own plain JSON: board number, dealer, vulnerability, the deal, and the calls and cards as strings such as `"1NT"` and `"HT"`.
  Turn, contract, tricks and result are derived by replay, so the stored format does not depend on the library.
- The library's vulnerability strings are from North-South's side: `VNv` means North-South vulnerable (`isDirectionVulnerable` in the library source).
  Unit tests pin the mapping: 4♠ made by North scores 620 when North-South is vulnerable and 420 when East-West is.

Spike and adapter results:

- The spike script ran 53 cases directly against the library: 52 passed.
  The one failure (`1S P P X P P P`) was a defect in the spike's comparison, which compared JSON text with a different key order; the values were equal.
- Through the adapter, 120 unit tests pass (`tests/unit/bridge-*.test.ts`), including all scoring, rotation, auction and play cases from the plan.
- A fault-injection check showed that the tests detect a swapped vulnerability mapping, a missing follow-suit check and dummy exposed before the opening lead.
- Vite bundles `src/bridge/engine.ts` with the library into one ES module (38.7 KB unminified) with no remaining imports, and a full board plays and scores from that bundle.

## Consequences

- The rules engine is small: the owned code is the replay, turn order, dummy handling, views and validation of stored boards.
- The library is maintained by one person and has had no release since 2024.
  A defect found later is fixed in our adapter, or the affected function is replaced by owned code in `rules.ts` only.
- Replacing the whole library costs one module and needs no state migration, because stored boards hold only our own strings.
- The library adds about 39 KB unminified to the bundle once the table UI imports the engine.

## Alternatives Considered

- **Owned engine from the start.** It removes the dependency, but every rule, the declarer search and the scoring table become our code to write and verify.
  The spike showed that the library is correct on every pinned case, so this extra work does not buy correctness now; it stays the fallback.
- **Other npm bridge packages.** Not evaluated: the plan named one candidate and allowed one spike.
  If the library must be replaced, owned code in `rules.ts` is the planned path, not a second library.
- **Store library objects in the room state.** This would tie the stored format to the library's types and make a later replacement a state migration, so it was rejected.
