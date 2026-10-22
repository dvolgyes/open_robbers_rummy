// The phone probe: one self-contained page that a phone and a desktop open to find each other.
// `build-phone.mjs` inlines this script, Trystero and a new random room into phone.html.
// The page shows only ids, counts, states, candidate types and times. It never shows SDP, candidates or addresses.

import { getRelaySockets, joinRoom, selfId } from "@trystero-p2p/torrent";

const APP_ID = "open-canasta-phone-probe";
// The handover's STUN server. No TURN.
const RTC_CONFIG: RTCConfiguration = {
	iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
};
const TICK_MS = 3_000;
const MAX_TEXT = 200;
const MAX_LOG = 40;
const MAX_RTTS = 20;

type Kind = "phone" | "desktop";
type Tone = "ok" | "wait" | "bad";
type Hello = { kind: Kind; network: string };
type Report = { pathType: string; rttMs: number | null; texts: number };
type Ping = { nonce: string; reply: boolean };

type PeerView = {
	id: string;
	foundMs: number;
	leftMs: number | null;
	hello: Hello | null;
	/** The peer's own view of this link. */
	report: Report | null;
	rttMs: number | null;
	rtts: number[];
	pathType: string;
	texts: string[];
};

export type Snapshot = {
	selfId: string;
	kind: Kind;
	network: string;
	secure: boolean;
	room: string;
	trackers: Record<string, string>;
	peers: PeerView[];
	errors: string[];
	log: string[];
};

type Config =
	| { ok: true; room: string; password: string }
	| { ok: false; reason: string };

type Nav = Navigator & {
	userAgentData?: { mobile?: boolean };
	connection?: { type?: string; effectiveType?: string };
};

const nav = navigator as Nav;
const kind: Kind =
	nav.userAgentData?.mobile === true ||
	/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
		? "phone"
		: "desktop";

const network = (): string => {
	const connection = nav.connection;
	const parts = [connection?.type, connection?.effectiveType].filter(Boolean);
	return parts.length > 0 ? parts.join(" ") : "unknown";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isHello = (value: unknown): value is Hello =>
	isRecord(value) &&
	(value.kind === "phone" || value.kind === "desktop") &&
	typeof value.network === "string" &&
	value.network.length <= 40;

const isReport = (value: unknown): value is Report =>
	isRecord(value) &&
	typeof value.pathType === "string" &&
	value.pathType.length <= 40 &&
	(value.rttMs === null || typeof value.rttMs === "number") &&
	typeof value.texts === "number";

const isPing = (value: unknown): value is Ping =>
	isRecord(value) &&
	typeof value.nonce === "string" &&
	value.nonce.length <= 64 &&
	typeof value.reply === "boolean";

const readConfig = (): Config => {
	const fromHash = new URLSearchParams(location.hash.slice(1));
	const text = document.getElementById("probe-config")?.textContent ?? "";
	const embedded: unknown = text ? JSON.parse(text) : null;
	const field = (name: string): string | null => {
		const value = isRecord(embedded) ? embedded[name] : null;
		return typeof value === "string" && value ? value : null;
	};
	const room = fromHash.get("room") ?? field("room");
	const password = fromHash.get("password") ?? field("password");
	if (!room || !password) {
		return {
			ok: false,
			reason: "This page has no room. Build it with build-phone.mjs.",
		};
	}
	return { ok: true, room, password };
};

const byId = (id: string): HTMLElement => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`phone.html has no #${id}`);
	return element;
};

const el = (tag: string, text: string): HTMLElement => {
	const element = document.createElement(tag);
	element.textContent = text;
	return element;
};

const setStatus = (tone: Tone, text: string): void => {
	const status = byId("status");
	status.dataset.tone = tone;
	status.textContent = text;
};

const fillList = (id: string, rows: Array<[string, string]>): void => {
	byId(id).replaceChildren(
		...rows.flatMap(([term, value]) => [el("dt", term), el("dd", value)]),
	);
};

const socketState = ["connecting", "open", "closing", "closed"];

/** The candidate types and protocol of the selected ICE pair, such as "srflx/srflx udp". No addresses. */
const pathTypeOf = async (pc: RTCPeerConnection): Promise<string> => {
	const stats = [...(await pc.getStats()).values()];
	const pair = stats.find(
		(s) =>
			s.type === "candidate-pair" && s.nominated && s.state === "succeeded",
	);
	if (!pair) return "no selected pair";
	const local = stats.find((s) => s.id === pair.localCandidateId);
	const remote = stats.find((s) => s.id === pair.remoteCandidateId);
	return `${local?.candidateType ?? "unknown"}/${remote?.candidateType ?? "unknown"} ${local?.protocol ?? ""}`.trim();
};

const pathMeaning = (pathType: string): string => {
	if (pathType.startsWith("host/host")) return "direct on the local network";
	if (pathType.includes("relay")) return "through a relay";
	if (pathType.includes("srflx") || pathType.includes("prflx"))
		return "across NAT, with STUN";
	return "path not known yet";
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const start = (room: string, password: string): void => {
	const startedAt = performance.now();
	const since = () => Math.round(performance.now() - startedAt);
	const peers = new Map<string, PeerView>();
	const pings = new Map<string, { peerId: string; sentAt: number }>();
	const log: string[] = [];
	const errors: string[] = [];

	const trackers = (): Record<string, string> =>
		Object.fromEntries(
			Object.entries(getRelaySockets() as Record<string, WebSocket>).map(
				([url, socket]) => [
					new URL(url).host,
					socketState[socket.readyState] ?? "unknown",
				],
			),
		);

	const live = (): PeerView[] =>
		[...peers.values()].filter((peer) => peer.leftMs === null);

	const render = (): void => {
		const states = Object.values(trackers());
		const open = states.filter((state) => state === "open").length;
		fillList("facts", [
			["This device", kind],
			["Network", network()],
			["Secure context", window.isSecureContext ? "yes" : "no"],
			["Room code", room.slice(0, 6)],
			["Peer id", selfId.slice(0, 6)],
			[
				"Trackers",
				Object.entries(trackers())
					.map(([host, state]) => `${host}: ${state}`)
					.join(", ") || "none yet",
			],
			["Time on page", seconds(since())],
		]);
		fillList(
			"peers",
			[...peers.values()].map((peer) => [
				peer.id.slice(0, 6),
				[
					peer.hello?.kind ?? "device not known yet",
					`found after ${seconds(peer.foundMs)}`,
					peer.leftMs === null
						? `round trip ${peer.rttMs === null ? "–" : `${peer.rttMs} ms`}`
						: `left after ${seconds(peer.leftMs)}`,
					`path ${peer.pathType} (${pathMeaning(peer.pathType)})`,
					`its network ${peer.hello?.network ?? "–"}`,
					`messages received ${peer.texts.length}`,
				].join(" · "),
			]),
		);
		byId("log").replaceChildren(...log.map((line) => el("li", line)));

		const linked = live().find((peer) => peer.hello && peer.rttMs !== null);
		if (linked?.hello) {
			setStatus(
				"ok",
				`Connected to the ${linked.hello.kind} · round trip ${linked.rttMs} ms · ${pathMeaning(linked.pathType)}`,
			);
		} else if (live().length > 0) {
			setStatus("wait", "Found a peer, checking the link…");
		} else if (peers.size > 0) {
			setStatus("wait", "The other device left. Searching again…");
		} else {
			setStatus(
				"wait",
				`Searching for the other device… ${open} of ${states.length} trackers connected (${seconds(since())})`,
			);
		}
	};

	const note = (text: string): void => {
		log.unshift(`${seconds(since())} ${text}`);
		log.length = Math.min(log.length, MAX_LOG);
		render();
	};

	const joined = joinRoom(
		{ appId: APP_ID, password, rtcConfig: RTC_CONFIG },
		room,
		{
			onJoinError: ({ error }) => {
				errors.push(error);
				note(`join error: ${error}`);
			},
		},
	);
	const hello = joined.makeAction<Hello>("hello");
	const report = joined.makeAction<Report>("report");
	const ping = joined.makeAction<Ping>("ping");
	const text = joined.makeAction<string>("text");

	joined.onPeerJoin = (peerId) => {
		peers.set(peerId, {
			id: peerId,
			foundMs: since(),
			leftMs: null,
			hello: null,
			report: null,
			rttMs: null,
			rtts: [],
			pathType: "unknown",
			texts: [],
		});
		void hello.send({ kind, network: network() }, { target: peerId });
		void text.send(`hello from the ${kind}`, { target: peerId });
		note(`found peer ${peerId.slice(0, 6)}`);
	};
	joined.onPeerLeave = (peerId) => {
		const peer = peers.get(peerId);
		if (peer) peer.leftMs = since();
		note(`peer ${peerId.slice(0, 6)} left`);
	};
	hello.onMessage = (data: unknown, { peerId }) => {
		const peer = peers.get(peerId);
		if (!peer || !isHello(data)) return;
		if (!peer.hello) note(`peer ${peerId.slice(0, 6)} is a ${data.kind}`);
		peer.hello = data;
	};
	report.onMessage = (data: unknown, { peerId }) => {
		const peer = peers.get(peerId);
		if (peer && isReport(data)) peer.report = data;
	};
	text.onMessage = (data: unknown, { peerId }) => {
		const peer = peers.get(peerId);
		if (!peer || typeof data !== "string") return;
		const line = data.slice(0, MAX_TEXT);
		peer.texts.push(line);
		note(`message from ${peerId.slice(0, 6)}: ${line}`);
	};
	ping.onMessage = (data: unknown, { peerId }) => {
		if (!isPing(data)) return;
		if (!data.reply) {
			void ping.send({ nonce: data.nonce, reply: true }, { target: peerId });
			return;
		}
		const sent = pings.get(data.nonce);
		const peer = peers.get(peerId);
		if (!sent || sent.peerId !== peerId || !peer) return;
		pings.delete(data.nonce);
		peer.rttMs = Math.round(performance.now() - sent.sentAt);
		peer.rtts = [...peer.rtts, peer.rttMs].slice(-MAX_RTTS);
	};

	const tick = async (): Promise<void> => {
		const now = performance.now();
		for (const [nonce, sent] of pings) {
			if (now - sent.sentAt < TICK_MS) continue;
			pings.delete(nonce);
			const peer = peers.get(sent.peerId);
			if (peer) peer.rttMs = null;
		}
		const connections = joined.getPeers();
		for (const peer of live()) {
			const pc = connections[peer.id];
			if (pc) peer.pathType = await pathTypeOf(pc);
			const nonce = crypto.randomUUID();
			pings.set(nonce, { peerId: peer.id, sentAt: performance.now() });
			void ping.send({ nonce, reply: false }, { target: peer.id });
			void hello.send({ kind, network: network() }, { target: peer.id });
			void report.send(
				{
					pathType: peer.pathType,
					rttMs: peer.rttMs,
					texts: peer.texts.length,
				},
				{ target: peer.id },
			);
		}
		render();
	};
	setInterval(() => void tick(), TICK_MS);

	document.addEventListener("visibilitychange", () =>
		note(`page ${document.visibilityState}`),
	);
	window.addEventListener("online", () => note("browser online"));
	window.addEventListener("offline", () => note("browser offline"));

	window.phoneProbe = {
		snapshot: (): Snapshot => ({
			selfId,
			kind,
			network: network(),
			secure: window.isSecureContext,
			room: room.slice(0, 6),
			trackers: trackers(),
			peers: [...peers.values()].map((peer) => ({
				...peer,
				rtts: [...peer.rtts],
				texts: [...peer.texts],
			})),
			errors: [...errors],
			log: [...log],
		}),
		send: (line: string) => {
			for (const peer of live()) void text.send(line, { target: peer.id });
		},
	};
	note(`joined room ${room.slice(0, 6)} as a ${kind}`);
};

declare global {
	interface Window {
		phoneProbe: {
			snapshot: () => Snapshot;
			send: (line: string) => void;
		};
	}
}

const config = readConfig();
if (!config.ok) {
	setStatus("bad", config.reason);
} else if (!window.isSecureContext || !crypto.subtle) {
	setStatus(
		"bad",
		"This page is not a secure context, so the browser blocks the crypto that the probe needs. Open it through USB port forwarding as localhost (see the README).",
	);
} else {
	start(config.room, config.password);
}
