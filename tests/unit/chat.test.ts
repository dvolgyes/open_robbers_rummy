import { describe, expect, it } from "vitest";
import {
	chatModule,
	chatPayload,
	checkMessageText,
	parseChatEvent,
} from "../../src/game/chat";
import { envelopeEvent } from "../../src/protocol";
import { CONFIG, OTHER_TABLE_ID, TABLE_ID } from "./fixtures";

const CONTEXT = {
	tableId: TABLE_ID,
	config: CONFIG,
	seat: "3" as const,
	holder: "holder-3",
	commandId: "cmd-1",
	seq: 1,
	present: [],
};

function initial() {
	return chatModule.initialState(TABLE_ID, CONFIG);
}

describe("checkMessageText", () => {
	it("trims surrounding white space", () => {
		expect(checkMessageText("  hello \n")).toEqual({ ok: true, text: "hello" });
	});

	it.each([
		["a non-string", 5, "message is not text"],
		["an empty message", "", "message is empty"],
		["white space only", " \t\n", "message is empty"],
		[
			"501 characters",
			"a".repeat(501),
			"message is longer than 500 characters",
		],
		["a NUL character", "a\u0000b", "message contains control characters"],
		["an escape character", "a\u001bb", "message contains control characters"],
		["a C1 control", "a\u0085b", "message contains control characters"],
	])("rejects %s", (_label, text, reason) => {
		expect(checkMessageText(text)).toEqual({ ok: false, reason });
	});

	it("counts characters, not UTF-16 code units", () => {
		expect(checkMessageText("😀".repeat(500)).ok).toBe(true);
		expect(checkMessageText("😀".repeat(501)).ok).toBe(false);
	});

	it("allows tabs and line breaks inside a message", () => {
		expect(checkMessageText("a\tb\r\nc").ok).toBe(true);
	});
});

describe("chatModule.apply", () => {
	it("accepts a message, names the sender from the table config and counts it", () => {
		const result = chatModule.apply(
			initial(),
			CONTEXT,
			chatPayload(TABLE_ID, " hi "),
		);
		expect(result).toEqual({
			ok: true,
			event: { fromName: "player2", text: "hi" },
			state: { ...initial(), messages: 1 },
		});
	});

	it.each([
		["a non-object payload", "hi", "command is not an object"],
		[
			"another protocol version",
			{ ...chatPayload(TABLE_ID, "hi"), v: 2 },
			"unsupported protocol version",
		],
		[
			"another table",
			chatPayload(OTHER_TABLE_ID, "hi"),
			"command is for another table",
		],
		[
			"an unknown type",
			{ ...chatPayload(TABLE_ID, "hi"), type: "meld" },
			"unknown command type",
		],
		["an empty text", chatPayload(TABLE_ID, ""), "message is empty"],
	])("rejects %s", (_label, payload, reason) => {
		expect(chatModule.apply(initial(), CONTEXT, payload)).toEqual({
			ok: false,
			reason,
		});
	});

	it("refuses to continue from a state of another table or game", () => {
		const foreign = chatModule.initialState(OTHER_TABLE_ID, CONFIG);
		expect(
			chatModule.apply(foreign, CONTEXT, chatPayload(TABLE_ID, "hi")).ok,
		).toBe(false);
		expect(
			chatModule.apply(
				{ ...initial(), game: "poker" },
				CONTEXT,
				chatPayload(TABLE_ID, "hi"),
			).ok,
		).toBe(false);
	});
});

describe("parseChatEvent", () => {
	it("reads an enveloped event and refuses an incomplete one", () => {
		const event = envelopeEvent(
			{ tableId: TABLE_ID, seq: 2, commandId: "cmd-2", fromSeat: "3" },
			{ fromName: "player2", text: "hi" },
		);
		expect(parseChatEvent(event)).toEqual({
			seq: 2,
			commandId: "cmd-2",
			fromSeat: "3",
			fromName: "player2",
			text: "hi",
		});
		expect(parseChatEvent({ ...event, text: undefined })).toBeUndefined();
	});
});
