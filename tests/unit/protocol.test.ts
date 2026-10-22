import { describe, expect, it } from "vitest";
import {
	envelopeEvent,
	parseRoomConfig,
	SEATS,
	seatLabel,
	seatsOf,
} from "../../src/protocol";
import { CONFIG, ROOM_ID } from "./fixtures";

describe("parseRoomConfig", () => {
	it("accepts a complete configuration", () => {
		expect(parseRoomConfig(structuredClone(CONFIG))).toEqual(CONFIG);
	});

	it("keeps the bot seats inside the players in play", () => {
		const botSetup = { seats: ["4"] };
		expect(parseRoomConfig({ ...CONFIG, botSetup })).toEqual({
			...CONFIG,
			botSetup,
		});
		expect(
			parseRoomConfig({ ...CONFIG, botSetup: { seats: ["5"] } }),
		).toBeUndefined();
		expect(
			parseRoomConfig({ ...CONFIG, botSetup: { seats: ["4", "4"] } }),
		).toBeUndefined();
	});

	it("does not infer bot seats from player names", () => {
		const config = {
			...CONFIG,
			names: { ...CONFIG.names, "1": "robot", "2": "bot" },
			botSetup: { seats: [] },
		};
		expect(parseRoomConfig(config)?.botSetup?.seats).toEqual([]);
	});

	it("accepts two and six players, and lists the seats in play in turn order", () => {
		const two = parseRoomConfig({ ...CONFIG, names: { "1": "a", "2": "b" } });
		expect(two === undefined ? [] : seatsOf(two)).toEqual(["1", "2"]);
		const names = {
			"1": "a",
			"2": "b",
			"3": "c",
			"4": "d",
			"5": "e",
			"6": "f",
		};
		const six = parseRoomConfig({ ...CONFIG, names });
		expect(six === undefined ? [] : seatsOf(six)).toEqual(SEATS);
	});

	it.each([
		[
			"a missing name",
			{ ...CONFIG, names: { ...CONFIG.names, "2": undefined } },
		],
		["an empty name", { ...CONFIG, names: { ...CONFIG.names, "2": "" } }],
		["one player", { ...CONFIG, names: { "1": "a" } }],
		["a gap in the seats", { ...CONFIG, names: { "1": "a", "3": "c" } }],
		[
			"a seat outside 1 to 6",
			{ ...CONFIG, names: { "1": "a", "2": "b", "7": "c" } },
		],
		["no table rules", { names: CONFIG.names }],
		[
			"an unknown preset",
			{ ...CONFIG, table: { ...CONFIG.table, preset: "canasta" } },
		],
		["one joker", { ...CONFIG, table: { ...CONFIG.table, jokers: 1 } }],
		["seven jokers", { ...CONFIG, table: { ...CONFIG.table, jokers: 7 } }],
		[
			"a fractional joker count",
			{ ...CONFIG, table: { ...CONFIG.table, jokers: 2.5 } },
		],
		[
			"an assist flag that is not a boolean",
			{ ...CONFIG, table: { ...CONFIG.table, assist: 1 } },
		],
	])("rejects %s", (_label, value) => {
		expect(parseRoomConfig(value)).toBeUndefined();
	});
});

describe("seat helpers", () => {
	it("labels a seat with its direction and predefined name", () => {
		expect(seatLabel(CONFIG, "1")).toBe("Player 1 — player1");
	});
});

describe("envelopeEvent", () => {
	it("lets the envelope win over forged body fields", () => {
		const event = envelopeEvent(
			{ roomId: ROOM_ID, seq: 4, commandId: "cmd", fromSeat: "3" },
			{
				text: "hi",
				v: 9,
				roomId: "elsewhere",
				type: "chat",
				seq: 1,
				commandId: "other",
				fromSeat: "4",
			},
		);
		expect(event).toEqual({
			text: "hi",
			v: 1,
			roomId: ROOM_ID,
			type: "event",
			seq: 4,
			commandId: "cmd",
			fromSeat: "3",
		});
	});
});
