// Browser side of the discovery probe. Playwright calls `window.probe`. Nothing here touches the app.
// It never returns SDP, ICE candidates or addresses: only peer ids, counts, states and times.

import {
	defaultRelayUrls,
	getRelaySockets,
	joinRoom,
	type MessageAction,
	type Room,
	selfId,
} from "@trystero-p2p/torrent";

const APP_ID = "open-canasta-discovery-probe";
// The handover's STUN server. No TURN.
const RTC_CONFIG: RTCConfiguration = {
	iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
};

type Echo = { nonce: string; reply: boolean };
type Line = { seq: number; from: string; text: string };

type Joined = {
	room: Room;
	startedAt: number;
	joins: Array<{ peerId: string; ms: number }>;
	leaves: Array<{ peerId: string; ms: number }>;
	errors: string[];
	lines: Line[];
	echo: MessageAction<Echo>;
	say: MessageAction<string>;
	line: MessageAction<Line>;
	waiting: Map<string, () => void>;
};

// One page is one peer, so the page holds the probe's state for its lifetime.
const rooms = new Map<string, Joined>();
const star: { publish: ((from: string, text: string) => void) | null } = {
	publish: null,
};
const blocked = new Set<string>();

// Test hook: a blocked tracker URL gets a socket to a name that never resolves (RFC 2606 `.invalid`).
// The socket fails before `open`, as in a real outage, so Trystero's retry backoff grows as it would.
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
	constructor(url: string | URL, protocols?: string | string[]) {
		super(blocked.has(String(url)) ? "wss://blocked.invalid/" : url, protocols);
	}
};

const get = (name: string): Joined => {
	const joined = rooms.get(name);
	if (!joined) throw new Error(`no joined room named ${name}`);
	return joined;
};

const elapsed = (joined: Joined): number =>
	Math.round(performance.now() - joined.startedAt);

const until = (check: () => boolean, timeoutMs: number): Promise<boolean> =>
	new Promise((resolve) => {
		const deadline = performance.now() + timeoutMs;
		const tick = () => {
			if (check()) resolve(true);
			else if (performance.now() > deadline) resolve(false);
			else setTimeout(tick, 50);
		};
		tick();
	});

const probe = {
	selfId,
	defaultRelayUrls,
	secure: window.isSecureContext,

	/** Joins `roomId` under the local handle `name`. `urls` replaces the default trackers. */
	join(name: string, roomId: string, password: string, urls?: string[]): void {
		if (rooms.has(name))
			throw new Error(`room handle ${name} is already in use`);
		const errors: string[] = [];
		const room = joinRoom(
			{
				appId: APP_ID,
				password,
				rtcConfig: RTC_CONFIG,
				...(urls ? { relayConfig: { urls } } : {}),
			},
			roomId,
			{ onJoinError: ({ error }) => errors.push(error) },
		);
		const joined: Joined = {
			room,
			startedAt: performance.now(),
			joins: [],
			leaves: [],
			errors,
			lines: [],
			echo: room.makeAction<Echo>("echo"),
			say: room.makeAction<string>("say"),
			line: room.makeAction<Line>("line"),
			waiting: new Map(),
		};
		room.onPeerJoin = (peerId) =>
			joined.joins.push({ peerId, ms: elapsed(joined) });
		room.onPeerLeave = (peerId) =>
			joined.leaves.push({ peerId, ms: elapsed(joined) });
		joined.echo.onMessage = ({ nonce, reply }, { peerId }) => {
			if (reply) joined.waiting.get(`${peerId}:${nonce}`)?.();
			else void joined.echo.send({ nonce, reply: true }, { target: peerId });
		};
		joined.line.onMessage = (line) => {
			joined.lines.push(line);
		};
		rooms.set(name, joined);
	},

	/** Milliseconds from the join to the `count`-th peer join, or null after `timeoutMs`. */
	async waitPeers(
		name: string,
		count: number,
		timeoutMs: number,
	): Promise<number | null> {
		const joined = get(name);
		const seen = await until(
			() => Object.keys(joined.room.getPeers()).length >= count,
			timeoutMs,
		);
		return seen ? (joined.joins[count - 1]?.ms ?? elapsed(joined)) : null;
	},

	/** Milliseconds from this call until `peerId` is a peer of `name`, or null after `timeoutMs`. */
	async waitPeer(
		name: string,
		peerId: string,
		timeoutMs: number,
	): Promise<number | null> {
		const t0 = performance.now();
		const seen = await until(
			() => peerId in get(name).room.getPeers(),
			timeoutMs,
		);
		return seen ? Math.round(performance.now() - t0) : null;
	},

	/** Milliseconds from this call until `peerId` is no longer a peer of `name`, or null after `timeoutMs`. */
	async waitGone(
		name: string,
		peerId: string,
		timeoutMs: number,
	): Promise<number | null> {
		const t0 = performance.now();
		const gone = await until(
			() => !(peerId in get(name).room.getPeers()),
			timeoutMs,
		);
		return gone ? Math.round(performance.now() - t0) : null;
	},

	peers(name: string): string[] {
		return Object.keys(get(name).room.getPeers());
	},

	events(name: string): {
		joins: Joined["joins"];
		leaves: Joined["leaves"];
		errors: string[];
	} {
		const { joins, leaves, errors } = get(name);
		return { joins, leaves, errors };
	},

	/** Sends a fresh nonce to every current peer; returns the slowest round trip, or null if one did not echo it. */
	async echoAll(
		name: string,
		timeoutMs: number,
	): Promise<{ peers: number; maxMs: number } | null> {
		const joined = get(name);
		const peers = Object.keys(joined.room.getPeers());
		const t0 = performance.now();
		const replies = peers.map((peerId) => {
			const nonce = crypto.randomUUID();
			const key = `${peerId}:${nonce}`;
			return new Promise<number | null>((resolve) => {
				const timer = setTimeout(() => {
					joined.waiting.delete(key);
					resolve(null);
				}, timeoutMs);
				joined.waiting.set(key, () => {
					clearTimeout(timer);
					joined.waiting.delete(key);
					resolve(Math.round(performance.now() - t0));
				});
				void joined.echo.send({ nonce, reply: false }, { target: peerId });
			});
		});
		const times = await Promise.all(replies);
		if (peers.length === 0 || times.some((ms) => ms === null)) return null;
		return { peers: peers.length, maxMs: Math.max(...(times as number[])) };
	},

	async maxPing(name: string): Promise<number> {
		const joined = get(name);
		const pings = await Promise.all(
			Object.keys(joined.room.getPeers()).map((id) => joined.room.ping(id)),
		);
		return Math.round(Math.max(...pings));
	},

	/** The host side of the star: every `say` in any of `names` gets the next number and goes to all of them. */
	host(names: string[]): void {
		let seq = 0;
		const all = names.map(get);
		const publish = (from: string, text: string) => {
			seq += 1;
			const line = { seq, from, text };
			for (const joined of all) {
				joined.lines.push(line);
				void joined.line.send(line);
			}
		};
		for (const [index, joined] of all.entries()) {
			joined.say.onMessage = (text) => publish(names[index] ?? "?", text);
		}
		star.publish = publish;
	},

	hostSay(text: string): void {
		if (!star.publish) throw new Error("call host() first");
		star.publish("host", text);
	},

	say(name: string, text: string): void {
		void get(name).say.send(text);
	},

	lines(name: string): Line[] {
		return get(name).lines;
	},

	async leave(name: string): Promise<void> {
		await get(name).room.leave();
		rooms.delete(name);
	},

	/** The candidate types of each peer's selected ICE pair, such as "host/host" or "srflx/srflx". No addresses. */
	async pathTypes(name: string): Promise<string[]> {
		const paths = Object.values(get(name).room.getPeers()).map(async (pc) => {
			const stats = [...(await pc.getStats()).values()];
			const pair = stats.find(
				(s) =>
					s.type === "candidate-pair" && s.nominated && s.state === "succeeded",
			);
			const typeOf = (id: string) =>
				stats.find((s) => s.id === id)?.candidateType ?? "unknown";
			return pair
				? `${typeOf(pair.localCandidateId)}/${typeOf(pair.remoteCandidateId)}`
				: "no selected pair";
		});
		return Promise.all(paths);
	},

	/** Tracker URL → WebSocket readyState (0 connecting, 1 open, 2 closing, 3 closed). */
	relays(): Record<string, number> {
		const sockets = getRelaySockets() as Record<string, WebSocket>;
		return Object.fromEntries(
			Object.entries(sockets).map(([url, socket]) => [url, socket.readyState]),
		);
	},

	/** From now on, new sockets to these tracker URLs fail. An empty list unblocks all. */
	block(urls: string[]): void {
		blocked.clear();
		for (const url of urls) blocked.add(url);
	},

	/** Closes every open tracker socket. Trystero then retries them on its own. */
	dropRelays(): void {
		for (const socket of Object.values(
			getRelaySockets() as Record<string, WebSocket>,
		))
			socket.close();
	},

	/** Gathers ICE candidates with the STUN server and counts them by type. No candidate text leaves this function. */
	async candidateTypes(timeoutMs: number): Promise<Record<string, number>> {
		const pc = new RTCPeerConnection(RTC_CONFIG);
		pc.createDataChannel("probe");
		const types: Record<string, number> = {};
		const gathered = new Promise<void>((resolve) => {
			pc.onicecandidate = ({ candidate }) => {
				if (!candidate) resolve();
				else
					types[candidate.type ?? "unknown"] =
						(types[candidate.type ?? "unknown"] ?? 0) + 1;
			};
		});
		await pc.setLocalDescription(await pc.createOffer());
		await Promise.race([
			gathered,
			new Promise((resolve) => setTimeout(resolve, timeoutMs)),
		]);
		pc.close();
		return types;
	},
};

export type Probe = typeof probe;

declare global {
	interface Window {
		probe: Probe;
	}
}

window.probe = probe;
