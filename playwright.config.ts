import { defineConfig } from "@playwright/test";

const PORT = 4173;
const HARNESS_PORT = 4174;

export default defineConfig({
	testDir: "tests/e2e",
	// One worker: the specs share the public trackers, and parallel browsers would compete for them and the CPU.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 20_000 },
	reporter: [["list"]],
	use: {
		baseURL: `http://localhost:${PORT}/`,
		channel: "chrome",
		// No traces: they would record the table keys in the links.
		trace: "off",
		screenshot: "only-on-failure",
		// A generated tone replaces the microphone. The permission stays per context (`permissions`), so a test
		// can still see a refused microphone.
		launchOptions: { args: ["--use-fake-device-for-media-stream"] },
	},
	webServer: [
		{
			command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
			url: `http://localhost:${PORT}/`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
		{
			// The P2P harness (tests/e2e/harness) for p2p-mesh.spec.ts.
			command: `npx vite --config vite.harness.config.ts --port ${HARNESS_PORT} --strictPort`,
			url: `http://localhost:${HARNESS_PORT}/`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
});
