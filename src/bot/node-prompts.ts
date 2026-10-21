import { readFileSync } from "node:fs";
import type { PromptTemplates } from "./strategy";

export const NODE_PROMPT_TEMPLATES: PromptTemplates = {
	turn: readFileSync(
		new URL("../../public/bot-prompts/turn.txt", import.meta.url),
		"utf8",
	),
};
