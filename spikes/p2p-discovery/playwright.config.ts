import { defineConfig } from "@playwright/test";

const PORT = 4180;

export default defineConfig({
	testDir: ".",
	testMatch: "discovery.spec.ts",
	// One worker: the trials share public trackers, and parallel trials would distort the timings.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 20 * 60_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	use: {
		baseURL: `http://localhost:${PORT}/`,
		channel: "chrome",
		trace: "off",
	},
	webServer: {
		command: `../../node_modules/.bin/vite --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/`,
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
