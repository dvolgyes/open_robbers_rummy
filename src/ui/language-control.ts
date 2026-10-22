import type { AppDeps } from "./deps";
import { el } from "./dom";

const LOCALE_STORAGE_KEY = "open_canasta.locale";

/** The language picker. A change stores the choice in this browser and reloads the page in that language. */
export function languageControl(deps: AppDeps): HTMLElement {
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
