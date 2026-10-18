# OpenTrick

OpenTrick is a four-player contract bridge game that runs in the browser.
It supports human players, optional voice and video calls, and AI players powered by OpenRouter.
The game handles bidding, trick play, duplicate scoring, undo requests, and claims with opponent approval.

**Play:** [dvolgyes.github.io/opentrick](https://dvolgyes.github.io/opentrick/)
**Source:** [github.com/dvolgyes/opentrick](https://github.com/dvolgyes/opentrick)

The game is a static site with no game server or database.
Players connect through public WebTorrent trackers, then exchange game data directly over WebRTC.
One browser coordinates the table at a time; every seated browser stores a copy so another can take over if needed.
The table key is in the link fragment and is not sent to the web server.

## How to play

OpenTrick is a four-player contract bridge table.
North and South form one partnership, and East and West form the other.
Players use the auction to agree a contract, then play tricks to try to make it.
The game deals the cards, guides the auction and card play, and keeps the duplicate score.

### Create a table and invite friends

1. Open [OpenTrick](https://dvolgyes.github.io/opentrick/) and fill in a name for each seat: North, East, South, and West.
2. Select **This is me** beside the seat you want to play.
3. Select **Create game**.
   Your browser creates the table, takes your seat, and copies the room link when clipboard access is available.
4. Use **Copy link** at the table to copy the shared link again, then send the full link to your friends in a private message.
5. Each friend opens the link and selects one of the available seats.
   If only one seat remains, OpenTrick takes it automatically.

![The create screen lets the table creator name the four seats and choose their own seat.](docs/images/create-room.png)

The room link is the invitation key.
Room discovery can announce that a room exists, but a person still needs the complete link to join because the room password is carried in the link fragment.
Treat the full link like a password: send it only to people you want at the table.
Do not post it publicly.

![The table lobby shows the room call, player seats, bot controls, and Copy link button.](docs/images/room-created.png)

### Take a seat and play

The room opens at a seat-selection screen when more than one seat is free.
Choose the seat the host agreed with you.
If a seat is already held by an active browser, choose another available seat or ask its player to release it.
Reopening the link in the same browser normally restores that browser's seat.

When all four seats are ready, the table deals a board automatically, then players bid in turn.
The final contract names a trump suit (or no trump), a level, and a declarer.
After the opening lead, declarer's partner becomes the dummy: their hand is shown on the table, and declarer plays both hands.
The defenders play together to stop the contract, while declarer tries to make it.
The table records tricks and duplicate scores as the hand finishes.

![A bot-played auction in progress, with the bidding history and a player's hand visible.](docs/images/gameplay-auction.png)

![Four cards from a completed trick, with the contract and trick count shown beside the table.](docs/images/gameplay-trick.png)

You must take one of the four player seats to use the table.
There is no spectator or kibitz mode, so people who are not seated cannot watch the cards or the auction from inside the room.

### Use bots

Bots can fill seats for a game, or the host can turn on autoplay for a player who needs to step away temporarily.
For a permanent bot seat, select **Bot** for that seat while creating the table.
For a temporary substitute, the host can enable the bot for the player's seat from the table controls, then turn it off when the player returns.
The player keeps their seat and stays in the room call while the bot handles bridge actions.

OpenRouter is a service that provides access to AI models from many providers through one API.
Bot play can cost money because AI model requests may be billed; the table displays the accumulated OpenRouter cost as you play.
You bring your own [OpenRouter API key](https://openrouter.ai/).
Enter the key in the create screen when setting up bot seats, or in the table's bot controls before enabling a substitute.
The key is stored in the host browser and is not included in the shared room link.
If the current host has no usable key, bot play is unavailable until a host with a key takes over or the key is set.
You can choose the model order and retry settings when creating the room.

### Call and finding players

The table includes an optional audio and video call for room members.
Each player chooses whether to join the call and whether to send a microphone or camera.
On mobile phones, video calls are intentionally unavailable because the screen has limited space; audio calls remain available.
The call is separate from bridge actions, so using autoplay does not make the player leave the call.
The call has no kibitz or spectator access.

OpenTrick does not currently provide matchmaking or a way to find random players online.
You need to invite people yourself and share the room link with them.
Random-player discovery may be added in the future.

### Save and reuse a room link

You can bookmark or save the shared table link and reuse it with regular partners.
The link keeps the seat names and table setup, so it can start a fresh table for the same group without creating and distributing another invitation.
The current game state is stored in the players' browsers, not on a game server.
After about 24 hours without activity on a device, its saved table expires; starting again from the saved link creates a fresh session and does not restore the previous deal, score, or seat claims.
Use **Copy link** in the table if you need to share the invitation again.

## License

OpenTrick is all rights reserved, with free access to play the hosted game.
The source code and original assets are not licensed for reuse or independent hosting.
See [LICENSE](LICENSE) for the terms.
GitHub's terms still allow users to view and fork a public repository ([GitHub licensing documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)).
