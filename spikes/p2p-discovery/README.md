# P2P discovery probe

This probe answers one question before the Supabase-to-P2P migration starts.
Can public WebTorrent trackers connect the browsers of one card table?
The probe is not app code.
It does not change `src/`, the root `package.json` or the root lockfile.
Trystero is installed only here, with an exact version and its own lockfile.

## What it tests

- Layer 1, `tracker-relay.mjs`: two Node clients speak the tracker protocol of Trystero 0.26.0 to each tracker.
  The clients send fake SDP text, so they send no network addresses.
  A tracker passes when it relays one offer and one answer.
- Layers 2 and 3, `discovery.spec.ts`: Playwright opens Chrome contexts that load `probe.ts`.
  Each context is one peer.
  The peers use `@trystero-p2p/torrent` with the default trackers and the handover's STUN server.
  The spec measures discovery, pair rooms with passwords, a table of four with a West host in three pair rooms, reloads, and tracker loss.
  `probe.ts` returns only peer ids, counts, states, candidate types and times.
  It never returns SDP, candidates or addresses.

## How to run

```sh
cd spikes/p2p-discovery
npm ci
node tracker-relay.mjs 3
PROBE_TRIALS=10 npm run probe
```

`tracker-relay.mjs` writes its JSON result to stdout and its progress to stderr.
The spec writes its JSON result to `probe-results/` (git-ignored), or to `$PROBE_OUT`.
It uses the root `node_modules` for Vite, TypeScript and Playwright, so run `npm ci` in the root first.
A full run takes about 5 minutes.

## Results, 2026-10-18

Environment: Linux, Google Chrome 155.0.8059.79, Playwright 1.64.1, Node 22.22.1, one machine on one network.

### Layer 1: tracker relay (3 trials per tracker)

| Tracker | Relayed | Max open ms | Max offer ms | Max answer ms | Announce interval s |
| --- | --- | --- | --- | --- | --- |
| `wss://open.ftorrent.com` | 3/3 | 524 | 171 | 170 | 120 |
| `wss://tracker.webtorrent.dev` | 3/3 | 192 | 68 | 33 | 120 |
| `wss://tracker.openwebtorrent.com` | 3/3 | 84 | 26 | 25 | 120 |
| `wss://tracker.btorrent.xyz` | 0/3 | socket error before open | | | |
| `wss://tracker.files.fm:7073/announce` | 0/3 | socket error before open | | | |

Trystero uses only the first three trackers by default (`defaultRedundancy = 3`).
The last two trackers are fallbacks in the list, and both were down or refused the connection.

### Layers 2 and 3: browser peers

Run 1 executed tests 1 to 8, run 2 executed all 12 tests, and runs 3 to 5 executed tests 7 to 12.

| Test | Result |
| --- | --- |
| Secure context and default tracker list | Pass in all runs. |
| STUN gives a server-reflexive candidate | Pass: 2 srflx candidates and 1 host candidate. |
| Cold pair discovery with the default trackers | 22/22 trials found the peer (2 smoke trials and 2 runs of 10). Median per run 276–279 ms, maximum 344 ms. Data-channel round trip at most 2 ms. |
| Each tracker alone (2 trials each, 2 runs) | The three defaults found the peer 2/2 each. Median: `open.ftorrent.com` 807–1798 ms, `tracker.webtorrent.dev` 417–426 ms, `tracker.openwebtorrent.com` 281–300 ms. The two fallbacks: 0/2, socket closed. |
| Wrong password | No peer within 30 s, and the error "incorrect room password when decrypting offer". |
| Blocked trackers (2 runs) | First tracker blocked: 3/3 found in each run. First two blocked: 3/3 found in each run. All three blocked: 0/1 in each run (Trystero does not fall back to trackers 4 and 5). |
| Table of four: West host in three pair rooms | 5/5 runs. All six joins within 317 ms. One test message and three replies gave the same four-line transcript, with the same order, in all four pages. |
| Guest reload | The host found the new page 314–369 ms after the reload started. The old peer id was gone by then. |
| Host reload | All three guests found the new host 320–569 ms after the reload started. |
| Trackers lost after connection | All tracker sockets closed. The existing links continued (round trip 1 ms). A guest that reloaded during the outage was not found in 20 s. After the trackers came back, the host found it after 9.8, 4.2, 4.7 and 13.8 s. |
| Selected ICE pair of the host's links (run 5) | `host/host` for all three links. |
| Uncaught page errors | None. |

### The shared-connection prediction was false

A Trystero shared peer connection finds a room by SHA-256 of `Trystero:<appId>:<roomId>`, without the password.
The prediction from the source was this: a guest that already shares a connection with the host can enter another seat's pair room with a wrong password.
Test 8 let North enter East's pair room with a wrong password.
In all five runs that executed test 8, the host's East room did not admit North within 30 s, and no forged line reached the transcript.
Runs 2 to 5 also recorded the host's errors: the East room reported "incorrect password for overlapping room" twice in each run.
The control is the overlapping-room challenge in `@trystero-p2p/core` 0.26.0 (`handshake.mjs`).
The host challenges the peer with a random value and requires SHA-256 of `<challenge>:<password>:<appId>:<roomId>`.

The app must still do its own admission.
The handover requires it (line 39: Trystero isolation is a transport facility, not seat validation).
This test shows only that Trystero 0.26.0 does not add a bypass through shared connections.
A library update can change this behavior, so keep test 8 when the version changes.

## Limits

- In `discovery.spec.ts`, all peers ran on one machine.
  The selected ICE pairs were `host/host`, so that spec does not test NAT traversal.
  The phone probe tested NAT traversal once (see above).
  Without TURN, peers behind symmetric NAT or carrier-grade NAT can fail to connect after discovery.
  This applies to every WebRTC design, also with Supabase as the signaling path.
- The probe used one network and one day.
  Public trackers are volunteer services, and two of the five in Trystero's list were down on this day.
- The tracker-loss test closed the sockets and made new sockets fail.
  It did not test a network change on the device, such as Wi-Fi to mobile data.
- The probe did not test Android suspend and resume, or Safari and Firefox.
- The trackers see the room's info hash, the public address of each WebSocket client, and the encrypted SDP.
  The handover permits public trackers and STUN.

## Phone probe: a phone and this machine on different networks

`phone.html` and `phone.ts` are one page that two devices open.
`build-phone.mjs` puts the page, Trystero and a new random room into one file: `phone-dist/p2p-phone-probe.html` (git-ignored).
Every build makes a new room, so the phone and the desktop must open the same build.
The page shows its status, the trackers, each peer, the round trip, and the candidate types of the connection.
It never shows SDP, candidates or addresses.

```sh
npm run phone:build   # writes phone-dist/p2p-phone-probe.html
npm run phone:check   # test 1: a desktop and an emulated phone context on this machine
npm run phone:wait    # test 2: this machine waits 15 min (PHONE_WAIT_MIN) for a real phone
```

To test with a real phone:

1. Start `npm run phone:wait` on this machine.
2. Copy `phone-dist/p2p-phone-probe.html` to the phone, and open it in Chrome.
   For a test across networks, switch off Wi-Fi on the phone and use mobile data.
3. The phone shows "Connected to the desktop", and test 2 writes its result to `probe-results/phone-<date>.json`.
   A path of `host/host` means that the phone and this machine connected on the same local network.

Trystero needs `crypto.subtle`, which works only in a secure context.
If the phone shows "This page is not a secure context", load the page through USB instead:

1. Connect the phone with USB debugging on, and open `chrome://inspect/#devices` in desktop Chrome.
2. Turn on "Port forwarding" for port `4181` to `localhost:4181`.
3. Run `npm run phone:serve`, and open `http://localhost:4181/p2p-phone-probe.html` on the phone.

Only the page goes through USB.
The trackers and the peer connection use the phone's own network.
I did not test iOS.
If an iPhone cannot run the scripts of a local file, it needs a hosted copy of the page.

### Result, 2026-10-18: Android phone on mobile data, desktop on its own network

One run.
The phone opened the file from local storage in Chrome, so the file page was a secure context.

| Item | Result |
| --- | --- |
| Phone network (`navigator.connection`) | `cellular 4g` |
| Selected ICE pair, from each side | `srflx/srflx udp` on the desktop and on the phone |
| Data-channel round trip, 7 samples in 21 s | 44–146 ms, median 56 ms |
| Messages | One in each direction, and the phone confirmed both desktop messages |
| Trackers on the desktop | 3 of 3 open |
| Errors | None on the desktop page |

`srflx/srflx` means that both peers were behind NAT and connected directly over UDP with the STUN addresses, without a relay.
The desktop page waited 24.9 minutes before the phone joined, which is the time until the phone opened the page.
The test did not record how long the phone took to find the desktop after it opened the page.

## What this means for the migration

Discovery through the default WebTorrent trackers works on this machine: every cold trial found the peer in less than 0.4 s.
Discovery needs at least one of the three default trackers.
One phone on mobile data found this machine and connected directly through NAT with STUN (`srflx/srflx`), without TURN.
This is one carrier and one home network.
A carrier or network with symmetric NAT can still prevent a direct connection, and without TURN such a player cannot join.
