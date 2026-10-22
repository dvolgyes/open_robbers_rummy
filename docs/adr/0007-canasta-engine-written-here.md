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
- Follow the classic four-player partnership rules, as stated on Pagat (https://www.pagat.com/rummy/canasta.html, checked 2026-10-22), with these points.
  Pagat states each of them for the classic game:
  - A joker counts 50 points, an ace or a 2 counts 20, a king down to an 8 counts 10, and a 7 down to a 4, or a black three, counts 5.
    Amended 2026-10-22: before this change, a 2 counted 50.
  - A meld has at least two natural cards and at most three wild cards, so its wild cards can outnumber its natural cards, as in Q-Q-2-2-2.
    Amended 2026-10-22: before this change, the engine refused such a meld.
    That rule belongs to the Austrian variant, which Pagat lists as a modification.
  - The first dealer is chosen at random, and the deal passes clockwise.
    Amended 2026-10-22: before this change, North dealt the first hand of every match.
  - A player draws one card from the stock, or takes the whole discard pile.
  - The initial meld needs 15 points at a negative score, 50 from 0, 90 from 1500, and 120 from 3000.
  - A red three is set aside when dealt or drawn.
    It adds 100 points if the side has made its initial meld, and subtracts 100 otherwise.
    A side with all four red threes scores 800, or -800 without a meld.
  - A black three may be discarded at any time.
    Discarding it blocks the next player from taking the pile.
  - A player who goes out in this turn may meld three or four black threes, with no wild card.
    The engine accepts this meld only when it leaves the player at most one card, the discard that goes out, so the player lays the other melds first.
    Amended 2026-10-22: before this change, the engine refused every meld of threes.
  - A pile that contains a wild card is frozen, and a frozen pile cannot be extended.
    A side that has not made its initial meld is also blocked from the pile, so it can take the pile only with two natural cards from its hand.
    Amended 2026-10-22: a frozen pile can go onto a meld of the side when the player adds a natural pair of that rank from the hand.
    Pagat says that this meld "could be the same rank as an existing meld belonging to your partnership, in which case the melds are then merged".
    Before this change, the engine refused every frozen pickup onto a meld.
  - When the starter card of the pile is a wild card or a red three, more cards are turned onto it until the top card is neither.
    The card under the top freezes the pile against both sides.
    A player who takes such a pile puts the red three with the side's red threes and draws no replacement card.
    Amended 2026-10-22: before this change, a red three starter went to the bottom of the stock, and a wild starter stayed as the only pile card.
  - A side has at most one meld of each rank.
    Pagat: "It is not allowed for one partnership to have two separate melds of the same rank."
    A new meld or a pickup of a rank that the side already melded is refused, and the same cards are offered as an extension of that meld.
    Added 2026-10-22; before, the engine let a side lay a second meld of the same rank.
  - An unfrozen pile can be taken with a natural pair, with one natural card and one wild card, or by adding the top card to a meld of the side.
  - Points for the initial meld count the cards from the hand and the top pile card.
    The rest of the pile does not count, even when it is melded in the same turn.
  - The initial meld must be laid in the turn in which it is made, at or above the minimum for the side's score.
    A discard is refused while the side has partial melds on the table; `resetTurn` takes them back.
    Amended 2026-10-22: `resetTurn` keeps a card drawn from the stock, so a player cannot see the card, take it back, and take the pile instead.
    It still undoes a pile pickup, because a pickup below the initial minimum must stay retractable.
  - When the stock is exhausted, the next player may take the pile, or draw from the empty stock, which ends the hand.
    The draw is refused when the pile is not frozen for the side and its top card goes onto a meld of the side.
    Pagat: "a player must take the discard if the pile is not frozen and the discard matches any previous meld of that player's side", and "As soon as a player is entitled to draw from the stock and chooses to do so, but there is no card in the stock, the play ends."
    If that player cannot take the pile, the hand ends at once.
    Amended 2026-10-22: a pickup that leaves one card in the hand is refused while the side has no canasta, because that card can be neither melded nor discarded.
    Before this change, a pickup that the player could not complete left the turn between the pickup and `resetTurn` forever.
    Amended 2026-10-22: before this change, every possible pickup was forced, and `resetTurn` after a pickup ended the hand.
    Now `resetTurn` returns to the start of the turn, where the player can end the hand only when the pickup is not forced.
  - While the side has no canasta, a meld, an extension, or a pickup that leaves one card in the hand is refused.
    Pagat: "It is against the rules in this case to meld all your cards except one."
    Amended 2026-10-22: before this change, only the pickup was refused, and a player who melded down to one card could only take the turn back.
  - A last stock card that is a red three ends the hand when it is drawn, so its drawer may not meld or discard.
  - A player goes out concealed when the player melded nothing in an earlier turn of the hand, adds no card to the partner's melds, and lays a complete canasta in the last turn.
    The partner may have melded before.
    A side with no meld may go out concealed after a stock draw without the minimum count; after a pile pickup, the minimum applies.
    Amended 2026-10-22: before this change, the bonus depended on the side having no meld at the start of the turn, and the minimum always applied.
    The hand records the seats that melded in the optional `meldedSeats` field; a hand stored without it keeps the earlier rule until it ends.

## Consequences

- The project owns about 1,000 lines of rules code.
  Every rule is tested in `tests/unit/canasta-engine.test.ts`, including a random-play run of 100 hands that checks card conservation and termination.
- Rule variants are a code change, not a configuration change, until the rules are made options.
  The rules that differ between published variants are listed above, so a reviewer can compare them with the ruleset the players expect.
  American (modern) canasta differs in several of them: it draws two cards, takes the pile only with a natural pair, and does not count the pickup cards toward the initial meld.
- A defect in the rules is fixed here, with no upstream to wait for.
- A later change to the rules that alters how a hand is scored changes past results.
  Stored matches must record the rules version before that happens.

## Alternatives Considered

- **Vendor `rvenning/canasta`.** It would save writing the meld and score code, but its license is unknown, and copying unlicensed code is not allowed.
  It stays a reference.
- **Use a library through a wrapper, as ADR 0002 did for bridge.** No suitable package exists, so there is no library to wrap.
- **Build the rules on a server.** The game is serverless and peer-to-peer, so a server would add infrastructure and a trust boundary that the project avoids.
