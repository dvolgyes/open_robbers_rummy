import type { MaybeStorage } from "../session";

const STORAGE_KEY = "open-canasta.openrouter-api-key";

export function normalizeHostApiKey(apiKey: string): string {
	return apiKey.trim();
}

/** The key stays in this browser's local storage and is never part of room setup. */
export function readHostApiKey(storage: MaybeStorage): string {
	return normalizeHostApiKey(storage?.getItem(STORAGE_KEY) ?? "");
}

export function writeHostApiKey(storage: MaybeStorage, apiKey: string): void {
	if (!storage) throw new Error("local storage is not available");
	const normalized = normalizeHostApiKey(apiKey);
	if (normalized === "") storage.removeItem(STORAGE_KEY);
	else storage.setItem(STORAGE_KEY, normalized);
}
