import type { BrowserContext, WebSocketRoute } from "@playwright/test";

interface SocketPair {
	readonly page: WebSocketRoute;
	readonly server: WebSocketRoute;
}

/**
 * Cuts one browser context off from the trackers, as a tracker outage would (plan §9). Blocking closes the open
 * tracker sockets on both sides and refuses new ones. Direct WebRTC links between the pages stay up.
 */
export class NetworkSwitch {
	#blocked = false;
	readonly #sockets = new Set<SocketPair>();

	static async install(
		context: BrowserContext,
		trackerUrls: readonly string[],
	): Promise<NetworkSwitch> {
		const network = new NetworkSwitch();
		const hosts = new Set(trackerUrls.map((url) => new URL(url).host));
		await context.routeWebSocket(
			(url) => hosts.has(url.host),
			(socket) => network.#socket(socket),
		);
		return network;
	}

	async block(): Promise<void> {
		this.#blocked = true;
		const open = [...this.#sockets];
		this.#sockets.clear();
		await Promise.all(
			open.flatMap(({ page, server }) => [server.close(), page.close()]),
		);
	}

	unblock(): void {
		this.#blocked = false;
	}

	#socket(page: WebSocketRoute): void {
		if (this.#blocked) {
			void page.close();
			return;
		}
		// Without message handlers, Playwright forwards all traffic and closures between the two sides.
		this.#sockets.add({ page, server: page.connectToServer() });
	}
}

/**
 * Withholds the WebRTC offers of one browser context for `ms` after its first tracker socket opens, as if each
 * page that the trackers chose could not answer. The announces reach the trackers without their offers, and
 * the offers and answers that the trackers relay to the context are dropped. The announce replies still
 * arrive, so the page keeps the trackers' announce interval. The filter reads only which fields a message has,
 * never a session description.
 */
export async function withholdOffers(
	context: BrowserContext,
	trackerUrls: readonly string[],
	ms: number,
): Promise<void> {
	const hosts = new Set(trackerUrls.map((url) => new URL(url).host));
	let until: number | undefined;
	const withheld = () => until !== undefined && Date.now() < until;
	await context.routeWebSocket(
		(url) => hosts.has(url.host),
		(page) => {
			until ??= Date.now() + ms;
			// With message handlers, Playwright forwards nothing on its own, so each handler sends on.
			const server = page.connectToServer();
			page.onMessage((message) =>
				server.send(withheld() ? withoutOffers(message) : message),
			);
			server.onMessage((message) => {
				if (!withheld() || !carriesSignal(message)) page.send(message);
			});
		},
	);
}

/** An announce without its offers; any other message unchanged. */
function withoutOffers(message: string | Buffer): string | Buffer {
	if (typeof message !== "string") return message;
	const data: unknown = JSON.parse(message);
	if (!isRecord(data) || !Array.isArray(data.offers)) return message;
	return JSON.stringify({ ...data, offers: [] });
}

/** An offer or an answer that a tracker relays from another page. */
function carriesSignal(message: string | Buffer): boolean {
	if (typeof message !== "string") return false;
	const data: unknown = JSON.parse(message);
	return isRecord(data) && ("offer" in data || "answer" in data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
