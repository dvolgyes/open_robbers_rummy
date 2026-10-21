import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "@playwright/test";
import { loadEnv } from "vite";
import { parseTrackerUrls } from "../../src/p2p/config";
import { NetworkSwitch } from "./network";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Device options of the context, for example a phone viewport with touch. Kept across restarts. */
export type ContextOptions = Omit<
	NonNullable<Parameters<Browser["newContext"]>[0]>,
	"storageState" | "baseURL"
>;

/** Test rig options of a player. Kept across restarts. */
export interface RigOptions {
	/** Routes the tracker sockets through a `NetworkSwitch`, so that the test can cut them (plan §9). */
	readonly trackerSwitch?: boolean;
	/**
	 * Starts a separate Chrome whose profile does not allow sites to save data, the setting a person can choose
	 * in Chrome. Chrome then refuses localStorage, sessionStorage, IndexedDB and Web Locks.
	 */
	readonly blockSiteData?: boolean;
}

/**
 * A Chrome with a new profile that blocks site data, as the "Don't allow sites to save data" setting does. The
 * channel and the fake media device match playwright.config.ts. Returns the context and a cleanup of the
 * profile.
 */
async function blockedContext(
	options: ContextOptions,
	baseURL: string,
): Promise<{ context: BrowserContext; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(
		join(process.env.TMPDIR ?? tmpdir(), "oc-blocked-"),
	);
	await mkdir(join(dir, "Default"));
	await writeFile(
		join(dir, "Default", "Preferences"),
		JSON.stringify({
			profile: { default_content_setting_values: { cookies: 2 } },
		}),
	);
	const context = await chromium.launchPersistentContext(dir, {
		...options,
		baseURL,
		channel: "chrome",
		args: ["--use-fake-device-for-media-stream"],
	});
	for (const page of context.pages()) await page.close();
	return {
		context,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

/** The tracker list of the build, read from the same files and prefix as the Vite build. */
export function buildTrackerUrls(): readonly string[] {
	const env = loadEnv("production", process.cwd(), ["VITE_TRACKER_"]);
	const result = parseTrackerUrls(env.VITE_TRACKER_URLS);
	if (!result.ok) throw new Error(result.error);
	return result.urls;
}

/** How long a failure report waits for one tab; a frozen tab never answers. */
const REPORT_WAIT_MS = 2_000;

/**
 * On failure: the Network panel of every open tab on stderr. The panel shows counts and yes-or-no facts only; no
 * key, no address.
 */
export async function reportNetwork(players: Iterable<Player>): Promise<void> {
	for (const player of players) {
		for (const [index, page] of player.pages.entries()) {
			const read = page
				.getByTestId("network")
				.locator("dt, dd")
				.allTextContents()
				.catch(() => null);
			const late = new Promise<null>((resolve) =>
				setTimeout(resolve, REPORT_WAIT_MS, null),
			);
			const parts = await Promise.race([read, late]);
			const pairs: string[] = [];
			for (let at = 0; parts !== null && at + 1 < parts.length; at += 2)
				pairs.push(`${parts[at]}: ${parts[at + 1]}`);
			const shown =
				parts === null
					? "no answer"
					: pairs.length === 0
						? "no Network panel"
						: pairs.join("; ");
			console.error(`${player.name} tab ${index}: ${shown}`);
		}
	}
}

/** The old version's backend. The P2P app must never contact it (plan §9). */
function isSupabase(url: URL): boolean {
	return /(^|\.)supabase\.(co|com|in)$/.test(url.hostname);
}

/**
 * One person's browser: a context with its own storage, so its own holder (plan §9). Every request to a
 * Supabase host is refused and counted in `supabaseRequests`.
 */
export class Player {
	readonly name: string;
	/** Uncaught errors of every tab, in order. */
	readonly errors: string[] = [];
	readonly #browser: Browser;
	readonly #baseURL: string;
	readonly #options: ContextOptions;
	readonly #rig: RigOptions;
	readonly #initScripts: (() => void)[] = [];
	readonly #grants: string[] = [];
	#context: BrowserContext | undefined;
	#network: NetworkSwitch | undefined;
	#cleanup: (() => Promise<void>) | undefined;
	#supabase = 0;

	private constructor(
		browser: Browser,
		baseURL: string,
		name: string,
		options: ContextOptions,
		rig: RigOptions,
	) {
		this.name = name;
		this.#browser = browser;
		this.#baseURL = baseURL;
		this.#options = options;
		this.#rig = rig;
	}

	/** A new browser with empty storage. */
	static async open(
		browser: Browser,
		baseURL: string,
		name: string,
		options: ContextOptions = {},
		rig: RigOptions = {},
	): Promise<Player> {
		const player = new Player(browser, baseURL, name, options, rig);
		await player.#start(undefined);
		return player;
	}

	/** The tracker switch; only a player opened with `trackerSwitch` has one. */
	get network(): NetworkSwitch {
		if (!this.#network)
			throw new Error(`${this.name} has no tracker switch or is closed`);
		return this.#network;
	}

	/** The open tabs; none when the player is closed. */
	get pages(): readonly Page[] {
		return this.#context?.pages() ?? [];
	}

	/** Requests to Supabase hosts since the player opened, over all restarts. Must stay 0. */
	get supabaseRequests(): number {
		return this.#supabase;
	}

	/** Runs the script in every later tab, before the app's own scripts. Kept across restarts. */
	async addInitScript(script: () => void): Promise<void> {
		if (!this.#context) throw new Error(`${this.name} is closed`);
		this.#initScripts.push(script);
		await this.#context.addInitScript(script);
	}

	/** Grants browser permissions, for example the microphone, to open and later tabs. Kept across restarts. */
	async grantPermissions(permissions: readonly string[]): Promise<void> {
		if (!this.#context) throw new Error(`${this.name} is closed`);
		this.#grants.push(...permissions);
		await this.#context.grantPermissions([...permissions]);
	}

	/** Opens a new tab at the URL. */
	async page(url: string): Promise<Page> {
		if (!this.#context) throw new Error(`${this.name} is closed`);
		const page = await this.#context.newPage();
		page.on("pageerror", (error) =>
			this.errors.push(`${this.name}: ${error.message}`),
		);
		await page.goto(url);
		return page;
	}

	/**
	 * Quits and restarts the browser: all tabs and sessionStorage are lost; localStorage and IndexedDB (the
	 * table replicas) are kept.
	 */
	async restart(): Promise<void> {
		const state = await this.#stop();
		await this.#start(state);
	}

	/** Closes the browser without reading its storage, so that a page left frozen by a failed test cannot block it. */
	async close(): Promise<void> {
		const context = this.#context;
		if (!context) return;
		this.#context = undefined;
		this.#network = undefined;
		await context.close();
		await this.#cleanup?.();
		this.#cleanup = undefined;
	}

	async #start(state: StorageState | undefined): Promise<void> {
		let context: BrowserContext;
		if (this.#rig.blockSiteData) {
			const blocked = await blockedContext(this.#options, this.#baseURL);
			context = blocked.context;
			this.#cleanup = blocked.cleanup;
		} else
			context = await this.#browser.newContext({
				...this.#options,
				baseURL: this.#baseURL,
				...(state === undefined ? {} : { storageState: state }),
			});
		this.#context = context;
		await context.route(isSupabase, (route) => {
			this.#supabase += 1;
			return route.abort("blockedbyclient");
		});
		await context.routeWebSocket(isSupabase, (socket) => {
			this.#supabase += 1;
			void socket.close();
		});
		for (const script of this.#initScripts) await context.addInitScript(script);
		if (this.#grants.length > 0) await context.grantPermissions(this.#grants);
		if (this.#rig.trackerSwitch)
			this.#network = await NetworkSwitch.install(context, buildTrackerUrls());
	}

	async #stop(): Promise<StorageState> {
		if (!this.#context) throw new Error(`${this.name} is closed`);
		const state = await this.#context.storageState({ indexedDB: true });
		await this.#context.close();
		this.#context = undefined;
		this.#network = undefined;
		await this.#cleanup?.();
		this.#cleanup = undefined;
		return state;
	}
}
