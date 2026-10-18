import { describe, expect, it } from "vitest";
import { envelopeEvent, parseRoomConfig, seatLabel } from "../../src/protocol";
import { CONFIG, ROOM_ID } from "./fixtures";

describe("parseRoomConfig", () => {
	it("accepts a complete configuration", () => {
		expect(parseRoomConfig(structuredClone(CONFIG))).toEqual(CONFIG);
	});

	it("validates bot seats, full model names, retry count, and delay", () => {
		const botSetup = {
			seats: ["W"],
			model: "inception/mercury-3",
			fallbackModel: "openai/gpt-6-luna",
			retries: 5,
			retryDelayMs: 5000,
		};
		expect(parseRoomConfig({ ...CONFIG, botSetup })).toEqual({
			...CONFIG,
			botSetup,
		});
		expect(
			parseRoomConfig({ ...CONFIG, botSetup: { ...botSetup, model: "other" } }),
		).toBeUndefined();
		expect(
			parseRoomConfig({ ...CONFIG, botSetup: { ...botSetup, retries: 99 } }),
		).toBeUndefined();
	});

	it("does not infer bot seats from player names", () => {
		const botSetup = {
			seats: [],
			model: "inception/mercury-3",
			fallbackModel: "openai/gpt-6-luna",
			retries: 5,
			retryDelayMs: 5000,
		};
		const config = {
			...CONFIG,
			names: { ...CONFIG.names, N: "robot", E: "bot" },
			botSetup,
		};
		expect(parseRoomConfig(config)?.botSetup?.seats).toEqual([]);
	});

	it.each([
		["a missing name", { ...CONFIG, names: { ...CONFIG.names, E: undefined } }],
		["an empty name", { ...CONFIG, names: { ...CONFIG.names, E: "" } }],
		["an unimplemented scoring", { ...CONFIG, scoring: "rubber" }],
	])("rejects %s", (_label, value) => {
		expect(parseRoomConfig(value)).toBeUndefined();
	});
});

describe("seat helpers", () => {
	it("labels a seat with its direction and predefined name", () => {
		expect(seatLabel(CONFIG, "N")).toBe("North — player1");
	});
});

describe("envelopeEvent", () => {
	it("lets the envelope win over forged body fields", () => {
		const event = envelopeEvent(
			{ roomId: ROOM_ID, seq: 4, commandId: "cmd", fromSeat: "S" },
			{
				text: "hi",
				v: 9,
				roomId: "elsewhere",
				type: "chat",
				seq: 1,
				commandId: "other",
				fromSeat: "W",
			},
		);
		expect(event).toEqual({
			text: "hi",
			v: 1,
			roomId: ROOM_ID,
			type: "event",
			seq: 4,
			commandId: "cmd",
			fromSeat: "S",
		});
	});
});
