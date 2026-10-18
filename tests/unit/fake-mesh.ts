import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { Clock, Send } from "../../src/p2p/ports";
import type { OutboxRecord, Replica, Tombstone } from "../../src/p2p/records";
import {
	type Commit,
	MemoryStorage,
	type PartitionInfo,
	type StorageResult,
	type TableStorage,
} from "../../src/p2p/storage";
import {
	type CtlMessage,
	frame,
	type LogMessage,
	parseCtl,
	parseLog,
} from "../../src/p2p/wire";
import type { Seat } from "../../src/protocol";

/**
 * Test kit for the replication modules (plan §8, P5): a virtual clock, a mesh that delivers messages after
 * deterministic delays, a recorder for one component's output, and a storage whose writes fail on demand. Every
 * message goes through `frame`, JSON and the wire validators, as it does between browsers.
 */

/** The wall clock at virtual time 0. */
export const WALL0 = 1_700_000_000_000;

export class VirtualClock implements Clock {
	now = 0;

	monotonic(): number {
		return this.now;
	}

	wall(): number {
		return WALL0 + this.now;
	}
}

/** A Trystero-like peer id that passes the wire validator: the name, padded to 20 characters. */
export function peerId(name: string): string {
	if (!/^[0-9A-Za-z]{1,20}$/.test(name))
		throw new Error(`bad peer name ${name}`);
	return name.padEnd(20, "0");
}

/**
 * `crypto.subtle.digest` resolves after a varying number of event-loop turns. This replaces it with the same
 * SHA-256 computed at once, so that `settle` sees every step. Returns the restore function.
 */
export function syncDigest(): () => void {
	const spy = vi
		.spyOn(crypto.subtle, "digest")
		.mockImplementation(async (algorithm, data) => {
			if (algorithm !== "SHA-256")
				throw new Error("the test digest is SHA-256");
			const bytes = ArrayBuffer.isView(data)
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
				: new Uint8Array(data);
			return Uint8Array.from(createHash("sha256").update(bytes).digest())
				.buffer;
		});
	return () => spy.mockRestore();
}

/** Runs every queued microtask. With `syncDigest` and memory storage, the replication modules use no others. */
export function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export type Channel = "ctl" | "log";

/** A message as the receiver sees it: framed, serialized, parsed. A message that fails the validator throws. */
export function overTheWire(
	tableId: string,
	channel: "ctl",
	message: CtlMessage,
): CtlMessage;
export function overTheWire(
	tableId: string,
	channel: "log",
	message: LogMessage,
): LogMessage;
export function overTheWire(
	tableId: string,
	channel: Channel,
	message: CtlMessage | LogMessage,
): CtlMessage | LogMessage;
export function overTheWire(
	tableId: string,
	channel: Channel,
	message: CtlMessage | LogMessage,
): CtlMessage | LogMessage {
	const text = JSON.parse(JSON.stringify(frame(tableId, message)));
	const parsed =
		channel === "ctl" ? parseCtl(text, tableId) : parseLog(text, tableId);
	if (!parsed.ok) {
		throw new Error(
			`${message.k} on ${channel} is ${parsed.reason}: ${JSON.stringify(message)}`,
		);
	}
	return parsed.message;
}

export interface Sent<M = CtlMessage | LogMessage> {
	readonly to: string | null;
	readonly channel: Channel;
	readonly message: M;
}

/** The Send of one component under test: keeps each message as the receiver would parse it. */
export class Recorder implements Send {
	readonly tableId: string;
	sent: Sent[] = [];

	constructor(tableId: string) {
		this.tableId = tableId;
	}

	ctl(to: string | null, message: CtlMessage): void {
		this.sent.push({
			to,
			channel: "ctl",
			message: overTheWire(this.tableId, "ctl", message),
		});
	}

	log(to: string | null, message: LogMessage): void {
		this.sent.push({
			to,
			channel: "log",
			message: overTheWire(this.tableId, "log", message),
		});
	}

	/** The messages so far; clears the record. */
	take(): Sent[] {
		const sent = this.sent;
		this.sent = [];
		return sent;
	}

	/** Messages of kind `k` so far, without clearing. */
	of<K extends (CtlMessage | LogMessage)["k"]>(
		k: K,
	): Sent<Extract<CtlMessage | LogMessage, { k: K }>>[] {
		return this.sent.filter(
			(item): item is Sent<Extract<CtlMessage | LogMessage, { k: K }>> =>
				item.message.k === k,
		);
	}
}

/** What the mesh calls on a page. */
export interface Endpoint {
	receiveCtl(peer: string, message: CtlMessage): void;
	receiveLog(peer: string, message: LogMessage): void;
	join(peer: string): void;
	leave(peer: string): void;
}

interface Task {
	readonly at: number;
	readonly order: number;
	readonly owner: string | null;
	readonly run: () => void;
}

function linkKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Pages connected by links, in virtual time. A message arrives after `delay` milliseconds, if the link still
 * exists then; tasks with the same time run in the order they were scheduled. Removing a page is a crash: its
 * links close, its messages in flight are lost, and its timers stop.
 */
export class FakeMesh {
	readonly clock = new VirtualClock();
	readonly tableId: string;
	/** Delivery delay of one message; constant by default, so each link delivers in order. */
	delay: (
		from: string,
		to: string,
		message: CtlMessage | LogMessage,
	) => number = () => 10;
	/** Sees every message as it is sent. */
	tap:
		| ((
				from: string,
				to: string | null,
				message: CtlMessage | LogMessage,
		  ) => void)
		| null = null;
	/** Messages lost because the link or a page went away. */
	dropped = 0;
	readonly #nodes = new Map<string, Endpoint>();
	readonly #links = new Set<string>();
	#tasks: Task[] = [];
	#order = 0;

	constructor(tableId: string) {
		this.tableId = tableId;
	}

	add(peer: string, endpoint: Endpoint): void {
		if (this.#nodes.has(peer)) throw new Error(`${peer} is already here`);
		this.#nodes.set(peer, endpoint);
	}

	/** The page's Send; null means every linked page. */
	send(from: string): Send {
		return {
			ctl: (to, message) => this.#post(from, to, "ctl", message),
			log: (to, message) => this.#post(from, to, "log", message),
		};
	}

	connect(a: string, b: string): void {
		const key = linkKey(a, b);
		if (a === b || this.#links.has(key)) return;
		const left = this.#nodes.get(a);
		const right = this.#nodes.get(b);
		if (!left || !right) throw new Error("both pages must be in the mesh");
		this.#links.add(key);
		left.join(b);
		right.join(a);
	}

	disconnect(a: string, b: string): void {
		if (!this.#links.delete(linkKey(a, b))) return;
		this.#nodes.get(a)?.leave(b);
		this.#nodes.get(b)?.leave(a);
	}

	/** Links every page with every other. */
	connectAll(): void {
		const peers = [...this.#nodes.keys()];
		for (const a of peers) for (const b of peers) if (a < b) this.connect(a, b);
	}

	/** A crash: the page leaves without a word. */
	remove(peer: string): void {
		for (const other of this.peersOf(peer)) this.disconnect(peer, other);
		this.#nodes.delete(peer);
		this.#tasks = this.#tasks.filter((task) => task.owner !== peer);
	}

	has(peer: string): boolean {
		return this.#nodes.has(peer);
	}

	linked(a: string, b: string): boolean {
		return this.#links.has(linkKey(a, b));
	}

	peersOf(peer: string): string[] {
		return [...this.#nodes.keys()].filter(
			(other) => other !== peer && this.linked(peer, other),
		);
	}

	/** Runs `run` after `ms`; a task owned by a page stops with the page. */
	after(ms: number, run: () => void, owner: string | null = null): void {
		this.#tasks.push({
			at: this.clock.now + ms,
			order: this.#order++,
			owner,
			run,
		});
	}

	/** Runs `run` every `ms` while the page is in the mesh. */
	every(owner: string, ms: number, run: () => void): void {
		const repeat = (): void => {
			run();
			this.after(ms, repeat, owner);
		};
		this.after(ms, repeat, owner);
	}

	/** Moves virtual time forward by `ms`, running due tasks in order and settling after each. */
	async advance(ms: number): Promise<void> {
		const end = this.clock.now + ms;
		await settle();
		for (;;) {
			const task = this.#next(end);
			if (!task) break;
			this.clock.now = task.at;
			task.run();
			await settle();
		}
		this.clock.now = end;
	}

	/** Advances in steps of `step` until `done` holds; throws after `limit` milliseconds. */
	async until(done: () => boolean, limit: number, step = 50): Promise<void> {
		const end = this.clock.now + limit;
		await settle();
		while (!done()) {
			if (this.clock.now >= end) {
				throw new Error(`still waiting after ${limit} ms of virtual time`);
			}
			await this.advance(step);
		}
	}

	#next(end: number): Task | undefined {
		let best: Task | undefined;
		for (const task of this.#tasks) {
			if (task.at > end) continue;
			if (
				!best ||
				task.at < best.at ||
				(task.at === best.at && task.order < best.order)
			)
				best = task;
		}
		if (best) this.#tasks = this.#tasks.filter((task) => task !== best);
		return best;
	}

	#post(
		from: string,
		to: string | null,
		channel: Channel,
		message: CtlMessage | LogMessage,
	): void {
		const copy = overTheWire(this.tableId, channel, message);
		this.tap?.(from, to, copy);
		if (!this.#nodes.has(from)) {
			this.dropped++;
			return;
		}
		const targets = to === null ? this.peersOf(from) : [to];
		for (const target of targets) {
			if (!this.linked(from, target)) {
				this.dropped++;
				continue;
			}
			this.after(this.delay(from, target, copy), () => {
				const node = this.#nodes.get(target);
				if (!node || !this.linked(from, target)) {
					this.dropped++;
					return;
				}
				if (channel === "ctl") node.receiveCtl(from, copy as CtlMessage);
				else node.receiveLog(from, copy as LogMessage);
			});
		}
	}
}

const WRITE_FAILED: StorageResult<never> = {
	ok: false,
	code: "storage",
	detail: "the test made this write fail",
};

/**
 * Memory storage that survives a page crash (keep the object, open a new page on it) and counts as
 * persistent by default, so its pages are eligible to host. Writes fail while `fail` is set.
 */
export class TestStorage implements TableStorage {
	readonly persistent: boolean;
	readonly #inner = new MemoryStorage();
	/** While true, every commit and outbox write fails with `storage`, as a full quota does. */
	fail = false;
	/** Successful commits. */
	commits = 0;

	constructor(persistent = true) {
		this.persistent = persistent;
	}

	load(tableId: string, replica: Seat): Promise<StorageResult<Replica | null>> {
		return this.#inner.load(tableId, replica);
	}

	async commit(change: Commit): Promise<StorageResult<void>> {
		if (this.fail) return WRITE_FAILED;
		const done = await this.#inner.commit(change);
		if (done.ok) this.commits++;
		return done;
	}

	putOutbox(record: OutboxRecord): Promise<StorageResult<void>> {
		if (this.fail) return Promise.resolve(WRITE_FAILED);
		return this.#inner.putOutbox(record);
	}

	deleteOutbox(
		tableId: string,
		replica: Seat,
		id: string,
	): Promise<StorageResult<void>> {
		if (this.fail) return Promise.resolve(WRITE_FAILED);
		return this.#inner.deleteOutbox(tableId, replica, id);
	}

	partitions(): Promise<StorageResult<PartitionInfo[]>> {
		return this.#inner.partitions();
	}

	expireTable(tableId: string, now: number): Promise<StorageResult<void>> {
		return this.#inner.expireTable(tableId, now);
	}

	tombstone(tableId: string): Promise<StorageResult<Tombstone | null>> {
		return this.#inner.tombstone(tableId);
	}

	reviveTable(tableId: string): Promise<StorageResult<void>> {
		if (this.fail) return Promise.resolve(WRITE_FAILED);
		return this.#inner.reviveTable(tableId);
	}

	pruneTombstones(before: number): Promise<StorageResult<number>> {
		return this.#inner.pruneTombstones(before);
	}
}
