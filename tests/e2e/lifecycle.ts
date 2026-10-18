import type { Page } from "@playwright/test";

/**
 * Freezes the page's JavaScript, as Chrome freezes a background tab and as Android suspends a browser (plan §9):
 * timers and event handlers stop until the thaw, and the browser's network threads keep the WebRTC links open.
 * Headless Chrome reports every page as visible and ignores `Page.setWebLifecycleState` frozen (measured: a 200 ms
 * timer kept firing), so the freeze pauses the page in the debugger instead.
 * Returns the thaw.
 */
export async function freeze(page: Page): Promise<() => Promise<void>> {
	const session = await page.context().newCDPSession(page);
	await session.send("Debugger.enable");
	await session.send("Debugger.pause");
	return async () => {
		await session.send("Debugger.resume");
		await session.send("Debugger.disable");
		await session.detach();
	};
}
