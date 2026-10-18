// Tests for the single-file phone probe, phone-dist/p2p-phone-probe.html (build it with build-phone.mjs).
// Test 1 runs on this machine: a desktop context and an emulated phone context open the file.
// Test 2 is the real test: this machine opens the file and waits for a real phone that opened the same build.
// Test 2 runs only when PHONE_WAIT_MIN is set.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	type Browser,
	type BrowserContextOptions,
	devices,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { Snapshot } from "./phone";

const FILE_URL = new URL("./phone-dist/p2p-phone-probe.html", import.meta.url);
const LOCAL_MS = 60_000;
const WAIT_MIN = Number(process.env.PHONE_WAIT_MIN ?? 0);
const OUT = process.env.PROBE_OUT ?? "probe-results";
// Text that would show an address or signaling data. The page must never show it.
const LEAKS = [
	/\b\d{1,3}(\.\d{1,3}){3}\b/,
	/candidate:/i,
	/\bv=0\b/,
	/a=fingerprint/i,
];

type Peer = { page: Page; close: () => Promise<void>; errors: string[] };

const random = (bytes: number) =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
		"base64url",
	);

const open = async (
	browser: Browser,
	options: BrowserContextOptions,
	hash: string,
): Promise<Peer> => {
	const context = await browser.newContext(options);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${FILE_URL.href}${hash}`);
	await page.waitForFunction(
		() =>
			window.phoneProbe !== undefined ||
			document.getElementById("status")?.dataset.tone === "bad",
	);
	return { page, close: () => context.close(), errors };
};

const snapshot = (page: Page): Promise<Snapshot> =>
	page.evaluate(() => window.phoneProbe.snapshot());

/**
 * Waits until `page` has a live peer with a hello, a round trip, a path, and a report that
 * says the peer received at least `texts` messages from this page. Returns that peer.
 */
const waitLinked = async (page: Page, texts: number, timeoutMs: number) => {
	await page.waitForFunction(
		(min) =>
			window.phoneProbe
				.snapshot()
				.peers.some(
					(peer) =>
						peer.leftMs === null &&
						peer.hello !== null &&
						peer.rttMs !== null &&
						peer.pathType !== "unknown" &&
						(peer.report?.texts ?? 0) >= min,
				),
		texts,
		{ timeout: timeoutMs, polling: 500 },
	);
	const state = await snapshot(page);
	const peer = state.peers.find(
		(candidate) =>
			candidate.leftMs === null &&
			candidate.hello !== null &&
			candidate.rttMs !== null,
	);
	if (!peer) throw new Error("the linked peer disappeared");
	return { state, peer };
};

const expectNoLeaks = async (page: Page) => {
	const text = await page.locator("body").innerText();
	for (const leak of LEAKS) expect(text).not.toMatch(leak);
};

test.beforeAll(() => {
	if (!existsSync(fileURLToPath(FILE_URL))) {
		throw new Error(
			`${fileURLToPath(FILE_URL)} is missing: run node build-phone.mjs first`,
		);
	}
});

test("1 the file connects a desktop and an emulated phone on this machine", async ({
	browser,
}) => {
	test.setTimeout(3 * 60_000);
	// A new room, so that a real phone with the built file cannot join this test.
	const hash = `#room=${random(16)}&password=${random(32)}`;
	const desktop = await open(browser, {}, hash);
	const phone = await open(browser, devices["Pixel 7"], hash);
	try {
		for (const peer of [desktop, phone]) {
			expect(await peer.page.evaluate(() => window.isSecureContext)).toBe(true);
		}
		const fromDesktop = await waitLinked(desktop.page, 1, LOCAL_MS);
		const fromPhone = await waitLinked(phone.page, 1, LOCAL_MS);
		expect(fromDesktop.state.kind).toBe("desktop");
		expect(fromPhone.state.kind).toBe("phone");
		expect(fromDesktop.peer.hello?.kind).toBe("phone");
		expect(fromPhone.peer.hello?.kind).toBe("desktop");
		expect(fromDesktop.peer.texts).toContain("hello from the phone");
		expect(fromPhone.peer.texts).toContain("hello from the desktop");
		expect(fromDesktop.peer.pathType).not.toBe("no selected pair");
		await expect(desktop.page.locator("#status")).toContainText(
			"Connected to the phone",
		);
		await expect(phone.page.locator("#status")).toContainText(
			"Connected to the desktop",
		);
		await expectNoLeaks(desktop.page);
		await expectNoLeaks(phone.page);

		await phone.close();
		await expect(desktop.page.locator("#status")).toContainText(
			"The other device left",
		);
		expect([...desktop.errors, ...phone.errors]).toEqual([]);
		test.info().annotations.push({
			type: "path on this machine",
			description: fromDesktop.peer.pathType,
		});
	} finally {
		await desktop.close();
		await phone.close();
	}
});

test("2 a real phone opens the same file and connects to this machine", async ({
	browser,
}) => {
	test.skip(!(WAIT_MIN > 0), "set PHONE_WAIT_MIN to wait for a real phone");
	test.setTimeout((WAIT_MIN + 2) * 60_000);
	const desktop = await open(browser, {}, "");
	try {
		const { room } = await snapshot(desktop.page);
		console.log(`waiting up to ${WAIT_MIN} min for a phone in room ${room}`);
		const linked = await waitLinked(desktop.page, 1, WAIT_MIN * 60_000);
		console.log(`found a ${linked.peer.hello?.kind}, measuring for 15 s`);
		// Round trips every 3 s for 15 s, then one more message that the phone must confirm.
		await desktop.page.waitForTimeout(15_000);
		await desktop.page.evaluate(() =>
			window.phoneProbe.send("the desktop got your hello"),
		);
		const confirmed = await waitLinked(desktop.page, 2, 15_000);
		const { peer, state } = confirmed;
		const result = {
			date: new Date().toISOString(),
			room,
			foundAfterMs: peer.foundMs,
			desktop: {
				network: state.network,
				trackers: state.trackers,
				pathType: peer.pathType,
				rttsMs: peer.rtts,
			},
			phone: {
				kind: peer.hello?.kind,
				network: peer.hello?.network,
				pathType: peer.report?.pathType,
				messagesReceived: peer.report?.texts,
			},
			messagesFromPhone: peer.texts,
			errors: state.errors,
		};
		await mkdir(OUT, { recursive: true });
		await writeFile(
			`${OUT}/phone-${result.date.replaceAll(":", "-")}.json`,
			`${JSON.stringify(result, null, "\t")}\n`,
		);
		console.log(JSON.stringify(result, null, 2));

		expect(peer.texts).toContain("hello from the phone");
		expect(peer.report?.texts).toBeGreaterThanOrEqual(2);
		expect(peer.rtts.length).toBeGreaterThanOrEqual(3);
		await expectNoLeaks(desktop.page);
		expect(desktop.errors).toEqual([]);
		if (peer.pathType.startsWith("host/host")) {
			test.info().annotations.push({
				type: "same network",
				description:
					"The phone connected directly on the local network. Switch off Wi-Fi on the phone to test across networks.",
			});
		}
	} finally {
		await desktop.close();
	}
});
