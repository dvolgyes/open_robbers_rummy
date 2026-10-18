import { describe, expect, it } from "vitest";
import {
	detectLocale,
	type Locale,
	translatedMessageKeys,
	translator,
} from "../../src/i18n";
import { additionalCatalogs } from "../../src/i18n-translations";

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

	it("provides every existing translation key in each new catalog", () => {
		const expected = [...translatedMessageKeys].sort();
		expect(new Set(expected).size).toBe(expected.length);

		for (const locale of newLocales) {
			expect(Object.keys(additionalCatalogs[locale]).sort()).toEqual(expected);
		}
	});

	it("translates bridge terms and substitutes message values", () => {
		const cases = [
			["es", "Palo de triunfo", "Contrato: faltan 2 / 13"],
			["pt", "Naipe de trunfo", "Contrato: faltam 2 / 13"],
			["fr", "Couleur d'atout", "Contrat : 2 / 13 nécessaires"],
			["it", "Colore d'atout", "Contratto: servono 2 / 13"],
			["nl", "Troefkleur", "Contract: 2 / 13 nodig"],
		] as const satisfies readonly (readonly [Locale, string, string])[];

		for (const [locale, trump, contract] of cases) {
			const t = translator(locale);
			expect(t("Trump suit")).toBe(trump);
			expect(
				t("Contract needs {needed} / {remaining}", {
					needed: 2,
					remaining: 13,
				}),
			).toBe(contract);
		}
	});

	it("translates declarer and dummy in every supported language", () => {
		const roles = [
			["de", "Alleinspieler", "Tisch"],
			["hu", "Felvevő", "Asztal"],
			["no", "Spillefører", "Blindemann"],
			["es", "Declarante", "Muerto"],
			["pt", "Declarante", "Morto"],
			["fr", "Déclarant", "Mort"],
			["it", "Dichiarante", "Morto"],
			["nl", "Leider", "Blinde"],
		] as const satisfies readonly (readonly [Locale, string, string])[];

		for (const [locale, declarer, dummy] of roles) {
			const t = translator(locale);
			expect(t("Declarer")).toBe(declarer);
			expect(t("Dummy")).toBe(dummy);
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
});
