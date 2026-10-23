# Open Robber's Rummy

Open Robber's Rummy is a Robber's Rummy game for 2 to 6 players that runs in the browser.
It supports human players, optional voice and video calls, and solver bots.
The game deals the cards, checks every play, and counts the penalty points at the end.

**Source:** [github.com/dvolgyes/open_robbers_rummy](https://github.com/dvolgyes/open_robbers_rummy)
**Play:** [dvolgyes.github.io/open_robbers_rummy](https://dvolgyes.github.io/open_robbers_rummy/)

The game is a static site with no game server or database.
Players connect through public WebTorrent trackers, then exchange game data directly over WebRTC.
One browser coordinates the table at a time; every seated browser stores a copy so another can take over if needed.
The table key is in the link fragment and is not sent to the web server.

## How to play

Robber's Rummy is a rummy game where all melds on the table belong to every player.
On your turn, you can rearrange the melds on the table, as long as every meld is valid at the end and you added at least one card from your hand.
The first player who empties the hand wins.

The game uses two 52-card decks and 2 to 6 jokers (4 by default).

### Create a table and invite friends

1. Open Open Robber's Rummy and choose the number of players, from 2 to 6.
2. Fill in a name for each player, and select **Bot** for the seats that a bot plays.
3. Select **This is me** beside your seat.
4. Choose the rules, the number of jokers, and whether **Allow solver suggestions** is on.
5. Select **Create game**.
   Your browser creates the table, takes your seat, and copies the room link when clipboard access is available.
6. Use **Copy link** at the table to copy the shared link again, then send the full link to your friends in a private message.
7. Each friend opens the link and selects one of the available seats.
   If only one seat remains, the game takes it automatically.

The room link holds the player names and the table rules.

The room link is the invitation key.
Room discovery can announce that a room exists, but a person still needs the complete link to join because the room password is carried in the link fragment.
Treat the full link like a password: send it only to people you want at the table.
Do not post it publicly.

### Take a seat and play

The room opens at a seat-selection screen when more than one seat is free.
Choose the seat the host agreed with you.
If a seat is already held by an active browser, choose another available seat or ask its player to release it.
Reopening the link in the same browser normally restores that browser's seat.

When every seat is ready, the table deals the cards automatically.
The first dealer is chosen at random, and the player after the dealer starts.

The table shows the other players in the top row, each with a small strip that shows how many cards they hold.
All melds are in the middle, and your hand is at the bottom.
The cards of the last play have a gold frame.

On your turn:

1. Select cards in your hand or on the table, then choose a meld with **+**, or **New meld**.
   **To hand** puts your own cards back, and **Undo changes** restores the table.
2. **Play** is available when every meld is valid.
3. If you cannot or do not want to play, **Draw a card**.
   With the gamerules.com and Wikipedia rules, you can play after a draw, or draw after a play, and then the turn ends.
4. **End the turn** when you are done.

A player who lays nothing must draw.
When the stock is empty, a player who cannot play passes.
If every player passes in a row, the game ends, and the player with the lowest penalty wins.

When **Allow solver suggestions** is on, **Suggest** fills in the play that the solver finds for your hand.

The main rules, in short:

- A set is 3 or 4 cards of one rank, each of a different suit.
- A run is 3 or more cards of one suit in sequence.
  The ace is low (A-2-3) or high (Q-K-A).
- A joker stands for any card in a meld.
  Table jokers can move to another meld, but no table card goes back to a hand.
- At the end of the game, cards still in a hand count as penalty points: joker 25, ace 15, 10 to K 10, every other card 5.

The table creator chooses one of these rule sets:

| Rules | Cards dealt | First play | Turn | Jokers in one meld | Ace |
| --- | --- | --- | --- | --- | --- |
| gamerules.com | 11 | 40 points of new melds from your hand | play and draw | one | low or high |
| Wikipedia | 13 | no minimum | play and draw | any, with one natural card | also K-A-2 |
| Machiavelli (Pagat) | 13 | no minimum | play or draw | one | low or high |

The sources and the points that they leave open are in [ADR 0005](docs/adr/0005-robbers-rummy-engine-and-solver-bots.md).

You must take one of the player seats to use the table.
There is no spectator or kibitz mode, so people who are not seated cannot watch the cards from inside the room.

### Start a new game

After a game ends, the middle of the screen shows the winner and the penalty points of every player.
**New game** asks the other players for a new game, and the next player deals.
During a game, **Reset** sends the same request.
Every other player at the table must approve; one rejection cancels it.
The player who asked can cancel the request.
The game waits while a request is open.
The chat and the call stay as they are.

### Use bots

Bots can fill seats for a game, or the host can turn on autoplay for a player who needs to step away temporarily.
For a permanent bot seat, select **Bot** for that seat while creating the table.
For a temporary substitute, the host can enable the bot for the player's seat from the table controls, then turn it off when the player returns.
The player keeps their seat and stays in the room call while the bot plays.
Bots approve a new-game request automatically.

The bots use a solver, not an AI model, so they need no account or API key.
The solver looks for the play that puts the most cards from the hand on the table.
A bot keeps its jokers for later, except for its first play, for a play that empties its hand, and when another player has 3 cards or fewer.
A bot thinks for at most a few seconds; if it finds no play in that time, it draws.
A bot waits until a play was on the table for at least 5 seconds, so that every player can see the cards with the gold frame.

### Call and finding players

The table includes an optional audio and video call for room members.
Each player chooses whether to join the call and whether to send a microphone or camera.
On mobile phones, video calls are intentionally unavailable because the screen has limited space; audio calls remain available.
The call is separate from the game actions, so using autoplay does not make the player leave the call.
The call has no kibitz or spectator access.

Open Robber's Rummy does not currently provide matchmaking or a way to find random players online.
You need to invite people yourself and share the room link with them.

### Save and reuse a room link

You can bookmark or save the shared table link and reuse it with regular players.
The link keeps the player names and the table rules, so it can start a fresh table for the same group without creating and distributing another invitation.
The current game state is stored in the players' browsers, not on a game server.
After about 24 hours without activity on a device, its saved table expires; starting again from the saved link creates a fresh session and does not restore the previous game or seat claims.
Use **Copy link** in the table if you need to share the invitation again.

### Fair play

Every seated browser stores the whole table state, including the other hands and the stock, so that any player can take over as the host.
The screen hides the cards that a player must not see, but a player who inspects the browser's storage or network traffic can see them.
**Allow solver suggestions** is a table rule that only the screen enforces.
The game is meant for friends who trust each other.
[ADR 0004](docs/adr/0004-module-boundaries.md) records this decision.

## Development

The game is TypeScript, built with Vite.
See [CLAUDE.md](CLAUDE.md) for the module map and the commands for tests and checks.

```sh
npm install
npm run dev        # local development server
npm run build      # type check and production build into dist/
npm test           # unit tests and browser tests
npx playwright test  # end-to-end tests with several browsers
```

## License

Open Robber's Rummy is all rights reserved.
The source code and original assets are not licensed for reuse or independent hosting.
Third-party components keep their own licenses.
See [LICENSE](LICENSE) for the terms.
GitHub's terms still allow users to view and fork a public repository ([GitHub licensing documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)).
