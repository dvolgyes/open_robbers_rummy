import { isChatCommand, isChatEvent, parseChatEvent } from "../game/chat";
import { englishTranslator as english, type Translate } from "../i18n";
import type { ElectionView, HostBlock } from "../p2p/election";
import type { MeshDiagnostics } from "../p2p/mesh";
import type { OutboxItem, SubmitResult } from "../p2p/outbox";
import type { StorageCode } from "../p2p/storage";
import type {
	ChooseResult,
	CommandFailure,
	PeerView,
	TableStatus,
} from "../p2p/table";
import type {
	Entry,
	Lobby,
	ReleaseCode,
	Roster,
	SeatCode,
	SeatHolder,
} from "../p2p/wire";
import {
	isObject,
	isSeat,
	MAX_NAME_LENGTH,
	type RoomConfig,
	SEAT_NAMES,
	SEATS,
	type Seat,
	seatLabel,
} from "../protocol";

/** Pure view model of the table screens: the DOM layer only renders what these functions return. */

export const TEXT = {
	connecting: "Connecting",
	superseded: "This tab was superseded",
	expired: "The game has expired or is no longer available",
	send: "Send",
	sendHint: "Stored; sent when a host is connected",
	becomeHost: "Make me the host",
	undone: "Undone after a host change",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Create form

export const DEFAULT_NAMES: Readonly<Record<Seat, string>> = {
	N: "player1",
	S: "player2",
	E: "player3",
	W: "player4",
};

export interface CreateFields {
	readonly names: Readonly<Record<Seat, string>>;
	/** The creator's own seat; its browser hosts first. */
	readonly seat: string;
}

export type CreateCheck =
	| { readonly ok: true; readonly config: RoomConfig; readonly seat: Seat }
	| { readonly ok: false; readonly errors: readonly string[] };

/** The room config rules, so the form explains a refusal before the table is written. */
export function checkCreateFields(
	fields: CreateFields,
	t: Translate = english,
): CreateCheck {
	const errors: string[] = [];
	const names: Partial<Record<Seat, string>> = {};
	for (const seat of SEATS) {
		const name = fields.names[seat].trim();
		const length = Array.from(name).length;
		if (length === 0)
			errors.push(t("{seat}: enter a name.", { seat: SEAT_NAMES[seat] }));
		else if (length > MAX_NAME_LENGTH)
			errors.push(
				t("{seat}: use at most {max} characters.", {
					max: MAX_NAME_LENGTH,
					seat: SEAT_NAMES[seat],
				}),
			);
		names[seat] = name;
	}
	if (!isSeat(fields.seat)) errors.push(t("Choose your seat."));
	if (errors.length > 0 || !isSeat(fields.seat)) return { ok: false, errors };
	return {
		ok: true,
		config: {
			names: names as Record<Seat, string>,
		},
		seat: fields.seat,
	};
}

export const DEFAULT_CREATE_FIELDS: CreateFields = {
	names: DEFAULT_NAMES,
	seat: "W",
};

// ---------------------------------------------------------------------------------------------------------------
// Failure texts

/** A short explanation of a storage failure, for the person in front of the screen. */
export function storageText(code: StorageCode, t: Translate = english): string {
	switch (code) {
		case "expired":
			return t(TEXT.expired);
		case "conflict":
			return t(
				"Another tab changed the table at the same time. Reload the page.",
			);
		case "storage":
			return t("This browser could not save the table.");
	}
}

/** The notice on a page that keeps the table only in memory (plan §4.3). */
export function storageNotice(problem: string, t: Translate = english): string {
	return t(
		"This browser does not store data ({problem}). You can play, but you cannot become the host, and a reload loses this copy of the table.",
		{ problem },
	);
}

/** Why a message or an action was not stored for sending. */
export function submitText(
	result: Exclude<SubmitResult, { ok: true }>,
	t: Translate = english,
): string {
	return result.code === "full"
		? t("Too many messages are waiting. Wait until the host is connected.")
		: storageText(result.code, t);
}

/** Why the host did not accept a seat claim. */
export function seatText(code: SeatCode, t: Translate = english): string {
	switch (code) {
		case "taken":
			return t("Another player took this seat. Choose another one.");
		case "invalid":
			return t("This seat cannot be taken.");
		case "expired":
			return t(TEXT.expired);
		case "storage":
			return t("The host could not save the table. Try again.");
		case "not_host":
			return t("The host changed. Try again.");
	}
}

/** Why the host did not release a seat. */
export function releaseText(code: ReleaseCode, t: Translate = english): string {
	switch (code) {
		case "online":
			return t("The player is online again.");
		case "unseated":
			return t("Only a seated player can release a seat.");
		case "invalid":
			return t("This seat cannot be released.");
		case "storage":
			return t("The host could not save the table.");
		case "not_host":
			return t("The request did not reach the host. Try again.");
	}
}

const FAILURE_TEXT: Readonly<Record<CommandFailure["status"], string>> = {
	rejected: "rejected by the host",
	invalid: "the host could not read it",
	full: "the table is full",
};

const HOST_BLOCK_TEXT: Readonly<Record<HostBlock, string>> = {
	witness: "Another player must be online to confirm",
	seat: "Only a seated player can become the host",
	ineligible: "This client cannot host the table",
	storage: "This browser cannot store the table",
	limit: "This table cannot change its host again",
};

// ---------------------------------------------------------------------------------------------------------------
// Banner

export interface HostButtonView {
	readonly label: string;
	readonly enabled: boolean;
	readonly hint?: string;
}

export type Banner =
	| { readonly kind: "expired" }
	| { readonly kind: "superseded"; readonly by: "tab" | "seat" | null }
	| { readonly kind: "incompatible" }
	| { readonly kind: "full" }
	| { readonly kind: "connection-failed" }
	| { readonly kind: "host-unreachable" }
	| { readonly kind: "becoming-host"; readonly self: boolean }
	| {
			readonly kind: "waiting-for-host";
			readonly seconds: number;
			readonly button: HostButtonView | undefined;
	  }
	| { readonly kind: "nobody-here" }
	| { readonly kind: "connecting" };

export interface BannerInput {
	readonly status: TableStatus;
	readonly supersededBy: "tab" | "seat" | null;
	readonly election: ElectionView | null;
}

/**
 * One banner at a time (plan §4.9): expired > superseded > incompatible > full > connection failed > host
 * unreachable > becoming host > waiting for host > nobody here > connecting.
 */
export function bannerFor(input: BannerInput): Banner | undefined {
	const { status, election } = input;
	if (status === "expired") return { kind: "expired" };
	if (status === "superseded" || election?.phase === "superseded")
		return { kind: "superseded", by: input.supersededBy };
	if (status === "incompatible") return { kind: "incompatible" };
	if (status === "full") return { kind: "full" };
	if (status === "connection-failed") return { kind: "connection-failed" };
	if (status === "starting" || election === null) return { kind: "connecting" };
	switch (election.phase) {
		case "host-unreachable":
			return { kind: "host-unreachable" };
		case "becoming-host":
			return { kind: "becoming-host", self: election.self };
		case "waiting-for-host": {
			const { button } = election;
			return {
				kind: "waiting-for-host",
				seconds: Math.floor(election.absentMs / 1000),
				button:
					button === null
						? undefined
						: button.enabled
							? { label: TEXT.becomeHost, enabled: true }
							: {
									label: TEXT.becomeHost,
									enabled: false,
									hint: HOST_BLOCK_TEXT[button.reason],
								},
			};
		}
		case "nobody-here":
			return { kind: "nobody-here" };
		case "connecting":
			return { kind: "connecting" };
		default:
			return undefined;
	}
}

const SUPERSEDED_BY: Readonly<Record<"tab" | "seat", string>> = {
	tab: "another tab of this browser holds this seat now",
	seat: "another device holds this seat now",
};

/** The banner's sentence; a button may follow it. */
export function bannerText(banner: Banner, t: Translate = english): string {
	switch (banner.kind) {
		case "expired":
			return t(TEXT.expired);
		case "superseded":
			return banner.by === null
				? t(TEXT.superseded)
				: `${t(TEXT.superseded)}: ${t(SUPERSEDED_BY[banner.by])}`;
		case "incompatible":
			return t(
				"The other players use another version of the app. Reload the page.",
			);
		case "full":
			return t("This table has too many open pages");
		case "connection-failed":
			return t(
				"Connection failed: the other players were found, but no direct connection works. Try another network.",
			);
		case "host-unreachable":
			return t("The host is online, but this device cannot reach it");
		case "becoming-host":
			return t(banner.self ? "Becoming host…" : "A new host is taking over…");
		case "waiting-for-host":
			return t("Waiting for the host ({seconds} s)", {
				seconds: banner.seconds,
			});
		case "nobody-here":
			return t("Nobody is at this table right now. Keep this page open");
		case "connecting":
			return t(TEXT.connecting);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Lobby

/** Why this page could not take a seat. */
export function chooseText(
	reason: Exclude<ChooseResult, { ok: true }>["reason"],
	t: Translate = english,
): string {
	switch (reason) {
		case "seated":
			return t("This page already holds a seat.");
		case "held-elsewhere":
			return t("Another tab of this browser holds this seat.");
		case "closed":
			return t("The table is closed. Reload the page.");
		case "refused":
			return t("Another tab of this browser is taking this seat. Try again.");
		default:
			return storageText(reason, t);
	}
}

export interface LobbyChoice {
	readonly seat: Seat;
	readonly label: string;
}

export type LobbyScreen =
	| { readonly kind: "expired" }
	| { readonly kind: "problem"; readonly text: string }
	| {
			readonly kind: "lobby";
			readonly status: string | undefined;
			/** The seats to take; undefined until the host's lobby arrives. */
			readonly choices: readonly LobbyChoice[] | undefined;
	  };

export interface LobbyInput extends BannerInput {
	readonly lobby: Lobby | null;
	readonly heldElsewhere: readonly Seat[];
	readonly setup?: { readonly config: RoomConfig };
	readonly t?: Translate;
}

/** The screen of a page without a seat. The lobby lists only the seats this page can take. */
export function lobbyScreen(input: LobbyInput): LobbyScreen {
	const banner = bannerFor(input);
	const t = input.t ?? english;
	switch (banner?.kind) {
		case "expired":
			return { kind: "expired" };
		case "superseded":
		case "incompatible":
		case "full":
		case "connection-failed":
			return { kind: "problem", text: bannerText(banner, t) };
	}
	const { lobby } = input;
	const elsewhere = new Set(input.heldElsewhere);
	const setupConfig = input.setup?.config;
	return {
		kind: "lobby",
		status: banner === undefined ? undefined : bannerText(banner, t),
		choices:
			lobby !== null
				? lobby.seats
						.filter((row) => row.available && !elsewhere.has(row.seat))
						.map((row) => ({
							seat: row.seat,
							label: seatLabel(lobby.config, row.seat),
						}))
				: setupConfig !== undefined
					? SEATS.filter((seat) => !elsewhere.has(seat)).map((seat) => ({
							seat,
							label: seatLabel(setupConfig, seat),
						}))
					: undefined,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Network panel

export interface NetworkInput {
	readonly network: MeshDiagnostics | null;
	readonly peers: readonly PeerView[];
	readonly publicAddress: boolean;
	readonly persistent: boolean;
	/** The browser's answer to the persistence request; undefined before it answers. */
	readonly persisted: boolean | undefined;
	readonly t?: Translate;
}

export interface NetworkLine {
	readonly label: string;
	readonly value: string;
}

/** Counts and yes-or-no facts only: never an address, a candidate or a session description. */
export function networkLines(input: NetworkInput): NetworkLine[] {
	const { network } = input;
	const t = input.t ?? english;
	const checked: string[] = [];
	for (const peer of input.peers) {
		if (peer.seat !== null && peer.check?.state === "ready")
			checked.push(
				`${SEAT_NAMES[peer.seat]} (${Math.round(peer.check.rttMs)} ms)`,
			);
	}
	return [
		{
			label: t("Trackers reachable"),
			value: network
				? `${network.trackersOpen} of ${network.trackers}`
				: t("not started"),
		},
		{ label: t("Direct connections"), value: String(input.peers.length) },
		{
			label: t("Players checked"),
			value: checked.length === 0 ? t("none") : checked.join(", "),
		},
		{
			label: t("Pages not reachable directly"),
			value: String(network?.unreachable ?? 0),
		},
		{
			label: t("Link repair rooms"),
			value: network ? repairLine(network, t) : t("none"),
		},
		{
			label: t("Rejoins with no links"),
			value: String(network?.rejoins ?? 0),
		},
		{
			label: t("Public address found"),
			value: input.publicAddress ? t("yes") : t("no"),
		},
		{
			label: t("Ignored wrong-key attempts"),
			value: String(network?.wrongKey ?? 0),
		},
		{ label: t("Storage"), value: storageLine(input, t) },
	];
}

function repairLine(network: MeshDiagnostics, t: Translate): string {
	const late =
		network.unattached > 0
			? ` (${network.unattached} ${t("after connecting")})`
			: "";
	return `${network.pairRooms} ${t("open")}, ${network.repaired} ${t("repaired")}, ${network.pairTimeouts} ${t("timed out")}${late}`;
}

function storageLine(input: NetworkInput, t: Translate): string {
	if (!input.persistent) return t("memory only: a reload loses this copy");
	if (input.persisted === true) return t("kept by the browser");
	if (input.persisted === false) return t("stored; the browser may clear it");
	return t("stored in this browser");
}

// ---------------------------------------------------------------------------------------------------------------
// Room view

export interface RosterRow {
	readonly seat: Seat;
	readonly label: string;
	readonly host: boolean;
	readonly you: boolean;
	readonly state: "online" | "offline" | "free";
	/** Another player holds this seat and is offline, so the viewer may release it (D2). */
	readonly releasable: boolean;
}

export interface TranscriptLine {
	readonly seq: number;
	readonly from: string;
	readonly text: string;
	/** Seats other than the sender that acknowledged this event. */
	readonly receivedBy: number;
	readonly of: number;
}

export type PendingState = "sending" | "pending" | "not-sent" | "undone";

export interface PendingLine {
	readonly id: string;
	readonly text: string;
	readonly state: PendingState;
	readonly reason?: string;
}

export interface SendState {
	readonly label: string;
	readonly enabled: boolean;
	readonly hint?: string;
}

export interface RoomView {
	readonly roster: readonly RosterRow[];
	readonly transcript: readonly TranscriptLine[];
	readonly pending: readonly PendingLine[];
	readonly send: SendState;
}

export interface RoomViewInput {
	readonly config: RoomConfig;
	readonly seat: Seat;
	/** The tab can no longer act (superseded, expired or stopped). */
	readonly terminal: boolean;
	/** Own commands reach a host now. */
	readonly ready: boolean;
	/** The seats that a player holds in the replica. */
	readonly held: ReadonlySet<Seat>;
	/** The host's seat and the seats whose peer is connected to the host. */
	readonly online: ReadonlySet<Seat>;
	readonly hostSeat: Seat | null;
	/** The latest revision that each seat acknowledged. */
	readonly acked: Readonly<Partial<Record<Seat, number>>>;
	/** The replicated log, oldest first. */
	readonly entries: readonly Entry[];
	readonly outbox: readonly OutboxItem[];
	readonly failures: readonly CommandFailure[];
	readonly undone: readonly Entry[];
}

/** The seats that a player holds. */
export function heldSeats(rows: readonly SeatHolder[]): ReadonlySet<Seat> {
	return new Set(
		rows.filter((row) => row.holder !== null).map((row) => row.seat),
	);
}

/**
 * The host's seat, and the seats whose peer the roster binds at the seat's current generation (plan §12 R4).
 * The host decides; this copy only explains why an action waits.
 */
export function presentSeats(
	hostSeat: Seat | null,
	roster: Roster | null,
): ReadonlySet<Seat> {
	const present = new Set<Seat>();
	if (hostSeat !== null) present.add(hostSeat);
	for (const binding of roster?.peers ?? []) {
		const row = roster?.seats.find((item) => item.seat === binding.seat);
		if (row?.gen === binding.gen) present.add(binding.seat);
	}
	for (const seat of roster?.bots ?? []) present.add(seat);
	return present;
}

export function roomView(input: RoomViewInput): RoomView {
	return {
		roster: SEATS.map((rowSeat) => rosterRow(input, rowSeat)),
		transcript: transcriptLines(input),
		pending: pendingLines(input),
		send: sendState(input),
	};
}

function rosterRow(input: RoomViewInput, seat: Seat): RosterRow {
	const held = input.held.has(seat);
	const online = input.online.has(seat);
	return {
		seat,
		label: `${SEAT_NAMES[seat]} — ${input.config.names[seat]}`,
		host: seat === input.hostSeat,
		you: seat === input.seat,
		state: online ? "online" : held ? "offline" : "free",
		releasable: !input.terminal && seat !== input.seat && held && !online,
	};
}

/** Chat messages only: deals, calls and plays show on the table, and the call status in the call panel. */
function transcriptLines(input: RoomViewInput): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const entry of input.entries) {
		if (entry.kind !== "cmd" || !isChatEvent(entry.event)) continue;
		const others = SEATS.filter((seat) => seat !== entry.seat);
		const receivedBy = others.filter(
			(seat) => (input.acked[seat] ?? 0) >= entry.seq,
		).length;
		const event = parseChatEvent(entry.event);
		lines.push({
			seq: entry.seq,
			from: `${SEAT_NAMES[entry.seat]} — ${event?.fromName ?? input.config.names[entry.seat]}`,
			text: event?.text ?? "(unreadable message)",
			receivedBy,
			of: others.length,
		});
	}
	return lines;
}

function payloadText(payload: unknown): string {
	return isObject(payload) && typeof payload.text === "string"
		? payload.text
		: "";
}

/** Shared by the room and the table: one own command that is not in the log. */
export interface OwnCommandLine<State extends string> {
	readonly id: string;
	readonly payload: unknown;
	readonly state: State;
	readonly reason?: string;
}

/**
 * This seat's commands that are not in the log: undone by a host change, refused by the host, and waiting in
 * the outbox, in that order.
 */
export function ownCommands(
	input: Pick<RoomViewInput, "outbox" | "failures" | "undone">,
): OwnCommandLine<PendingState>[] {
	const lines: OwnCommandLine<PendingState>[] = [];
	for (const entry of input.undone) {
		if (entry.kind === "cmd")
			lines.push({ id: entry.id, payload: entry.payload, state: "undone" });
	}
	for (const failure of input.failures) {
		lines.push({
			id: failure.id,
			payload: failure.payload,
			state: "not-sent",
			reason: failure.reason ?? FAILURE_TEXT[failure.status],
		});
	}
	for (const item of input.outbox) {
		const { id, payload } = item;
		if (item.waiting !== undefined)
			lines.push({ id, payload, state: "pending", reason: item.waiting });
		else
			lines.push({
				id,
				payload,
				state: item.state === "queued" ? "pending" : "sending",
			});
	}
	return lines;
}

function pendingLines(input: RoomViewInput): PendingLine[] {
	return ownCommands(input)
		.filter((line) => isChatCommand(line.payload))
		.map((line) => ({
			id: line.id,
			text: payloadText(line.payload),
			state: line.state,
			...(line.reason === undefined ? {} : { reason: line.reason }),
		}));
}

/** A seated tab may always send: the outbox stores the message until a host is connected. */
function sendState(input: RoomViewInput): SendState {
	if (input.terminal) return { label: TEXT.send, enabled: false };
	return input.ready
		? { label: TEXT.send, enabled: true }
		: { label: TEXT.send, enabled: true, hint: TEXT.sendHint };
}

/** Initial text of the send field. */
export function draftFor(seat: Seat): string {
	return `Connection test from ${SEAT_NAMES[seat]}`;
}
