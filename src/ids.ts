const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ROOM_ID_BYTES = 16;

export type RandomBytes = (length: number) => Uint8Array;

export function platformRandomBytes(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length));
}

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** 128 bits from the platform CSPRNG; the room ID is the only key to a room. */
export function newRoomId(
	randomBytes: RandomBytes = platformRandomBytes,
): string {
	const bytes = randomBytes(ROOM_ID_BYTES);
	if (bytes.length !== ROOM_ID_BYTES) {
		throw new Error(`expected ${ROOM_ID_BYTES} random bytes`);
	}
	return base64url(bytes);
}

export function isRoomId(value: unknown): value is string {
	return typeof value === "string" && ROOM_ID_PATTERN.test(value);
}

export function newCommandId(): string {
	return crypto.randomUUID();
}

const COMMAND_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `newCommandId()` output. */
export function isCommandId(value: unknown): value is string {
	return typeof value === "string" && COMMAND_ID_PATTERN.test(value);
}
