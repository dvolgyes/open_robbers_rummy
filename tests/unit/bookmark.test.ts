import { describe, expect, it } from "vitest";
import {
	bookmarkQuery,
	botSeatsQuery,
	parseBookmark,
	parseRoomSetup,
} from "../../src/bookmark";
import { DEFAULT_TABLE_SETUP, type RoomConfig } from "../../src/protocol";

const TWO: RoomConfig = {
	names: { "1": "ann", "2": "ben" },
	table: DEFAULT_TABLE_SETUP,
};

const SIX: RoomConfig = {
	names: {
		"1": "a&b=c",
		"2": "x y",
		"3": "é+ü",
		"4": "#1",
		"5": "e",
		"6": "f",
	},
	table: { preset: "wikipedia", jokers: 6, assist: false },
	botSetup: { seats: ["3", "6"] },
};

describe("parseBookmark", () => {
	it("reads the names, the host seat and the table rules", () => {
		expect(
			parseBookmark(
				"?p1=ann&p2=zsdh&p3=bo&host=2&rules=machiavelli&jokers=3&assist=0",
			),
		).toEqual({
			names: { "1": "ann", "2": "zsdh", "3": "bo" },
			host: "2",
			table: { preset: "machiavelli", jokers: 3, assist: false },
		});
	});

	it("trims names and drops empty ones", () => {
		expect(parseBookmark("?p2=%20%20zsdh%20&p4=%20")).toEqual({
			names: { "2": "zsdh" },
			table: {},
		});
	});

	it("drops a name longer than 40 characters, counting characters not bytes", () => {
		const forty = "é".repeat(40);
		expect(parseBookmark(`?p2=${forty}`).names).toEqual({ "2": forty });
		expect(parseBookmark(`?p2=${forty}x`).names).toEqual({});
	});

	it("ignores unknown keys, seats outside 1 to 6 and invalid rule values", () => {
		expect(
			parseBookmark(
				"?P1=zsdh&p7=x&p0=y&host=7&rules=poker&jokers=7&assist=yes&room=1",
			),
		).toEqual({ names: {}, table: {} });
	});

	it("keeps the first value of a repeated key", () => {
		expect(parseBookmark("?p1=first&p1=second").names).toEqual({
			"1": "first",
		});
	});

	it("reads an empty query as no prefill", () => {
		expect(parseBookmark("")).toEqual({ names: {}, table: {} });
	});
});

describe("bookmarkQuery", () => {
	it("updates the bot-seat snapshot without changing other room settings", () => {
		const query = botSeatsQuery(
			"?p1=ann&p2=ben&p3=cy&host=1&rules=gamerules&bot_seats=2&selected_player=1",
			["3", "2"],
		);
		const params = new URLSearchParams(query);
		expect(params.get("bot_seats")).toBe("2,3");
		expect(params.get("rules")).toBe("gamerules");
		expect(params.get("selected_player")).toBe("1");
		expect(params.get("p1")).toBe("ann");
	});

	it("writes the names, the host seat and the table rules", () => {
		expect(bookmarkQuery(TWO, "2")).toBe(
			"p1=ann&p2=ben&host=2&rules=gamerules&jokers=4&assist=1",
		);
	});

	it("round-trips two and six players through parseRoomSetup", () => {
		expect(parseRoomSetup(`?${bookmarkQuery(TWO, "1")}`)).toEqual({
			config: TWO,
			host: "1",
		});
		const query = bookmarkQuery(SIX, "4");
		expect(query).toContain("bot_seats=3%2C6");
		expect(query).not.toMatch(/api.?key|secret|model/i);
		expect(parseRoomSetup(`?${query}`)).toEqual({ config: SIX, host: "4" });
	});
});

describe("parseRoomSetup", () => {
	const VALID = "p1=ann&p2=ben&p3=cy&host=1&rules=gamerules&jokers=4&assist=1";

	it("accepts a complete link", () => {
		expect(parseRoomSetup(`?${VALID}`)?.config.names).toEqual({
			"1": "ann",
			"2": "ben",
			"3": "cy",
		});
	});

	it.each([
		["one player", "p1=ann&host=1&rules=gamerules&jokers=4&assist=1"],
		[
			"a gap in the seats",
			"p1=ann&p3=cy&host=1&rules=gamerules&jokers=4&assist=1",
		],
		["a host outside the table", VALID.replace("host=1", "host=4")],
		["an unknown preset", VALID.replace("rules=gamerules", "rules=poker")],
		["a missing preset", VALID.replace("&rules=gamerules", "")],
		["one joker", VALID.replace("jokers=4", "jokers=1")],
		["seven jokers", VALID.replace("jokers=4", "jokers=7")],
		[
			"a joker count that is not a number",
			VALID.replace("jokers=4", "jokers=4x"),
		],
		[
			"an assist value other than 0 or 1",
			VALID.replace("assist=1", "assist=yes"),
		],
		["a bot seat outside the table", `${VALID}&bot_seats=4`],
		["a repeated bot seat", `${VALID}&bot_seats=2,2`],
		["a repeated rule value", `${VALID}&jokers=5`],
	])("refuses a link with %s", (_case, query) => {
		expect(parseRoomSetup(`?${query}`)).toBeUndefined();
	});
});
