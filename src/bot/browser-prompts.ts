import type { PromptTemplates } from "./strategy";

export async function loadBrowserPromptTemplates(): Promise<PromptTemplates> {
	// Relative to the page, so the game also works under a sub-path such as a GitHub Pages project site.
	const response = await fetch("bot-prompts/turn.txt");
	if (!response.ok)
		throw new Error(`could not load bot prompt (${response.status})`);
	return { turn: await response.text() };
}
