import { afterEach, describe, expect, it } from "vitest";
import type { RummyState } from "../../src/game/rummy";
import {
	catalogKeys,
	type Locale,
	type Translate,
	translator,
} from "../../src/i18n";
import {
	DEFAULT_TABLE_SETUP,
	PROTOCOL_VERSION,
	SEATS,
} from "../../src/protocol";
import { type Action, type HandState, rulesFor } from "../../src/rummy";
import type { RosterRow } from "../../src/ui/model";
import "../../src/ui/style.css";
import { type TableHandlers, tableSection } from "../../src/ui/table";
import {
	type TableView,
	type TableViewInput,
	tableView,
} from "../../src/ui/table-model";

const sections: HTMLElement[] = [];

afterEach(() => {
	for (const element of sections.splice(0)) element.remove();
});

interface HandInput {
	readonly turn?: number;
	readonly opened?: boolean;
	readonly preset?: "gamerules" | "wikipedia";
	readonly outcome?: HandState["outcome"];
}

/**
 * Player 3 (engine seat 2) is the viewer and holds three hearts that extend the table run, the king of clubs, and a
 * joker. Player 2's latest play put the 7♥ on the table.
 */
function hand(input: HandInput = {}): HandState {
	return {
		rules: rulesFor(input.preset ?? "wikipedia", 4, true),
		players: 4,
		dealer: 1,
		turn: input.turn ?? 2,
		phase: "start",
		hands: [
			["1-2C", "1-4D"],
			["1-6S"],
			["0-8H", "0-9H", "0-10H", "0-KC", "JK0"],
			["1-QD", "1-KD", "JK1"],
		],
		stock: ["1-3S", "1-4S"],
		table: [
			{ id: "m1", cards: ["0-5H", "0-6H", "0-7H"] },
			{ id: "m2", cards: ["1-9C", "JK2", "1-9S"] },
		],
		opened: [true, true, input.opened ?? true, true],
		lastPlay: { seat: 1, cards: ["0-7H"], meldIds: ["m1"] },
		passes: 0,
		nextMeldNo: 3,
		outcome: input.outcome ?? null,
	};
}

/** The view of Player 3; Player 1 hosts. */
function viewOf(
	match: HandState,
	actions = 3,
	overrides: Partial<TableViewInput> = {},
): TableView {
	const state: RummyState = {
		v: PROTOCOL_VERSION,
		roomId: "room-1",
		game: "rummy",
		messages: 0,
		matches: 1,
		lastDealer: 1,
		match: { handNo: 1, hand: match },
		actions,
		reset: null,
		media: {},
	};
	const roster: RosterRow[] = SEATS.map((seat) => ({
		seat,
		label: seat,
		host: seat === "1",
		you: seat === "3",
		state: "online",
		releasable: false,
	}));
	return tableView({
		config: {
			names: { "1": "Ann", "2": "Ben", "3": "Cy", "4": "Dee" },
			table: DEFAULT_TABLE_SETUP,
		},
		seat: "3",
		state,
		terminal: false,
		present: new Set(SEATS),
		roster,
		hostSeat: "1",
		outbox: [],
		failures: [],
		undone: [],
		...overrides,
	});
}

function mount(
	acted: Action[],
	t?: Translate,
	extra: Partial<TableHandlers> = {},
) {
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
			...extra,
		},
		t,
	);
	sections.push(section.element);
	document.body.append(section.element);
	return section;
}

function query<T extends Element = HTMLElement>(
	root: HTMLElement,
	selector: string,
): T {
	const found = root.querySelector<T>(selector);
	if (found === null) throw new Error(`no ${selector}`);
	return found;
}

function click(root: HTMLElement, selector: string): void {
	query<HTMLButtonElement>(root, selector).click();
}

/** The card ids of each meld in the centre, in display order. */
function meldIds(root: HTMLElement): string[][] {
	return [...root.querySelectorAll('[data-testid="meld"]')].map((meld) =>
		[...meld.querySelectorAll("[data-card]")].map(
			(card) => card.getAttribute("data-card") ?? "",
		),
	);
}

describe("the other players", () => {
	it("shows each other player in the top row with a dense strip of card backs and the count", () => {
		const section = mount([]);
		section.render(viewOf(hand()));
		const opponents = query(section.element, '[data-testid="opponents"]');
		const seats = [...opponents.querySelectorAll(".seat.opponent")].map(
			(node) => node.getAttribute("data-testid"),
		);
		expect(seats).toEqual(["seat-4", "seat-1", "seat-2"]);
		const west = query(opponents, '[data-testid="seat-4"]');
		const strip = query(west, '[data-testid="card-count"]');
		expect(strip.dataset.count).toBe("3");
		expect(strip.querySelectorAll(".count-back")).toHaveLength(3);
		expect(query(strip, ".count-number").textContent).toBe("3");
		// The strip sits below the video tile, and the backs overlap.
		const tile = query(west, ".tile").getBoundingClientRect();
		expect(strip.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			tile.bottom,
		);
		const [first, second] = [...strip.querySelectorAll(".count-back")].map(
			(back) => back.getBoundingClientRect(),
		);
		expect((second?.left ?? 0) - (first?.left ?? 0)).toBeLessThan(
			first?.width ?? 0,
		);
		// The player on turn: no other seat has the turn mark.
		expect(opponents.querySelectorAll('[data-turn="true"]')).toHaveLength(0);
	});
});

/** Six players: the four of `hand`, then Player 5 with one card and Player 6 with two. */
function sixPlayers(): HandState {
	const four = hand();
	return {
		...four,
		players: 6,
		hands: [...four.hands, ["0-2S"], ["0-3S", "0-4S"]],
		opened: [...four.opened, true, true],
	};
}

const SIX_NAMES = {
	"1": "Ann",
	"2": "Ben",
	"3": "Cy",
	"4": "Dee",
	"5": "Eve",
	"6": "Flo",
};

describe("the other players at tables of two and six", () => {
	it("keeps five other players in one row at phone width, in turn order after the viewer", () => {
		const section = mount([]);
		section.element.style.width = "358px";
		section.render(
			viewOf(sixPlayers(), 3, {
				config: { names: SIX_NAMES, table: DEFAULT_TABLE_SETUP },
			}),
		);
		const opponents = query(section.element, '[data-testid="opponents"]');
		const seats = [
			...opponents.querySelectorAll<HTMLElement>(".seat.opponent"),
		];
		expect(seats.map((node) => node.getAttribute("data-testid"))).toEqual([
			"seat-4",
			"seat-5",
			"seat-6",
			"seat-1",
			"seat-2",
		]);
		const tops = seats.map((node) =>
			Math.round(node.getBoundingClientRect().top),
		);
		expect(new Set(tops).size).toBe(1);
		expect(opponents.scrollWidth).toBeLessThanOrEqual(opponents.clientWidth);
		const box = opponents.getBoundingClientRect();
		for (const node of seats) {
			const rect = node.getBoundingClientRect();
			expect(rect.left).toBeGreaterThanOrEqual(box.left);
			expect(rect.right).toBeLessThanOrEqual(box.right);
		}
		expect(
			seats.map(
				(node) => query(node, '[data-testid="card-count"]').dataset.count,
			),
		).toEqual(["3", "1", "2", "2", "1"]);
	});

	it("keeps the host's bot controls of five other players inside the row and apart at phone width", () => {
		const section = mount([]);
		section.element.style.width = "320px";
		section.render(
			viewOf(sixPlayers(), 3, {
				config: { names: SIX_NAMES, table: DEFAULT_TABLE_SETUP },
			}),
		);
		section.setBotControls(true, ["5"]);
		const opponents = query(section.element, '[data-testid="opponents"]');
		const box = opponents.getBoundingClientRect();
		const controls = [
			...opponents.querySelectorAll<HTMLElement>(".tile-bot-control"),
		].map((node) => node.getBoundingClientRect());
		expect(controls).toHaveLength(5);
		for (const [index, rect] of controls.entries()) {
			expect(rect.left).toBeGreaterThanOrEqual(box.left - 0.5);
			expect(rect.right).toBeLessThanOrEqual(box.right + 0.5);
			const next = controls[index + 1];
			if (next) expect(rect.right).toBeLessThanOrEqual(next.left + 0.5);
		}
	});

	it("shows the one other player of a two-player table", () => {
		const two: HandState = {
			...hand(),
			players: 2,
			turn: 0,
			dealer: 1,
			hands: [["1-2C", "1-4D"], ["1-6S"]],
			opened: [true, true],
			lastPlay: null,
		};
		const section = mount([]);
		section.render(
			viewOf(two, 3, {
				seat: "1",
				config: {
					names: { "1": "Ann", "2": "Ben" },
					table: DEFAULT_TABLE_SETUP,
				},
			}),
		);
		const opponents = query(section.element, '[data-testid="opponents"]');
		expect(
			[...opponents.querySelectorAll(".seat.opponent")].map((node) =>
				node.getAttribute("data-testid"),
			),
		).toEqual(["seat-2"]);
	});
});

describe("the table", () => {
	it("frames the cards of the latest play in gold, and shows the card a joker stands for", () => {
		const section = mount([]);
		section.render(viewOf(hand({ turn: 0 })));
		const gold = [...section.element.querySelectorAll(".pip.gold")];
		expect(gold.map((card) => card.getAttribute("data-card"))).toEqual([
			"0-7H",
		]);
		expect(gold[0]?.getAttribute("title")).toBe("New on the table");
		const frame = getComputedStyle(gold[0] as Element);
		expect(frame.boxShadow).not.toBe("none");
		const joker = query(section.element, '[data-card="JK2"]');
		expect(joker.textContent).toMatch(/^★9/);
		expect(joker.getAttribute("title")).toMatch(/^Joker as 9/);
		// Not the viewer's turn: no draft editor.
		expect(section.element.querySelector('[data-testid="meld-add"]')).toBe(
			null,
		);
		expect(section.element.querySelector(".own-hand button.card")).toBe(null);
	});

	it("keeps the hand and the action buttons when a new view shows the same position", () => {
		const acted: Action[] = [];
		const section = mount(acted);
		const view = viewOf(hand());
		section.render(view);
		const draw = query(section.element, '[data-testid="action-draw"]');
		const card = query(section.element, ".own-hand button.card");

		// A beat or a roster change renders the same position again, as a new object.
		section.render(structuredClone(view));
		expect(draw.isConnected).toBe(true);
		expect(card.isConnected).toBe(true);

		draw.click();
		expect(acted).toEqual([{ type: "draw" }]);
	});

	it("keeps a selected card selected after a render of the same position", () => {
		const section = mount([]);
		const view = viewOf(hand());
		section.render(view);
		click(section.element, '.own-hand [data-card="0-8H"]');
		const pressed = () =>
			query(section.element, '.own-hand [data-card="0-8H"]').getAttribute(
				"aria-pressed",
			);
		expect(pressed()).toBe("true");
		section.render(structuredClone(view));
		expect(pressed()).toBe("true");
	});

	it("keeps the viewer's autoplay control when a new view shows the same seat", () => {
		const section = mount([]);
		const view = viewOf(hand());
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
});

describe("the draft", () => {
	it("moves selected hand cards onto a meld and plays the whole table", () => {
		const acted: Action[] = [];
		const section = mount(acted);
		section.render(viewOf(hand()));
		const play = () =>
			query<HTMLButtonElement>(section.element, '[data-testid="action-play"]');
		expect(play().disabled).toBe(true);

		click(section.element, '.own-hand [data-card="0-8H"]');
		click(section.element, '.own-hand [data-card="0-9H"]');
		click(section.element, '[data-meld="0"] [data-testid="meld-add"]');

		expect(meldIds(section.element)[0]).toEqual([
			"0-5H",
			"0-6H",
			"0-7H",
			"0-8H",
			"0-9H",
		]);
		expect(
			[...section.element.querySelectorAll(".pip.placed")].map((card) =>
				card.getAttribute("data-card"),
			),
		).toEqual(["0-8H", "0-9H"]);
		expect(section.element.querySelector('.own-hand [data-card="0-8H"]')).toBe(
			null,
		);
		// The table melds go back in display order; the engine compares each meld as a set of cards.
		play().click();
		expect(acted).toEqual([
			{
				type: "play",
				melds: [
					["0-5H", "0-6H", "0-7H", "0-8H", "0-9H"],
					["1-9C", "1-9S", "JK2"],
				],
			},
		]);
	});

	it("outlines a meld that the rules refuse, names the reason, and undoes the changes", () => {
		const section = mount([]);
		section.render(viewOf(hand()));
		click(section.element, '.own-hand [data-card="0-KC"]');
		click(section.element, '[data-meld="0"] [data-testid="meld-add"]');

		const meld = query(section.element, '[data-meld="0"]');
		expect(meld.classList.contains("invalid")).toBe(true);
		expect(query(meld, ".meld-problem").textContent).toBe(
			"the cards of a run must share one suit",
		);
		expect(
			query(section.element, '[data-testid="draft-hint"]').textContent,
		).toBe("the cards of a run must share one suit");
		expect(
			query<HTMLButtonElement>(section.element, '[data-testid="action-play"]')
				.disabled,
		).toBe(true);

		click(section.element, '[data-testid="action-reset"]');
		expect(meldIds(section.element)[0]).toEqual(["0-5H", "0-6H", "0-7H"]);
		expect(
			section.element.querySelector('.own-hand [data-card="0-KC"]'),
		).not.toBe(null);
	});

	it("makes a new meld, and takes its cards back to the hand", () => {
		const section = mount([]);
		section.render(viewOf(hand()));
		for (const id of ["0-8H", "0-9H", "0-10H"])
			click(section.element, `.own-hand [data-card="${id}"]`);
		click(section.element, '[data-testid="new-meld"]');
		expect(meldIds(section.element)).toHaveLength(3);
		expect(
			query<HTMLButtonElement>(section.element, '[data-testid="action-play"]')
				.disabled,
		).toBe(false);

		click(section.element, '[data-meld="2"] [data-card="0-10H"]');
		click(section.element, '[data-testid="action-to-hand"]');
		expect(meldIds(section.element)[2]).toEqual(["0-8H", "0-9H"]);
		expect(
			section.element.querySelector('.own-hand [data-card="0-10H"]'),
		).not.toBe(null);
	});

	it("keeps the table cards in place before the viewer's opening", () => {
		const section = mount([]);
		section.render(viewOf(hand({ preset: "gamerules", opened: false })));
		click(section.element, '.own-hand [data-card="0-8H"]');
		click(section.element, '[data-meld="0"] [data-testid="meld-add"]');
		expect(meldIds(section.element)[0]).toEqual(["0-5H", "0-6H", "0-7H"]);
		expect(
			query(section.element, '[data-testid="draft-hint"]').textContent,
		).toBe("before your opening, play only new melds");
	});

	it("loads the solver's suggestion into the draft when assist is on", async () => {
		const asked: TableView[] = [];
		const section = mount([], undefined, {
			suggest: async (view) => {
				asked.push(view);
				return {
					type: "play",
					melds: [
						["0-5H", "0-6H", "0-7H", "0-8H", "0-9H", "0-10H"],
						["1-9C", "JK2", "1-9S"],
					],
				};
			},
		});
		section.render(viewOf(hand()));
		click(section.element, '[data-testid="action-suggest"]');
		await expect.poll(() => meldIds(section.element)[0]?.length).toBe(6);
		expect(asked).toHaveLength(1);
		expect(
			query<HTMLButtonElement>(section.element, '[data-testid="action-play"]')
				.disabled,
		).toBe(false);
	});

	it("says so when the solver finds no play", async () => {
		const section = mount([], undefined, {
			suggest: async () => ({ type: "draw" }),
		});
		section.render(viewOf(hand()));
		click(section.element, '[data-testid="action-suggest"]');
		await expect
			.poll(
				() => query(section.element, '[data-testid="draft-hint"]').textContent,
			)
			.toBe("The solver found no play.");
	});
});

describe("the end of the game", () => {
	it("names the winner, lists the penalties and offers a new game", () => {
		let newGames = 0;
		const section = mount([], undefined, {
			newGame: () => {
				newGames += 1;
			},
		});
		const over = hand({ outcome: { kind: "out", seat: 1 } });
		section.render(
			viewOf({ ...over, hands: [["1-2C"], [], ["JK0"], ["1-QD"]] }),
		);
		const summary = query(section.element, '[data-testid="hand-summary"]');
		expect(summary.checkVisibility()).toBe(true);
		expect(query(summary, ".winner").textContent).toBe("Ben won.");
		expect(
			[...summary.querySelectorAll("tbody tr")].map((row) => [
				row.querySelector("th")?.textContent,
				row.querySelector("td:last-child")?.textContent,
			]),
		).toEqual([
			["Ben", "0"],
			["Ann", "5"],
			["Dee", "10"],
			["Cy", "25"],
		]);
		click(summary, '[data-testid="new-game"]');
		expect(newGames).toBe(1);
	});
});

describe("texts", () => {
	it("asks only for messages that every language translates", () => {
		const asked = new Set<string>();
		const english = translator("en");
		const t: Translate = (message, values) => {
			asked.add(message);
			return english(message, values);
		};
		const section = mount([], t, {
			suggest: async () => undefined,
			newGame: () => {},
		});
		const refused = {
			id: "c1",
			payload: { type: "action", hand: 1, at: 3, action: { type: "draw" } },
			status: "rejected" as const,
		};
		section.render(viewOf(hand(), 3, { t }));
		section.render(
			viewOf(hand(), 3, {
				t,
				failures: [
					refused,
					{ ...refused, id: "c2", reason: "it is not your turn" },
				],
			}),
		);
		click(section.element, '.own-hand [data-card="0-KC"]');
		click(section.element, '[data-meld="0"] [data-testid="meld-add"]');
		click(section.element, '[data-meld="0"] [data-card="0-KC"]');
		click(section.element, ".sort-toggle");
		section.setBotControls(true, ["2", "4"]);
		section.setPlayerAutoplay(true, false, false, "");
		section.setPlayerAutoplay(true, true, false, "");
		section.render(
			viewOf(hand({ preset: "gamerules", opened: false }), 4, { t }),
		);
		section.render(viewOf(hand({ turn: 0 }), 5, { t }));
		section.render(viewOf(hand({ outcome: { kind: "blocked" } }), 6, { t }));
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
