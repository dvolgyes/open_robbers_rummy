import { describe, expect, it } from "vitest";
import {
	chatModule,
	chatPayload,
	checkMessageText,
	parseChatEvent,
} from "../../src/game/chat";
import { envelopeEvent } from "../../src/protocol";
import { CONFIG, OTHER_ROOM_ID, ROOM_ID } from "./fixtures";

const CONTEXT = {
	roomId: ROOM_ID,
	config: CONFIG,
	seat: "S" as const,
	holder: "holder-S",
	commandId: "cmd-1",
	seq: 1,
	present: [],
};

function initial() {
	return chatModule.initialState(ROOM_ID, CONFIG);
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
	it("accepts a message, names the sender from the room config and counts it", () => {
		const result = chatModule.apply(
			initial(),
			CONTEXT,
			chatPayload(ROOM_ID, " hi "),
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
			{ ...chatPayload(ROOM_ID, "hi"), v: 2 },
			"unsupported protocol version",
		],
		[
			"another room",
			chatPayload(OTHER_ROOM_ID, "hi"),
			"command is for another room",
		],
		[
			"an unknown type",
			{ ...chatPayload(ROOM_ID, "hi"), type: "bid" },
			"unknown command type",
		],
		["an empty text", chatPayload(ROOM_ID, ""), "message is empty"],
	])("rejects %s", (_label, payload, reason) => {
		expect(chatModule.apply(initial(), CONTEXT, payload)).toEqual({
			ok: false,
			reason,
		});
	});

	it("refuses to continue from a state of another room or game", () => {
		const foreign = chatModule.initialState(OTHER_ROOM_ID, CONFIG);
		expect(
			chatModule.apply(foreign, CONTEXT, chatPayload(ROOM_ID, "hi")).ok,
		).toBe(false);
		expect(
			chatModule.apply(
				{ ...initial(), game: "canasta" },
				CONTEXT,
				chatPayload(ROOM_ID, "hi"),
			).ok,
		).toBe(false);
	});
});

describe("parseChatEvent", () => {
	it("reads an enveloped event and refuses an incomplete one", () => {
		const event = envelopeEvent(
			{ roomId: ROOM_ID, seq: 2, commandId: "cmd-2", fromSeat: "S" },
			{ fromName: "player2", text: "hi" },
		);
		expect(parseChatEvent(event)).toEqual({
			seq: 2,
			commandId: "cmd-2",
			fromSeat: "S",
			fromName: "player2",
			text: "hi",
		});
		expect(parseChatEvent({ ...event, text: undefined })).toBeUndefined();
	});
});
