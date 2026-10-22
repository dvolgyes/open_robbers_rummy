import { describe, expect, it } from "vitest";
import {
	catalogKeys,
	detectLocale,
	type Locale,
	translatedMessageKeys,
	translator,
} from "../../src/i18n";

const newLocales = [
	"es",
	"pt",
	"fr",
	"it",
	"nl",
] as const satisfies readonly Locale[];

describe("localization", () => {
	it("detects each supported language from regional browser preferences", () => {
		const cases = [
			["es-MX", "es"],
			["pt-BR", "pt"],
			["fr-CA", "fr"],
			["it-IT", "it"],
			["nl-NL", "nl"],
		] as const;

		for (const [preference, locale] of cases) {
			expect(detectLocale([preference], undefined)).toBe(locale);
		}
	});

	it("provides every existing translation key in each catalog", () => {
		const expected = [...translatedMessageKeys].sort();
		expect(new Set(expected).size).toBe(expected.length);

		for (const locale of ["de", "hu", "no", ...newLocales] as const) {
			expect([...catalogKeys(locale)].sort()).toEqual(expected);
		}
	});

	it("labels autoplay as a bot option in every supported language", () => {
		const labels = {
			en: "Enable autoplay (bot)",
			de: "Autoplay (Bot) aktivieren",
			hu: "Automatikus játék (bot) bekapcsolása",
			no: "Slå på automatisk spilling (bot)",
			es: "Activar juego automático (bot)",
			pt: "Ativar jogo automático (bot)",
			fr: "Activer le jeu automatique (bot)",
			it: "Attiva il gioco automatico (bot)",
			nl: "Automatisch spelen (bot) aanzetten",
		} as const satisfies Record<Locale, string>;

		for (const [locale, label] of Object.entries(labels) as [
			Locale,
			string,
		][]) {
			expect(translator(locale)("Enable autoplay (bot)")).toBe(label);
		}
	});

	it("translates the canasta table texts, with their values, in each language", () => {
		expect(translator("de")("{count} cards", { count: 3 })).toBe("3 Karten");
		expect(translator("hu")("Hand {number}", { number: 2 })).toBe(
			"2. leosztás",
		);
		expect(
			translator("fr")("{name} ({side}) went out.", {
				name: "Ann",
				side: "N-S",
			}),
		).toBe("Ann (N-S) sort.");
		for (const locale of ["de", "hu", "no", ...newLocales] as const)
			expect(
				translator(locale)("Your turn: draw from the stock, or take the pile."),
			).not.toBe("Your turn: draw from the stock, or take the pile.");
	});
});
