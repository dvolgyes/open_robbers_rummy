import "./ui/style.css";
import { parseStunUrls, rtcConfiguration } from "./call/ice";
import { detectLocale, translator } from "./i18n";
import { readMeshConfig } from "./p2p/config";
import type { Clock } from "./p2p/ports";
import {
	MemoryStorage,
	openIndexedDbStorage,
	type TableStorage,
} from "./p2p/storage";
import { trysteroMesh } from "./p2p/trystero";
import { guardedStorage, SeatMemory, webSeatLocks } from "./session";
import { startApp } from "./ui/app";
import type { CallSupport } from "./ui/deps";

const LOCALE_STORAGE_KEY = "open_canasta.locale";
const browser = guardedStorage(() => window.localStorage);
const detectedLocale = detectLocale(navigator.languages, navigator.language);
const storedLocale = browser?.getItem(LOCALE_STORAGE_KEY);
const savedLocale =
	storedLocale === "en" ||
	storedLocale === "de" ||
	storedLocale === "hu" ||
	storedLocale === "no" ||
	storedLocale === "es" ||
	storedLocale === "pt" ||
	storedLocale === "fr" ||
	storedLocale === "it" ||
	storedLocale === "nl"
		? storedLocale
		: undefined;
const locale = savedLocale ?? detectedLocale;
const t = translator(locale);
document.documentElement.lang = locale;

const root = document.getElementById("app");
if (!root) throw new Error("index.html must contain #app");

/**
 * Calls need WebRTC. Without the capture API (for example on a page that is not a secure context) Listen only
 * still works: a microphone request then fails, which the call shows as "No working microphone".
 */
function callSupport(stunList: string | undefined): CallSupport {
	const stun = parseStunUrls(stunList);
	if (!stun.ok)
		return { available: false, reason: configErrorText(stun.error) };
	if (typeof RTCPeerConnection !== "function") {
		return { available: false, reason: t("This browser cannot make calls.") };
	}
	const configuration = rtcConfiguration(stun.urls);
	const devices = navigator.mediaDevices as MediaDevices | undefined;
	return {
		available: true,
		getUserMedia: (constraints) =>
			devices === undefined
				? Promise.reject(
						new DOMException("No capture API", "NotSupportedError"),
					)
				: devices.getUserMedia(constraints),
		cameras: {
			enumerate: () =>
				devices === undefined
					? Promise.resolve([])
					: typeof devices.enumerateDevices !== "function"
						? Promise.resolve(undefined)
						: devices.enumerateDevices().then((listed) =>
								listed
									.filter((device) => device.kind === "videoinput")
									.map((device) => ({
										deviceId: device.deviceId,
										label: device.label,
									})),
							),
			subscribe: (listener) => {
				if (devices === undefined) return () => {};
				devices.addEventListener("devicechange", listener);
				return () => devices.removeEventListener("devicechange", listener);
			},
		},
		createConnection: () => new RTCPeerConnection(configuration),
		newSession: () => crypto.randomUUID(),
		granted: (medium) => granted(medium === "audio" ? "microphone" : "camera"),
	};
}

function configErrorText(message: string): string {
	const trackerCount =
		/^At most (\d+) tracker URLs are allowed \(VITE_TRACKER_URLS\)\.$/.exec(
			message,
		);
	if (trackerCount)
		return t("At most {count} tracker URLs are allowed (VITE_TRACKER_URLS).", {
			count: trackerCount[1] as string,
		});
	const badTracker =
		/^Not a valid wss: tracker URL in VITE_TRACKER_URLS: (.+)$/.exec(message);
	if (badTracker)
		return t("Not a valid wss: tracker URL in VITE_TRACKER_URLS: {url}", {
			url: badTracker[1] as string,
		});
	const stunCount =
		/^At most (\d+) STUN URLs are allowed \(VITE_STUN_URLS\)\.$/.exec(message);
	if (stunCount)
		return t("At most {count} STUN URLs are allowed (VITE_STUN_URLS).", {
			count: stunCount[1] as string,
		});
	const badStun =
		/^Not a valid stun: or stuns: URL in VITE_STUN_URLS: (.+)$/.exec(message);
	if (badStun)
		return t("Not a valid stun: or stuns: URL in VITE_STUN_URLS: {url}", {
			url: badStun[1] as string,
		});
	return t(message);
}

/** The browser's stored answer for a capture permission; a browser that cannot tell counts as not granted. */
function granted(name: "microphone" | "camera"): Promise<boolean> {
	const permissions = navigator.permissions as Permissions | undefined;
	if (permissions === undefined) return Promise.resolve(false);
	return permissions.query({ name }).then(
		(status) => status.state === "granted",
		// Some browsers do not know this permission name: the page asks the user instead.
		() => false,
	);
}

/** IndexedDB, or a memory store with the reason when this browser does not allow storing data (plan §4.3). */
async function openStorage(): Promise<{
	storage: TableStorage;
	problem: string | undefined;
}> {
	const api =
		typeof indexedDB === "undefined"
			? undefined
			: { factory: indexedDB, keyRange: IDBKeyRange };
	const opened = await openIndexedDbStorage(api, (record) =>
		console.error(`Ignored a damaged stored ${record} record.`),
	);
	return opened.ok
		? { storage: opened.value, problem: undefined }
		: { storage: new MemoryStorage(), problem: opened.detail };
}

/**
 * Web Locks, or none when this browser refuses them (blocked site data): a seat then comes back only after the
 * seat hold, when its holder is unseen for SEAT_HOLD_MS (plan §4.6).
 */
async function usableLocks(): Promise<LockManager | undefined> {
	const locks = navigator.locks as LockManager | undefined;
	if (locks === undefined) return undefined;
	return locks.query().then(
		() => locks,
		() => undefined,
	);
}

/** Best effort: a browser without the API, or one that refuses, can still clear the stored tables later. */
function askPersistence(): Promise<boolean> {
	const manager = navigator.storage as StorageManager | undefined;
	if (typeof manager?.persist !== "function") return Promise.resolve(false);
	return manager.persist().catch(() => false);
}

async function main(root: HTMLElement): Promise<void> {
	// Trystero and the table identifiers need Web Crypto, which only a secure context has (plan §4.1).
	if (!window.isSecureContext) {
		root.textContent = t("Open this page over HTTPS.");
		return;
	}
	const mesh = readMeshConfig(import.meta.env);
	if (!mesh.ok) {
		root.textContent = configErrorText(mesh.error);
		return;
	}
	const { config } = mesh;
	const clock: Clock = {
		monotonic: () => performance.now(),
		wall: () => Date.now(),
	};
	const memory = new SeatMemory(
		guardedStorage(() => window.sessionStorage),
		browser,
		clock.wall,
	);
	memory.prune();
	const { storage, problem } = await openStorage();
	let persisted: Promise<boolean> | undefined;
	startApp(root, {
		locale,
		detectedLocale,
		savedLocale,
		t,
		storage,
		storageProblem: problem,
		locks: webSeatLocks(await usableLocks()),
		memory,
		browser,
		clock,
		openMesh: (tableId, key) => trysteroMesh(tableId, key, config, clock),
		call: callSupport(import.meta.env.VITE_STUN_URLS),
		pageUrl: () => location.href,
		persist: () => {
			persisted ??= askPersistence();
			return persisted;
		},
	});
}

void main(root);
