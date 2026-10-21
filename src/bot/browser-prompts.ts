import type { PromptTemplates } from "./strategy";

export async function loadBrowserPromptTemplates(): Promise<PromptTemplates> {
	const response = await fetch("/bot-prompts/turn.txt");
	if (!response.ok)
		throw new Error(`could not load bot prompt (${response.status})`);
	return { turn: await response.text() };
}
