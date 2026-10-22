import { analyzeMeld, cardOf, type JokerRole, type MeldRules } from "../rummy";

/**
 * The player's working copy of the table in a turn: the screen moves cards between the hand and the melds here, and
 * sends the melds as one play when the engine accepts them.
 *
 * Table cards never go back to a hand. Before the player's opening, the table is locked: its cards stay where they
 * are, and the hand cards go only into new melds.
 */
export interface Draft {
	/** The table melds as the turn found them, then the new melds; a meld that becomes empty is dropped. */
	readonly melds: readonly (readonly string[])[];
	/** The hand cards that are not on the table. */
	readonly hand: readonly string[];
	/** The table and the hand at the start of the draft. */
	readonly start: {
		readonly melds: readonly (readonly string[])[];
		readonly hand: readonly string[];
	};
	/** The table is locked until the player's opening. */
	readonly locked: boolean;
}

/** A meld of the draft, by index, or a new meld. */
export type DraftTarget = number | "new";

export type DraftMove =
	| { readonly ok: true; readonly draft: Draft }
	| { readonly ok: false; readonly reason: string };

export type MeldStatus =
	| {
			readonly ok: true;
			/** The cards in display order. */
			readonly order: readonly string[];
			/** The card that a joker stands for, by joker id. */
			readonly jokerAs: Readonly<Record<string, JokerRole>>;
	  }
	| { readonly ok: false; readonly reason: string };

export function newDraft(
	melds: readonly (readonly string[])[],
	hand: readonly string[],
	locked: boolean,
): Draft {
	return { melds, hand, start: { melds, hand }, locked };
}

const refuse = (reason: string): DraftMove => ({ ok: false, reason });

/** True for a card that was on the table when the draft started. */
function fromTable(draft: Draft, id: string): boolean {
	return draft.start.melds.some((meld) => meld.includes(id));
}

/** Moves the cards, from the hand or from melds, to the end of the target meld. */
export function moveCards(
	draft: Draft,
	cards: readonly string[],
	target: DraftTarget,
): DraftMove {
	if (cards.length === 0) return refuse("select the cards to move");
	if (new Set(cards).size !== cards.length)
		return refuse("a card is selected twice");
	for (const id of cards)
		if (!draft.hand.includes(id) && !draft.melds.some((m) => m.includes(id)))
			return refuse("a selected card is not in the draft");
	if (target !== "new" && draft.melds[target] === undefined)
		return refuse("the target meld is not on the table");
	if (draft.locked) {
		if (cards.some((id) => fromTable(draft, id)))
			return refuse("before your opening, the table cards stay where they are");
		if (target !== "new" && target < draft.start.melds.length)
			return refuse("before your opening, play only new melds");
	}
	const moving = new Set(cards);
	const kept = draft.melds.map((meld) => meld.filter((id) => !moving.has(id)));
	const targetCards = target === "new" ? [] : (kept[target] ?? []);
	const melds = kept.map((meld, at) =>
		at === target ? [...targetCards, ...cards] : meld,
	);
	if (target === "new") melds.push([...cards]);
	return {
		ok: true,
		draft: {
			...draft,
			melds: melds.filter((meld) => meld.length > 0),
			hand: draft.hand.filter((id) => !moving.has(id)),
		},
	};
}

/** Takes cards that came from the hand off the table, back into the hand. */
export function returnToHand(
	draft: Draft,
	cards: readonly string[],
): DraftMove {
	if (cards.length === 0) return refuse("select the cards to move");
	if (cards.some((id) => !draft.start.hand.includes(id)))
		return refuse("table cards cannot go into a hand");
	const moving = new Set(cards.filter((id) => !draft.hand.includes(id)));
	return {
		ok: true,
		draft: {
			...draft,
			melds: draft.melds
				.map((meld) => meld.filter((id) => !moving.has(id)))
				.filter((meld) => meld.length > 0),
			hand: [...draft.hand, ...moving],
		},
	};
}

/**
 * Replaces the draft's melds with a play, such as the solver's suggestion. The play must keep every table card of the
 * draft's start and take its other cards from the start hand; the hand keeps the rest.
 */
export function loadPlay(
	draft: Draft,
	melds: readonly (readonly string[])[],
): DraftMove {
	const cards = melds.flat();
	const tableCards = draft.start.melds.flat();
	const fits =
		new Set(cards).size === cards.length &&
		tableCards.every((id) => cards.includes(id)) &&
		cards.every(
			(id) => tableCards.includes(id) || draft.start.hand.includes(id),
		);
	if (!fits) return refuse("the suggestion does not fit the table");
	const placed = new Set(cards);
	return {
		ok: true,
		draft: {
			...draft,
			melds,
			hand: draft.start.hand.filter((id) => !placed.has(id)),
		},
	};
}

/** The hand cards that the draft puts on the table. */
export function placedCards(draft: Draft): string[] {
	return draft.start.hand.filter((id) => !draft.hand.includes(id));
}

/** True when the draft differs from the table and the hand at its start. */
export function changed(draft: Draft): boolean {
	return (
		draft.melds.length !== draft.start.melds.length ||
		draft.melds.some(
			(meld, at) =>
				meld.length !== draft.start.melds[at]?.length ||
				meld.some((id, index) => draft.start.melds[at]?.[index] !== id),
		)
	);
}

/** Each meld of the draft: its display order, or why it is not a meld. */
export function meldStatus(
	meld: readonly string[],
	rules: MeldRules,
): MeldStatus {
	const check = analyzeMeld(meld.map(cardOf), rules);
	if (!check.ok) return check;
	return { ok: true, order: check.order, jokerAs: check.jokerAs };
}
