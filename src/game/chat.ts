import {
	isNonNegativeInteger,
	isObject,
	isSeat,
	type JsonObject,
	PROTOCOL_VERSION,
	type Seat,
} from "../protocol";
import type { GameModule } from "./module";

/** Milestone 1: ordered text messages between the four seats. */

export const MAX_MESSAGE_LENGTH = 500;

// C0 controls other than tab and line breaks, DEL and C1 controls. They have no use in a message and
// JSON-escape to six bytes each, which could push a 500-character message over the 4 KB command limit.
function isControl(codePoint: number): boolean {
	if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)
		return false;
	return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

export type TextCheck =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly reason: string };

export function checkMessageText(text: unknown): TextCheck {
	if (typeof text !== "string")
		return { ok: false, reason: "message is not text" };
	const trimmed = text.trim();
	if (trimmed === "") return { ok: false, reason: "message is empty" };
	const characters = Array.from(trimmed);
	if (characters.length > MAX_MESSAGE_LENGTH) {
		return {
			ok: false,
			reason: `message is longer than ${MAX_MESSAGE_LENGTH} characters`,
		};
	}
	if (
		characters.some((character) => isControl(character.codePointAt(0) ?? 0))
	) {
		return { ok: false, reason: "message contains control characters" };
	}
	return { ok: true, text: trimmed };
}

export function chatPayload(roomId: string, text: string): JsonObject {
	return { v: PROTOCOL_VERSION, roomId, type: "chat", text };
}

/** Chat commands, as opposed to table actions and call status. */
export function isChatCommand(payload: unknown): boolean {
	return isObject(payload) && payload.type === "chat";
}

/** Chat events (`{fromName, text}`): every other event has a `kind`. */
export function isChatEvent(event: JsonObject): boolean {
	return event.kind === undefined;
}

export interface ChatEvent {
	readonly seq: number;
	readonly commandId: string;
	readonly fromSeat: Seat;
	readonly fromName: string;
	readonly text: string;
}

export function parseChatEvent(event: JsonObject): ChatEvent | undefined {
	const { type, seq, commandId, fromSeat, fromName, text } = event;
	if (type !== "event" || !isNonNegativeInteger(seq) || !isSeat(fromSeat)) {
		return undefined;
	}
	if (typeof commandId !== "string" || typeof fromName !== "string")
		return undefined;
	if (typeof text !== "string") return undefined;
	return { seq, commandId, fromSeat, fromName, text };
}

export const chatModule: GameModule = {
	initialState(roomId) {
		return { v: PROTOCOL_VERSION, roomId, game: "chat", messages: 0 };
	},

	isState(state, roomId) {
		return (
			state.v === PROTOCOL_VERSION &&
			state.roomId === roomId &&
			state.game === "chat" &&
			isNonNegativeInteger(state.messages)
		);
	},

	apply(state, context, payload) {
		if (!chatModule.isState(state, context.roomId)) {
			return { ok: false, reason: "room state is not a chat state" };
		}
		if (!isObject(payload))
			return { ok: false, reason: "command is not an object" };
		if (payload.v !== PROTOCOL_VERSION)
			return { ok: false, reason: "unsupported protocol version" };
		if (payload.roomId !== context.roomId)
			return { ok: false, reason: "command is for another room" };
		if (payload.type !== "chat")
			return { ok: false, reason: "unknown command type" };
		const check = checkMessageText(payload.text);
		if (!check.ok) return check;
		const event: JsonObject = {
			fromName: context.config.names[context.seat],
			text: check.text,
		};
		const messages = (state.messages as number) + 1;
		return { ok: true, event, state: { ...state, messages } };
	},
};
