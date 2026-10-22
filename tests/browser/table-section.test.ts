import { afterEach, describe, expect, it } from "vitest";
import type { Action, MatchState } from "../../src/canasta";
import { applyAction, startMatch } from "../../src/canasta";
import { type CanastaState, tableSeat } from "../../src/game/canasta";
import {
	catalogKeys,
	type Locale,
	type Translate,
	translator,
} from "../../src/i18n";
import { PROTOCOL_VERSION, SEATS } from "../../src/protocol";
import type { RosterRow } from "../../src/ui/model";
import { tableSection } from "../../src/ui/table";
import {
	type TableView,
	type TableViewInput,
	tableView,
} from "../../src/ui/table-model";

const sections: HTMLElement[] = [];

afterEach(() => {
	for (const element of sections.splice(0)) element.remove();
});

/** The view of the seat that takes the first turn of a new match; another seat hosts. */
function firstTurnView(): TableView {
	return turnView(startMatch(7), 0);
}

/** The match after the seat on turn drew from the stock, so it can meld and discard. */
function afterDraw(): MatchState {
	const match = startMatch(7);
	const step = applyAction(match.hand, match.hand.turn, { type: "draw" });
	if (!step.ok) throw new Error(step.reason);
	return { ...match, hand: step.hand };
}

/** The view of the seat on turn; another seat hosts. */
function turnView(
	match: MatchState,
	actions: number,
	overrides: Partial<TableViewInput> = {},
): TableView {
	const seat = tableSeat(match.hand.turn);
	const host = SEATS.find((item) => item !== seat) ?? "N";
	const state: CanastaState = {
		v: PROTOCOL_VERSION,
		roomId: "room-1",
		game: "canasta",
		messages: 0,
		matches: 1,
		match,
		actions,
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
		...overrides,
	});
}

function mount(acted: Action[], t?: Translate) {
	const section = tableSection(
		{
			exit: () => {},
			shareUrl: async () => {},
			act: (action) => acted.push(action),
			call: {
				join: () => {},
				leave: () => {},
				setSwitch: () => {},
				retry: () => {},
			},
		},
		t,
	);
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

	it("shows the cards of an action as cards with a suit symbol, red for hearts and diamonds", () => {
		const section = mount([], translator("hu"));
		section.render(turnView(afterDraw(), 1, { t: translator("hu") }));
		const card = section.element.querySelector<HTMLButtonElement>(
			".own-hand button.card",
		);
		card?.click();
		const discard = section.element.querySelector(
			'[data-testid="action-discard"]',
		);
		const pip = discard?.querySelector(".pip");
		expect(discard?.textContent).toBe(`Eldobás: ${card?.textContent}`);
		expect(pip?.textContent).toBe(card?.textContent);
		expect(pip?.textContent).toMatch(/^(\d+|[JQKA])[♣♦♥♠]$|^Joker$/);
		expect(pip?.classList.contains("red")).toBe(
			/[♦♥]/.test(card?.textContent ?? ""),
		);
	});

	it("asks only for messages that every language translates", () => {
		const asked = new Set<string>();
		const english = translator("en");
		const t: Translate = (message, values) => {
			asked.add(message);
			return english(message, values);
		};
		const section = mount([], t);
		const drawn = afterDraw();
		const refused = {
			id: "c1",
			payload: { type: "action", hand: 1, action: { type: "draw" } },
			status: "rejected" as const,
		};
		section.render(turnView(startMatch(7), 0, { t }));
		section.render(
			turnView(startMatch(7), 0, {
				t,
				failures: [
					refused,
					{ ...refused, id: "c2", reason: "draw before melding" },
				],
			}),
		);
		section.render(turnView(drawn, 1, { t }));
		section.element
			.querySelector<HTMLButtonElement>(".own-hand button.card")
			?.click();
		section.element.querySelector<HTMLButtonElement>(".sort-toggle")?.click();
		section.setBotControls(true, ["E", "W"]);
		section.setPlayerAutoplay(true, false, false, "");
		section.setPlayerAutoplay(true, true, false, "");
		section.setCountdown(1);
		section.setCountdown(5);
		const ended = {
			...drawn,
			hand: { ...drawn.hand, outcome: { kind: "stock" as const } },
		};
		section.render(turnView(ended, 2, { t }));
		section.render(turnView({ ...ended, winner: 0 }, 2, { t }));
		expect(asked.size).toBeGreaterThan(20);
		const locales = [
			"de",
			"hu",
			"no",
			"es",
			"pt",
			"fr",
			"it",
			"nl",
		] as const satisfies readonly Exclude<Locale, "en">[];
		for (const locale of locales) {
			const known = new Set(catalogKeys(locale));
			expect(
				[...asked].filter((message) => !known.has(message)),
				locale,
			).toEqual([]);
		}
	});
});
