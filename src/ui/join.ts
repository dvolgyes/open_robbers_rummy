import type { RoomSetup } from "../bookmark";
import type { HostBotSettings } from "../bot/host-runner";
import { canastaModule } from "../game/canasta";
import { newCommandId } from "../ids";
import { randomNonce } from "../p2p/checks";
import {
	TableController,
	type TableIdentity,
	type TableStatus,
	type TableView,
	tableIdentity,
} from "../p2p/table";
import { SEAT_NAMES, type Seat } from "../protocol";
import type { AppDeps, Dispose, Navigation } from "./deps";
import { button, el } from "./dom";
import {
	chooseText,
	type LobbyScreen,
	lobbyScreen,
	networkLines,
	seatText,
	storageNotice,
	TEXT,
} from "./model";
import { networkPanel } from "./network";
import { showRoom } from "./room-view";
import { turnSound } from "./turn-sound";

/** A room in one of these states stays on the screen, read-only, after its seat is gone. */
const KEEP_ROOM: ReadonlySet<TableStatus> = new Set([
	"expired",
	"superseded",
	"incompatible",
]);

function message(...children: (Node | string)[]): HTMLElement {
	return el(
		"section",
		{ className: "message", attrs: { "data-testid": "message" } },
		...children,
	);
}

/**
 * A table link. Runs one table controller at a time: the lobby while this page holds no seat, and the room
 * screen while it holds one. `creator` is true only for the page load that has just created the table.
 */
export function showTable(
	root: HTMLElement,
	deps: AppDeps,
	key: string,
	creator: boolean,
	navigation: Navigation,
	seatHint?: Seat,
	bootstrap?: RoomSetup,
	autoCopy?: Promise<string>,
	hostBots?: HostBotSettings,
): Dispose {
	let disposed = false;
	const turnAlert = turnSound();
	const unlockTurnAlert = (): void => turnAlert.unlock();
	root.addEventListener("pointerdown", unlockTurnAlert);
	root.addEventListener("keydown", unlockTurnAlert);
	let identity: TableIdentity | undefined;
	let controller: TableController | undefined;
	let unsubscribe: (() => void) | undefined;
	/** True while a controller starts; the screen shows "Connecting" until it is ready. */
	let opening = false;
	let room: Dispose | undefined;
	let roomSeat: Seat | undefined;
	/** Why the last seat request of this page failed. */
	let notice: string | undefined;
	/** The lobby as last built: an equal lobby only updates its status line and the network panel. */
	let shown: string | undefined;
	/** True once this page has taken the last free seat, so a refusal does not repeat the take. */
	let autoTook = false;

	const status = el("p", {
		attrs: { role: "status", "data-testid": "table-status" },
	});
	const network = networkPanel(deps.t);

	const leaveRoom = (): void => {
		room?.();
		room = undefined;
		roomSeat = undefined;
	};

	const stopController = (): void => {
		unsubscribe?.();
		unsubscribe = undefined;
		controller?.stop();
		controller = undefined;
	};

	const showConnecting = (): void => {
		shown = undefined;
		document.title = "Open Canasta";
		root.replaceChildren(message(el("p", {}, deps.t(TEXT.connecting))));
	};

	/** Tries to claim this seat again, if no active tab holds it and the host allows it. */
	const retryRoomSeat = (): void => {
		const seat = roomSeat;
		if (seat === undefined) return;
		leaveRoom();
		stopController();
		showConnecting();
		void open(false, async (table) => {
			const view = table.view();
			if (view.seat !== null) return;
			const result = await table.choose(seat);
			if (!result.ok) notice = chooseText(result.reason, deps.t);
		});
	};

	async function open(
		asCreator: boolean,
		then?: (table: TableController) => Promise<void>,
	): Promise<void> {
		opening = true;
		identity ??= await tableIdentity(key, deps.browser);
		if (disposed) return;
		const table = new TableController({
			identity,
			storage: deps.storage,
			locks: deps.locks,
			memory: deps.memory,
			module: canastaModule,
			clock: deps.clock,
			every: (ms, run) => {
				const timer = setInterval(run, ms);
				return () => clearInterval(timer);
			},
			openMesh: deps.openMesh(identity.tableId, key),
			newId: newCommandId,
			nonce: randomNonce,
			creator: asCreator,
			preferredSeat: seatHint,
			bootstrap,
		});
		controller = table;
		unsubscribe = table.onChange(render);
		await table.start();
		if (disposed || controller !== table) return;
		await then?.(table);
		if (disposed || controller !== table) return;
		opening = false;
		render();
	}

	async function take(seat: Seat): Promise<void> {
		const table = controller;
		if (!table) return;
		notice = undefined;
		const result = await table.choose(seat);
		if (disposed || table !== controller) return;
		if (!result.ok) notice = chooseText(result.reason, deps.t);
		render();
	}

	function render(): void {
		const table = controller;
		if (disposed || opening || !table) return;
		const view = table.view();
		if (room !== undefined) {
			// The room renders itself. It goes only when the host refused or dropped the seat.
			if (view.seat === roomSeat || KEEP_ROOM.has(view.status)) return;
			leaveRoom();
		}
		if (view.seat !== null) {
			navigation.rememberSeat(view.seat);
			document.title = `Open Canasta: ${view.table?.config.names[view.seat] ?? SEAT_NAMES[view.seat]} (${deps.t(view.seat)})`;
			shown = undefined;
			notice = undefined;
			roomSeat = view.seat;
			room = showRoom(
				root,
				deps,
				table,
				key,
				view.seat,
				{
					...navigation,
					retrySeat: retryRoomSeat,
					turnSound: turnAlert,
				},
				bootstrap?.config,
				autoCopy,
				hostBots,
			);
			return;
		}
		document.title = "Open Canasta";
		const screen = lobbyScreen({
			status: view.status,
			supersededBy: view.supersededBy,
			election: view.election,
			lobby: view.lobby,
			heldElsewhere: view.heldElsewhere,
			setup: bootstrap,
			t: deps.t,
		});
		// One claimable seat needs no choice, even when other same-browser tabs hold their own seats.
		if (
			seatHint === undefined &&
			!autoTook &&
			screen.kind === "lobby" &&
			screen.choices?.length === 1
		) {
			const [only] = screen.choices;
			if (only !== undefined) {
				autoTook = true;
				void take(only.seat);
				return;
			}
		}
		renderLobby(screen, view);
	}

	function renderLobby(screen: LobbyScreen, view: TableView): void {
		network.render(
			networkLines({
				network: view.network,
				peers: view.peers,
				publicAddress: view.publicAddress,
				persistent: view.persistent,
				persisted: undefined,
				t: deps.t,
			}),
		);
		if (screen.kind === "lobby") status.textContent = screen.status ?? "";
		const problem =
			notice ??
			(view.seatError === null ? undefined : seatText(view.seatError, deps.t));
		const signature = JSON.stringify([
			screen.kind === "lobby" ? { ...screen, status: undefined } : screen,
			problem,
		]);
		if (signature === shown) return;
		shown = signature;
		root.replaceChildren(lobbyElement(screen, problem));
	}

	function lobbyElement(
		screen: LobbyScreen,
		problem: string | undefined,
	): HTMLElement {
		switch (screen.kind) {
			case "expired":
				return message(
					el("h1", {}, deps.t(TEXT.expired)),
					button(deps.t("Create new game"), navigation.createNew),
				);
			case "problem":
				return message(
					el("p", {}, screen.text),
					button(deps.t("Reload"), () => location.reload()),
					network.element,
				);
			case "lobby": {
				const parts: (Node | string)[] = [];
				if (screen.choices !== undefined)
					parts.push(el("h1", {}, deps.t("Choose your seat")));
				parts.push(status);
				if (deps.storageProblem !== undefined)
					parts.push(
						el(
							"p",
							{ className: "notice" },
							storageNotice(deps.storageProblem, deps.t),
						),
					);
				if (problem !== undefined)
					parts.push(
						el("p", { className: "notice", attrs: { role: "alert" } }, problem),
					);
				if (screen.choices !== undefined) {
					parts.push(
						screen.choices.length > 0
							? el(
									"div",
									{ className: "choices" },
									...screen.choices.map((choice) =>
										button(choice.label, () => void take(choice.seat), {
											attrs: { "data-testid": `pick-${choice.seat}` },
										}),
									),
								)
							: el("p", {}, deps.t("All seats are taken.")),
					);
				}
				parts.push(network.element);
				return message(...parts);
			}
		}
	}

	// The election restarts its absence clock when the page comes back (plan §4.4 rule 5).
	const onVisible = (): void => {
		if (document.visibilityState === "visible") controller?.wake();
	};
	const onWake = (): void => controller?.wake();
	document.addEventListener("visibilitychange", onVisible);
	window.addEventListener("online", onWake);
	window.addEventListener("pageshow", onWake);

	/** A start link seats its host directly. A seat that another device holds leaves the lobby with a notice. */
	const claimHint = async (table: TableController): Promise<void> => {
		if (seatHint === undefined) return;
		const view = table.view();
		if (view.seat !== null) return;
		const result = await table.choose(seatHint);
		if (!result.ok) notice = chooseText(result.reason, deps.t);
	};

	showConnecting();
	void open(creator, claimHint);

	return () => {
		disposed = true;
		document.title = "Open Canasta";
		document.removeEventListener("visibilitychange", onVisible);
		window.removeEventListener("online", onWake);
		window.removeEventListener("pageshow", onWake);
		root.removeEventListener("pointerdown", unlockTurnAlert);
		root.removeEventListener("keydown", unlockTurnAlert);
		leaveRoom();
		stopController();
		turnAlert.dispose();
	};
}

/** A link that does not open a table: an old link, another version, or a damaged one. */
export function showLinkProblem(
	root: HTMLElement,
	navigation: Navigation,
	text: string,
	t: (message: string) => string = (message) => message,
): Dispose {
	root.replaceChildren(
		message(
			el("p", {}, text),
			button(t("Create new game"), navigation.createNew),
		),
	);
	return () => {};
}
