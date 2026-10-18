import { parseRoute, tableFragment } from "../p2p/link";
import {
	bookmarkQuery,
	parseBookmark,
	parseRoomSetup,
	parseSelectedPlayer,
	selectedPlayerQuery,
} from "./bookmark";
import { showCreate } from "./create";
import type { AppDeps, Dispose, Navigation } from "./deps";
import { copyToClipboard, el } from "./dom";
import { showLinkProblem, showTable } from "./join";

const LOCALE_STORAGE_KEY = "opentrick.locale";

function languageControl(deps: AppDeps): HTMLElement {
	const select = el("select", {
		attrs: { "aria-label": deps.t("Language"), title: deps.t("Language") },
	});
	select.disabled = deps.browser === undefined;
	for (const [value, label] of [
		["auto", `🌐 ${deps.t("Automatic")}`],
		["en", "🇬🇧 English"],
		["de", "🇩🇪 Deutsch"],
		["hu", "🇭🇺 Magyar"],
		["no", "🇳🇴 Norsk (bokmål)"],
		["es", "🇪🇸 Español"],
		["pt", "🇵🇹 Português"],
		["fr", "🇫🇷 Français"],
		["it", "🇮🇹 Italiano"],
		["nl", "🇳🇱 Nederlands"],
	] as const) {
		const option = el("option", { attrs: { value } }, label);
		option.selected =
			value === "auto" ? deps.savedLocale === undefined : value === deps.locale;
		select.append(option);
	}
	select.addEventListener("change", () => {
		if (select.value === "auto") deps.browser?.removeItem(LOCALE_STORAGE_KEY);
		else deps.browser?.setItem(LOCALE_STORAGE_KEY, select.value);
		location.reload();
	});
	return el("label", { className: "language-control" }, select);
}

/**
 * Routes on the URL fragment: empty → create, `#v=p2p-v1&k=<key>` → the table. The query prefills the create screen
 * and can select a seat in a table. Leaving a screen disposes it, so a previous table's mesh and timers stop before
 * the next table starts.
 */
export function startApp(root: HTMLElement, deps: AppDeps): void {
	root.before(languageControl(deps));
	let dispose: Dispose | undefined;
	const navigation: Navigation = {
		createNew: () => {
			location.hash = "";
		},
		rememberSeat: (seat) => {
			const query = selectedPlayerQuery(location.search, seat);
			history.replaceState(
				null,
				"",
				`${location.pathname}?${query}${location.hash}`,
			);
		},
	};

	const route = (): void => {
		dispose?.();
		dispose = undefined;
		const target = parseRoute(location.hash);
		switch (target.kind) {
			case "create":
				dispose = showCreate(
					root,
					deps,
					parseBookmark(location.search),
					(key, config, seat, hostBots) => {
						// Keep setup data and the selected seat in the address; replaceState fires no hashchange.
						const query = bookmarkQuery(config.names, seat, config.botSetup);
						const sharedUrl = new URL(deps.pageUrl());
						sharedUrl.search = query;
						sharedUrl.hash = tableFragment(key);
						const autoCopy = copyToClipboard(sharedUrl.toString());
						history.replaceState(
							null,
							"",
							`${location.pathname}?${query}${tableFragment(key)}`,
						);
						dispose?.();
						dispose = showTable(
							root,
							deps,
							key,
							true,
							navigation,
							parseSelectedPlayer(location.search),
							undefined,
							autoCopy,
							hostBots,
						);
					},
				);
				return;
			case "table": {
				dispose = showTable(
					root,
					deps,
					target.key,
					false,
					navigation,
					parseSelectedPlayer(location.search),
					parseRoomSetup(location.search),
				);
				return;
			}
			case "legacy":
				dispose = showLinkProblem(
					root,
					navigation,
					deps.t(
						"This link is for the old version. Ask the table creator for a new link.",
					),
					deps.t,
				);
				return;
			case "incompatible":
				dispose = showLinkProblem(
					root,
					navigation,
					deps.t(
						"This link is for another version of the app. Reload the page, or ask the table creator for a new link.",
					),
					deps.t,
				);
				return;
			case "invalid":
				dispose = showLinkProblem(
					root,
					navigation,
					deps.t("This link is not valid. Check that you copied all of it."),
					deps.t,
				);
				return;
		}
	};

	window.addEventListener("hashchange", route);
	route();
}
