import { describe, expect, it } from "vitest";
import { type Board, createBoard, scoreBoard } from "../../src/bridge/engine";
import {
	actionPayload,
	type BridgeState,
	dealPayload,
} from "../../src/game/bridge";
import type { OutboxItem } from "../../src/p2p/outbox";
import type { CommandFailure } from "../../src/p2p/table";
import type { Entry } from "../../src/p2p/wire";
import {
	type JsonObject,
	type RoomConfig,
	SEAT_NAMES,
	type Seat,
} from "../../src/protocol";
import type { RosterRow } from "../../src/ui/model";
import {
	autoDealBoard,
	callText,
	cardText,
	commandText,
	type HandDisplay,
	positionOf,
	resultText,
	type TableView,
	type TableViewInput,
	tableView,
} from "../../src/ui/table-model";
import { bidding, call, DEAL, play, playing } from "./bridge-fixtures";

const TABLE_ID = "Table_ID-0123456789abc";
const CONFIG: RoomConfig = {
	names: { N: "player1", E: "player3", S: "player2", W: "player4" },
	scoring: "duplicate",
};
const ALL = new Set<Seat>(["N", "E", "S", "W"]);
const ROSTER: RosterRow[] = (["N", "E", "S", "W"] as const).map((seat) => ({
	seat,
	label: SEAT_NAMES[seat],
	host: seat === "N",
	you: seat === "N",
	state: "online",
	releasable: false,
}));

function tableState(board: Board | null): BridgeState {
	const result = board && scoreBoard(board);
	const earlier = board ? board.number - 1 : 0;
	const results = Array.from({ length: earlier }, (_, i) => ({
		number: i + 1,
		contract: null,
		declarerTricks: 0,
		scoreNS: 0,
	}));
	return {
		v: 1,
		roomId: TABLE_ID,
		game: "bridge",
		messages: 0,
		board,
		results: result ? [...results, result] : results,
		undo: null,
		claim: null,
		claimResult: null,
		media: {},
	};
}

function view(
	seat: Seat,
	board: Board | null,
	overrides: Partial<TableViewInput> = {},
): TableView {
	return tableView({
		config: CONFIG,
		seat,
		state: tableState(board),
		terminal: false,
		present: ALL,
		roster: ROSTER,
		hostSeat: "N",
		outbox: [],
		failures: [],
		undone: [],
		...overrides,
	});
}

function queued(
	id: string,
	payload: JsonObject,
	state: OutboxItem["state"] = "queued",
): OutboxItem {
	return { id, payload, order: 1, state };
}

function refused(
	id: string,
	payload: JsonObject,
	reason: string,
): CommandFailure {
	return { id, payload, status: "rejected", reason };
}

function seatView(table: TableView, seat: Seat) {
	const found = table.seats.find((item) => item.seat === seat);
	if (!found) throw new Error(`no seat ${seat}`);
	return found;
}

function shownCards(hand: HandDisplay): string[] {
	return hand.visible
		? hand.suits.flatMap((row) => row.cards.map((c) => c.card))
		: [];
}

function playableCards(hand: HandDisplay): string[] {
	return hand.visible
		? hand.suits.flatMap((row) =>
				row.cards.filter((c) => c.playable).map((c) => c.card),
			)
		: [];
}

const BOARD = createBoard(1, DEAL);
/** 1♠ by North; East has led the ♠7, so declarer plays next from dummy (South). */
const LED = playing(bidding(BOARD, "1S P P P"), "S7");
const NORTH_DECLARER_BOARD = bidding(BOARD, "1C P P P");
const NORTH_DUMMY_TURN = playing(NORTH_DECLARER_BOARD, "S7");
const NORTH_OWN_TURN = playing(NORTH_DECLARER_BOARD, "S7 S4 H3");

describe("text", () => {
	it("writes cards, calls and commands as players read them", () => {
		expect(cardText("ST")).toBe("♠10");
		expect(cardText("DQ")).toBe("♦Q");
		expect(
			["P", "X", "XX", "1S", "3NT"].map((c) => callText(c as never)),
		).toEqual(["Pass", "Double", "Redouble", "1♠", "3NT"]);
		expect(commandText(dealPayload(TABLE_ID, 2))).toBe("Deal board 2");
		expect(commandText(actionPayload(TABLE_ID, BOARD, call("XX")))).toBe(
			"Call Redouble",
		);
		expect(commandText(actionPayload(TABLE_ID, LED, play("S2")))).toBe(
			"Play ♠2",
		);
	});

	it("states the result of a board from the side that scored", () => {
		const contract = {
			level: 4,
			strain: "H",
			declarer: "E",
			doubling: "X",
		} as const;
		expect(
			resultText({ number: 1, contract, declarerTricks: 7, scoreNS: 500 }),
		).toBe("4♥X-3 by East: N-S +500.");
		expect(
			resultText({
				number: 1,
				contract: { ...contract, doubling: "" },
				declarerTricks: 11,
				scoreNS: -450,
			}),
		).toBe("4♥+1 by East: E-W +450.");
		expect(
			resultText({ number: 1, contract: null, declarerTricks: 0, scoreNS: 0 }),
		).toBe("Passed out. No score.");
	});
});

describe("table layout", () => {
	it("enables claims for declarer on their turn and dummy's turn", () => {
		expect(view("N", NORTH_DECLARER_BOARD).claim.canRequest).toBe(false);
		expect(view("N", NORTH_DUMMY_TURN).claim.canRequest).toBe(true);
		expect(view("N", NORTH_OWN_TURN).claim.canRequest).toBe(true);
		expect(view("E", NORTH_DUMMY_TURN).claim.canRequest).toBe(false);
	});

	it("puts the viewer at the bottom and the others clockwise: left, top, right", () => {
		expect(
			(["S", "W", "N", "E"] as Seat[]).map((s) => positionOf("S", s)),
		).toEqual(["bottom", "left", "top", "right"]);
		expect(positionOf("W", "N")).toBe("left");
		expect(positionOf("W", "S")).toBe("right");
	});

	it("shows only the viewer's own hand in the auction, sorted into suit rows", () => {
		const table = view("E", BOARD);
		expect(table.phase).toBe("auction");
		expect(table.heading).toBe("AUCTION");
		expect(table.details).toBe("Dealer: North · Vulnerable: Not vulnerable");
		const own = seatView(table, "E");
		expect(own.tags).toEqual([]);
		expect(own.position).toBe("bottom");
		expect(own.hand.visible && own.hand.suits.map((row) => row.symbol)).toEqual(
			["♣", "♦", "♥", "♠"],
		);
		expect(
			own.hand.visible &&
				own.hand.suits
					.find((row) => row.symbol === "♠")
					?.cards.map((c) => c.rank),
		).toEqual(["7", "6", "5"]);
		expect(seatView(table, "N")).toMatchObject({
			tags: ["Host"],
			turn: true,
			hand: { visible: false, count: 13 },
		});
	});
});

describe("auction", () => {
	it("offers the legal calls only to the seat whose turn it is", () => {
		const north = view("N", bidding(BOARD, ""));
		expect(north.prompt).toBe("North to bid");
		expect(north.bids.map((bid) => bid.call)).not.toContain("X");
		expect(north.bids[0]).toEqual({ call: "P", text: "Pass" });
		expect(north.bids).toHaveLength(36);
		const east = view("E", BOARD);
		expect(east.bids).toEqual([]);
		expect(east.prompt).toBe("North to bid");
	});

	it("lines up the calls under their seats, starting at the dealer", () => {
		const board2 = bidding(createBoard(2, DEAL), "1C X P");
		const table = view("N", board2);
		expect(table.details).toBe("Dealer: East · Vulnerable: North-South");
		expect(table.auction).toEqual({
			seats: ["N", "E", "S", "W"],
			rows: [["", "1♣", "Double", "Pass"]],
		});
	});
});

describe("play", () => {
	it("keeps the West declarer's thirteen cards through the opponents' opening lead", () => {
		const board = playing(bidding(createBoard(3, DEAL), "P 2S P P P"), "SA S7");
		const table = view("W", board);

		expect(table.header?.declarer).toBe("W");
		expect(table.trick?.cards.map((item) => item.seat)).toEqual(["N", "E"]);
		expect(shownCards(seatView(table, "W").hand)).toHaveLength(13);
		expect(table.need?.remaining).toBe(13);
	});

	it("lets declarer play from dummy, and shows dummy to everyone after the lead", () => {
		const north = view("N", LED);
		expect(north.phase).toBe("play");
		expect(north.at).toBe(5);
		expect(north.prompt).toBe("Your turn: play a card from dummy.");
		expect(north.contract).toBe("1♠ by North");
		expect(playableCards(seatView(north, "S").hand)).toEqual([
			"S4",
			"S3",
			"S2",
		]);
		expect(playableCards(seatView(north, "N").hand)).toEqual([]);
		expect(seatView(north, "N").tags).toEqual(["Host", "Declarer"]);
		expect(seatView(north, "S").tags).toEqual(["Dummy"]);

		const south = view("S", LED);
		expect(south.prompt).toBe("Waiting for North to play from dummy.");
		expect(playableCards(seatView(south, "S").hand)).toEqual([]);
		const west = view("W", LED);
		expect(shownCards(seatView(west, "S").hand)).toHaveLength(13);
		expect(seatView(west, "N").hand).toEqual({ visible: false, count: 13 });
		expect(west.trick).toEqual({
			title: "Current trick",
			detail: "Trick 1",
			cards: [
				{
					seat: "E",
					position: "top",
					card: "S7",
					text: "♠7",
					rank: "7",
					symbol: "♠",
				},
			],
		});
	});

	it("shows the last trick and its winner until the next card is led", () => {
		const board = playing(LED, "S2 H3 SA");
		const table = view("E", board);
		expect(table.trick?.title).toBe("Previous trick");
		expect(table.trick?.cards.map((c) => c.card)).toEqual([
			"S7",
			"S2",
			"H3",
			"SA",
		]);
		expect(table.tricks).toBe("Tricks: N-S 1 · E-W 0");
		expect(table.prompt).toBe("Waiting for North to play.");
	});
});

describe("presence (plan §12 R4)", () => {
	it("marks bot seats from the shared roster", () => {
		const table = view("N", null, { bots: new Set<Seat>(["E", "W"]) });
		expect(seatView(table, "E").bot).toBe(true);
		expect(seatView(table, "E").label).toContain("🤖");
		expect(seatView(table, "W").bot).toBe(true);
		expect(seatView(table, "N").bot).toBe(false);
	});

	const without = (...absent: Seat[]) =>
		new Set([...ALL].filter((seat) => !absent.includes(seat)));

	it("waits for every seat before a deal, and names the absent seats", () => {
		const table = view("E", null, { present: without("N", "W") });
		expect(table.nextBoard?.ready).toBe(false);
		expect(table.prompt).toBe("Waiting for North and West to come back");
	});

	it("waits for every seat during the auction", () => {
		const north = view("N", BOARD, { present: without("S") });
		expect(north.bids).toEqual([]);
		expect(north.prompt).toBe("Waiting for South to come back");
	});

	it("lets declarer play while dummy is away, but not while a defender is away", () => {
		const dummyAway = view("N", LED, { present: without("S") });
		expect(dummyAway.prompt).toBe("Your turn: play a card from dummy.");
		expect(playableCards(seatView(dummyAway, "S").hand)).toEqual([
			"S4",
			"S3",
			"S2",
		]);
		const defenderAway = view("N", LED, { present: without("W") });
		expect(defenderAway.prompt).toBe("Waiting for West to come back");
		expect(playableCards(seatView(defenderAway, "S").hand)).toEqual([]);
	});

	it("waits for dummy before the next deal", () => {
		const done = playing(
			bidding(BOARD, "1S P P P"),
			"S7 S2 H3 SA SK S6 S3 H2 SQ S5 S4 D2 SJ HJ H4 D3 ST HT H5 D4 S9 H9 H6 D5 S8 H8 D6 C2 HA H7 D7 C3 HK DT D8 C4 HQ DJ D9 C5 DA DQ CT C6 DK CK CJ C7 CA CQ C9 C8",
		);
		const table = view("N", done, { present: without("S") });
		expect(table.nextBoard?.ready).toBe(false);
		expect(table.prompt).toBe("Waiting for South to come back");
	});
});

describe("this seat's table actions", () => {
	it("offers nothing more while the seat's last action waits for the host", () => {
		const pending = queued(
			"local-1",
			actionPayload(TABLE_ID, BOARD, call("1S")),
		);
		const table = view("N", BOARD, { outbox: [pending] });
		expect(table.bids).toEqual([]);
		expect(table.actions).toEqual([
			{ id: "local-1", text: "Call 1♠", state: "pending" },
		]);

		const sent = queued(
			"local-2",
			actionPayload(TABLE_ID, LED, play("S2")),
			"sent",
		);
		const busy = view("N", LED, { outbox: [sent] });
		expect(playableCards(seatView(busy, "S").hand)).toEqual([]);
		expect(busy.actions).toEqual([
			{ id: "local-2", text: "Play ♠2", state: "sending" },
		]);
	});

	it("shows the host's reason while an action waits for an absent player", () => {
		const waiting: OutboxItem = {
			...queued("local-1", actionPayload(TABLE_ID, BOARD, call("1S"))),
			waiting: "Waiting for East to come back",
		};
		expect(view("N", BOARD, { outbox: [waiting] }).actions).toEqual([
			{
				id: "local-1",
				text: "Call 1♠",
				state: "pending",
				reason: "Waiting for East to come back",
			},
		]);
	});

	it("shows why the host refused an action, and lets the seat act again", () => {
		const reason = "the table has moved on since this action was chosen";
		const table = view("N", BOARD, {
			failures: [
				refused("c-1", actionPayload(TABLE_ID, BOARD, call("1S")), reason),
			],
		});
		expect(table.actions).toEqual([
			{ id: "c-1", text: "Call 1♠", state: "not-accepted", reason },
		]);
		expect(table.bids).not.toEqual([]);
	});

	it("shows an action that a host change undid", () => {
		const undone: Entry = {
			seq: 3,
			auth: { term: 1, tag: "holder-W", inc: 1 },
			prevAuth: { term: 1, tag: "holder-W", inc: 1 },
			id: "c-2",
			seat: "N",
			gen: 1,
			kind: "cmd",
			payload: actionPayload(TABLE_ID, BOARD, call("1S")),
			event: {},
		};
		expect(view("N", BOARD, { undone: [undone] }).actions).toEqual([
			{ id: "c-2", text: "Call 1♠", state: "undone" },
		]);
	});

	it("drops a deal that lost the race to another seat's deal, and actions of an earlier board", () => {
		const table = view("N", createBoard(2, DEAL), {
			failures: [
				refused("d-2", dealPayload(TABLE_ID, 2), "board 2 is already dealt"),
				refused(
					"c-1",
					actionPayload(TABLE_ID, BOARD, call("1S")),
					"it is not your turn",
				),
			],
		});
		expect(table.actions).toEqual([]);
	});

	it("offers nothing to a tab that can no longer act", () => {
		const table = view("N", BOARD, { terminal: true });
		expect(table.bids).toEqual([]);
		expect(view("N", null, { terminal: true }).nextBoard?.ready).toBe(false);
	});

	it("does not let a human act while the host bot controls their seat", () => {
		const table = view("N", BOARD, { bots: new Set(["N"]) });
		expect(table.bids).toEqual([]);
		expect(table.yourTurn).toBe(false);
	});
});

describe("the connection room before the first deal", () => {
	const WEST_HOSTS: RosterRow[] = [
		{
			seat: "W",
			label: SEAT_NAMES.W,
			host: true,
			you: false,
			state: "online",
			releasable: false,
		},
		{
			seat: "N",
			label: SEAT_NAMES.N,
			host: false,
			you: true,
			state: "online",
			releasable: false,
		},
	];

	it("shows joined seats with backs, free seats as not joined, and the host tag", () => {
		const table = view("N", null, {
			roster: WEST_HOSTS,
			hostSeat: "W",
			present: new Set<Seat>(["W"]),
		});
		expect(table.phase).toBe("waiting");
		expect(seatView(table, "W")).toMatchObject({
			presence: "online",
			tags: ["Host"],
			connecting: false,
			hand: { visible: false, count: 13 },
		});
		expect(seatView(table, "E")).toMatchObject({
			presence: "free",
			label: SEAT_NAMES.E,
			hand: { visible: false, count: 0 },
		});
		expect(seatView(table, "N")).toMatchObject({
			connecting: false,
			hand: { visible: false, count: 0 },
		});
	});

	it("keeps the first deal ready while the host's seat is bot controlled", () => {
		const table = view("W", null, {
			bots: new Set(["N", "E", "S", "W"]),
		});
		expect(table.nextBoard?.ready).toBe(true);
	});

	it("shows the viewer's own backs and the connecting banner until the host connects", () => {
		const table = view("N", null, {
			roster: WEST_HOSTS,
			hostSeat: "W",
			present: new Set<Seat>(),
		});
		expect(seatView(table, "N")).toMatchObject({
			connecting: true,
			hand: { visible: false, count: 13 },
		});
	});

	it("never shows the connecting banner to the host itself", () => {
		const table = view("W", null, {
			roster: WEST_HOSTS,
			hostSeat: "W",
			present: new Set<Seat>(),
		});
		expect(seatView(table, "W")).toMatchObject({ connecting: false });
	});
});

describe("dealing and scores", () => {
	it("requests the next board once after the countdown reaches zero", () => {
		const next = { board: 2, ready: true };
		expect(autoDealBoard(true, 1, 0, next, undefined)).toBe(2);
		expect(autoDealBoard(true, 1, 0, next, 2)).toBeUndefined();
		expect(autoDealBoard(true, 1, 1, next, undefined)).toBeUndefined();
		expect(
			autoDealBoard(true, 1, 0, { ...next, ready: false }, undefined),
		).toBeUndefined();
		expect(autoDealBoard(false, 1, 0, next, undefined)).toBeUndefined();
	});

	it("shows the compact score from the viewer's partnership", () => {
		const board = bidding(BOARD, "1S P P P");
		const done = playing(
			board,
			"S7 S2 H3 SA SK S6 S3 H2 SQ S5 S4 D2 SJ HJ H4 D3 ST HT H5 D4 S9 H9 H6 D5 S8 H8 D6 C2 HA H7 D7 C3 HK DT D8 C4 HQ DJ D9 C5 DA DQ CT C6 DK CK CJ C7 CA CQ C9 C8",
		);
		expect(view("S", done).scoring).toMatchObject({
			contract: { level: 1, strain: "S", doubling: "" },
			compactOutcome: "WON",
			compactDetail: "Made +6",
		});
		expect(view("W", done).scoring).toMatchObject({
			compactOutcome: "LOST",
			compactDetail: "Opponents made +6",
		});
		const defendersWon = {
			...tableState(done),
			results: tableState(done).results.map((result) => ({
				...result,
				declarerTricks: 6,
			})),
		};
		expect(view("W", done, { state: defendersWon }).scoring).toMatchObject({
			compactOutcome: "WON",
			compactDetail: "Opponents down 1",
		});
	});

	it("marks the first board ready for the host when all seats are present", () => {
		const table = view("E", null);
		expect(table.phase).toBe("waiting");
		expect(table.at).toBe(0);
		expect(table.prompt).toBe("The first board is dealt now.");
		expect(table.nextBoard).toEqual({
			board: 1,
			ready: true,
		});
		expect(table.heading).toBe("ROOM CONNECTION");
	});

	it("marks the sequential next board ready after a board ends", () => {
		const passedOut = bidding(BOARD, "P P P P");
		expect(view("N", passedOut).nextBoard).toEqual({
			board: 2,
			ready: true,
		});
	});

	it("marks the board not ready while a host deal command is pending", () => {
		const own = queued("local-1", dealPayload(TABLE_ID, 1));
		const table = view("N", null, {
			hostSeat: "N",
			outbox: [own],
		});
		expect(table.nextBoard?.ready).toBe(false);
		expect(table.actions).toEqual([
			{ id: "local-1", text: "Deal board 1", state: "pending" },
		]);
	});

	it("shows the result, the score rows, the totals and the next deal when the board is over", () => {
		const board = bidding(BOARD, "1S P P P");
		const done = playing(
			board,
			"S7 S2 H3 SA SK S6 S3 H2 SQ S5 S4 D2 SJ HJ H4 D3 ST HT H5 D4 S9 H9 H6 D5 S8 H8 D6 C2 HA H7 D7 C3 HK DT D8 C4 HQ DJ D9 C5 DA DQ CT C6 DK CK CJ C7 CA CQ C9 C8",
		);
		const table = view("S", done);
		expect(table.phase).toBe("complete");
		expect(table.result).toBe("Winner: N-S. 1♠+6 by North: N-S +260.");
		expect(table.scores).toEqual([
			{
				number: 1,
				contract: "1♠",
				declarer: "N",
				outcome: "+6",
				ns: "260",
				ew: "",
			},
		]);
		expect(table.totals).toEqual({ ns: 260, ew: 0 });
		expect(table.nextBoard).toEqual({
			board: 2,
			ready: true,
		});
		expect(shownCards(seatView(table, "W").hand)).toHaveLength(13);
	});

	it("reports a table that is loading or holds no bridge table", () => {
		expect(view("N", null, { state: undefined }).phase).toBe("loading");
		expect(view("N", null, { state: null }).phase).toBe("unreadable");
	});
});
