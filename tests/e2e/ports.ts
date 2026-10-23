// The ports of the end-to-end servers. Other local projects use 4173/4174 and 4373/4374, so a run beside
// them does not find its ports taken.

/** The production build (`vite preview`). */
export const APP_PORT = 4273;
/** The P2P harness (tests/e2e/harness). */
export const HARNESS_PORT = 4274;
export const HARNESS_URL = `http://localhost:${HARNESS_PORT}/`;
