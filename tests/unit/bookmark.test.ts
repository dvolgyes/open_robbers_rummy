import { describe, expect, it } from "vitest";
import {
	bookmarkQuery,
	botSeatsQuery,
	parseBookmark,
	parseRoomSetup,
} from "../../src/bookmark";

describe("parseBookmark", () => {
	it("reads the four names and the host seat by direction", () => {
		expect(
			parseBookmark("?north=ann&east=zsdh&south=bo&west=dvolgyes&host=west"),
		).toEqual({
			names: { N: "ann", E: "zsdh", S: "bo", W: "dvolgyes" },
			host: "W",
		});
	});

	it("trims names and drops empty ones", () => {
		expect(parseBookmark("?east=%20%20zsdh%20&west=%20")).toEqual({
			names: { E: "zsdh" },
		});
	});

	it("drops a name longer than 40 characters, counting characters not bytes", () => {
		const forty = "é".repeat(40);
		expect(parseBookmark(`?east=${forty}`).names).toEqual({ E: forty });
		expect(parseBookmark(`?east=${forty}x`).names).toEqual({});
	});

	it("ignores unknown keys, seat letters and other values", () => {
		expect(
			parseBookmark("?E=zsdh&hostseat=east&host=up&SOUTH=bo&room=1"),
		).toEqual({ names: {} });
	});

	it("keeps the first value of a repeated key", () => {
		expect(parseBookmark("?east=first&east=second").names).toEqual({
			E: "first",
		});
	});

	it("reads an empty query as no prefill", () => {
		expect(parseBookmark("")).toEqual({ names: {} });
	});
});

describe("bookmarkQuery", () => {
	it("updates the bot-seat snapshot without changing other room settings", () => {
		const query = botSeatsQuery(
			"?north=North&east=East&host=west&bot_seats=N&bot_model=custom/model&selected_player=W",
			["W", "E"],
		);
		const params = new URLSearchParams(query);
		expect(params.get("bot_seats")).toBe("E,W");
		expect(params.get("bot_model")).toBe("custom/model");
		expect(params.get("selected_player")).toBe("W");
		expect(params.get("north")).toBe("North");
	});

	it("writes the names by direction and the host seat", () => {
		const query = bookmarkQuery(
			{ N: "player1", E: "zsdh", S: "player2", W: "dvolgyes" },
			"E",
		);
		expect(query).toBe(
			"north=player1&east=zsdh&south=player2&west=dvolgyes&host=east",
		);
	});

	it("encodes initial bot seats and model/retry settings without an API key", () => {
		const query = bookmarkQuery(
			{ N: "player1", E: "player3", S: "player2", W: "player4" },
			"W",
			{
				seats: ["W"],
				model: "inception/mercury-3",
				fallbackModel: "openai/gpt-6-luna",
				retries: 5,
				retryDelayMs: 5000,
			},
		);
		expect(query).toContain("bot_seats=W");
		expect(query).toContain("bot_model=inception%2Fmercury-3");
		expect(query).toContain("bot_fallback=openai%2Fgpt-6-luna");
		expect(query).toContain("bot_retries=5");
		expect(query).toContain("bot_delay_ms=5000");
		expect(query).not.toMatch(/api.?key|secret/i);
		expect(parseRoomSetup(`?${query}`)?.config.botSetup).toEqual({
			seats: ["W"],
			model: "inception/mercury-3",
			fallbackModel: "openai/gpt-6-luna",
			retries: 5,
			retryDelayMs: 5000,
		});
	});

	it("round-trips through parseBookmark, including characters that need escaping", () => {
		const names = { N: "a&b=c", E: "x y", S: "é+ü", W: "#1" };
		expect(parseBookmark(`?${bookmarkQuery(names, "S")}`)).toEqual({
			names,
			host: "S",
		});
	});
});
