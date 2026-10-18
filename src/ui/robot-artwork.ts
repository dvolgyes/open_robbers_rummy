import type { BotModel } from "../protocol";
import jevArtwork from "./assets/robot-models/jev1.png";
import lunaArtwork from "./assets/robot-models/luna.png";
import lunaDecisionArtwork from "./assets/robot-models/luna-decision.png";
import mercuryArtwork from "./assets/robot-models/mercury.png";
import mercuryDecisionArtwork from "./assets/robot-models/mercury-decide.png";
import perplexityDecisionArtwork from "./assets/robot-models/perplexity-decision.png";
import solArtwork from "./assets/robot-models/sol.png";

const artworkByModel: ReadonlyMap<BotModel, string> = new Map([
	["inception/mercury-3", mercuryArtwork],
	["inception/mercury-decide", mercuryDecisionArtwork],
	["openai/gpt-6-luna", lunaArtwork],
	["openai/gpt-6-luna-decisions", lunaDecisionArtwork],
	["~perplexity/pplx-decider-latest", perplexityDecisionArtwork],
	["typesafe/jev-1.14", jevArtwork],
	["~openai/gpt-sol-latest", solArtwork],
]);

export function robotArtwork(model: string | undefined): string | undefined {
	if (model === undefined) return undefined;
	return artworkByModel.get(model as BotModel);
}
