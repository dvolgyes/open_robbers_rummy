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
import "../../src/ui/style.css";
import { tableSection } from "../../src/ui/table";
import {
	type CardView,
	type MeldView,
	type SideView,
	type TableView,
	type TableViewInput,
	tableView,
} from "../../src/ui/table-model";
import { pairPickupMatch } from "../unit/canasta-fixtures";

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

	it("shows the seat letters and the side names in the viewer's language, with whose side each is", () => {
		const hu = translator("hu");
		const section = mount([], hu);
		const view = turnView(afterDraw(), 1, { t: hu });
		section.render(view);
		const avatars = [
			...section.element.querySelectorAll<HTMLElement>(".tile .avatar"),
		].map((avatar) => avatar.textContent);
		expect(avatars).toHaveLength(3);
		for (const letter of avatars)
			expect(["É", "K", "D", "Ny"]).toContain(letter);
		const texts = (selector: string): (string | null)[] =>
			[...section.element.querySelectorAll<HTMLElement>(selector)].map(
				(node) => node.textContent,
			);
		const expected = view.sides[0]?.mine
			? ["É-D (miénk)", "K-Ny (övék)"]
			: ["É-D (övék)", "K-Ny (miénk)"];
		expect(texts(".side-title")).toEqual(expected);
		expect(texts(".score-strip .side-label")).toEqual(expected);
	});

	it("shows the opponents' melds above the viewer's, each meld as columns of at most 8 cards", () => {
		const card = (index: number): CardView => ({
			id: `7C-${index}`,
			rank: "7",
			suit: "C",
			text: "7♣",
		});
		const meld = (id: string, size: number): MeldView => ({
			id,
			rank: "7",
			cards: Array.from({ length: size }, (_, index) => card(index)),
			canasta: size >= 7,
		});
		const base = turnView(afterDraw(), 1);
		for (const mineFirst of [true, false]) {
			const side = (index: 0 | 1): SideView => ({
				...base.sides[index],
				mine: (index === 0) === mineFirst,
				melds: [meld(`m${index}a`, 3), meld(`m${index}b`, 11)],
			});
			const sides = [side(0), side(1)] as const;
			const section = mount([]);
			section.render({ ...base, sides });
			const blocks = [
				...section.element.querySelectorAll<HTMLElement>(".side-block"),
			];
			expect(blocks.map((block) => block.dataset.mine)).toEqual([
				"false",
				"true",
			]);
			const [theirs, ours] = blocks.map((block) =>
				block.getBoundingClientRect(),
			);
			expect(theirs?.bottom).toBeLessThanOrEqual(ours?.top ?? 0);
			const long = section.element.querySelector('[data-meld="m0b"]');
			const columns = [...(long?.querySelectorAll(".meld-column") ?? [])];
			expect(
				columns.map((column) => column.querySelectorAll(".pip").length),
			).toEqual([8, 3]);
			const pips = [...(columns[0]?.querySelectorAll(".pip") ?? [])].map(
				(pip) => pip.getBoundingClientRect(),
			);
			for (const [index, rect] of pips.entries()) {
				const above = pips[index - 1];
				if (above !== undefined)
					expect(rect.top).toBeGreaterThanOrEqual(above.bottom - 1);
			}
			const second = columns[1]?.getBoundingClientRect();
			expect(second?.left).toBeGreaterThanOrEqual(
				columns[0]?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
			);
			section.element.remove();
		}
	});

	it("offers to take the pile with a pair from the hand before any card is selected", () => {
		const acted: Action[] = [];
		const section = mount(acted);
		section.render(turnView(pairPickupMatch(), 0));
		const pickup = section.element.querySelector<HTMLButtonElement>(
			'[data-testid="action-takePile"]',
		);
		expect(pickup).not.toBeNull();
		expect(
			section.element.querySelector(".own-hand button.card.selected"),
		).toBeNull();
		pickup?.click();
		expect(acted.map((action) => action.type)).toEqual(["takePile"]);
	});

	it("frames the cards that this turn drew or took, and only those", () => {
		const hu = translator("hu");
		const section = mount([], hu);
		const match = afterDraw();
		const view = turnView(match, 1, { t: hu });
		const drawnId = match.hand.turnTaken?.[0];
		expect(drawnId).toBeDefined();
		section.render(view);
		const cards = [
			...section.element.querySelectorAll<HTMLButtonElement>(
				".own-hand button.card",
			),
		];
		const marked = cards.filter((card) => card.classList.contains("taken"));
		expect(marked.map((card) => card.dataset.card)).toEqual([drawnId]);
		expect(marked[0]?.title).toBe("Új ebben a körben");
		const plain = cards.find((card) => !card.classList.contains("taken"));
		expect(plain).toBeDefined();
		const frame = (card: Element | undefined) =>
			card === undefined ? "" : getComputedStyle(card).boxShadow;
		expect(frame(marked[0])).not.toBe(frame(plain));
		expect(getComputedStyle(marked[0] as Element, "::after").content).not.toBe(
			"none",
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
