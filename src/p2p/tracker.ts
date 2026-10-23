/**
 * Tracker rooms: the WebTorrent tracker strategy of Trystero 0.26.0 (`@trystero-p2p/torrent`, MIT, Copyright (c)
 * 2021 Dan Motzenbecker), adapted for this project (ADR 0001):
 *
 * - A room announces `offers` offers (default 1). A tracker forwards each offer of an announce to a different
 *   member of the swarm, and it picks the members in a fixed order, so one offer reaches the same old members on
 *   every announce. When those are frozen pages, a new page never meets the live ones before the next 120 s
 *   re-announce.
 * - A page that leaves a room tells each tracker so (`event: "stopped"`), and the tracker stops forwarding offers
 *   to it.
 * - The bookkeeping belongs to one `trackerRooms()` value instead of the module.
 *
 * The license of the original strategy:
 *
 * Copyright (c) 2021 Dan Motzenbecker
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 * the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 * THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import {
	createRelayManager,
	createStrategy,
	entries,
	genId,
	getRelays,
	type JoinRoom,
	type JoinRoomConfig,
	keys,
	libName,
	makeSocket,
	type OfferRecord,
	type SocketClient,
	selfId,
	sha1,
	toJson,
} from "@trystero-p2p/core";

export type TrackerRoomConfig = JoinRoomConfig & {
	/** Offers in each announce of this room, 1 to MAX_OFFERS; default 1. */
	readonly offers?: number;
};

export interface TrackerRooms {
	readonly joinRoom: JoinRoom<TrackerRoomConfig>;
	/** The tracker sockets by URL. */
	readonly sockets: () => Readonly<Record<string, WebSocket>>;
}

export const MAX_OFFERS = 10;

const HASH_LENGTH = 20;
const REQUESTED_PEERS = 3;
const ANNOUNCE_MS = 10_000;
const DORMANT_ANNOUNCE_MS = 120_000;
const OFFER_RETENTION_MS = 120_000;
const SIGNAL_DEDUPE_MS = 4_000;

/** The fields of a tracker message that the strategy reads; fields of another type are left out. */
interface TrackerMessage {
	readonly failure?: string;
	readonly warning?: string;
	readonly interval?: number;
	readonly infoHash?: string;
	readonly offer?: string;
	readonly answer?: string;
	readonly offerId?: string;
	readonly peerId?: string;
}

interface Outstanding extends OfferRecord {
	readonly createdAt: number;
}

interface TopicState {
	readonly announce: () => Promise<void>;
	announceMs: number;
	readonly handler: (message: TrackerMessage) => void;
	isActive: boolean;
	readonly startPassiveAnnouncements: () => void;
	readonly stopPassiveAnnouncements: () => void;
	readonly token: symbol;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function sdp(value: unknown): string | undefined {
	return typeof value === "object" && value !== null && "sdp" in value
		? text(value.sdp)
		: undefined;
}

/** Reads a tracker message; undefined when it is not a JSON object. */
export function parseTrackerMessage(raw: string): TrackerMessage | undefined {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof data !== "object" || data === null || Array.isArray(data))
		return undefined;
	const record = data as Record<string, unknown>;
	const interval = record.interval;
	return {
		failure: text(record["failure reason"]),
		warning: text(record["warning message"]),
		interval:
			typeof interval === "number" && Number.isFinite(interval)
				? interval
				: undefined,
		infoHash: text(record.info_hash),
		offer: sdp(record.offer),
		answer: sdp(record.answer),
		offerId: text(record.offer_id),
		peerId: text(record.peer_id),
	};
}

function offerCount(config: TrackerRoomConfig): number {
	const offers = config.offers ?? 1;
	if (!Number.isSafeInteger(offers) || offers < 1 || offers > MAX_OFFERS)
		throw new RangeError(
			`offers must be an integer from 1 to ${MAX_OFFERS}, not ${offers}`,
		);
	return offers;
}

/** One page's tracker rooms; a page makes one, because its rooms share the tracker sockets and the peers. */
export function trackerRooms(): TrackerRooms {
	const relays = createRelayManager<SocketClient>((client) => client.socket);
	const topicToInfoHash: Record<string, string> = {};
	const infoHashToTopic: Record<string, string> = {};
	const handledSignals: Record<string, number> = {};
	const topicStates = relays.scoped<TopicState>();
	const roomOffers: Record<string, Record<string, Outstanding>> = {};
	const roomOfferMaking: Record<string, Promise<void>> = {};
	const roomSubscribers: Record<string, number> = {};

	const infoHash = async (topic: string): Promise<string> => {
		const known = topicToInfoHash[topic];
		if (known) return known;
		const hash = (await sha1(topic)).slice(0, HASH_LENGTH);
		topicToInfoHash[topic] = hash;
		infoHashToTopic[hash] = topic;
		return hash;
	};
	const send = async (
		client: SocketClient,
		topic: string,
		payload: Record<string, unknown>,
	): Promise<void> =>
		client.send(
			toJson({
				action: "announce",
				info_hash: await infoHash(topic),
				peer_id: selfId,
				...payload,
			}),
		);
	const warn = (url: string, message: string, failed = false) =>
		console.warn(
			`${libName}: torrent tracker ${failed ? "failure" : "warning"} from ${url} - ${message}`,
		);
	const outstanding = (topic: string): Record<string, Outstanding> =>
		(roomOffers[topic] ??= {});
	const forgetOffers = (topic: string) => {
		delete roomOffers[topic];
		delete roomOfferMaking[topic];
	};
	const takeOffer = (
		topic: string,
		offerId: string,
		action: "claim" | "reclaim",
	): Outstanding | undefined => {
		const offers = roomOffers[topic];
		const offer = offers?.[offerId];
		if (!offers || !offer) return undefined;
		delete offers[offerId];
		offer[action]?.();
		if (!keys(offers).length && !roomSubscribers[topic]) forgetOffers(topic);
		return offer;
	};
	const reclaimOffers = (topic: string) => {
		for (const offerId of keys(outstanding(topic)))
			takeOffer(topic, offerId, "reclaim");
		forgetOffers(topic);
	};
	const pruneOffers = (topic: string) => {
		const now = Date.now();
		for (const [offerId, offer] of entries(outstanding(topic)))
			if (now - offer.createdAt > OFFER_RETENTION_MS)
				takeOffer(topic, offerId, "reclaim");
	};
	const ensureOffers = async (
		topic: string,
		count: number,
		getOffers: (n: number) => Promise<OfferRecord[]>,
	): Promise<Record<string, Outstanding>> => {
		while (roomOfferMaking[topic]) await roomOfferMaking[topic];
		const making = (async () => {
			pruneOffers(topic);
			const offers = outstanding(topic);
			const missing = Math.max(0, count - keys(offers).length);
			if (missing > 0)
				for (const record of await getOffers(missing))
					offers[genId(HASH_LENGTH)] = { ...record, createdAt: Date.now() };
		})().finally(() => {
			if (roomOfferMaking[topic] === making) delete roomOfferMaking[topic];
		});
		roomOfferMaking[topic] = making;
		await making;
		return outstanding(topic);
	};
	const receive = (
		url: string,
		client: SocketClient,
		config: TrackerRoomConfig,
		raw: string,
	) => {
		const message = parseTrackerMessage(raw);
		if (!message) return;
		const loud = config.relayConfig?.warnOnRelayFailure !== false;
		if (message.failure) {
			if (loud) warn(client.url, message.failure, true);
			return;
		}
		if (message.warning && loud) warn(client.url, message.warning);
		const topic = message.infoHash
			? infoHashToTopic[message.infoHash]
			: undefined;
		const state = topic ? topicStates.forKey(url)[topic] : undefined;
		if (message.interval && state)
			state.announceMs = Math.min(
				Math.max(message.interval * 1_000, ANNOUNCE_MS),
				OFFER_RETENTION_MS,
			);
		if ((message.offer || message.answer) && topic && message.offerId) {
			if (message.peerId === selfId) return;
			const signal = `${topic}:${message.offer ? "offer" : "answer"}:${message.offerId}:${message.peerId ?? ""}`;
			const now = Date.now();
			const handledAt = handledSignals[signal];
			if (typeof handledAt === "number" && now - handledAt < SIGNAL_DEDUPE_MS)
				return;
			handledSignals[signal] = now;
			for (const [key, at] of entries(handledSignals))
				if (now - at > SIGNAL_DEDUPE_MS * 6) delete handledSignals[key];
			state?.handler(message);
		}
	};

	const strategy = createStrategy<SocketClient, TrackerRoomConfig>({
		init: (config) =>
			getRelays(config, [], 0).map((url) => {
				const client = relays.register(url, () =>
					makeSocket(
						url,
						(raw) => receive(url, client, config, raw),
						() => {
							for (const state of Object.values(topicStates.forKey(url)))
								void state.announce();
						},
					),
				);
				return client.ready;
			}),
		subscribe: (client, rootTopic, _, onMessage, getOffers, context) => {
			const count = context ? offerCount(context.config) : 1;
			const states = topicStates.forRelay(client);
			const token = Symbol(rootTopic);
			roomSubscribers[rootTopic] = (roomSubscribers[rootTopic] ?? 0) + 1;
			let passiveTimeout: ReturnType<typeof setTimeout> | undefined;
			const stopPassiveAnnouncements = () => {
				clearTimeout(passiveTimeout);
				passiveTimeout = undefined;
			};
			const current = () => states[rootTopic]?.token === token;
			const state: TopicState = {
				announce: async () => {
					if (!current()) return;
					if (!state.isActive) {
						void send(client, rootTopic, {
							left: 0,
							numwant: REQUESTED_PEERS,
							offers: [],
						});
						return;
					}
					let offers: Record<string, Outstanding>;
					try {
						offers = await ensureOffers(rootTopic, count, getOffers);
					} catch (error) {
						if (!current()) return;
						throw error;
					}
					if (!current() || !state.isActive) return;
					void send(client, rootTopic, {
						numwant: Math.max(REQUESTED_PEERS, count),
						offers: entries(offers).map(([id, { offer }]) => ({
							offer_id: id,
							offer: { type: "offer", sdp: offer },
						})),
					});
				},
				announceMs: ANNOUNCE_MS,
				handler: (message) => {
					const { offer, answer, offerId, peerId } = message;
					if (!offerId || !peerId) return;
					if (offer)
						void onMessage(
							rootTopic,
							{ offer, offerId, peerId },
							(_, signal) => {
								void send(client, rootTopic, {
									answer: {
										type: "answer",
										sdp: (JSON.parse(signal) as { answer: string }).answer,
									},
									offer_id: offerId,
									to_peer_id: peerId,
								});
							},
						);
					else if (answer) {
						const taken = takeOffer(rootTopic, offerId, "claim");
						if (taken) {
							void onMessage(
								rootTopic,
								{ answer, offerId, peerId, peer: taken.peer },
								() => {},
							);
							void state.announce();
						}
					}
				},
				isActive: !context?.isPassive,
				startPassiveAnnouncements: () => {
					stopPassiveAnnouncements();
					if (!current() || state.isActive) return;
					void state.announce();
					passiveTimeout = setTimeout(
						state.startPassiveAnnouncements,
						Math.max(state.announceMs, DORMANT_ANNOUNCE_MS),
					);
				},
				stopPassiveAnnouncements,
				token,
			};
			states[rootTopic] = state;
			if (!state.isActive) state.startPassiveAnnouncements();
			return () => {
				state.stopPassiveAnnouncements();
				roomSubscribers[rootTopic] = Math.max(
					0,
					(roomSubscribers[rootTopic] ?? 1) - 1,
				);
				if (!roomSubscribers[rootTopic]) {
					delete roomSubscribers[rootTopic];
					reclaimOffers(rootTopic);
				}
				if (current()) {
					delete states[rootTopic];
					void send(client, rootTopic, {
						event: "stopped",
						numwant: 0,
						offers: [],
					});
				}
			};
		},
		announce: async (client, rootTopic) => {
			const state = topicStates.forRelay(client)[rootTopic];
			if (state) {
				state.stopPassiveAnnouncements();
				state.isActive = true;
				await state.announce();
			}
			return state?.announceMs ?? ANNOUNCE_MS;
		},
		deactivate: (client, rootTopic) => {
			const state = topicStates.forRelay(client)[rootTopic];
			if (state) state.isActive = false;
			reclaimOffers(rootTopic);
			state?.startPassiveAnnouncements();
		},
	});

	return {
		joinRoom: (config, roomId, callbacks) => {
			offerCount(config);
			if (!config.relayConfig?.urls?.length)
				throw new RangeError("a tracker room needs relayConfig.urls");
			return strategy(
				{ ...config, trickleIce: config.trickleIce ?? false },
				roomId,
				callbacks,
			);
		},
		sockets: relays.getSockets,
	};
}
