import { describe, expect, it } from "vitest";
import jevArtwork from "../../src/ui/assets/robot-models/jev1.png";
import lunaArtwork from "../../src/ui/assets/robot-models/luna.png";
import lunaDecisionArtwork from "../../src/ui/assets/robot-models/luna-decision.png";
import mercuryArtwork from "../../src/ui/assets/robot-models/mercury.png";
import mercuryDecisionArtwork from "../../src/ui/assets/robot-models/mercury-decide.png";
import perplexityDecisionArtwork from "../../src/ui/assets/robot-models/perplexity-decision.png";
import solArtwork from "../../src/ui/assets/robot-models/sol.png";
import { robotArtwork } from "../../src/ui/robot-artwork";

describe("bot model artwork", () => {
	it.each([
		["inception/mercury-3", mercuryArtwork],
		["inception/mercury-decide", mercuryDecisionArtwork],
		["openai/gpt-6-luna", lunaArtwork],
		["openai/gpt-6-luna-decisions", lunaDecisionArtwork],
		["~perplexity/pplx-decider-latest", perplexityDecisionArtwork],
		["typesafe/jev-1.14", jevArtwork],
		["~openai/gpt-sol-latest", solArtwork],
	] as const)("maps %s to its matching artwork", (model, artwork) => {
		expect(robotArtwork(model)).toBe(artwork);
	});

	it("returns no artwork for an unmapped model", () => {
		expect(robotArtwork("unmapped/model")).toBeUndefined();
	});
});
