import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import type { BrowserCommandContext } from "vitest/node";

// Only the public tracker and STUN lists may carry these prefixes, because Vite inlines them into the bundle.
const ENV_PREFIXES = ["VITE_TRACKER_", "VITE_STUN_"];

// Chrome cannot turn its touch emulation off again, so this file runs in a browser of its own.
const TOUCH = "tests/browser/call-device-class.test.ts";
// This file needs a Chrome whose test devices have no camera.
const NO_CAMERA = "tests/browser/call-media-no-camera.test.ts";

/** Headless Chrome with its generated test microphone and camera, as in the end-to-end tests. */
function chrome(fakeDevices = "--use-fake-device-for-media-stream") {
	return {
		enabled: true,
		headless: true,
		provider: playwright({
			launchOptions: { channel: "chrome", args: [fakeDevices] },
			contextOptions: { permissions: ["microphone", "camera"] },
		}),
		instances: [{ browser: "chromium" as const }],
		commands: {
			/** Withdraws every permission of the page; Chrome then ends the live capture tracks. */
			clearPermissions: (context: BrowserCommandContext) =>
				context.context.clearPermissions(),
			grantPermissions: (context: BrowserCommandContext, names: string[]) =>
				context.context.grantPermissions(names),
		},
	};
}

export default defineConfig({
	base: "./",
	envPrefix: ENV_PREFIXES,
	build: {
		target: "es2022",
		sourcemap: true,
	},
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: ["tests/unit/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				extends: true,
				test: {
					name: "browser",
					include: ["tests/browser/**/*.test.ts"],
					exclude: [...configDefaults.exclude, TOUCH, NO_CAMERA],
					// The files share the page's real IndexedDB and Web Storage, so they run one at a time.
					fileParallelism: false,
					browser: chrome(),
				},
			},
			{
				extends: true,
				test: {
					name: "browser-touch",
					include: [TOUCH],
					browser: chrome(),
				},
			},
			{
				extends: true,
				test: {
					name: "browser-no-camera",
					include: [NO_CAMERA],
					browser: chrome("--use-fake-device-for-media-stream=device-count=0"),
				},
			},
		],
	},
});
