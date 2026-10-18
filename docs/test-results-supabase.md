# Test results of the Supabase version (history)

This file records the tests of the Supabase version, which the tag `supabase-last` (commit 09d887a) keeps.
The current peer-to-peer version has its own results in [test-results.md](test-results.md); the evidence below does not apply to it.

Date: 2026-10-18.
Milestone 1 (connection and recovery) and milestone 2 (bridge for four humans) were tested on the same environment.
The table layout and the optional call (call/layout increments C1–C8) were tested on the same environment too.

## Environment

| Item | Value |
| --- | --- |
| OS | Linux 7.2.10 (liquorix, amd64) |
| Browser | Google Chrome 155.0.8059.79, headless, through the Playwright `chrome` channel |
| Test tools | Playwright 1.64.1, Vitest 5.0.5, Node.js 22.22.1 |
| Site | Production build (`vite build`, Vite 8.3.4), served by `vite preview` on `http://localhost:4173` |
| Backend | The hosted Supabase project (Free plan), migrations `20261018000001_rooms.sql` and `20261018000002_call_signaling.sql` |
| Call media | Chrome's generated test devices (`--use-fake-device-for-media-stream`): a tone and a moving picture; each context gets only the microphone or camera permission that its test needs, so no permission prompt opens |
| STUN | The default `stun:stun.cloudflare.com:3478`; all browsers are on one machine, so the links do not need it |

Each simulated person in the browser tests has a separate browser context (separate storage) and a separate anonymous identity.

## Unit and integration

| Suite | At milestone 1 | After milestone 2 | After call/layout (C8) |
| --- | --- | --- | --- |
| Unit (`npm test`) | 152 of 152 pass | 316 of 316 pass | 564 of 564 pass (27 files) |
| Integration (`npm run test:integration`): access control, Realtime probe, project probe; from C2 also the call-signaling probe and the call mesh | 23 of 23 pass | 23 of 23 pass | 48 of 48 pass: the 23 earlier tests, 10 call-signaling probes, 15 call-mesh tests |

The 4 expiry tests of the integration suite are skipped unless `LB_EXPIRY` is set.
The call-signaling probe P0 runs only with `LB_CALL_SQL=absent`, so a full run skips 5 tests.

## Milestone 1: connection and recovery

### Browser acceptance (handover §10, adapted to the owner's decisions)

Each row passed in 4 consecutive runs of the full suite (`npm run test:e2e`, 17 tests, 2.1–2.3 minutes per run).
Run 4 used the final test files.
Runs 1–3 differed only in the lower time limit of row 5c (20 s instead of 18 s).
Times below are from runs 2, 3 and 4; run 1 did not record them.

| Row | Check | Result |
| --- | --- | --- |
| 1 | The creator gets a West-host table with three free seats | PASS |
| 2 | Three browsers take North, South and East from one link; the picker offers only free guest seats | PASS |
| 3 | A test message and three replies arrive in the same order in all four views, each "Received by 3 of 3" | PASS |
| 4 | A guest reload restores the seat and the transcript | PASS |
| 5a | Another browser is not offered a held seat ("All seats are taken.") | PASS |
| 5b | After the host releases North, a different browser takes it; the old tab shows "superseded" and cannot send; "Take seat back" is refused while the new holder is present | PASS |
| 5b, reopen | Closing the tab and opening the link again gives the same seat back without the picker | PASS |
| 5c, guest | A guest that goes silent (all Supabase traffic cut) loses its seat after the 30 s timeout; a different browser takes it; the old tab shows "superseded" when its network returns | PASS; seat offered 30.7 s, 30.7 s and 27.7 s after the network loss |
| 5c, host | The host goes silent; another browser takes the host seat with the host link after the timeout; the old host tab shows "superseded"; the new host processes a guest message | PASS; seat taken 21.7 s, 30.8 s and 30.8 s after the network loss |
| 6 | The host tab crashes; guests show "waiting for host"; a guest message stays "Pending"; the reopened host processes it | PASS |
| 7 | All four browsers quit and restart, then open the plain link: same seats, same room, same transcript | PASS |
| 8 | The database stores a commit but the host does not get the response: the message is stored exactly once, also after a host reload, and the room continues | PASS; 1 commit call in each recorded run (see limits) |
| 9 | A second game gets a new ID, an empty transcript, and no messages from the first game | PASS |
| 10 | With Supabase unreachable, the outgoing message stays "Sending" with the retry banner and appears in no transcript; when the network returns, it is accepted once everywhere | PASS |
| Smoke | One browser, four tabs, one seat per tab | PASS |
| All | No uncaught page errors in any tab | PASS |

After milestone 2, all 17 tests above passed again in the full-suite run of the next section, on the build with the bridge table.

### Expiry and cleanup (owner-approved SQL in the hosted SQL Editor)

The test room had a host (identity-1), a guest on North (identity-2) and one accepted command.
Identity-3 was the outsider.

| Step | Time (UTC) | Result |
| --- | --- | --- |
| `npm run expiry:prepare` | Before 02:22 | Room created; 4 seats, 2 members, 1 accepted command |
| SQL: set `last_activity_at` 25 hours back, then count the rows | 02:22 | rooms 1, seats 4, room_members 2, commands 1 |
| `npm run expiry:verify` | 02:22:46 | 3 of 3 pass (see below) |
| SQL: count the rows before cleanup | 02:23:02 | rooms 1, seats 4, room_members 2, commands 1 |
| SQL: `select private.cleanup_expired_rooms();` | 02:23:13 | 1 room deleted |
| SQL: count the rows after cleanup | 02:23:31 | rooms 0, seats 0, room_members 0, commands 0 |
| SQL: `select jobname, schedule, command, active from cron.job;` | 02:23 | `libre-bridge-cleanup`, `*/15 * * * *`, `select private.cleanup_expired_rooms()`, active |

The three verify tests:

- Control: in a live room, the same host and guest read rows in all four tables, and the outsider's lobby request succeeds.
- In the expired room, the host, the guest and the outsider read 0 rows in all four tables, and the lobby and snapshot requests return `unavailable`.
- In the expired room, every caller gets `unavailable` for a claim of North, East and West, and for submit, commit, reject, heartbeat and release.

The rows still existed after the verify run, so the denials came from the expiry check and not from a deleted room.

Test correction: in the first verify run, the control test failed with "identity-1 commands: expected 0 to be greater than 0".
The control room had no command, so the control could not show that the callers can read the `commands` table.
This was a defect in the test, not in the product.
The control room now gets the same guest message and host commit as the expired room.
The second run passed.
The two denial tests passed in both runs.

## Milestone 2: bridge for four humans

### Browser acceptance (`tests/e2e/bridge.spec.ts`)

Four browser contexts sit at one table: West is the host, and North, South and East are guests.
The auction is fixed (North opens 1♣, then three passes), so North declares and South is dummy.
In the play, each player clicks the first card that the page lets them click.
The deal is random, so each run plays a different board.

| Row | Check | Result |
| --- | --- | --- |
| 1 | North deals board 1; each tab shows its own 13 cards and three hidden hands; the four own hands together are 52 different cards | PASS |
| 2 | The auction 1♣, Pass, Pass, Pass, with a reload of South (guest) and West (host) after the first pass; all four tabs show the same auction and the contract "1♣ by North"; the bid box goes away | PASS |
| 3 | East leads; then all four tabs show dummy's hand; North gets "play a card from dummy", South (dummy) gets no clickable card | PASS |
| 3, forced | South sends a dummy card straight to the submit RPC, past the page (a modified client): the host rejects it with "dummy's cards are played by declarer", and the table does not move | PASS |
| 4 | Play to the end of trick 4, with a reload of West (host) and North (declarer); after each reload, the table text is the same as before the reload | PASS |
| 4–5, forced | The first time that a player must follow suit from their own hand and also holds another suit, the test sends a card of the other suit straight to the submit RPC: the host rejects it with "&lt;card&gt; does not follow suit", the player's tab shows the refusal, and the table does not move; the test fails if this never happens on the board | PASS |
| 5 | The board is played to 13 tricks; all four tabs show the same result line, the same score sheet and all four original hands, have no clickable card, and offer "Deal board 2" | PASS |
| 6 | East deals board 2 (dealer East, N-S vulnerable); four passes; all tabs show "Passed out. No score."; the score sheet has 2 rows and the totals do not change | PASS |
| All | No uncaught page errors in any tab | PASS |

Runs:

1. The bridge suite alone: 7 of 7 pass, 1.5 minutes.
2. The full browser suite (milestone 1 and 2, 24 tests): 24 of 24 pass, 3.5 minutes.
   Row times: 1 in 3.9 s, 2 in 6.2 s, 3 in 4.6 s, 4 in 19.2 s, 5 in 42.7 s, 6 in 6.0 s.

### Visual check

A throwaway script (not in the repository) took screenshots of one table with the same build: the auction at 1280 px, and the play at 1280 px and at 390 px, for the declarer and a defender, in the light and the dark colour scheme.
The four seats are in the correct places for each viewer (own seat at the bottom, left-hand opponent on the left).
At 390 px, the page has no horizontal scroll (scroll width 390 px).
At 390 px, a suit of 4 or more cards in a side hand (for example dummy) wraps to a second line.
The cards stay readable.

### Open items

| Item | Owner | State |
| --- | --- | --- |
| Four people on different networks and devices | Owner | Not run |
| A real Android phone: switch apps, return, and reopen the link | Owner | Not run |
| Other browsers (Firefox, Safari, mobile browsers) | Owner | Not run |
| A full bridge session with four people, with real bidding and play | Owner | Not run |

## Call signaling (call/layout increment C2)

Migration `20261018000002_call_signaling.sql` was applied once in the hosted SQL Editor on 2026-10-18, after owner approval.
The editor text had the same SHA-256 as the repository file before the run, and the editor answered "Success. No rows returned".
The probe is `tests/integration/call-signal.test.ts`, with four identities: the host (West), North, East and an outsider who knows the room ID.
It logs only keys, counts, codes and timings, never message bodies.
The design and its trade-offs are in [ADR 0003](adr/0003-call-signaling-authorization.md).

| Row | Check | Result |
| --- | --- | --- |
| P0 | Before the apply (`LB_CALL_SQL=absent`): the function does not exist (PGRST202); the holder's join of its own private inbox is refused | PASS |
| P1 | North sends an offer to East: only East receives it, with `from`, `fromGen`, `toGen` and `roomId` set by the database and the message unchanged; a message to all reaches East and West, not North | PASS |
| P2 | West names North's seat and generation: `superseded`; nothing is delivered in 5 s | PASS |
| P3 | The outsider's join of East's inbox is refused; its send gets `superseded`, and a send to an unknown room gets `unavailable`; nothing is delivered | PASS |
| P4 | West's WebSocket join of East's inbox is refused; a REST publish with `private=true` is refused (Unauthorized) with West's session and with the publishable key alone; the Data API does not expose `realtime.send` or `realtime.messages` (PGRST106); nothing reaches East. Control: the same REST publish with `private=false` reaches a public subscriber of the same topic name | PASS |
| P5 | North claims its seat again: a send at the old generation gets `superseded`; East's answer reaches the new inbox, and the old inbox channel gets nothing | PASS |
| P6 | Six malformed topics (seat X, a short room ID, a leading zero, generation 0, 10 digits, an extra part) are refused for a seat holder | PASS |
| P7, P8 | After the host releases North: North's send gets `superseded`, its open inbox gets nothing when East sends to all (`sent` is 1, West only), and its new join of the old inbox is refused | PASS |
| P9 | Join of an allowed inbox: median 62 ms, maximum 62 ms; from the start of the function call to the delivery: median 71 ms, maximum 94 ms (10 trials each; threshold median ≤ 1 s, maximum ≤ 3 s) | PASS |
| P10 | 10 call messages leave the room's expiry time unchanged; a seat claim (control) moves it later | PASS |
| P11 | A message that is an array, a string, null, without a type or with an unknown type, or 1 octet over 48 KiB, and a `to` that is the own seat, X, or missing for an offer, answer or ICE batch: all get `invalid`, and only the control message at exactly 48 KiB is delivered | PASS |

Runs and findings:

1. The first run after the apply: 7 of 10 pass.
   - P1 failed because the delivered payload also has an `id` key, which `realtime.send` adds. The test now expects it.
   - P6 failed because 6 parallel refused joins on one connection gave 2 refusals and 4 client timeouts (10 s).
   - P7 got a timeout for one refused join right after P6.
   The test now joins one topic at a time.
2. The second and third runs: 10 of 10 pass. One refused join takes about 4 s (median 4059 ms, maximum 4066 ms over 6 trials).
   After a refused join, realtime-js tries again (2 CHANNEL_ERROR statuses in 12 s), so the client must remove the channel itself.
3. The full integration suite after the apply: 33 of 33 pass (23 earlier tests and the 10 probes); 5 are skipped by their phase setting.

## Table layout and call (call/layout increments C1–C8)

The browser specs are `tests/e2e/layout.spec.ts`, `call-audio.spec.ts`, `call-video.spec.ts` and `call-lifecycle.spec.ts`.
Below, "audio 3" means test 3 of `call-audio.spec.ts`, and so on.
Each spec has four seats in separate contexts with separate identities.
West, North and East are desktop windows (1280×720).
In the audio and video specs, South is an emulated phone (390×664, mobile, touch).
A test probe in the page counts the peer connections, the captures, the live tracks, the inbox joins and the received bytes.
It keeps no session descriptions, no ICE candidates and no addresses.
"Sound arrives" means that the received audio bytes of a link grow by more than a threshold in 2 s.

### Handover §8 acceptance tests

| Handover §8 test | Check | Result |
| --- | --- | --- |
| Play without joining | audio 1: four tabs at the table and a dealt board; after 4 s, each tab has 0 peer connections, 0 captures, 0 live tracks, 0 inbox joins and 0 `send_call_signal` requests. video 1: before Join, no tab asks for the camera or has a video source. | PASS |
| Each named preset | video 1: the desktop chooser has 5 choices and 4 switches; the phone's chooser has 2 choices (Audio only, Listen only) and 2 switches, and no camera switch. video 4: the desktops use all five choices, by Join and by switch changes during the call; each tab shows the switches of its choice. Unit: `call-policy.test.ts`. | PASS |
| All source/destination combinations | video 4: three rounds of a covering set of choice pairs; in each round, each choice sends next to one peer that receives video and one that does not; video arrives only where the sender sends and the receiver receives. audio 9: all 12 directions between four seats carry sound. Unit: each part of the rule (both in the call, the sender's switch, the receiver's switch, the device class) blocks the medium alone; an unknown peer gets nothing. | PASS; the browser covers a covering set, not all 25 choice pairs |
| Local send off while peer requests sendrecv | audio 3: North's Send mic off; West shows "North · Mic off". audio 12: after the toggles, 0 live tracks, and West gets less than 100 audio bytes from North in 2 s. video 5: North forces a sendrecv video section on its link to the phone; the phone sets it inactive, gets 0 video bytes, shows no picture and asks for no camera. Unit: "stops the microphone at once when Send mic goes off, then tells the peers". | PASS |
| Local receive off while peer continues sending | audio 3: West's Hear off; North's audio element stops and the caption shows "North · Audio reception off". audio 10: South's Hear off; South gets less than 100 audio bytes from each peer, and the other three seats still hear each other. video 2: West's See cameras off; North's tile has no picture and no video source. | PASS |
| Disable while getUserMedia prompt is pending | audio 11: the probe holds a granted microphone stream back for 3 s; Send off during the wait; the late track is stopped, no sender carries it, and the tab has 0 live tracks. | PASS; the wait is simulated, not a real permission prompt |
| Rapid toggles / simultaneous peer changes | audio 12: two seats click 9 switches each at the same time; each ends in its last choice, on the same links, with no extra live track. audio 9: four seats confirm Join within 1 s; one link per pair and one live microphone per tab. Integration `call-mesh.test.ts`: two and four seats join in the same tick. | PASS |
| Camera denied, microphone allowed | video 3: East has no camera permission and joins with Audio + video both ways; the camera switch shows "denied", the panel says "The browser blocks the camera: others cannot see you.", East's microphone is on, both other desktops hear East, and no tab gets video from East. | PASS |
| Listen/watch with no local capture permissions | audio 4: East has no microphone permission and joins with Listen only; East makes 0 captures and hears West. video 3: East has no camera permission and gets the pictures of North and West. video 4: East joins with See cameras; send voice, gets pictures, and asks for no camera. | PASS |
| Reload, rejoin or seat takeover | audio 8: a reload starts outside the call. audio 13: North reloads; each peer closes the old link after the new seat claim and within 10 s, and the reloaded page sends no call message; Join connects again. lifecycle 4: the host releases South; the old tab ends its links and tracks; a new identity takes South and has 0 links, captures and inbox joins until Join, then connects to all three. | PASS |
| Forged sender, wrong room, old generation | lifecycle 2: South's session sends for North's seat, for a later generation, for an unknown room, with an unknown type, and an offer without a target; all are refused (`superseded`, `unavailable`, `invalid`), and no browser gets a frame in 2 s. lifecycle 3: ten malformed or misaddressed messages at South's real generation reach the browsers and change no link, caption or note. lifecycle 4: the old generation is refused from the old tab and from the new holder. Integration `call-signal.test.ts` P2–P8. | PASS |
| Leave, room navigation or expiry | audio 5: Leave ends North's microphone and links; the others show "North · Not in call". video 7: the phone's Leave icon ends its microphone and links; the desktops show "South · Not in call" and keep their 2 links. lifecycle 6: East leaves the room page during the call: 0 links, 0 live tracks and one inbox leave for each inbox join; the peers show "East · Not in call"; back on the link, East gets its seat outside the call. Expiry: unit test "leaves the call when the last switch goes off, and when the seat is lost". | PASS for Leave and navigation; expiry has a unit test only |
| One player leaves | lifecycle 5: South leaves; each of the other three seats keeps 2 links with sound. audio 5: after North leaves, West and East stay connected. | PASS; no test has the host leave while the others stay (the call modules do not read the host seat) |
| Restrictive network / one failed pair | lifecycle 7: North's browser may use relays only (`iceTransportPolicy: "relay"`), and there is no relay; its three pairs show "Direct connection unavailable" and Retry on both ends within 25 s, the other three pairs stay connected, and North bids and plays. audio 6: after a network cut at East, the call messages come back and the sound continues. Unit: `ice.ts` refuses TURN URLs. | PASS with a forced browser policy; real networks: owner |
| Local player seated at N, E, S or W | layout 1: for each of the four viewers, the own hand is lowest, the partner highest, the left-hand opponent leftmost and the right-hand opponent rightmost; the labels show the real seats and names; each other seat has a 4:3 tile; there is no own tile. video 2–4: each picture shows in its sender's tile. | PASS |
| Existing game UI with or without a call | layout 1–2: at 1280×720, the hands, the tiles, the centre, the call panel and the game slot do not overlap, and the own hand, the bid grid and the call panel show without page scroll; at 1366×650 the own hand and the game slot show; at 900×600 during the play, dummy and the trick keep apart. layout 4: Claim all and Undo are disabled placeholders. audio 2: the call sends no `submit_command`. lifecycle 7: North bids and plays during a call. | PASS; the overlap checks ran outside a call; during a call, video 2 checks the tile box only |
| Mobile control strip | layout 3: at 320×568, 360×640, 390×664 and 844×390, the icons are one row, 44–48 px high and as wide as the own hand; the page has no horizontal scroll; the own hand, the game slot and the icon row are on the screen and apart. layout 4: separate microphone and speaker icons with names that say the direction and the medium, and a slash in the off state. | PASS in emulation; safe-area insets and real browser bars: owner |
| Mobile phone/tablet, including landscape | video 1: the phone's chooser offers only Audio only and Listen only. video 5: the phone in the call hears all three desktops, asks for no camera, and has no video section or picture. audio 9, 10 and 14: the phone joins, its Hear switch works, and its vanish ends its links. video 7: the phone's Leave. Tablets: device-class unit tests only (`userAgentData.mobile`, iPadOS with touch points, no fine pointer). Landscape: the layout fit at 844×390 only. | PASS for a phone in portrait emulation; tablets and calls in landscape: not run (owner) |
| Desktop camera sender with a mobile peer | video 5: North and East send their cameras; the phone gets audio only; North still gets East's picture. | PASS |
| Restored video preference / remote video offer on mobile | video 5: the forced sendrecv video offer to the phone (see above). The app stores no call switches, so there is no preference to restore: a reload starts outside the call (audio 8). Unit: "never asks a compact device for the camera: not for restored video switches, not for a video switch". | PASS for the forced offer; no stored preference exists |
| Active desktop call becomes compact | video 6: West sends and receives video; the window becomes 800 px wide; the camera ends within 1 s, the video switches go away, West shows no picture and North loses West's picture, and the sound continues both ways; at 1280 px again, the video switches stay off, and no camera request comes in 3 s. | PASS |
| All video states and viewport sizes | video 2: North's tile in West's view keeps its box (within 1 px) through "North", "Not in call", "Connecting", "Audio only", "Audio + video" and "Video reception off"; after reception off, the tile has no video source. video 6: no video source stays after the switch to compact. Sizes: layout 1–3 (1280×720, 1366×650, 900×600 and four compact sizes). | PASS; the tile box with video was checked at 1280×720 only |

### Measurements

| Measurement | Value | Test and runs |
| --- | --- | --- |
| Four seats confirm Join within 1 s | 36 call messages delivered, at most 24 in one 1-s window (budget 50), 28 `send_call_signal` requests, 36 inbox rows; the same in each of six runs | audio 9, C5b |
| A reload closes the old link at the peers | 167–444 ms after the new seat claim | audio 13, C5b |
| A vanished tab leaves the call | "Not in call" 9.9–10.1 s after the presence ends (limit 11.5 s) | audio 14, C5b |
| A desktop becomes compact | The camera ended 67 ms after the resize (limit 1 s) | video 6, one C6 run |
| Desktop fit at 1280×720 | The bid grid ends at 534 px in the auction, the call panel at 692 px in the play | layout, C3 |

### Runs

1. `call-mesh.test.ts` (integration, C4): 15 of 15 in three runs.
2. `call-audio.spec.ts` (C5b): 15 of 15 in six runs.
3. `call-video.spec.ts` (C6): 7 of 7 in two runs.
   C8 added video 7 before the two full runs; after them, it added the camera-request check to video 4.
   The spec with both additions passed 8 of 8 in two separate runs (the camera ended 64 ms and 63 ms after the resize).
4. `call-lifecycle.spec.ts` (C7): 9 of 9 in 3 of 4 full browser runs (59 of 59 each); run 1 failed because of a test defect (below).
5. C8, two full runs of type check, lint, unit, integration and browser suites:
   - Run 1: unit 564 of 564, integration 48 of 48 (5 skipped), browser 60 of 60 in 7.1 minutes.
   - Run 2: unit 564 of 564, integration 48 of 48 (5 skipped), browser 60 of 60 in 6.7 minutes.

### Findings and test corrections

- Product defect, C3: at 1280×720 the bid grid ended at 754 px, so a player had to scroll the page to call.
  The layout was changed, and the layout spec now checks the fit; the check fails on the old layout.
- Test defect, C6: audio 13 failed in 1 of 4 runs.
  The reload now waits until North's call messages stop, because the last toggles of audio 12 could still be in negotiation.
  This cause is an inference; it was not observed directly.
- Test defect, C6: a controller unit test counted a change notification from an earlier step; the test now clears its record first.
- Test defect, C7: run 1 failed before any call check, because the seat tiles come with the first board.
  West now deals in lifecycle 1.
- Coverage gaps closed in C8: no browser test pressed Leave on a phone, so video 7 was added; no browser test checked that the See cameras choice asks for no camera, so video 4 now checks it.

### Mutation checks

Each check put one deliberate defect into the code or the test input, ran the test, and then removed the defect.
Each listed defect made the named test fail.
This is a set of targeted checks, not systematic mutation testing.

| Defect | Failed test |
| --- | --- |
| The old desktop layout (the game slot ends at 731 px at 1366×650) | layout 1, the fit check |
| The inbox does not count its reconnect attempts, or the flood limit uses `<=` for `<` | unit, `call-signaling.test.ts` |
| The controller does not give the microphone track to the links | unit, `call-controller.test.ts` |
| The camera goes on every video sender, whatever the plan | 6 unit tests of the media plan |
| A valid join instead of one malformed join | lifecycle 3: all three peers open a link and show "South · Connecting" |
| One delivered message among the refused ones | lifecycle 2: one extra frame per browser |
| The camera also runs while See cameras is on | video 4: East asks for the camera 2 times instead of 1 |

### Open items (owner)

| Item | State |
| --- | --- |
| Real phones and tablets (Android Chrome, iOS Safari), in portrait and landscape, with real browser bars and safe areas | Not run |
| Firefox and Safari on a desktop | Not run |
| Four people on different networks (home routers, mobile data, a restrictive network) | Not run |
| mDNS host candidates between real devices | Not run |
| Real microphones, speakers and headphones (echo) | Not run |
| The deployed `https` site (C9) | Not run |

## Limits of this evidence

- The tests run against the hosted production project.
  A policy or check cannot be removed there to show that a test fails without it.
  Instead, each denial in the access-control suite is paired with the same request from an allowed caller, so an empty or refused answer cannot come from a broken query.
- Systematic mutation testing was not run.
  For the call and the layout, targeted mutation checks were run (see the call section).
- A lost network is simulated per browser context: Playwright routes abort all HTTP requests to Supabase and close the Realtime WebSocket on both sides.
  This is not a real operating-system network change, mobile network, or Android tab suspension.
- All browsers ran on one machine with one IP address, so real latency differences between players were not tested.
- Row 5c checks a lower limit only: the seat must not become free earlier than 18 s after the network loss (timeout minus one heartbeat interval, less 2 s for jitter).
  The upper limit is the test's wait of 75 s.
- Row 8 accepts two correct paths: the host retries the commit with the same command ID, or Realtime shows the command as accepted first.
  The test records the number of commit calls but does not require a retry.
  In all recorded runs the host made 1 commit call: it saw the acceptance before a retry was due.
  So the browser suite did not exercise the retry path.
  The integration test "commits each command once, answers a retry with its number, and reports conflicts" and the host unit test "retries a commit whose response was lost and finds it accepted, without a second event" cover it.
- The expiry check called the cleanup function by hand.
  It did not watch the scheduled job delete a room; it read only the job's definition and its active flag.
- The bridge browser suite uses one auction (1♣ by North) and the first clickable card in each turn.
  It does not try doubles, redoubles, slams or many contracts in the browser; the unit tests of the rules engine and the scoring cover those.
- The bridge browser suite checks that the score is the same in all four tabs and has the correct form.
  It does not calculate the expected score again; the unit tests pin the duplicate scores.
- The forced requests show that the host rejects an illegal card or a dummy play.
  The database does not check the bridge rules: the host's browser is the referee.
  A modified host could accept an illegal action; the owner accepts this in the trust model ([ADR 0001](adr/0001-room-link-access-and-json-state.md)).
- The bridge suite ran 2 times, against 4 times for the milestone 1 suite.
- The call-signaling probe uses one machine and one IP address, and four identities in one Node.js process.
  It does not test a browser call; increments C5–C7 do.
  The explanation that the server answers the joins of one connection in order is an inference from the 2-of-6 result, not a measurement.
- The call tests use generated test media on one machine.
  They measure received bytes, frames and track states, not sound or picture quality.
- The peer captions ("Mic off", "Audio only") come from the switches that each peer announces; the byte counts are the measured evidence.
- The tile shows a remote picture only while its track is unmuted; this behaviour was observed in Chrome only.
- The priority check reads the sender parameters (audio high, video low); it does not show their effect on a congested network.
- The relay-only check forces a browser policy; it is not a real restrictive network.
- The address check covers the page text, the attributes, the field values and the console texts in the browser tests.
  It does not cover the network traffic or the stored call messages, which contain addresses by design (README, R6).
- The call leaves at room expiry through the same path as a lost seat; only a unit test covers it.
- The C6 unit tests for video were written after the code, so no failing check came first.
- Only headless Chrome was tested.
- The app needs a secure context (`localhost` or `https`); a plain-`http` LAN address does not work.
