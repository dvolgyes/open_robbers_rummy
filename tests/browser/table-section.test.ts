import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "../../src/canasta";
import { startMatch } from "../../src/canasta";
import { type CanastaState, tableSeat } from "../../src/game/canasta";
import { PROTOCOL_VERSION, SEATS } from "../../src/protocol";
import type { RosterRow } from "../../src/ui/model";
import { tableSection } from "../../src/ui/table";
import { type TableView, tableView } from "../../src/ui/table-model";

const sections: HTMLElement[] = [];

afterEach(() => {
	for (const element of sections.splice(0)) element.remove();
});

/** The view of the seat that takes the first turn of a new match; another seat hosts. */
function firstTurnView(): TableView {
	const match = startMatch(7);
	const seat = tableSeat(match.hand.turn);
	const host = SEATS.find((item) => item !== seat) ?? "N";
	const state: CanastaState = {
		v: PROTOCOL_VERSION,
		roomId: "room-1",
		game: "canasta",
		messages: 0,
		matches: 1,
		match,
		actions: 0,
		reset: null,
		media: {},
	};
	const roster: RosterRow[] = SEATS.map((item) => ({
		seat: item,
		label: item,
		host: item === host,
		you: item === seat,
		state: "online",
		releasable: false,
	}));
	return tableView({
		config: { names: { N: "Ann", E: "Ben", S: "Cy", W: "Dee" } },
		seat,
		state,
		terminal: false,
		present: new Set(SEATS),
		roster,
		hostSeat: host,
		outbox: [],
		failures: [],
		undone: [],
	});
}

function mount(acted: Action[]) {
	const section = tableSection({
		exit: () => {},
		shareUrl: async () => {},
		act: (action) => acted.push(action),
		call: {
			join: () => {},
			leave: () => {},
			setSwitch: () => {},
			retry: () => {},
		},
	});
	sections.push(section.element);
	document.body.append(section.element);
	return section;
}

describe("table section", () => {
	it("keeps the hand and the action buttons when a new view shows the same position", () => {
		const acted: Action[] = [];
		const section = mount(acted);
		const view = firstTurnView();
		expect(view.yourTurn).toBe(true);
		section.render(view);
		const draw = section.element.querySelector('[data-testid="action-draw"]');
		const card = section.element.querySelector(".own-hand button.card");
		expect(draw).not.toBeNull();
		expect(card).not.toBeNull();

		// A beat or a roster change renders the same position again, as a new object.
		section.render(structuredClone(view));
		expect(draw?.isConnected).toBe(true);
		expect(card?.isConnected).toBe(true);

		(draw as HTMLButtonElement).click();
		expect(acted.map((action) => action.type)).toEqual(["draw"]);
	});

	it("keeps the viewer's autoplay control when a new view shows the same seat", () => {
		const section = mount([]);
		const view = firstTurnView();
		section.render(view);
		section.setPlayerAutoplay(true, false, false, "");
		const control = () =>
			section.element.querySelector('[data-testid="player-autoplay-toggle"]');
		const before = control();
		expect(before).not.toBeNull();
		section.render(structuredClone(view));
		expect(control()).toBe(before);
		section.setPlayerAutoplay(true, true, false, "");
		expect(control()?.textContent).toBe("Stop autoplay");
	});

	it("shows a selected card at once, also after a render of the same position", () => {
		const section = mount([]);
		const view = firstTurnView();
		section.render(view);
		const pressed = () =>
			section.element
				.querySelector(".own-hand button.card")
				?.getAttribute("aria-pressed");
		section.element
			.querySelector<HTMLButtonElement>(".own-hand button.card")
			?.click();
		expect(pressed()).toBe("true");
		section.render(structuredClone(view));
		expect(pressed()).toBe("true");
	});
});
