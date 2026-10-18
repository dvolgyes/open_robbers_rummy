import { readFileSync } from "node:fs";
import type { PromptTemplates } from "./strategy";

export const NODE_PROMPT_TEMPLATES: PromptTemplates = {
	bidding: readFileSync(
		new URL("../../public/bot-prompts/bidding.txt", import.meta.url),
		"utf8",
	),
	play: readFileSync(
		new URL("../../public/bot-prompts/play.txt", import.meta.url),
		"utf8",
	),
};
