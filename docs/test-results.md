# Test results

History: this file records the bridge game, before the conversion to canasta.
The peer-to-peer layer and the call stayed, but the rules, the table screen, and the bots changed.
The tests of the canasta version are in [test-results-canasta.md](test-results-canasta.md).

Date: 2026-10-19.
This file records the tests of the peer-to-peer version (plan increments P0–P11, commits 1969c9e and later).
The tests of the Supabase version are in [test-results-supabase.md](test-results-supabase.md); that evidence does not apply to this version.

## Environment

| Item | Value |
| --- | --- |
| OS | Linux 7.2.10 (liquorix, amd64), one machine |
| Browser | Google Chrome 155.0.8059.79, headless, through the Playwright `chrome` channel |
| Test tools | Playwright 1.64.1 (one worker, no retries, traces off), Vitest 5.0.5, Node.js 22.22.1 |
| Site | Production build (`vite build`, Vite 8.3.4), served by `vite preview` on `http://localhost:4173`; the test harness page on `http://localhost:4174` |
| Discovery | Trystero 0.26.0 through the three default public WebTorrent trackers: `wss://tracker.openwebtorrent.com`, `wss://tracker.webtorrent.dev` and `wss://open.ftorrent.com` |
| STUN | The default `stun:stun.cloudflare.com:3478`; no TURN |
| Call media | Chrome's generated test devices (`--use-fake-device-for-media-stream`): a tone and a moving picture; each context gets only the permissions that its test needs |
| Machine load | Other jobs ran on the same machine; the load average was about 36 during the earlier runs, and about 2.4 at the end of run full4 |

Each simulated person has a separate browser context, so each has its own IndexedDB, localStorage and holder.
No browser test uses a fake network, a mock or a fake server (owner instruction, 2026-10-19).
Every browser test goes through the public trackers and real WebRTC links.

## Browser suites

| Spec | Tests | What it checks |
| --- | --- | --- |
| `smoke` | 1 | One browser with four tabs: create, three seats from one link, ordered messages |
| `p2p-mesh` | 12 | Four pages form the full mesh, take seats and replicate commands; the table survives the host and three players leaving; a network change; a visitor whose first links fail; a latecomer whose first offers reach no page that answers; the presence rule; call signaling only from bound seats; the call status after a network change and a reload; a wrong key; the receive cap; an active sibling tab cannot be displaced; a failed seat claim |
| `acceptance` | 13 | One link; the lobby offers only free seats; ordered messages; a reload; an active seat cannot be taken from another tab; release of a silent seat; reopening the link; a host crash with a waiting message; all four browsers quit and reopen; a lost result is stored once; a second game |
| `seat-timeout` | 3 | A frozen player and a frozen host show offline, their seats free after the timeout, and the thawed tabs are superseded |
| `election` | 8 | The button at 10 s and the witness rule; a lone seat volunteers when a witness comes after 30 s; the automatic volunteer; two clicks in the same millisecond give one host; a reloading host resumes; a thawed old host steps down; a sibling tab cannot take the host's active seat |
| `resilience` | 7 | A tracker outage; a browser that blocks site data; an old Supabase link; a link of another version; a damaged key; expiry after 24 h |
| `reconnect` | 8 | Plan §12 R1 and R4 through the UI: crash and reload of a follower, a deal that waits for an absent player, a host crash mid-auction, dummy away during the play, three players away while one stays, a frozen player |
| `bridge` | 7 | The six bridge flows; forced actions come from a modified tab |
| `call-audio` | 15 | Joining, the switches, Leave, cut links, the keyboard, reloads, four seats at once, a seat that stops hearing, a late microphone, rapid toggles, a vanished tab |
| `call-video` | 9 | The desktop and phone choosers, the tile states, a blocked camera, video only where both sides agree, See cameras off, a phone next to camera senders, a desktop that becomes compact, the phone leaves |
| `call-lifecycle` | 9 | Forged call frames from a modified client and from a page without a seat, a holder change after a release, one player leaves, leaving the room during the call, a browser limited to relays, no address in any page or console message |
| `call-recovery` | 5 | Plan §12 R2: after a crash, a host change and a lost microphone permission, the call comes back with the same status |
| `layout` | 4 | The desktop and compact layouts and the names of the call controls |

Eleven specs also check that no page reported an uncaught error and that no page sent a request to a Supabase host; `p2p-mesh` and `layout` do not.
A page that the test player (`tests/e2e/player.ts`) opens refuses and counts each request to a Supabase host.

### Runs

The P10 gate is two consecutive green runs of the full suite.
The suite had 100 tests up to commit 66b124b; commit 0e26b05 adds the `p2p-mesh` latecomer test, so runs full3 and later have 101.

| Run | Result | Duration |
| --- | --- | --- |
| full1 | Failed: 99 of 100 passed; the `p2p-mesh` call-status test expected a stored call record without its holder (a test defect, below) | 17.1 min |
| full2 | Failed: 95 passed, 2 failed, 3 did not run; `call-recovery` test 3 and the `seat-timeout` frozen-host test failed because a new page had no link for more than 45 s (a defect, fixed in 0e26b05, below); the later tests of those two serial specs did not run | 28.1 min |
| full3 | 101 of 101 passed, at commit 0e26b05 | 17.4 min |
| full4 | 101 of 101 passed, at commit 0e26b05 | 15.8 min |
| full5 | 101 of 101 passed, at commit e47be4b | 16.0 min |

Runs full3 and full4 meet the P10 gate.
Run full5 repeats the suite after the browser-test changes T1 to T4.
Its app code differs from 0e26b05 only by one comment and one `export` in `src/call/device-class.ts`.
In both runs, the `p2p-mesh` latecomer reached the lobby after 10.96 s with one rejoin, and the visitor whose first links fail after 31.1 s with two rejoins.
A scan of both run logs found no table key, no session description, no ICE candidate and no IP address.

The P9 gate was two consecutive green runs of the game specs (58 tests: `smoke`, `p2p-mesh`, `acceptance`, `seat-timeout`, `election`, `resilience`, `reconnect` and `bridge`):

| Run | Result | Duration |
| --- | --- | --- |
| gs1 | Failed: `bridge` test 2 (a test defect, below) and the `seat-timeout` frozen-host test | — |
| gs2 | Failed: `bridge` test 2 (the same test defect) | — |
| gs3 | 58 of 58 passed | 11.3 min |
| gs4 | 58 of 58 passed | 10.9 min |

During P10, each call and layout spec passed alone before the full runs: `call-audio` 15 of 15 (1.8 min), `call-video` 9 of 9 (1.5 min), `call-lifecycle` 9 of 9, `call-recovery` 5 of 5 and `layout` 4 of 4.

### Measurements

The owner asked on 2026-10-19 for a sender-side check of the pause: when a receiver turns off a medium, the partner's sender for that pair must stop, and its sender to a third seat must go on.
The probe measures the bytes that each sender sent in 2 s and maps each sender to its pair through the stream number (SSRC) that the receiving tab reports.
The figures are from run full1:

| Check | Paused pair | Other pairs |
| --- | --- | --- |
| `call-audio` test 10: South turns Hear others off | West's audio sender to South: no track, 0 bytes | West's senders to North and East: a track each, 5997 bytes each |
| `call-video` test 5: East turns See cameras off | North's video sender to East: no track, 0 bytes | North's video sender to West: a track, 35 551 bytes |

The tests assert the paused sender and one other sender; the table shows all measured senders.
In both tests the paused sender sends again after the receiver turns the switch on again.

In `call-audio` test 6 (run full1), the call came back 3816 ms after East's trackers returned.

## Fault injection

All faults are real events in real Chrome on the real network.
No test replaces a network, a server or a browser API with a stand-in.

- A crash: `page.close({ runBeforeUnload: false })`, so no unload handler runs; IndexedDB and localStorage stay.
- A frozen page: a CDP `Debugger.pause`.
  Headless Chrome reports every page as visible and ignores `Page.setWebLifecycleState` frozen (measured: a 200 ms timer kept firing), so the plan's freeze method (plan §9) was replaced.
- A tracker outage: the page's tracker WebSockets are closed and new ones are refused.
- A network change: the harness closes all WebRTC links and the tracker sockets of a page; Trystero opens the sockets again, and the page keeps its peer identifier.
- Cut game links: the game connections of one page are closed and its trackers are blocked for longer than 10 s; its call connections stay open.
- A failed first link: for a time, each new `RTCPeerConnection` of the page may use only relay candidates; there is no TURN server, so its ICE fails.
- Withheld offers: for 8 s after the first tracker socket of a browser context opens, its announces reach the trackers without their WebRTC offers, and the offers and answers that the trackers relay to it are dropped.
  This is a message filter on the real tracker sockets; it reads only which fields a message has, never a session description.
  It has the effect of offers that reach only pages that cannot answer, such as a frozen tab or a tab that left the table but keeps its tracker sockets.
- A relay-only call: the same limit for the call's connections only, so the game links stay direct.
- A late call answer: the probe delays the page's call messages by 4 s.
- Forged call frames: a harness page holds a seat and sends raw `lb-call` frames past the call signaling.
- A modified tab: the test enables a disabled control in the DOM and clicks it, so the page's own handler sends an action that the host must refuse.
- A browser that blocks site data: a Chrome profile with "Don't allow sites to save data".
- An old table: the stored table record is aged by 25 h.
  The plan moved the browser clock instead; aging the record tests the same expiry path.
- A lost microphone permission: `context.clearPermissions()`, then a reload, then `grantPermissions`.

## Defects found by these tests

| Commit | Defect | Evidence |
| --- | --- | --- |
| 68f2247 | The host engine never counted a quiet player as seen, and a page that became host mid-session saw every other seat as offline | The new presence checks (unit tests and `p2p-mesh`) |
| 82fb7e4 | A frozen page keeps its WebRTC link, so the roster listed it as present while the host refused its seat | Before the fix, a paused North stayed online for 15 s (run st3); after it, `seat-timeout` 3 of 3 and `acceptance` 13 of 13 passed |
| 95477c2 | A page without peers whose first WebRTC exchange failed stayed alone until the next tracker announce, up to 120 s | 2 of 11 failures in `smoke` and `p2p-mesh` after P8b; the new `p2p-mesh` case with `failLinksFor` passes |
| ef97574 | In a browser that blocks site data, `navigator.locks.query()` rejects with a `SecurityError`, and the page stayed at "Connecting" with a page error | `resilience` failed in run rs1 and passed 7 of 7 in run rs2 |
| 738caba | A denied microphone was announced as "Audio only" instead of "Mic off"; the Supabase version had the same defect | `call-audio` test 4 |
| 0e26b05 | A new page could stay without any link for more than 45 s: in `seat-timeout`, the latecomer's first offers went only to pages that cannot answer, and the trackers' next announce comes only after 120 s; in `call-recovery` test 3, the two pages of a seat pair kept their two-page rooms open at different times, because one side's retry wait continued after the other seat got a new page; the fix makes a page without links join the table room again after 10 s alone (then 20 s, 40 s, at most 60 s), and starts a seat pair again without a wait when the other seat has a new page | The two failures of run full2; the new `p2p-mesh` latecomer test failed 3 of 3 on the code before the fix (66b124b), each time with 3 trackers open and no link, and passed 3 of 3 with it, with the lobby after about 11.0 s and one rejoin; with the fix, `call-recovery`, `p2p-mesh` and `seat-timeout` passed 19 of 19, and `call-recovery` 15 of 15 (three repeats) |

## Test corrections and acceptance changes

Each change is recorded in its commit message.

- `p2p-mesh` (66b124b): since 12f49ce, the host stores the seat holder with each call record, but the call-status test still expected the record without it.
  The spec had not run since the P9 gate, so the stale expectation showed only in run full1.
  The test now expects East's own holder, which the harness reads from East's browser, in every replica and after East's reload.
- `bridge` (808d7d9): the reload check took its "before" snapshot while a page still waited for the previous seat's new page; it now waits until the roster shows four seats online.
  This was the `bridge` test 2 failure in gs1 and gs2.
- `bridge` (65c3b53): a forced revoke and a forced play of dummy's card come from the page itself; the reload check ignores the page's own notes of refused actions, because the host does not store a refused command.
- `election` (53cc409): the lone-seat case is now two cases, because the page volunteers as soon as a witness comes (rule 8).
- `resilience` (ef97574): the damaged-key case changes the first key character; the last one holds only 4 key bits, so changing it made the link invalid instead of naming another table.
- `reconnect` (b9b032c): a forced deal while a player is away stays waiting, as the presence rule specifies, instead of being refused.
- `smoke` (95477c2): the waits use the 45 s connection budget instead of 20 s.
- `call-audio` (8b525b9): the stored media records replace the database rows; a reload joins the call again from the stored status (plan §12 R2); with cut links, the call comes back when the links return, because the transport has no "lost" state.
- `call-video` (dcc15f7): the late answer comes from the probe's send delay instead of a delayed database request.
- `call-lifecycle` (14e8e6b): forged frames reach the browsers, and the receivers refuse them.
  A frame for another table or with its own sender seat cannot be sent, because the mesh stamps the table and the receiver takes the seat from the sender's binding.
  Back in the room after a navigation, the player rejoins the call with the stored status.
- `layout` (0e1f78d): the creator's default name is "player4", and a deal waits for all four seats.

## Unit tests

`npm test` (Vitest, also part of `pre-commit run --all`): 1231 of 1231 tests passed in 45 files, at commit e47be4b.

The unit tests check pure functions with real inputs: the link and identifier derivation, the validators, the election rules with a seeded simulation, the presence rule, the bridge rules and the view models.
Some older unit suites use in-memory stand-ins:

- `tests/unit/fake-mesh.ts`, an in-memory mesh, in the host-engine, follower, outbox, sync and replication-simulation tests;
- `tests/unit/call-fakes.ts` (call links) and `tests/unit/call-rtc-fakes.ts` (peer connections, tracks, transceivers and session descriptions) in the call peer, controller and mesh tests;
- a transport stand-in in `call-signaling.test.ts`.

They check logic only and are not evidence of network behavior.
No new test uses a stand-in.
On 2026-10-19 the owner asked to replace these suites with real browser and network tests.
Later that day the owner decided that these suites can stay if the software is shown to work on the real network.
The end-to-end suite gives this evidence (runs full3 to full5), within the limits in "Limits of this evidence" below, so the replacement stopped.
Replaced before that decision: the storage contract, the local log and the expiry failure now run in headless Chrome on its IndexedDB (`tests/browser`, Vitest browser mode).
The seat memory and the seat locks run on Chrome's `sessionStorage`, `localStorage` and `navigator.locks`.
Their faults are real: a cross-origin frame's storage gives `SecurityError`, a full `localStorage` gives `QuotaExceededError`, and another request steals a lock.
In Chrome, no fault was found that makes a Web Storage read fail in the page's own realm, so the read guards of `guardedStorage` are not tested.
The device class reads Chrome's window: the viewport changes the width, and DevTools emulation gives a mobile user agent and a touch-only pointer.
Chrome cannot turn its touch emulation off again, so this test file runs in a browser of its own (Vitest project `browser-touch`).
The local capture runs on Chrome's test microphone and camera.
A withdrawn permission ends the live track, and a refused permission gives "denied".
A Chrome without a test camera (Vitest project `browser-no-camera`) gives "failed".
The capture test passes each request to Chrome unchanged and keeps its promise, so it can check that a track that arrives too late is stopped.
The call controls hold real tracks from the test devices.
Chrome returns exactly one track of the requested kind, so the code that stops extra tracks and the failure for a stream without a track (`#captured` in `src/call/media.ts`) are not tested.
No trigger was found for a `SecurityError` from `getUserMedia` either.

## Limits of this evidence

- All browsers run on one machine, so the WebRTC links use host candidates, and STUN and NAT traversal are not exercised.
  The cross-network evidence is the discovery spike (commit 09d887a): an Android phone on 4G connected directly to a desktop, without TURN.
- No test switches a device from Wi-Fi to a cellular network.
  The network change in `p2p-mesh` closes the links and the tracker sockets of a page; a real switch also changes the IP address.
- Only headless Chrome on Linux was tested; there is no run with Firefox, Safari or a real phone for this version.
  The compact layout is tested with phone-size viewports.
- A frozen page is simulated with a debugger pause, not with the freeze of a background tab or the suspension of an Android app.
- The call media are generated test devices.
- The public trackers are third-party services, so every run depends on them.
  No gate failure was traced to a tracker.
- The `seat-timeout` frozen-host test failed in gs1 and full2: the latecomer saw "Nobody is at this table right now" for 45 s.
  In full2, the page had all three trackers open, no link and no failed WebRTC exchange, so its offers had reached no page that answered; commit 0e26b05 fixes this case.
  The gs1 failure had the same symptom; its log does not show the cause.
- In `call-recovery` test 3 of full2, South and the new West page still had no link when the test's wait ended.
  Their seat-pair rooms were open at different times, which commit 0e26b05 fixes.
  The log does not show why the two-page room named by their peer identifiers did not connect them either.
  The Network panel now also counts the two-page rooms that connected a peer that the table room did not take, so a repeat would show this case.
- A rejoin drops the handshakes in progress in the room that the page leaves.
  So the `p2p-mesh` visitor whose first links fail now connects after 31.1 s through the rejoin instead of 25.1 s through a two-page room; the budget is 45 s.
- The address scan (`call-lifecycle` test 8) checks the text, the attributes, the field values and the console messages of the pages in that spec.
- Each run used one worker on a loaded machine; the durations are not performance measurements.
