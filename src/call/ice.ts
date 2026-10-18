/**
 * ICE server configuration (handover §6): a configurable STUN list and nothing else. TURN URLs are refused so a
 * paid relay is never enabled by a configuration value; adding TURN later changes only this module.
 */

export const DEFAULT_STUN_URLS: readonly string[] = [
	"stun:stun.cloudflare.com:3478",
];

const MAX_STUN_URLS = 8;

// RFC 7064: stun:host[:port] or stuns:host[:port]; host is a name, an IPv4 address or a bracketed IPv6 address.
const STUN_URL =
	/^stuns?:(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;

export type IceConfigResult =
	| { readonly ok: true; readonly urls: readonly string[] }
	| { readonly ok: false; readonly error: string };

/** Parses a comma- or space-separated STUN list (`VITE_STUN_URLS`); empty or absent gives the default. */
export function parseStunUrls(value: string | undefined): IceConfigResult {
	const urls = (value ?? "").split(/[\s,]+/).filter((url) => url !== "");
	if (urls.length === 0) return { ok: true, urls: DEFAULT_STUN_URLS };
	if (urls.length > MAX_STUN_URLS) {
		return {
			ok: false,
			error: `At most ${MAX_STUN_URLS} STUN URLs are allowed (VITE_STUN_URLS).`,
		};
	}
	for (const url of urls) {
		if (/^turns?:/i.test(url)) {
			return {
				ok: false,
				error:
					"TURN URLs are not supported; VITE_STUN_URLS takes stun: and stuns: URLs only.",
			};
		}
		const match = STUN_URL.exec(url);
		const port = match?.[1] === undefined ? undefined : Number(match[1]);
		if (match === null || (port !== undefined && (port < 1 || port > 65535))) {
			return {
				ok: false,
				error: `Not a valid stun: or stuns: URL in VITE_STUN_URLS: ${url}`,
			};
		}
	}
	return { ok: true, urls };
}

export function rtcConfiguration(urls: readonly string[]): RTCConfiguration {
	return { iceServers: [{ urls: [...urls] }] };
}
