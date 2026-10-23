import { describe, expect, it } from "vitest";
import { botSeatClaims, botSeats } from "../../src/p2p/bot-seats";
import { CONFIG, TABLE_ID } from "./fixtures";

describe("botSeats", () => {
	it("are the seats with a Bot choice, and a player named bot keeps the seat free", async () => {
		const config = {
			...CONFIG,
			names: { "1": "bot", "2": "Botond", "3": "player2", "4": "host" },
			botSetup: { seats: ["3" as const] },
		};
		expect(botSeats(config)).toEqual(["3"]);
		const claims = await botSeatClaims(TABLE_ID, config, () => "id", "4");
		expect(claims.map((claim) => claim.seat)).toEqual(["3"]);
	});
});
