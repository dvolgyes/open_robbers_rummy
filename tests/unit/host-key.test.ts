import { describe, expect, it } from "vitest";
import { readHostApiKey, writeHostApiKey } from "../../src/bot/host-key";

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => void values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
}

describe("host OpenRouter API key", () => {
	it("trims the key when saving and when reading older stored values", () => {
		const storage = memoryStorage();
		writeHostApiKey(storage, "  fresh-key\n");
		expect(readHostApiKey(storage)).toBe("fresh-key");

		storage.setItem("open-canasta.openrouter-api-key", "\tlegacy-key  ");
		expect(readHostApiKey(storage)).toBe("legacy-key");
	});

	it("removes a saved key when the input contains only whitespace", () => {
		const storage = memoryStorage();
		writeHostApiKey(storage, "  key  ");
		writeHostApiKey(storage, " \n\t ");
		expect(readHostApiKey(storage)).toBe("");
	});
});
