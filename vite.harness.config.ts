import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The P2P test harness (tests/e2e/harness), served for tests/e2e/p2p-mesh.spec.ts. Only the tracker and STUN
// lists reach the page; the harness imports the production modules from src/.
const REPOSITORY = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	root: "tests/e2e/harness",
	envDir: REPOSITORY,
	envPrefix: ["VITE_TRACKER_", "VITE_STUN_"],
	server: { fs: { allow: [REPOSITORY] } },
	// Bundled at startup, so the first test does not see a reload when Vite optimizes it later.
	optimizeDeps: { include: ["@trystero-p2p/core"] },
});
