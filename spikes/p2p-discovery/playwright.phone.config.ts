import { defineConfig } from "@playwright/test";

// The phone probe opens phone-dist/p2p-phone-probe.html from the file system, so there is no web server.
export default defineConfig({
	testDir: ".",
	testMatch: "phone.spec.ts",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 60 * 60_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	use: {
		channel: "chrome",
		trace: "off",
	},
});
