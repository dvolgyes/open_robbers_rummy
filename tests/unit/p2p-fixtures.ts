import type { Authority } from "../../src/p2p/authority";
import type { OutboxRecord, TableRecord } from "../../src/p2p/records";
import type { Entry } from "../../src/p2p/wire";
import { type RoomConfig, SEATS, type Seat } from "../../src/protocol";

export const TABLE = "vKg29g0NeA3vntlnYBW0TP";
export const OTHER_TABLE = "Other-ID-0123456789abc";
export const HOLDER_N = "DFqES54ngHxkS3v5";
export const HOLDER_E = "AAAAAAAAAAAAAAAA";

/** The creator at N hosts term 1; E takes over in term 2. */
export const AUTH_1: Authority = { term: 1, tag: `${HOLDER_N}.N`, inc: 1 };
export const AUTH_2: Authority = { term: 2, tag: `${HOLDER_E}.E`, inc: 1 };

export const CONFIG: RoomConfig = {
	names: { N: "player1", E: "player3", S: "player2", W: "player4" },
};

export function commandId(n: number): string {
	return `123e4567-e89b-42d3-a456-${n.toString(16).padStart(12, "0")}`;
}

/** Command entries `from..to`, all by `auth`, after a log whose last entry has `prevAuth`. */
export function entries(
	from: number,
	to: number,
	auth: Authority,
	prevAuth: Authority | null,
): Entry[] {
	const log: Entry[] = [];
	for (let seq = from; seq <= to; seq++) {
		log.push({
			seq,
			auth,
			prevAuth: seq === from ? prevAuth : auth,
			id: commandId(seq),
			seat: "N",
			gen: 1,
			kind: "cmd",
			payload: { type: "chat", text: `message ${seq}` },
			event: { type: "chat", seq },
		});
	}
	return log;
}

/** N holds its seat, the others are free; the log has three entries by `AUTH_1`. */
export function tableRecord(overrides: Partial<TableRecord> = {}): TableRecord {
	return {
		tableId: TABLE,
		replica: "N",
		config: CONFIG,
		state: { phase: "lobby" },
		rev: 3,
		lastAuth: AUTH_1,
		host: AUTH_1,
		inc: 1,
		lastActivityAt: 1_000,
		seats: SEATS.map((seat) => ({
			seat,
			holder: seat === "N" ? HOLDER_N : null,
			gen: seat === "N" ? 1 : 0,
		})),
		...overrides,
	};
}

export function outboxRecord(
	order: number,
	overrides: Partial<OutboxRecord> = {},
): OutboxRecord {
	return {
		tableId: TABLE,
		replica: "N",
		id: commandId(1000 + order),
		order,
		payload: { type: "chat", text: `queued ${order}` },
		...overrides,
	};
}

export function partition(
	tableId: string,
	replica: Seat,
): Pick<TableRecord, "tableId" | "replica"> {
	return { tableId, replica };
}
