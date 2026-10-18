import { describe, expect, it } from "vitest";
import { EMPTY_POSITION, type Position } from "../../src/p2p/authority";
import { MAX_PAGE_BYTES, MAX_PAGE_ENTRIES } from "../../src/p2p/limits";
import type { TableRecord } from "../../src/p2p/records";
import {
	answerSync,
	type SyncProgress,
	type SyncReply,
	SyncRequest,
	type SyncSource,
} from "../../src/p2p/sync";
import {
	type Entry,
	frame,
	jsonBytes,
	type LogMessage,
	type Page,
	type Snapshot,
} from "../../src/p2p/wire";
import { overTheWire } from "./fake-mesh";
import { AUTH_1, AUTH_2, entries, TABLE, tableRecord } from "./p2p-fixtures";

const PEER = "responder00000000000";

function source(log: Entry[], table: Partial<TableRecord> = {}): SyncSource {
	const end = log.at(-1);
	return {
		tableId: TABLE,
		auth: end?.auth ?? null,
		table: tableRecord({
			rev: log.length,
			lastAuth: end?.auth ?? AUTH_1,
			...table,
		}),
		entries: log,
		now: 61_000,
	};
}

/** Entries whose events are `bytes` characters long. */
function bigEntries(
	from: number,
	to: number,
	bytes: number,
	prevAuth = from === 1 ? null : AUTH_1,
): Entry[] {
	return entries(from, to, AUTH_1, prevAuth).map((entry) => ({
		...entry,
		event: { type: "chat", text: "x".repeat(bytes) },
	}));
}

function logMessages(reply: SyncReply): readonly LogMessage[] {
	if (reply.kind !== "log") throw new Error(`the reply is ${reply.kind}`);
	return reply.messages;
}

function pages(reply: SyncReply): Page[] {
	return logMessages(reply).filter(
		(message): message is Page => message.k === "page",
	);
}

/** Feeds the reply, as received over the wire, to a request; returns the last progress. */
function collect(request: SyncRequest, reply: SyncReply): SyncProgress {
	const messages =
		reply.kind === "behind" ? [reply.message] : [...reply.messages];
	let progress: SyncProgress = "pending";
	for (const message of messages) {
		const received =
			message.k === "behind"
				? overTheWire(TABLE, "ctl", message)
				: overTheWire(TABLE, "log", message);
		if (
			received.k !== "behind" &&
			received.k !== "page" &&
			received.k !== "snap"
		)
			throw new Error(`unexpected ${received.k}`);
		progress = request.receive(PEER, received);
	}
	return progress;
}

function sync(responder: SyncSource, pos: Position): SyncProgress {
	const request = new SyncRequest(7, PEER, pos);
	return collect(request, answerSync(responder, request.message));
}

describe("answerSync", () => {
	it("answers behind with the empty position when it has no table", () => {
		const reply = answerSync(
			{ tableId: TABLE, auth: null, table: null, entries: [], now: 0 },
			{ k: "sync", req: 1, pos: EMPTY_POSITION },
		);
		expect(reply).toEqual({
			kind: "behind",
			message: { k: "behind", req: 1, pos: EMPTY_POSITION },
		});
	});

	it("extends a contained position with the entries after it and the state", () => {
		const responder = source(entries(1, 5, AUTH_1, null), {
			state: { phase: "play" },
		});
		const outcome = sync(responder, { rev: 3, lastAuth: AUTH_1 });
		expect(outcome).toEqual({
			kind: "extend",
			base: { rev: 3, lastAuth: AUTH_1 },
			entries: entries(4, 5, AUTH_1, AUTH_1),
			state: { phase: "play" },
			auth: AUTH_1,
		});
	});

	it("extends an equal position with no entries", () => {
		const outcome = sync(source(entries(1, 3, AUTH_1, null)), {
			rev: 3,
			lastAuth: AUTH_1,
		});
		expect(outcome).toMatchObject({ kind: "extend", entries: [] });
	});

	it("sends a snapshot and the whole log to an empty requester", () => {
		const log = entries(1, 4, AUTH_1, null);
		const reply = answerSync(source(log), {
			k: "sync",
			req: 2,
			pos: EMPTY_POSITION,
		});
		const [snap] = logMessages(reply);
		expect(snap).toMatchObject({
			k: "snap",
			mode: "replace",
			pos: { rev: 4, lastAuth: AUTH_1 },
			idleMs: 60_000,
		});
		expect(sync(source(log), EMPTY_POSITION)).toMatchObject({
			kind: "replace",
			entries: log,
		});
	});

	it("answers behind to a longer log and never truncates it", () => {
		const responder = source(entries(1, 3, AUTH_1, null));
		expect(sync(responder, { rev: 5, lastAuth: AUTH_1 })).toEqual({
			kind: "behind",
			pos: { rev: 3, lastAuth: AUTH_1 },
		});
	});

	it("replaces a longer old-host tail after a newer host takes authority", () => {
		const log = entries(1, 3, AUTH_1, null);
		const responder: SyncSource = {
			...source(log, { host: AUTH_2 }),
			auth: AUTH_2,
		};
		const outcome = sync(responder, { rev: 4, lastAuth: AUTH_1 });
		expect(outcome).toMatchObject({ kind: "replace", entries: log });
	});

	it("answers behind when the logs diverge and its own copy is not better", () => {
		// The requester has entries 3..4 of term 2; the responder has a longer log of term 1 only.
		const responder = source(entries(1, 6, AUTH_1, null));
		expect(sync(responder, { rev: 4, lastAuth: AUTH_2 })).toEqual({
			kind: "behind",
			pos: { rev: 6, lastAuth: AUTH_1 },
		});
	});

	it("replaces a diverged log when its own copy is better", () => {
		const log = [
			...entries(1, 2, AUTH_1, null),
			...entries(3, 4, AUTH_2, AUTH_1),
		];
		const outcome = sync(source(log), { rev: 6, lastAuth: AUTH_1 });
		expect(outcome).toMatchObject({ kind: "replace", entries: log });
		if (typeof outcome !== "object" || outcome.kind !== "replace") return;
		expect(outcome.snap.pos).toEqual({ rev: 4, lastAuth: AUTH_2 });
	});

	it("splits a long log into pages of at most MAX_PAGE_ENTRIES that pass the validator", () => {
		const count = 2 * MAX_PAGE_ENTRIES + 50;
		const log = entries(1, count, AUTH_1, null);
		const reply = answerSync(source(log), {
			k: "sync",
			req: 3,
			pos: { rev: 1, lastAuth: AUTH_1 },
		});
		const sizes = pages(reply).map((page) => page.entries.length);
		expect(sizes).toEqual([MAX_PAGE_ENTRIES, MAX_PAGE_ENTRIES, 49]);
		expect(pages(reply).map((page) => page.last)).toEqual([false, false, true]);
		for (const message of logMessages(reply)) {
			expect(overTheWire(TABLE, "log", message)).toEqual(message);
		}
		expect(sync(source(log), { rev: 1, lastAuth: AUTH_1 })).toMatchObject({
			kind: "extend",
			entries: log.slice(1),
		});
	});

	it("keeps every page under MAX_PAGE_BYTES when the entries are large", () => {
		const log = bigEntries(1, 40, 15_000);
		const reply = answerSync(source(log), {
			k: "sync",
			req: 4,
			pos: EMPTY_POSITION,
		});
		const list = pages(reply);
		expect(list.length).toBeGreaterThan(3);
		for (const page of list) {
			expect(jsonBytes(frame(TABLE, page))).toBeLessThanOrEqual(MAX_PAGE_BYTES);
			expect(overTheWire(TABLE, "log", page)).toEqual(page);
		}
		expect(list.flatMap((page) => page.entries)).toEqual(log);
	});

	it("puts a large state on an extra last page when it does not fit beside the last entries", () => {
		const log = bigEntries(1, 7, 15_000);
		const state = { blob: "y".repeat(120_000) };
		const reply = answerSync(source(log, { state }), {
			k: "sync",
			req: 5,
			pos: EMPTY_POSITION,
		});
		const list = pages(reply);
		expect(list.map((page) => [page.entries.length, page.last])).toEqual([
			[7, false],
			[0, true],
		]);
		expect(list[1]?.state).toEqual(state);
		expect(list[1]?.base).toEqual({ rev: 7, lastAuth: AUTH_1 });
		for (const page of list) {
			expect(overTheWire(TABLE, "log", page)).toEqual(page);
		}
	});
});

describe("SyncRequest", () => {
	const responder = source(entries(1, 4, AUTH_1, null));

	function replaceMessages(): [Snapshot, ...Page[]] {
		const [snap, ...rest] = logMessages(
			answerSync(responder, { k: "sync", req: 9, pos: EMPTY_POSITION }),
		);
		if (snap?.k !== "snap") throw new Error("expected a snapshot");
		return [snap, ...(rest as Page[])];
	}

	it("ignores messages of another peer or another request", () => {
		const request = new SyncRequest(9, PEER, EMPTY_POSITION);
		const [snap] = replaceMessages();
		expect(request.receive("other000000000000000", snap)).toBe("ignored");
		expect(request.receive(PEER, { ...snap, req: 8 })).toBe("ignored");
		expect(request.receive(PEER, snap)).toBe("pending");
	});

	it("fails on a page that does not continue the previous one, and stays failed", () => {
		const request = new SyncRequest(9, PEER, { rev: 1, lastAuth: AUTH_1 });
		const page: Page = {
			k: "page",
			req: 9,
			auth: AUTH_1,
			base: { rev: 2, lastAuth: AUTH_1 },
			entries: entries(3, 4, AUTH_1, AUTH_1),
			last: true,
			state: {},
		};
		expect(request.receive(PEER, page)).toBe("failed");
		expect(
			request.receive(PEER, { ...page, base: { rev: 1, lastAuth: AUTH_1 } }),
		).toBe("failed");
	});

	it("fails on behind or a snapshot after the reply has started", () => {
		const [snap, ...rest] = replaceMessages();
		const first = new SyncRequest(9, PEER, EMPTY_POSITION);
		first.receive(PEER, snap);
		expect(
			first.receive(PEER, { k: "behind", req: 9, pos: EMPTY_POSITION }),
		).toBe("failed");
		const second = new SyncRequest(9, PEER, EMPTY_POSITION);
		second.receive(PEER, snap);
		expect(second.receive(PEER, snap)).toBe("failed");
		expect(rest).toHaveLength(1);
	});

	it("fails a replacement whose pages do not end at the snapshot's position", () => {
		const [snap, page] = replaceMessages();
		if (!page) throw new Error("expected a page");
		const request = new SyncRequest(9, PEER, EMPTY_POSITION);
		request.receive(PEER, { ...snap, pos: { rev: 5, lastAuth: AUTH_1 } });
		expect(request.receive(PEER, page)).toBe("failed");
	});
});
