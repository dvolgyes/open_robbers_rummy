import { describe, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";
import {
	classify,
	type Form,
	readSignals,
	watchDeviceClass,
} from "../../src/call/device-class";

// The tests use this page's window in Chrome. The viewport changes the layout width, and Chrome's DevTools
// emulation changes the user agent and the pointer.

/** Sets the viewport width and waits for the window's resize event. */
async function resizeTo(width: number): Promise<void> {
	if (innerWidth === width) return;
	const resized = new Promise((resolve) =>
		addEventListener("resize", resolve, { once: true }),
	);
	await page.viewport(width, 720);
	await resized;
	expect(innerWidth).toBe(width);
}

describe("readSignals on Chrome's window", () => {
	it("reads the width, the user agent and the fine pointer of desktop Chrome", async () => {
		await resizeTo(1280);
		const signals = readSignals(window);
		expect(signals).toEqual({
			viewportWidth: 1280,
			uaMobile: false,
			userAgent: navigator.userAgent,
			maxTouchPoints: 0,
			anyFinePointer: true,
		});
		expect(classify(signals)).toBe("desktop");
	});

	it("reads userAgentData.mobile from a mobile user agent", async () => {
		await resizeTo(1280);
		await cdp().send("Emulation.setUserAgentOverride", {
			userAgent: navigator.userAgent,
			userAgentMetadata: {
				platform: "Android",
				platformVersion: "14",
				architecture: "",
				model: "Pixel 8",
				mobile: true,
			},
		});
		try {
			expect(readSignals(window).uaMobile).toBe(true);
			expect(classify(readSignals(window))).toBe("compact");
		} finally {
			await cdp().send("Emulation.setUserAgentOverride", { userAgent: "" });
		}
		expect(readSignals(window).uaMobile).toBe(false);
	});
});

describe("watchDeviceClass on Chrome's window", () => {
	it("reports only changes of class from viewport resizes, and nothing after stop", async () => {
		await resizeTo(1280);
		const seen: Form[] = [];
		const stop = watchDeviceClass(window, (form) => seen.push(form));
		await resizeTo(1000); // still desktop
		await resizeTo(800); // compact
		await resizeTo(700); // still compact
		await resizeTo(1280); // desktop
		expect(seen).toEqual(["compact", "desktop"]);
		stop();
		await resizeTo(800);
		expect(seen).toEqual(["compact", "desktop"]);
	});

	// Last test of the file: Chrome keeps the touch-only pointer until the browser closes.
	it("reports compact when the pointer becomes touch only, and nothing after stop", async () => {
		await resizeTo(1280);
		const stopped: Form[] = [];
		watchDeviceClass(window, (form) => stopped.push(form))();
		const seen: Form[] = [];
		const stop = watchDeviceClass(window, (form) => seen.push(form));
		await cdp().send("Emulation.setTouchEmulationEnabled", {
			enabled: true,
			maxTouchPoints: 5,
		});
		await expect.poll(() => seen).toEqual(["compact"]);
		expect(readSignals(window)).toMatchObject({
			anyFinePointer: false,
			maxTouchPoints: 5,
		});
		expect(stopped).toEqual([]);
		stop();
	});
});
