import {
	type Action,
	type Card,
	type HandView,
	isCanasta,
	type Meld,
} from "../canasta";

/** A card as the model reads it: rank then suit letter, for example "10H", "2S" or "JK". */
export function cardLabel(card: Pick<Card, "rank" | "suit">): string {
	return `${card.rank}${card.suit ?? ""}`;
}

/** Every card the seat can name by id: its own hand, the pile, and both sides' melds and red threes. */
export function cardsById(view: HandView): ReadonlyMap<string, Card> {
	const cards = new Map<string, Card>();
	const add = (list: readonly Card[]) => {
		for (const card of list) cards.set(card.id, card);
	};
	add(view.own);
	add(view.pile);
	for (const team of view.teams) {
		add(team.redThrees);
		for (const meld of team.melds) add(meld.cards);
	}
	return cards;
}

export function meldLabel(meld: Meld, view: HandView): string {
	const canasta = isCanasta(meld, view.rules) ? ", canasta" : "";
	return `${meld.rank}s (${meld.cards.map(cardLabel).join(" ")}${canasta})`;
}

function labelsOf(ids: readonly string[], cards: ReadonlyMap<string, Card>) {
	return ids.map((id) => {
		const card = cards.get(id);
		return card ? cardLabel(card) : id;
	});
}

/** One legal action in words, with the card labels filled in from the seat's view. */
export function actionLabel(action: Action, view: HandView): string {
	const cards = cardsById(view);
	switch (action.type) {
		case "draw":
			return view.rules.drawCount === 1
				? "Draw a card from the stock"
				: `Draw ${view.rules.drawCount} cards from the stock`;
		case "takePile": {
			const top = view.pile.at(-1);
			// Onto an existing meld the top card can go alone, with no hand card.
			const using =
				action.cards.length === 0
					? ""
					: ` with ${labelsOf(action.cards, cards).join(" ")}`;
			const topText = top ? cardLabel(top) : "";
			const target =
				action.extend === undefined
					? "as a new meld"
					: `added to meld ${action.extend}`;
			return `Take the pile (top ${topText})${using}, ${target}`;
		}
		case "meld":
			return `Lay down a meld of ${labelsOf(action.cards, cards).join(" ")}`;
		case "extend":
			return `Add ${labelsOf(action.cards, cards).join(" ")} to meld ${action.meldId}`;
		case "discard":
			return `Discard ${labelsOf([action.card], cards)[0]}`;
		case "resetTurn":
			return "Take back this turn's melds and reset the turn";
	}
}
