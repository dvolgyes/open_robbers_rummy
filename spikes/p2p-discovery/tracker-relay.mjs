// Layer 1: does each public WebTorrent tracker relay an offer and an answer between two clients?
// It speaks the tracker protocol that Trystero 0.26.0 uses, with fake SDP text, so it sends no network addresses.
// Usage: node tracker-relay.mjs [trials]. Progress goes to stderr; the JSON result goes to stdout.

import { randomBytes } from "node:crypto";

// The same list as `defaultRelayUrls` in @trystero-p2p/torrent 0.26.0. Trystero uses the first 3.
const TRACKERS = [
	"wss://open.ftorrent.com",
	"wss://tracker.webtorrent.dev",
	"wss://tracker.openwebtorrent.com",
	"wss://tracker.btorrent.xyz",
	"wss://tracker.files.fm:7073/announce",
];
const STEP_MS = 10_000;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const trials = Number(process.argv[2] ?? 3);
if (!Number.isInteger(trials) || trials < 1) {
	throw new Error(`trials must be a positive integer, got ${process.argv[2]}`);
}

/** A 20-character id from the same alphabet as Trystero's ids. */
const id20 = () =>
	Array.from(randomBytes(20), (b) => ALPHABET[b % 36]).join("");

/** A client that queues tracker messages, so a test can wait for the next one that matches. */
const connect = (url) =>
	new Promise((resolve) => {
		const started = performance.now();
		const socket = new WebSocket(url);
		const inbox = [];
		const waiters = [];
		const notes = [];
		socket.addEventListener("message", (event) => {
			const data = JSON.parse(String(event.data));
			if (data["failure reason"])
				notes.push(`failure: ${data["failure reason"]}`);
			if (data["warning message"])
				notes.push(`warning: ${data["warning message"]}`);
			inbox.push(data);
			for (const waiter of [...waiters]) waiter();
		});
		const client = {
			socket,
			notes,
			send: (payload) =>
				socket.send(JSON.stringify({ action: "announce", ...payload })),
			next: (match) =>
				new Promise((done) => {
					const t0 = performance.now();
					const check = () => {
						const index = inbox.findIndex(match);
						if (index < 0) return false;
						waiters.splice(waiters.indexOf(check), 1);
						clearTimeout(timer);
						done({
							data: inbox.splice(index, 1)[0],
							ms: Math.round(performance.now() - t0),
						});
						return true;
					};
					const timer = setTimeout(() => {
						waiters.splice(waiters.indexOf(check), 1);
						done(null);
					}, STEP_MS);
					waiters.push(check);
					check();
				}),
			close: () => socket.close(),
		};
		const timer = setTimeout(
			() => resolve({ ...client, openMs: null, error: "no open within 10 s" }),
			STEP_MS,
		);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolve({
				...client,
				openMs: Math.round(performance.now() - started),
				error: null,
			});
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			resolve({ ...client, openMs: null, error: "socket error before open" });
		});
	});

/** One trial: B joins the swarm, A announces an offer, B must get it, answer it, and A must get the answer. */
const trial = async (url) => {
	const infoHash = id20();
	const [a, b] = await Promise.all([connect(url), connect(url)]);
	const result = {
		open: a.openMs !== null && b.openMs !== null,
		openMs: Math.max(a.openMs ?? 0, b.openMs ?? 0),
	};
	try {
		if (!result.open)
			return { ...result, stage: "open", error: a.error ?? b.error };
		const aId = id20();
		const bId = id20();
		b.send({
			info_hash: infoHash,
			peer_id: bId,
			numwant: 3,
			left: 0,
			offers: [],
		});
		const joined = await b.next(
			(m) => m.info_hash === infoHash && m.interval !== undefined,
		);
		if (!joined) return { ...result, stage: "announce", notes: b.notes };
		result.interval = joined.data.interval;

		const offerId = id20();
		const offerSdp = `probe-offer-${id20()}`;
		a.send({
			info_hash: infoHash,
			peer_id: aId,
			numwant: 3,
			offers: [{ offer_id: offerId, offer: { type: "offer", sdp: offerSdp } }],
		});
		const offer = await b.next((m) => m.offer_id === offerId && m.offer);
		if (!offer)
			return {
				...result,
				stage: "offer relay",
				notes: [...a.notes, ...b.notes],
			};
		if (offer.data.offer.sdp !== offerSdp || offer.data.peer_id !== aId) {
			return {
				...result,
				stage: "offer content",
				notes: ["the relayed offer differs from the sent offer"],
			};
		}
		result.offerMs = offer.ms;

		const answerSdp = `probe-answer-${id20()}`;
		b.send({
			info_hash: infoHash,
			peer_id: bId,
			to_peer_id: aId,
			offer_id: offerId,
			answer: { type: "answer", sdp: answerSdp },
		});
		const answer = await a.next((m) => m.offer_id === offerId && m.answer);
		if (!answer)
			return {
				...result,
				stage: "answer relay",
				notes: [...a.notes, ...b.notes],
			};
		if (answer.data.answer.sdp !== answerSdp || answer.data.peer_id !== bId) {
			return {
				...result,
				stage: "answer content",
				notes: ["the relayed answer differs from the sent answer"],
			};
		}
		result.answerMs = answer.ms;
		return { ...result, stage: "done", ok: true };
	} finally {
		a.close();
		b.close();
	}
};

const report = { date: new Date().toISOString(), trials, trackers: {} };
for (const url of TRACKERS) {
	const runs = [];
	for (let i = 0; i < trials; i++) {
		const run = await trial(url);
		runs.push(run);
		process.stderr.write(
			`${url} trial ${i + 1}: ${run.ok ? "relayed" : `stopped at ${run.stage}`}\n`,
		);
	}
	const ok = runs.filter((run) => run.ok);
	const max = (key) =>
		ok.length ? Math.max(...ok.map((run) => run[key])) : null;
	report.trackers[url] = {
		relayed: `${ok.length}/${trials}`,
		maxOpenMs: max("openMs"),
		maxOfferMs: max("offerMs"),
		maxAnswerMs: max("answerMs"),
		interval: ok[0]?.interval ?? null,
		failures: runs
			.filter((run) => !run.ok)
			.map(({ stage, error, notes }) => ({ stage, error, notes })),
	};
}
process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
