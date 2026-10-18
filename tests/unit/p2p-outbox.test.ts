import { describe, expect, it } from "vitest";
import { backoffMs } from "../../src/backoff";
import type { Target } from "../../src/p2p/follower";
import {
	MAX_OUTBOX,
	RESULT_TIMEOUT_MS,
	WAITING_RETRY_MS,
} from "../../src/p2p/limits";
import { appendCommit, LocalLog, openLog } from "../../src/p2p/log";
import { Outbox, type OutboxEvent } from "../../src/p2p/outbox";
import type { OutboxRecord } from "../../src/p2p/records";
import type { CommandResult, Entry } from "../../src/p2p/wire";
import {
	peerId,
	Recorder,
	settle,
	TestStorage,
	VirtualClock,
} from "./fake-mesh";
import {
	AUTH_1,
	commandId,
	entries,
	OTHER_TABLE,
	outboxRecord,
	TABLE,
	tableRecord,
} from "./p2p-fixtures";

const HOST = peerId("host");
const OTHER = peerId("other");
const TARGET: Target = { peer: HOST, gen: 2 };
const WAITING = "Waiting for West to come back";

class Rig {
	readonly clock = new VirtualClock();
	readonly sent = new Recorder(TABLE);
	readonly events: OutboxEvent[] = [];
	readonly storage: TestStorage;
	readonly log: LocalLog;
	readonly outbox: Outbox;

	constructor(storage: TestStorage, log: LocalLog, records: OutboxRecord[]) {
		this.storage = storage;
		this.log = log;
		this.outbox = new Outbox(
			{
				storage,
				send: this.sent,
				clock: this.clock,
				onEvent: (event) => this.events.push(event),
			},
			log,
			records,
		);
	}

	/** Partition N with entries 1..3, and these outbox records stored beside it. */
	static async open(records: OutboxRecord[] = []): Promise<Rig> {
		const storage = new TestStorage();
		const created = await storage.commit({
			table: tableRecord(),
			expect: null,
			append: entries(1, 3, AUTH_1, null),
		});
		if (!created.ok) throw new Error(created.detail);
		for (const record of records) await storage.putOutbox(record);
		const opened = await openLog(storage, TABLE, "N");
		if (!opened.ok) throw new Error(opened.detail);
		return new Rig(storage, opened.value.log, [...opened.value.outbox]);
	}

	sentIds(): string[] {
		return this.sent
			.take()
			.flatMap((item) => (item.message.k === "cmd" ? [item.message.id] : []));
	}

	result(id: string, status: CommandResult["status"], peer = HOST): void {
		const result: CommandResult =
			status === "accepted"
				? { k: "result", id, status, seq: 4 }
				: status === "rejected"
					? { k: "result", id, status, reason: "not your turn" }
					: status === "waiting"
						? { k: "result", id, status, reason: WAITING }
						: { k: "result", id, status };
		this.outbox.receive(peer, result);
	}

	tick(ms: number): void {
		this.clock.now += ms;
		this.outbox.tick();
	}

	async stored(): Promise<string[]> {
		const loaded = await this.storage.load(TABLE, "N");
		if (!loaded.ok) throw new Error(loaded.detail);
		return loaded.value?.outbox.map((record) => record.id) ?? [];
	}

	/** Commits the entry of the command `id` as seq 4, as the follower does when it arrives. */
	async logged(id: string): Promise<void> {
		const [next] = entries(4, 4, AUTH_1, AUTH_1);
		if (!next) throw new Error("no entry");
		const entry: Entry = { ...next, id };
		const written = await this.log.write((table) =>
			table ? appendCommit(table, [entry], { phase: "play" }, 5_000) : null,
		);
		if (!written.ok) throw new Error(written.detail);
		await settle();
	}
}

describe("submit", () => {
	it("stores the command before it sends it", async () => {
		const rig = await Rig.open();
		rig.outbox.connect(TARGET);
		expect(
			await rig.outbox.submit(commandId(10), { type: "chat", text: "hi" }),
		).toEqual({
			ok: true,
		});
		expect(await rig.stored()).toEqual([commandId(10)]);
		expect(rig.sent.take().map((item) => [item.to, item.message])).toEqual([
			[
				HOST,
				{
					k: "cmd",
					id: commandId(10),
					gen: 2,
					payload: { type: "chat", text: "hi" },
				},
			],
		]);
		expect(rig.outbox.items.map((item) => item.state)).toEqual(["sent"]);
	});

	it("sends nothing and keeps nothing when the store fails", async () => {
		const rig = await Rig.open();
		rig.outbox.connect(TARGET);
		rig.storage.fail = true;
		expect(
			await rig.outbox.submit(commandId(10), { type: "chat", text: "hi" }),
		).toEqual({
			ok: false,
			code: "storage",
		});
		expect(rig.sent.sent).toEqual([]);
		expect(rig.outbox.items).toEqual([]);
	});

	it(`refuses a command when ${MAX_OUTBOX} wait`, async () => {
		const rig = await Rig.open();
		for (let n = 0; n < MAX_OUTBOX; n++) {
			expect((await rig.outbox.submit(commandId(100 + n), { n })).ok).toBe(
				true,
			);
		}
		expect(await rig.outbox.submit(commandId(999), { n: 999 })).toEqual({
			ok: false,
			code: "full",
		});
		expect(rig.sent.sent).toEqual([]);
	});

	it("rejects records of another partition", async () => {
		const storage = new TestStorage();
		const log = new LocalLog(storage, TABLE, "N");
		expect(
			() => new Rig(storage, log, [outboxRecord(1, { tableId: OTHER_TABLE })]),
		).toThrow("another partition");
		expect(
			() => new Rig(storage, log, [outboxRecord(1, { replica: "E" })]),
		).toThrow("another partition");
	});
});

describe("connect", () => {
	it("sends stored commands in their order, with the target's generation, and new ones after them", async () => {
		const rig = await Rig.open([outboxRecord(2), outboxRecord(1)]);
		await rig.outbox.submit(commandId(10), { type: "chat", text: "later" });
		expect(rig.sent.sent).toEqual([]);
		rig.outbox.connect(TARGET);
		expect(rig.sentIds()).toEqual([
			outboxRecord(1).id,
			outboxRecord(2).id,
			commandId(10),
		]);
	});

	it("drops commands that the log already has before it sends", async () => {
		const rig = await Rig.open([
			outboxRecord(1, { id: commandId(3) }),
			outboxRecord(2),
		]);
		rig.outbox.connect(TARGET);
		expect(rig.sentIds()).toEqual([outboxRecord(2).id]);
		expect(rig.outbox.items.map((item) => item.id)).toEqual([
			outboxRecord(2).id,
		]);
	});

	it("sends everything again to a new host, including accepted commands", async () => {
		const rig = await Rig.open([outboxRecord(1), outboxRecord(2)]);
		rig.outbox.connect(TARGET);
		rig.sent.take();
		rig.result(outboxRecord(1).id, "accepted");
		rig.outbox.connect(null);
		rig.tick(RESULT_TIMEOUT_MS);
		expect(rig.sent.sent).toEqual([]);
		rig.outbox.connect({ peer: OTHER, gen: 3 });
		expect(
			rig.sent
				.take()
				.map((item) => [item.to, item.message.k === "cmd" && item.message.gen]),
		).toEqual([
			[OTHER, 3],
			[OTHER, 3],
		]);
	});
});

describe("results", () => {
	it("an accepted command waits for its entry; the log commit that holds it removes it", async () => {
		const rig = await Rig.open([outboxRecord(1)]);
		const { id } = outboxRecord(1);
		rig.outbox.connect(TARGET);
		expect(rig.sentIds()).toEqual([id]);
		rig.result(id, "accepted");
		expect(rig.events).toContainEqual({ type: "accepted", id, seq: 4 });
		expect(rig.outbox.items.map((item) => item.state)).toEqual(["accepted"]);
		rig.tick(RESULT_TIMEOUT_MS * 3);
		expect(rig.sentIds()).toEqual([]);
		await rig.logged(id);
		expect(rig.outbox.items).toEqual([]);
		expect(await rig.stored()).toEqual([]);
	});

	it("ignores a result from another peer, or for a command it did not send", async () => {
		const rig = await Rig.open([outboxRecord(1)]);
		const { id } = outboxRecord(1);
		rig.result(id, "accepted");
		rig.outbox.connect(TARGET);
		rig.result(id, "accepted", OTHER);
		rig.result(commandId(77), "accepted");
		expect(rig.outbox.items.map((item) => item.state)).toEqual(["sent"]);
		expect(rig.events.filter((event) => event.type === "accepted")).toEqual([]);
	});

	it.each(["busy", "storage", "not_host"] as const)(
		"sends again with backoff after %s",
		async (status) => {
			const rig = await Rig.open([outboxRecord(1)]);
			const { id } = outboxRecord(1);
			rig.outbox.connect(TARGET);
			rig.sent.take();
			rig.result(id, status);
			rig.tick(backoffMs(0) - 1);
			expect(rig.sentIds()).toEqual([]);
			rig.tick(1);
			expect(rig.sentIds()).toEqual([id]);
			rig.result(id, status);
			rig.tick(backoffMs(1) - 1);
			expect(rig.sentIds()).toEqual([]);
			rig.tick(1);
			expect(rig.sentIds()).toEqual([id]);
		},
	);

	it("keeps a waiting command with its reason and sends it every WAITING_RETRY_MS until a host accepts it", async () => {
		const rig = await Rig.open([outboxRecord(1)]);
		const { id } = outboxRecord(1);
		rig.outbox.connect(TARGET);
		rig.sent.take();
		for (let round = 0; round < 3; round++) {
			rig.result(id, "waiting");
			expect(rig.outbox.items).toEqual([
				expect.objectContaining({ id, state: "queued", waiting: WAITING }),
			]);
			rig.tick(WAITING_RETRY_MS - 1);
			expect(rig.sentIds()).toEqual([]);
			rig.tick(1);
			expect(rig.sentIds()).toEqual([id]);
		}
		rig.result(id, "accepted");
		expect(rig.outbox.items).toEqual([
			{ id, payload: outboxRecord(1).payload, order: 1, state: "accepted" },
		]);
		expect(await rig.stored()).toEqual([id]);
		expect(rig.events.filter((event) => event.type === "failed")).toEqual([]);
	});

	it.each(["rejected", "invalid", "full"] as const)(
		"ends the command after %s, deletes its record and reports it",
		async (status) => {
			const rig = await Rig.open([outboxRecord(1)]);
			const { id, payload } = outboxRecord(1);
			rig.outbox.connect(TARGET);
			expect(rig.sentIds()).toEqual([id]);
			rig.result(id, status);
			await settle();
			expect(rig.outbox.items).toEqual([]);
			expect(await rig.stored()).toEqual([]);
			expect(rig.events).toContainEqual({
				type: "failed",
				id,
				payload,
				status,
				...(status === "rejected" ? { reason: "not your turn" } : {}),
			});
			rig.tick(RESULT_TIMEOUT_MS * 3);
			expect(rig.sentIds()).toEqual([]);
		},
	);

	it.each(["superseded", "expired"] as const)(
		"stops sending after %s and keeps the command stored",
		async (status) => {
			const rig = await Rig.open([outboxRecord(1)]);
			const { id } = outboxRecord(1);
			rig.outbox.connect(TARGET);
			rig.sent.take();
			rig.result(id, status);
			expect(rig.events).toContainEqual({ type: "stopped", status });
			rig.tick(RESULT_TIMEOUT_MS * 3);
			rig.outbox.connect(TARGET);
			rig.tick(RESULT_TIMEOUT_MS * 3);
			expect(rig.sent.sent).toEqual([]);
			expect(await rig.stored()).toEqual([id]);
		},
	);

	it("sends again when the result does not come within RESULT_TIMEOUT_MS", async () => {
		const rig = await Rig.open([outboxRecord(1)]);
		const { id } = outboxRecord(1);
		rig.outbox.connect(TARGET);
		rig.sent.take();
		rig.tick(RESULT_TIMEOUT_MS - 1);
		expect(rig.sentIds()).toEqual([]);
		rig.tick(1);
		rig.tick(backoffMs(0));
		expect(rig.sentIds()).toEqual([id]);
	});
});
