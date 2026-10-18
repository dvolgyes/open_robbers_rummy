import { englishTranslator, type Translate } from "../i18n";
import { BOT_MODELS, type BotModel, botModelLabel } from "../protocol";
import { button, el } from "./dom";

export interface ModelPriorityControl {
	readonly element: HTMLOListElement;
	setValue(order: readonly BotModel[]): void;
	value(): BotModel[];
}

export function modelPriorityControl(
	initialOrder: readonly BotModel[],
	t: Translate = englishTranslator,
): ModelPriorityControl {
	let order = [...initialOrder];
	const element = el("ol", {
		className: "model-priority-list",
		attrs: { "aria-label": t("Bot model priority") },
	});

	const render = (): void => {
		element.replaceChildren(
			...order.map((model, index) => {
				const item = el(
					"li",
					{ attrs: { "data-model": model } },
					el(
						"span",
						{ className: "model-priority-label" },
						`${index + 1}. ${botModelLabel(model)} · ${t(index === 0 ? "Primary" : index === 1 ? "Fallback" : "Backup")}`,
					),
				);
				const move = (offset: -1 | 1): void => {
					const target = index + offset;
					if (target < 0 || target >= order.length) return;
					[order[index], order[target]] = [
						order[target] as BotModel,
						order[index] as BotModel,
					];
					render();
				};
				item.append(
					button("↑", () => move(-1), {
						attrs: {
							"aria-label": t("Move {model} up", {
								model: botModelLabel(model),
							}),
							...(index === 0 ? { disabled: "" } : {}),
						},
					}),
					button("↓", () => move(1), {
						attrs: {
							"aria-label": t("Move {model} down", {
								model: botModelLabel(model),
							}),
							...(index === order.length - 1 ? { disabled: "" } : {}),
						},
					}),
				);
				return item;
			}),
		);
	};

	const isValidOrder = (value: readonly BotModel[]): boolean =>
		value.length === BOT_MODELS.length &&
		new Set(value).size === BOT_MODELS.length &&
		value.every((model) => (BOT_MODELS as readonly string[]).includes(model));

	if (!isValidOrder(order))
		throw new Error(
			"bot model priority must include each supported model once",
		);
	render();
	return {
		element,
		setValue(value) {
			if (!isValidOrder(value))
				throw new Error(
					"bot model priority must include each supported model once",
				);
			order = [...value];
			render();
		},
		value: () => [...order],
	};
}
