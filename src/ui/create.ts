import type { Bookmark } from "../bookmark";
import { rummyModule } from "../game/rummy";
import { newCommandId } from "../ids";
import { newTableKey } from "../p2p/link";
import { CANNOT_STORE, createTable, tableIdentity } from "../p2p/table";
import {
	DEFAULT_BOT_SETUP,
	parseBotSetup,
	type RoomConfig,
	SEAT_NAMES,
	SEATS,
	type Seat,
} from "../protocol";
import type { AppDeps, Dispose } from "./deps";
import { el } from "./dom";
import { checkCreateFields, DEFAULT_CREATE_FIELDS, storageText } from "./model";

/**
 * The create screen, prefilled from a bookmark (names and the creator's seat). Calls `onCreated` with the table key,
 * its config and the creator's seat only after the table is stored in this browser.
 */
export function showCreate(
	root: HTMLElement,
	deps: AppDeps,
	prefill: Bookmark,
	onCreated: (
		key: string,
		config: RoomConfig,
		seat: Seat,
		hostBots: boolean,
	) => void,
): Dispose {
	let disposed = false;
	const nameFields = {} as Record<Seat, HTMLInputElement>;
	const meChoices = {} as Record<Seat, HTMLInputElement>;
	const botChoices = {} as Record<Seat, HTMLInputElement>;
	const host = prefill.host ?? DEFAULT_CREATE_FIELDS.seat;
	const rows = SEATS.map((seat) => {
		const name = el("input", {
			attrs: {
				type: "text",
				name: `name-${seat}`,
				autocomplete: "off",
				"aria-label": `${deps.t(SEAT_NAMES[seat])} ${deps.t("Name").toLowerCase()}`,
			},
		});
		name.value = prefill.names[seat] ?? DEFAULT_CREATE_FIELDS.names[seat];
		nameFields[seat] = name;
		const me = el("input", {
			attrs: { type: "radio", name: "me", value: seat },
		});
		const bot = el("input", {
			attrs: { type: "checkbox", name: `bot-${seat}`, value: seat },
		});
		me.checked = seat === host;
		bot.checked = (prefill.botSetup ?? DEFAULT_BOT_SETUP).seats.includes(seat);
		meChoices[seat] = me;
		botChoices[seat] = bot;
		return el(
			"tr",
			{},
			el("th", { attrs: { scope: "row" } }, deps.t(SEAT_NAMES[seat])),
			el("td", {}, name),
			el("td", {}, el("label", {}, me, ` ${deps.t("This is me")}`)),
			el("td", {}, el("label", {}, bot, ` ${deps.t("Bot")}`)),
		);
	});

	const errors = el("ul", {
		className: "errors",
		attrs: { role: "alert", "data-testid": "errors" },
	});
	const submit = el(
		"button",
		{ attrs: { type: "submit", "data-testid": "create" } },
		deps.t("Create game"),
	);
	const form = el(
		"form",
		{ className: "create" },
		el(
			"table",
			{},
			el(
				"thead",
				{},
				el(
					"tr",
					{},
					el("th", { attrs: { scope: "col" } }, deps.t("Seat")),
					el("th", { attrs: { scope: "col" } }, deps.t("Name")),
					el("th", { attrs: { scope: "col" } }, deps.t("You")),
					el("th", { attrs: { scope: "col" } }, deps.t("Bot")),
				),
			),
			el("tbody", {}, ...rows),
		),
		errors,
		submit,
	);

	const showErrors = (messages: readonly string[]): void => {
		errors.replaceChildren(...messages.map((text) => el("li", {}, text)));
	};

	// Only a browser that keeps data can hold the first copy of the table (plan §4.3).
	if (!deps.storage.persistent) {
		showErrors([deps.t(CANNOT_STORE)]);
		submit.disabled = true;
	}

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const names = {} as Record<Seat, string>;
		for (const seat of SEATS) names[seat] = nameFields[seat].value;
		const seat = SEATS.find((choice) => meChoices[choice].checked) ?? "";
		const check = checkCreateFields({ names, seat }, deps.t);
		if (!check.ok) {
			showErrors(check.errors.map((error) => deps.t(error)));
			return;
		}
		const botSeats = SEATS.filter((item) => botChoices[item].checked);
		// The bots use the solver; the model fields stay for the kept OpenRouter transport.
		const botSetup = parseBotSetup({ ...DEFAULT_BOT_SETUP, seats: botSeats });
		if (botSetup === undefined) return;
		const config: RoomConfig = { ...check.config, botSetup };
		showErrors([]);
		submit.disabled = true;
		submit.textContent = deps.t("Creating…");
		void create(config, check.seat, botSeats.length > 0);
	});

	async function create(
		config: RoomConfig,
		seat: Seat,
		hostBots: boolean,
	): Promise<void> {
		const key = newTableKey();
		const identity = await tableIdentity(key, deps.browser);
		if (disposed) return;
		const created = await createTable({
			storage: deps.storage,
			identity,
			seat,
			config,
			module: rummyModule,
			newId: newCommandId,
			clock: deps.clock,
			memory: deps.memory,
			hostBots,
		});
		if (disposed) return;
		if (!created.ok) {
			showErrors([
				`${deps.t("Could not create the game")}: ${storageText(created.code, deps.t)}`,
			]);
			submit.disabled = false;
			submit.textContent = deps.t("Create game");
			return;
		}
		void deps.persist();
		onCreated(key, config, seat, hostBots);
	}

	root.replaceChildren(
		el(
			"section",
			{ className: "create-screen" },
			el("h1", {}, deps.t("Create game")),
			el(
				"p",
				{},
				deps.t(
					"Enter the four players. Choose your seat. Your browser hosts first; anyone at the table can take over.",
				),
			),
			form,
		),
	);
	return () => {
		disposed = true;
	};
}
