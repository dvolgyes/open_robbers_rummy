import { describe, expect, it } from "vitest";
import { isRoomId } from "../../src/ids";
import {
	deriveHolder,
	derivePairRoomId,
	deriveTableId,
	isClientId,
	isHolder,
	isTag,
	makeTag,
	newClientId,
	tagHolder,
	tagSeat,
} from "../../src/p2p/keys";

// Reference values from Node's `crypto.createHash("sha256")` and `Buffer.toString("base64url")`, so the
// expected text does not come from the code under test.
const KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"; // 32 bytes of 0x01
const TABLE_ID = "nA4T9YSm2T2Isf5qOeYuDn";
const CLIENT_ID = "AgICAgICAgICAgICAgICAg"; // 16 bytes of 0x02
const HOLDER = "Xjpu4Jr_HMMHDwPX";

describe("deriveTableId", () => {
	it("is the first 22 characters of the SHA-256 of the labelled key", async () => {
		const tableId = await deriveTableId(KEY);
		expect(tableId).toBe(TABLE_ID);
		expect(isRoomId(tableId)).toBe(true);
	});

	it("differs for another key", async () => {
		expect(await deriveTableId(`${KEY.slice(0, 42)}g`)).not.toBe(TABLE_ID);
	});
});

describe("derivePairRoomId", () => {
	it("is the first 22 characters of the SHA-256 of the labelled key and pair", async () => {
		expect(await derivePairRoomId(KEY, "seat|E|S")).toBe(
			"aoEEi3K_7wmAavbkfHP8Ed",
		);
	});

	it("differs from the table room and for another key", async () => {
		const pair = await derivePairRoomId(KEY, "seat|E|S");
		expect(pair).not.toBe(TABLE_ID);
		expect(await derivePairRoomId(`${KEY.slice(0, 42)}g`, "seat|E|S")).not.toBe(
			pair,
		);
	});
});

describe("deriveHolder", () => {
	it("is the first 16 characters of the SHA-256 of table and client", async () => {
		const holder = await deriveHolder(TABLE_ID, CLIENT_ID);
		expect(holder).toBe(HOLDER);
		expect(isHolder(holder)).toBe(true);
	});

	it("differs per table for the same browser", async () => {
		expect(await deriveHolder("AAAAAAAAAAAAAAAAAAAAAA", CLIENT_ID)).not.toBe(
			HOLDER,
		);
	});
});

describe("newClientId", () => {
	it("encodes 16 random bytes", () => {
		const clientId = newClientId((length) => new Uint8Array(length).fill(2));
		expect(clientId).toBe(CLIENT_ID);
		expect(isClientId(clientId)).toBe(true);
	});

	it("refuses a generator that returns the wrong number of bytes", () => {
		expect(() => newClientId(() => new Uint8Array(15))).toThrow(
			"expected 16 random bytes",
		);
	});
});

describe("host tags", () => {
	it("join holder and seat, and split again", () => {
		const tag = makeTag(HOLDER, "E");
		expect(tag).toBe(`${HOLDER}.E`);
		expect(isTag(tag)).toBe(true);
		expect(tagSeat(tag)).toBe("E");
		expect(tagHolder(tag)).toBe(HOLDER);
	});

	it.each([
		["a short holder", `${HOLDER.slice(1)}.E`],
		["no seat", HOLDER],
		["an unknown seat", `${HOLDER}.X`],
		["a number", 7],
	])("rejects %s", (_label, value) => {
		expect(isTag(value)).toBe(false);
	});

	it("refuses an invalid holder", () => {
		expect(() => makeTag("short", "N")).toThrow("invalid host tag");
		expect(() => tagSeat("short.N")).toThrow("invalid host tag");
	});
});
