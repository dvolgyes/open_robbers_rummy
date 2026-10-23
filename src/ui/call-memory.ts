import type { CallController } from "../call/call";
import type { Medium, Switches } from "../call/policy";
import {
	type CallRecords,
	callRecordFor,
	callRecordPayload,
	callRestore,
	ownCallRecord,
	pendingCallRecords,
} from "../call/record";
import type { JsonObject, Seat } from "../protocol";

/**
 * Keeps this person's call status in the table and restores it on the next table screen.
 *
 * It stores a record only after an explicit call action of the user (Join, Leave, a switch), never because the
 * page closed, the seat was lost or the device class changed: a reload or a crash then restores the call. One
 * record at a time waits in the outbox; a later change goes when it has left, so call switches never fill the
 * outbox that game commands need.
 *
 * Once per table screen, when the page holds its seat, it restores the newest own record. It joins on its own
 * only when no capture needs a question: every device whose Send switch is on is already granted. Otherwise it
 * offers "Rejoin the call", so a page that opened without its user never asks for, or opens, a device.
 */

export interface CallMemoryDeps {
	readonly call: CallController;
	readonly tableId: string;
	readonly seat: Seat;
	/** This browser's holder; only a record of this holder is restored. */
	readonly holder: string;
	readonly granted: (medium: Medium) => Promise<boolean>;
	/** Stores an own command for sending; true when the outbox has it. */
	readonly send: (payload: JsonObject) => Promise<boolean>;
	/** The rejoin offer changed. */
	readonly changed: () => void;
}

/** What the memory reads from the table. */
export interface CallTable {
	/** Undefined while the table state is not known. */
	readonly records: CallRecords | undefined;
	/** The payloads of this page's own commands that are not in the log yet. */
	readonly outbox: readonly JsonObject[];
}

export class CallMemory {
	readonly #deps: CallMemoryDeps;
	#table: CallTable = { records: undefined, outbox: [] };
	/** An explicit action changed the call, and the change is not stored yet. */
	#dirty = false;
	/** A record is on its way into the outbox. */
	#storing = false;
	/** The restore ran, or the user acted first. */
	#decided = false;
	/** Counts the user's call actions, so a late permission answer never overrides one. */
	#actions = 0;
	#rejoin: Switches | undefined;
	#stopped = false;

	constructor(deps: CallMemoryDeps) {
		this.#deps = deps;
	}

	/** The switches that "Rejoin the call" joins with; undefined when the page does not offer it. */
	get rejoin(): Switches | undefined {
		return this.#rejoin;
	}

	/** Call after the user joined, left or changed a switch, once the call controller has the new status. */
	acted(): void {
		this.#actions += 1;
		this.#decided = true;
		this.#dirty = true;
		if (this.#rejoin !== undefined) {
			this.#rejoin = undefined;
			this.#deps.changed();
		}
		this.#store();
	}

	/** The table changed. */
	update(table: CallTable): void {
		this.#table = table;
		this.#store();
		this.#restore();
	}

	stop(): void {
		this.#stopped = true;
	}

	#store(): void {
		const { records, outbox } = this.#table;
		if (!this.#dirty || this.#storing || records === undefined) return;
		const pending = pendingCallRecords(outbox);
		if (pending.length > 0) return;
		this.#dirty = false;
		const { requested, form } = this.#deps.call.view;
		const record = callRecordFor(
			records[this.#deps.seat],
			this.#deps.holder,
			pending,
			requested,
			form,
		);
		if (record === undefined) return;
		this.#storing = true;
		// A record that could not be stored is not retried: the next action stores the status again.
		void this.#deps
			.send(callRecordPayload(this.#deps.tableId, record))
			.then(() => {
				this.#storing = false;
				if (!this.#stopped) this.#store();
			});
	}

	#restore(): void {
		const { call } = this.#deps;
		const { records, outbox } = this.#table;
		if (this.#decided || records === undefined || !call.view.canJoin) return;
		// The page holds its seat, so its replica has every entry up to its own seat claim.
		this.#decided = true;
		const own = ownCallRecord(
			records[this.#deps.seat],
			this.#deps.holder,
			pendingCallRecords(outbox),
		);
		const restore = callRestore(own, call.view.form);
		if (restore === undefined) return;
		// Sending video always returns through the local preview and confirmation, even when permission persists.
		if (restore.selection.send.video) {
			this.#rejoin = restore.selection;
			this.#deps.changed();
			return;
		}
		const actions = this.#actions;
		const asked = restore.devices.map((medium) => this.#deps.granted(medium));
		void Promise.all(asked).then((answers) => {
			if (this.#stopped || actions !== this.#actions || !call.view.canJoin)
				return;
			if (answers.every(Boolean)) {
				call.join(restore.selection);
			} else {
				this.#rejoin = restore.selection;
				this.#deps.changed();
			}
		});
	}
}
