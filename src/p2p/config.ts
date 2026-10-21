import { parseStunUrls, rtcConfiguration } from "../call/ice";

/**
 * Mesh settings from the build environment (plan §4.2): the tracker list from `VITE_TRACKER_URLS` and the STUN
 * list from `VITE_STUN_URLS`. The page never falls back to Trystero's own defaults, so a configuration value
 * alone decides which outside services see the page.
 */

/** Unversioned, so pages of different versions meet and report the mismatch. */
export const APP_ID = "open-canasta";

/** The three trackers that answered in every spike trial (spikes/p2p-discovery). */
export const DEFAULT_TRACKER_URLS: readonly string[] = [
	"wss://tracker.openwebtorrent.com",
	"wss://tracker.webtorrent.dev",
	"wss://open.ftorrent.com",
];

const MAX_TRACKER_URLS = 8;

export interface MeshConfig {
	readonly trackers: readonly string[];
	readonly rtc: RTCConfiguration;
}

export type MeshConfigResult =
	| { readonly ok: true; readonly config: MeshConfig }
	| { readonly ok: false; readonly error: string };

type Env = Readonly<Record<string, string | undefined>>;

/** Only `wss:` URLs without credentials, query or fragment: a tracker sees the page's address, so it must be named. */
function isTrackerUrl(text: string): boolean {
	if (!URL.canParse(text)) return false;
	const url = new URL(text);
	return (
		url.protocol === "wss:" &&
		url.hostname !== "" &&
		url.username === "" &&
		url.password === "" &&
		url.search === "" &&
		url.hash === ""
	);
}

export function parseTrackerUrls(
	value: string | undefined,
):
	| { readonly ok: true; readonly urls: readonly string[] }
	| { readonly ok: false; readonly error: string } {
	const urls = (value ?? "").split(/[\s,]+/).filter((url) => url !== "");
	if (urls.length === 0) return { ok: true, urls: DEFAULT_TRACKER_URLS };
	if (urls.length > MAX_TRACKER_URLS) {
		return {
			ok: false,
			error: `At most ${MAX_TRACKER_URLS} tracker URLs are allowed (VITE_TRACKER_URLS).`,
		};
	}
	const bad = urls.find((url) => !isTrackerUrl(url));
	if (bad !== undefined) {
		return {
			ok: false,
			error: `Not a valid wss: tracker URL in VITE_TRACKER_URLS: ${bad}`,
		};
	}
	return { ok: true, urls: [...new Set(urls)] };
}

export function readMeshConfig(env: Env): MeshConfigResult {
	const trackers = parseTrackerUrls(env.VITE_TRACKER_URLS);
	if (!trackers.ok) return trackers;
	const stun = parseStunUrls(env.VITE_STUN_URLS);
	if (!stun.ok) return stun;
	return {
		ok: true,
		config: { trackers: trackers.urls, rtc: rtcConfiguration(stun.urls) },
	};
}
