import type { PromptTemplates } from "./strategy";

export async function loadBrowserPromptTemplates(): Promise<PromptTemplates> {
	const [bidding, play] = await Promise.all(
		["/bot-prompts/bidding.txt", "/bot-prompts/play.txt"].map(async (url) => {
			const response = await fetch(url);
			if (!response.ok)
				throw new Error(`could not load bot prompt (${response.status})`);
			return response.text();
		}),
	);
	if (bidding === undefined || play === undefined)
		throw new Error("bot prompt templates are incomplete");
	return { bidding, play };
}
