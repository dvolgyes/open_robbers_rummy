import { withCanastaTexts } from "./i18n-canasta";
import { additionalCatalogs } from "./i18n-translations";

export type Locale =
	| "en"
	| "de"
	| "hu"
	| "no"
	| "es"
	| "pt"
	| "fr"
	| "it"
	| "nl";

export type Translate = (
	message: string,
	values?: Readonly<Record<string, string | number>>,
) => string;

type Catalog = Readonly<Record<string, string>>;

export const englishTranslator: Translate = (message, values = {}) =>
	message.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, key: string) =>
		String(values[key] ?? placeholder),
	);

const catalogs: Readonly<Record<Exclude<Locale, "en">, Catalog>> =
	withCanastaTexts({
		de: {
			Language: "Sprache",
			Automatic: "Automatisch",
			North: "Norden",
			East: "Osten",
			South: "Süden",
			West: "Westen",
			N: "N",
			E: "O",
			S: "S",
			W: "W",
			and: "und",
			"Room lobby": "Raumlobby",
			"Waiting for {players} to come back":
				"Warten auf die Rückkehr von {players}",
			"CONNECTING TO HOST": "VERBINDUNG ZUM HOST",
			"Enable autoplay (bot)": "Autoplay (Bot) aktivieren",
			"Autoplay is using this host's OpenRouter key.":
				"Autoplay verwendet den OpenRouter-Schlüssel dieses Hosts.",
			"Disable autoplay": "Autoplay deaktivieren",
			"Stop autoplay": "Autoplay stoppen",
			"Sending autoplay request…": "Autoplay-Anfrage wird gesendet…",
			"The host is playing your seat.": "Der Host spielt auf deinem Platz.",
			"Autoplay stopped.": "Autoplay gestoppt.",
			"Autoplay is unavailable on this host.":
				"Autoplay ist bei diesem Host nicht verfügbar.",
			"Autoplay request failed.": "Die Autoplay-Anfrage ist fehlgeschlagen.",
			"Autoplay stopped by the host.": "Der Host hat Autoplay gestoppt.",
			"Switch to bot": "Zu Bot wechseln",
			"Switch to player": "Zu Spieler wechseln",
			"Open this page over HTTPS.": "Öffne diese Seite über HTTPS.",
			"This browser cannot make calls.":
				"Dieser Browser kann keine Anrufe tätigen.",
			Connecting: "Verbindung wird hergestellt",
			"Choose your seat": "Wähle deinen Platz",
			"Create new game": "Neues Spiel erstellen",
			"Creating…": "Wird erstellt…",
			"Optional automated players": "Optionale automatisierte Spieler",
			Seat: "Platz",
			Name: "Name",
			You: "Du",
			Bot: "Bot",
			"This is me": "Das bin ich",
			"OpenRouter API key": "OpenRouter-API-Schlüssel",
			"Model priority: the first model is primary; after a server error, the bot tries the next model.":
				"Modellreihenfolge: Das erste Modell ist das Hauptmodell. Nach einem Serverfehler versucht der Bot das nächste Modell.",
			Retries: "Wiederholungen",
			"Wait between retries (seconds)":
				"Wartezeit zwischen Wiederholungen (Sekunden)",
			"Check the bot models, retry count, and retry delay.":
				"Prüfe die Bot-Modelle, die Anzahl der Wiederholungen und die Wartezeit.",
			"Enter an OpenRouter API key to run bot seats in this browser.":
				"Gib einen OpenRouter-API-Schlüssel ein, um Bots in diesem Browser zu verwenden.",
			"This browser could not store the OpenRouter API key.":
				"Dieser Browser konnte den OpenRouter-API-Schlüssel nicht speichern.",
			"Enter the four players. Choose your seat. Your browser hosts first; anyone at the table can take over.":
				"Gib die vier Spielernamen ein und wähle deinen Platz. Dein Browser hostet zuerst; alle am Tisch können übernehmen.",
			"This link is for the old version. Ask the table creator for a new link.":
				"Dieser Link gehört zu einer alten Version. Bitte den Ersteller des Tisches um einen neuen Link.",
			"This link is for another version of the app. Reload the page, or ask the table creator for a new link.":
				"Dieser Link gehört zu einer anderen App-Version. Lade die Seite neu oder bitte den Ersteller um einen neuen Link.",
			"This link is not valid. Check that you copied all of it.":
				"Dieser Link ist ungültig. Prüfe, ob du ihn vollständig kopiert hast.",
			"All seats are taken.": "Alle Plätze sind belegt.",
			"The game has expired or is no longer available":
				"Dieses Spiel ist abgelaufen oder nicht mehr verfügbar.",
			"Make me the host": "Mich zum Host machen",
			"Try seat again": "Platz erneut versuchen",
			Reload: "Neu laden",
			Network: "Netzwerk",
			"Copy link": "Link kopieren",
			Players: "Spieler",
			Messages: "Nachrichten",
			"Insufficient OpenRouter balance. Bots are paused until you update the API key or balance.":
				"OpenRouter-Guthaben reicht nicht aus. Bots sind pausiert, bis du den API-Schlüssel oder das Guthaben aktualisierst.",
			"The bot request failed. Check the model and resume bots.":
				"Die Bot-Anfrage ist fehlgeschlagen. Prüfe das Modell und setze die Bots fort.",
			"Bots paused.": "Bots pausiert.",
			"Running {count} bot seat(s) with {model}.":
				"{count} Bot-Platz/-Plätze aktiv mit {model}.",
			Online: "Online",
			Offline: "Offline",
			Free: "Frei",
			Sending: "Wird gesendet",
			"Waiting for the host": "Warte auf den Host",
			"Not accepted": "Nicht angenommen",
			"Undone after a host change": "Nach einem Hostwechsel rückgängig gemacht",
			"No bot seats are active.": "Keine Bot-Plätze aktiv.",
			Primary: "Primär",
			Fallback: "Ausweichmodell",
			Backup: "Reserve",
			"Bot model priority": "Bot-Modellreihenfolge",
			"Move {model} up": "{model} nach oben verschieben",
			"Move {model} down": "{model} nach unten verschieben",
			"Join call": "Anruf beitreten",
			"Leave call": "Anruf verlassen",
			"Rejoin the call": "Anruf erneut beitreten",
			Optional: "Optional",
			"room call": "Raumanruf",
			"Game actions": "Spielaktionen",
			"Send mic": "Mikrofon senden",
			"Send mic audio": "Mikrofonton senden",
			"Hear others": "Andere hören",
			"Hear others: receive audio": "Andere hören: Ton empfangen",
			"Send camera": "Kamera senden",
			"Send camera video": "Kameravideo senden",
			"Camera preview": "Kameravorschau",
			"Choose camera": "Kamera auswählen",
			"The camera preview is no longer available.":
				"Die Kameravorschau ist nicht mehr verfügbar.",
			"Starting camera preview…": "Kameravorschau wird gestartet…",
			"No camera is available.": "Keine Kamera verfügbar.",
			"Camera access was denied.": "Der Kamerazugriff wurde verweigert.",
			"The camera is in use or unavailable.":
				"Die Kamera wird verwendet oder ist nicht verfügbar.",
			"The camera could not be started.":
				"Die Kamera konnte nicht gestartet werden.",
			"Camera {number}": "Kamera {number}",
			"See cameras": "Kameras ansehen",
			"See cameras: receive video": "Kameras ansehen: Video empfangen",
			"Another tab changed the table at the same time. Reload the page.":
				"Ein anderer Tab hat den Tisch gleichzeitig geändert. Lade die Seite neu.",
			"This browser could not save the table.":
				"Dieser Browser konnte den Tisch nicht speichern.",
			"This browser does not store data ({problem}). You can play, but you cannot become the host, and a reload loses this copy of the table.":
				"Dieser Browser speichert keine Daten ({problem}). Du kannst spielen, aber nicht Host werden. Beim Neuladen geht diese Tischkopie verloren.",
			"Too many messages are waiting. Wait until the host is connected.":
				"Zu viele Nachrichten warten. Warte, bis der Host verbunden ist.",
			"Another player took this seat. Choose another one.":
				"Ein anderer Spieler hat diesen Platz genommen. Wähle einen anderen.",
			"This seat cannot be taken.": "Dieser Platz kann nicht genommen werden.",
			"The host could not save the table. Try again.":
				"Der Host konnte den Tisch nicht speichern. Versuche es erneut.",
			"The host changed. Try again.":
				"Der Host hat gewechselt. Versuche es erneut.",
			"The player is online again.": "Der Spieler ist wieder online.",
			"Only a seated player can release a seat.":
				"Nur ein Spieler mit Platz kann einen Platz freigeben.",
			"This seat cannot be released.":
				"Dieser Platz kann nicht freigegeben werden.",
			"The host could not save the table.":
				"Der Host konnte den Tisch nicht speichern.",
			"The request did not reach the host. Try again.":
				"Die Anfrage hat den Host nicht erreicht. Versuche es erneut.",
			"This page already holds a seat.":
				"Diese Seite hält bereits einen Platz.",
			"Another tab of this browser holds this seat.":
				"Ein anderer Tab dieses Browsers hält diesen Platz.",
			"The table is closed. Reload the page.":
				"Der Tisch ist geschlossen. Lade die Seite neu.",
			"Another tab of this browser is taking this seat. Try again.":
				"Ein anderer Tab dieses Browsers nimmt gerade diesen Platz. Versuche es erneut.",
			"The other players use another version of the app. Reload the page.":
				"Die anderen Spieler verwenden eine andere App-Version. Lade die Seite neu.",
			"This table has too many open pages":
				"Für diesen Tisch sind zu viele Seiten geöffnet.",
			"The host is online, but this device cannot reach it":
				"Der Host ist online, aber dieses Gerät kann ihn nicht erreichen.",
			"Becoming host…": "Host wird gewählt…",
			"A new host is taking over…": "Ein neuer Host übernimmt…",
			"Waiting for the host ({seconds} s)": "Warte auf den Host ({seconds} s)",
			"Nobody is at this table right now. Keep this page open":
				"Niemand ist gerade am Tisch. Lass diese Seite geöffnet.",
			"Direct connections": "Direktverbindungen",
			"Players checked": "Spieler geprüft",
			"Pages not reachable directly": "Seiten nicht direkt erreichbar",
			"Link repair rooms": "Verbindungsreparaturen",
			"Rejoins with no links": "Wiederbeitritte ohne Links",
			"Public address found": "Öffentliche Adresse gefunden",
			"Ignored wrong-key attempts": "Versuche mit falschem Schlüssel ignoriert",
			"not started": "nicht gestartet",
			none: "keine",
			yes: "ja",
			no: "nein",
			"after connecting": "nach dem Verbinden",
			open: "offen",
			repaired: "repariert",
			"timed out": "Zeitüberschreitung",
			"memory only: a reload loses this copy":
				"nur im Speicher: Neuladen löscht diese Kopie",
			"kept by the browser": "vom Browser behalten",
			"stored; the browser may clear it":
				"gespeichert; der Browser kann es löschen",
			"stored in this browser": "in diesem Browser gespeichert",
			"Your hand": "Deine Hand",
			"Share URL": "URL teilen",
			"Share action completed.": "Teilen abgeschlossen.",
			"Could not share the board URL.":
				"Die Tisch-URL konnte nicht geteilt werden.",
			Host: "Host",
			Release: "Freigeben",
			"Confirm release": "Freigabe bestätigen",
			"Received by {receivedBy} of {of}": "Von {receivedBy} von {of} empfangen",
			"Pending — waiting for the host": "Ausstehend — wartet auf den Host",
			"Not sent: {reason}": "Nicht gesendet: {reason}",
			"Not sent: {reason}.": "Nicht gesendet: {reason}.",
			"Release failed: {reason}": "Freigabe fehlgeschlagen: {reason}",
			"Release failed: no host is connected. Try again later.":
				"Freigabe fehlgeschlagen: Kein Host verbunden. Versuche es später erneut.",
			"This browser does not allow storing data, so it cannot create a table":
				"Dieser Browser erlaubt keine Datenspeicherung und kann daher keinen Tisch erstellen.",
			"This tab was superseded": "Dieser Tab wurde ersetzt",
			"another tab of this browser holds this seat now":
				"ein anderer Tab dieses Browsers hält diesen Platz jetzt",
			"another device holds this seat now":
				"ein anderes Gerät hält diesen Platz jetzt",
			"Connection failed: the other players were found, but no direct connection works. Try another network.":
				"Verbindung fehlgeschlagen: Die anderen Spieler wurden gefunden, aber keine Direktverbindung funktioniert. Versuche ein anderes Netzwerk.",
			Send: "Senden",
			"Stored; sent when a host is connected":
				"Gespeichert; wird gesendet, sobald ein Host verbunden ist",
			"Another player must be online to confirm":
				"Ein anderer Spieler muss online sein, um zu bestätigen",
			"Only a seated player can become the host":
				"Nur ein Spieler mit Platz kann Host werden",
			"This client cannot host the table":
				"Dieser Client kann den Tisch nicht hosten",
			"This browser cannot store the table":
				"Dieser Browser kann den Tisch nicht speichern",
			"This table cannot change its host again":
				"Der Host dieses Tisches kann nicht erneut wechseln",
			"{seat}: enter a name.": "{seat}: gib einen Namen ein.",
			"{seat}: use at most {max} characters.":
				"{seat}: höchstens {max} Zeichen verwenden.",
			"Choose your seat.": "Wähle deinen Platz.",
			"Could not create the game": "Das Spiel konnte nicht erstellt werden",
			"No direct connection to {names}.": "Keine Direktverbindung zu {names}.",
			"Connecting to {names}.": "Verbindung zu {names} wird hergestellt.",
			"Connected to {names}.": "Mit {names} verbunden.",
			"In the call; waiting for others to join.":
				"Im Anruf; warte darauf, dass andere beitreten.",
			"Joining the call…": "Anruf wird verbunden…",
			"Call messages are interrupted; reconnecting…":
				"Anrufnachrichten unterbrochen; Verbindung wird wiederhergestellt…",
			Waiting: "Wartend",
			"Not in call": "Nicht im Anruf",
			Reconnecting: "Verbindung wird wiederhergestellt",
			"Direct connection unavailable": "Direktverbindung nicht verfügbar",
			"Audio reception off": "Audioempfang aus",
			"Mic off": "Mikrofon aus",
			"Audio + video": "Audio + Video",
			"Audio only": "Nur Audio",
			"Video reception off": "Videoempfang aus",
			"Video reception off; {audio}": "Videoempfang aus; {audio}",
			"No working microphone: others cannot hear you.":
				"Kein funktionierendes Mikrofon: Andere können dich nicht hören.",
			"The browser blocks the microphone: others cannot hear you.":
				"Der Browser blockiert das Mikrofon: Andere können dich nicht hören.",
			"Asking for the microphone…": "Mikrofonzugriff wird angefragt…",
			"No working camera: others cannot see you.":
				"Keine funktionierende Kamera: Andere können dich nicht sehen.",
			"The browser blocks the camera: others cannot see you.":
				"Der Browser blockiert die Kamera: Andere können dich nicht sehen.",
			"Asking for the camera…": "Kamerazugriff wird angefragt…",
			"Video is not available on this device.":
				"Video ist auf diesem Gerät nicht verfügbar.",
			Retry: "Erneut versuchen",
			"Retry {name}": "{name} erneut versuchen",
			"Retry call connection to {name}":
				"Anrufverbindung zu {name} erneut versuchen",
			"Clipboard access is unavailable.":
				"Zugriff auf die Zwischenablage ist nicht verfügbar.",
			"Copied.": "Kopiert.",
			"Could not copy the link. Allow clipboard access and try again.":
				"Der Link konnte nicht kopiert werden. Erlaube den Zugriff auf die Zwischenablage und versuche es erneut.",
			"Room call": "Raumanruf",
			Storage: "Speicher",
			failed: "fehlgeschlagen",
			"Send this link to the three other players. Each one opens it and takes a seat.":
				"Sende diesen Link an die drei anderen Spieler. Jeder öffnet ihn und wählt einen Platz.",
			"At most {count} tracker URLs are allowed (VITE_TRACKER_URLS).":
				"Es sind höchstens {count} Tracker-URLs erlaubt (VITE_TRACKER_URLS).",
			"Not a valid wss: tracker URL in VITE_TRACKER_URLS: {url}":
				"Ungültige wss:-Tracker-URL in VITE_TRACKER_URLS: {url}",
			"At most {count} STUN URLs are allowed (VITE_STUN_URLS).":
				"Es sind höchstens {count} STUN-URLs erlaubt (VITE_STUN_URLS).",
			"Not a valid stun: or stuns: URL in VITE_STUN_URLS: {url}":
				"Ungültige stun:- oder stuns:-URL in VITE_STUN_URLS: {url}",
			"TURN URLs are not supported; VITE_STUN_URLS takes stun: and stuns: URLs only.":
				"TURN-URLs werden nicht unterstützt. VITE_STUN_URLS akzeptiert nur stun:- und stuns:-URLs.",
			"Pause bots": "Bots pausieren",
			"Resume bots": "Bots fortsetzen",
			Reset: "Zurücksetzen",
			"Approve reset": "Zurücksetzen bestätigen",
			"Reject reset": "Zurücksetzen ablehnen",
			"Cancel reset": "Zurücksetzen abbrechen",
			"Reset not sent: {reason}": "Zurücksetzen nicht gesendet: {reason}",
			"Reset approval not sent: {reason}":
				"Bestätigung des Zurücksetzens nicht gesendet: {reason}",
			"Reset decision not sent: {reason}":
				"Entscheidung über das Zurücksetzen nicht gesendet: {reason}",
			"Reset cancellation not sent: {reason}":
				"Abbruch des Zurücksetzens nicht gesendet: {reason}",
			"Waiting for {players} to approve the reset.":
				"Warte darauf, dass {players} das Zurücksetzen bestätigen.",
			"{requester} asks to reset the game.":
				"{requester} möchte das Spiel zurücksetzen.",
			"Choose bot model": "Bot-Modell wählen",
			"Use model": "Modell verwenden",
			"After a server error, the bot tries the next model in this order.":
				"Nach einem Serverfehler versucht der Bot das nächste Modell in dieser Reihenfolge.",
			"Set API key": "API-Schlüssel setzen",
			"Set OpenRouter API key": "OpenRouter-API-Schlüssel setzen",
			"Save key": "Schlüssel speichern",
			"All players connected": "Alle Spieler verbunden",
			"Set an OpenRouter API key before switching a seat to a bot.":
				"Setze einen OpenRouter-API-Schlüssel, bevor du einen Platz in einen Bot umwandelst.",
			"The host could not change that seat.":
				"Der Host konnte diesen Platz nicht ändern.",
			"The host could not restore the saved bot seats.":
				"Der Host konnte die gespeicherten Bot-Plätze nicht wiederherstellen.",
			"Only the current host can run bots in this browser.":
				"Nur der aktuelle Host kann Bots in diesem Browser ausführen.",
			"Set an OpenRouter API key to run the bots.":
				"Setze einen OpenRouter-API-Schlüssel, um die Bots auszuführen.",
			"Bots could not start. Check that this page is the ready host.":
				"Die Bots konnten nicht starten. Prüfe, ob diese Seite der aktive Host ist.",
			"Host changed. Bots stopped.":
				"Der Host hat gewechselt. Bots wurden angehalten.",
			Cancel: "Abbrechen",
			"Create game": "Spiel erstellen",
			Exit: "Beenden",
			Model: "Modell",
			"Copy table link": "Tischlink kopieren",
			"OpenRouter spending total": "OpenRouter-Ausgaben gesamt",
			Message: "Nachricht",
			"Trackers reachable": "Tracker erreichbar",
			"Openrouter rate limit - I will retry in a moment":
				"OpenRouter-Ratenlimit – neuer Versuch in Kürze",
		},
		hu: {
			Language: "Nyelv",
			Automatic: "Automatikus",
			North: "Észak",
			East: "Kelet",
			South: "Dél",
			West: "Nyugat",
			N: "É",
			E: "K",
			S: "D",
			W: "Ny",
			and: "és",
			"Room lobby": "Játékszoba várója",
			"Waiting for {players} to come back":
				"Várakozás, hogy visszatérjenek: {players}",
			"CONNECTING TO HOST": "KAPCSOLÓDÁS A HOSTHOZ",
			"Enable autoplay (bot)": "Automatikus játék (bot) bekapcsolása",
			"Autoplay is using this host's OpenRouter key.":
				"Az automatikus játék ennek a házigazdának az OpenRouter-kulcsát használja.",
			"Disable autoplay": "Automatikus játék kikapcsolása",
			"Stop autoplay": "Automatikus játék leállítása",
			"Sending autoplay request…": "Automatikus játék kérése…",
			"The host is playing your seat.": "A házigazda a te helyedben játszik.",
			"Autoplay stopped.": "Automatikus játék leállítva.",
			"Autoplay is unavailable on this host.":
				"Az automatikus játék nem érhető el ennél a házigazdánál.",
			"Autoplay request failed.": "Az automatikus játék kérése nem sikerült.",
			"Autoplay stopped by the host.":
				"A házigazda leállította az automatikus játékot.",
			"Switch to bot": "Váltás botra",
			"Switch to player": "Váltás játékosra",
			"Open this page over HTTPS.":
				"Nyisd meg ezt az oldalt HTTPS-en keresztül.",
			"This browser cannot make calls.":
				"Ez a böngésző nem tud hívásokat indítani.",
			Connecting: "Kapcsolódás",
			"Choose your seat": "Válassz helyet",
			"Create new game": "Új játék létrehozása",
			"Create game": "Játék létrehozása",
			"Creating…": "Létrehozás…",
			"Optional automated players": "Opcionális automatizált játékosok",
			Seat: "Hely",
			Name: "Név",
			You: "Te",
			Bot: "Bot",
			"This is me": "Én vagyok",
			"OpenRouter API key": "OpenRouter API-kulcs",
			"Model priority: the first model is primary; after a server error, the bot tries the next model.":
				"Modellprioritás: az első az elsődleges modell; szerverhiba után a bot a következőt próbálja.",
			Retries: "Újrapróbálkozások",
			"Wait between retries (seconds)":
				"Várakozás az újrapróbálkozások között (másodperc)",
			"Check the bot models, retry count, and retry delay.":
				"Ellenőrizd a botmodelleket, az újrapróbálkozások számát és a várakozási időt.",
			"Enter an OpenRouter API key to run bot seats in this browser.":
				"Adj meg egy OpenRouter API-kulcsot a botok futtatásához ebben a böngészőben.",
			"This browser could not store the OpenRouter API key.":
				"A böngésző nem tudta eltárolni az OpenRouter API-kulcsot.",
			"Enter the four players. Choose your seat. Your browser hosts first; anyone at the table can take over.":
				"Add meg a négy játékos nevét, majd válassz helyet. A böngésződ lesz először a host; bárki átveheti az asztalnál.",
			"This link is for the old version. Ask the table creator for a new link.":
				"Ez a hivatkozás egy régi verzióhoz tartozik. Kérj új hivatkozást a játék létrehozójától.",
			"This link is for another version of the app. Reload the page, or ask the table creator for a new link.":
				"Ez a hivatkozás az alkalmazás másik verziójához tartozik. Töltsd újra az oldalt, vagy kérj új hivatkozást a létrehozótól.",
			"This link is not valid. Check that you copied all of it.":
				"Ez a hivatkozás érvénytelen. Ellenőrizd, hogy teljes egészében másoltad-e.",
			"All seats are taken.": "Minden hely foglalt.",
			"Make me the host": "Legyek én a host",
			"Try seat again": "Hely újrapróbálása",
			Reload: "Újratöltés",
			Network: "Hálózat",
			"Copy link": "Hivatkozás másolása",
			"Set API key": "API-kulcs beállítása",
			"Set OpenRouter API key": "OpenRouter API-kulcs beállítása",
			"Save key": "Kulcs mentése",
			"Choose bot model": "Botmodell kiválasztása",
			"Use model": "Modell használata",
			"After a server error, the bot tries the next model in this order.":
				"Szerverhiba után a bot ebben a sorrendben próbálja a következő modellt.",
			"Pause bots": "Botok felfüggesztése",
			"Resume bots": "Botok folytatása",
			Reset: "Újrakezdés",
			"Approve reset": "Újrakezdés jóváhagyása",
			"Reject reset": "Újrakezdés elutasítása",
			"Cancel reset": "Újrakezdés visszavonása",
			"Reset not sent: {reason}": "Az újrakezdés nem lett elküldve: {reason}",
			"Reset approval not sent: {reason}":
				"Az újrakezdés jóváhagyása nem lett elküldve: {reason}",
			"Reset decision not sent: {reason}":
				"Az újrakezdésről szóló döntés nem lett elküldve: {reason}",
			"Reset cancellation not sent: {reason}":
				"Az újrakezdés visszavonása nem lett elküldve: {reason}",
			"Waiting for {players} to approve the reset.":
				"Várakozás arra, hogy {players} jóváhagyja az újrakezdést.",
			"{requester} asks to reset the game.":
				"{requester} a játék újrakezdését kéri.",
			"The game has expired or is no longer available":
				"A játék lejárt, vagy már nem érhető el.",
			Exit: "Kilépés",
			Players: "Játékosok",
			Messages: "Üzenetek",
			"Openrouter rate limit - I will retry in a moment":
				"OpenRouter-korlát – hamarosan újrapróbálkozom",
			"Insufficient OpenRouter balance. Bots are paused until you update the API key or balance.":
				"Nincs elegendő OpenRouter-egyenleg. A botok szünetelnek, amíg frissíted a kulcsot vagy az egyenleget.",
			"The bot request failed. Check the model and resume bots.":
				"A botkérés nem sikerült. Ellenőrizd a modellt, majd folytasd a botokat.",
			"Bots paused.": "A botok szünetelnek.",
			"No bot seats are active.": "Nincs aktív bothely.",
			"Running {count} bot seat(s) with {model}.":
				"{count} bothely fut ezzel: {model}.",
			Online: "Online",
			Offline: "Offline",
			Free: "Szabad",
			Sending: "Küldés",
			"Waiting for the host": "Várakozás a hostra",
			"Not accepted": "Elutasítva",
			"Undone after a host change": "Hostváltás miatt visszavonva",
			Primary: "Elsődleges",
			Fallback: "Tartalék",
			Backup: "Másodlagos tartalék",
			"Bot model priority": "Botmodellek sorrendje",
			"Move {model} up": "{model} feljebb",
			"Move {model} down": "{model} lejjebb",
			"Join call": "Hívás",
			"Leave call": "Lerak",
			"Rejoin the call": "Újracsatlakozás a híváshoz",
			Optional: "Opcionális",
			"room call": "szobahívás",
			"Game actions": "Játékműveletek",
			"Send mic": "Hang küldés",
			"Send mic audio": "Hang küldés",
			"Hear others": "Hang fogadás",
			"Hear others: receive audio": "Hang fogadás",
			"Send camera": "Videó küldés",
			"Send camera video": "Videó küldés",
			"Camera preview": "Kamera előnézet",
			"Choose camera": "Kamera kiválasztása",
			"The camera preview is no longer available.":
				"A kamera előnézete már nem érhető el.",
			"Starting camera preview…": "Kamera előnézet indítása…",
			"No camera is available.": "Nincs elérhető kamera.",
			"Camera access was denied.": "A kamera hozzáférés megtagadva.",
			"The camera is in use or unavailable.":
				"A kamera használatban van vagy nem érhető el.",
			"The camera could not be started.": "A kamera nem indítható el.",
			"Camera {number}": "Kamera {number}",
			"See cameras": "Videó fogadás",
			"See cameras: receive video": "Videó fogadás",
			"Another tab changed the table at the same time. Reload the page.":
				"Egy másik lap közben módosította az asztalt. Töltsd újra az oldalt.",
			"This browser could not save the table.":
				"A böngésző nem tudta menteni az asztalt.",
			"This browser does not store data ({problem}). You can play, but you cannot become the host, and a reload loses this copy of the table.":
				"A böngésző nem tárol adatokat ({problem}). Játszhatsz, de nem lehetsz host; újratöltéskor ez a példány elvész.",
			"Too many messages are waiting. Wait until the host is connected.":
				"Túl sok üzenet várakozik. Várj, amíg a host csatlakozik.",
			"Another player took this seat. Choose another one.":
				"Ezt a helyet egy másik játékos foglalta el. Válassz másikat.",
			"This seat cannot be taken.": "Ez a hely nem foglalható el.",
			"The host could not save the table. Try again.":
				"A host nem tudta menteni az asztalt. Próbáld újra.",
			"The host changed. Try again.": "Megváltozott a host. Próbáld újra.",
			"The player is online again.": "A játékos ismét online van.",
			"Only a seated player can release a seat.":
				"Csak egy helyet foglaló játékos adhatja fel a helyét.",
			"This seat cannot be released.": "Ez a hely nem adható fel.",
			"The host could not save the table.":
				"A host nem tudta menteni az asztalt.",
			"The request did not reach the host. Try again.":
				"A kérés nem jutott el a hosthoz. Próbáld újra.",
			"This page already holds a seat.": "Ez az oldal már foglal egy helyet.",
			"Another tab of this browser holds this seat.":
				"A böngésző egy másik lapja foglalja ezt a helyet.",
			"The table is closed. Reload the page.":
				"Az asztal lezárult. Töltsd újra az oldalt.",
			"Another tab of this browser is taking this seat. Try again.":
				"A böngésző egy másik lapja éppen elfoglalja ezt a helyet. Próbáld újra.",
			"The other players use another version of the app. Reload the page.":
				"A többi játékos az alkalmazás más verzióját használja. Töltsd újra az oldalt.",
			"This table has too many open pages":
				"Túl sok oldal van megnyitva ehhez az asztalhoz.",
			"The host is online, but this device cannot reach it":
				"A host online van, de ez az eszköz nem éri el.",
			"Becoming host…": "Host szerep átvétele…",
			"A new host is taking over…": "Új host veszi át az irányítást…",
			"Waiting for the host ({seconds} s)": "Várakozás a hostra ({seconds} mp)",
			"Nobody is at this table right now. Keep this page open":
				"Most senki sincs az asztalnál. Hagyd nyitva ezt az oldalt.",
			"Trackers reachable": "Elérhető trackerek",
			"Direct connections": "Közvetlen kapcsolatok",
			"Players checked": "Ellenőrzött játékosok",
			"Pages not reachable directly": "Közvetlenül nem elérhető oldalak",
			"Link repair rooms": "Kapcsolatjavító szobák",
			"Rejoins with no links": "Visszalépések hivatkozás nélkül",
			"Public address found": "Nyilvános cím megtalálva",
			"Ignored wrong-key attempts": "Hibás kulcsú próbálkozások mellőzve",
			"not started": "nem indult el",
			none: "nincs",
			yes: "igen",
			no: "nem",
			"after connecting": "kapcsolódás után",
			open: "nyitott",
			repaired: "javítva",
			"timed out": "időtúllépés",
			"memory only: a reload loses this copy":
				"csak memóriában: újratöltéskor ez a példány elvész",
			"kept by the browser": "a böngésző megtartotta",
			"stored; the browser may clear it": "mentve; a böngésző törölheti",
			"stored in this browser": "ebben a böngészőben mentve",
			"Your hand": "A lapjaid",
			"Share URL": "Hivatkozás megosztása",
			"Share action completed.": "A megosztás befejeződött.",
			"Could not share the board URL.":
				"Nem sikerült megosztani az asztal hivatkozását.",
			Host: "Host",
			Release: "Feladás",
			"Confirm release": "Feladás megerősítése",
			"Received by {receivedBy} of {of}":
				"{of} játékosból {receivedBy} megkapta",
			"Pending — waiting for the host": "Függőben — várakozás a hostra",
			"Not sent: {reason}": "Nem ment el: {reason}",
			"Not sent: {reason}.": "Nem ment el: {reason}.",
			"Release failed: {reason}": "A feladás nem sikerült: {reason}",
			"Release failed: no host is connected. Try again later.":
				"A feladás nem sikerült: nincs csatlakozott host. Próbáld később.",
			"All players connected": "Minden játékos csatlakozott",
			"Set an OpenRouter API key before switching a seat to a bot.":
				"Adj meg OpenRouter API-kulcsot, mielőtt egy helyet botra váltasz.",
			"The host could not change that seat.":
				"A host nem tudta módosítani ezt a helyet.",
			"The host could not restore the saved bot seats.":
				"A host nem tudta visszaállítani a mentett bothelyeket.",
			"Only the current host can run bots in this browser.":
				"Ebben a böngészőben csak az aktuális host futtathat botokat.",
			"Set an OpenRouter API key to run the bots.":
				"Adj meg OpenRouter API-kulcsot a botok futtatásához.",
			"Bots could not start. Check that this page is the ready host.":
				"A botok nem indultak el. Ellenőrizd, hogy ez az oldal az aktív host-e.",
			"Host changed. Bots stopped.": "Megváltozott a host. A botok leálltak.",
			"Copy table link": "Asztal hivatkozásának másolása",
			Model: "Modell",
			"This browser does not allow storing data, so it cannot create a table":
				"Ez a böngésző nem engedélyezi az adattárolást, ezért nem tud asztalt létrehozni.",
			"This tab was superseded": "Ezt a lapot felváltotta egy másik",
			"another tab of this browser holds this seat now":
				"a böngésző egy másik lapja foglalja ezt a helyet",
			"another device holds this seat now":
				"egy másik eszköz foglalja ezt a helyet",
			"Connection failed: the other players were found, but no direct connection works. Try another network.":
				"A kapcsolat nem sikerült: a többi játékos megtalálható, de nincs működő közvetlen kapcsolat. Próbálj másik hálózatot.",
			Send: "Küldés",
			"Stored; sent when a host is connected":
				"Mentve; a host csatlakozásakor elküldjük",
			"Another player must be online to confirm":
				"A megerősítéshez egy másik játékosnak online kell lennie",
			"Only a seated player can become the host":
				"Csak helyet foglaló játékos lehet host",
			"This client cannot host the table":
				"Ez a kliens nem hostolhatja az asztalt",
			"This browser cannot store the table":
				"Ez a böngésző nem tudja tárolni az asztalt",
			"This table cannot change its host again":
				"Ennek az asztalnak már nem váltható le a hostja",
			"{seat}: enter a name.": "{seat}: adj meg egy nevet.",
			"{seat}: use at most {max} characters.":
				"{seat}: legfeljebb {max} karaktert használj.",
			"Choose your seat.": "Válaszd ki a helyed.",
			"Could not create the game": "Nem sikerült létrehozni a játékot",
			"No direct connection to {names}.":
				"Nincs közvetlen kapcsolat vele: {names}.",
			"Connecting to {names}.": "Kapcsolódás ehhez: {names}.",
			"Connected to {names}.": "Kapcsolódva ehhez: {names}.",
			"In the call; waiting for others to join.":
				"A hívásban vagy; várakozás a többiekre.",
			"Joining the call…": "Csatlakozás a híváshoz…",
			"Call messages are interrupted; reconnecting…":
				"A hívás üzenetei megszakadtak; újracsatlakozás…",
			Waiting: "Várakozás",
			"Not in call": "Nincs a hívásban",
			Reconnecting: "Újracsatlakozás",
			"Direct connection unavailable": "Közvetlen kapcsolat nem érhető el",
			"Audio reception off": "Hangfogadás kikapcsolva",
			"Mic off": "Mikrofon kikapcsolva",
			"Audio + video": "Hang + videó",
			"Audio only": "Csak hang",
			"Video reception off": "Videófogadás kikapcsolva",
			"Video reception off; {audio}": "Videófogadás kikapcsolva; {audio}",
			"No working microphone: others cannot hear you.":
				"Nem működik a mikrofon: a többiek nem hallanak.",
			"The browser blocks the microphone: others cannot hear you.":
				"A böngésző letiltja a mikrofont: a többiek nem hallanak.",
			"Asking for the microphone…": "Mikrofonengedély kérése…",
			"No working camera: others cannot see you.":
				"Nem működik a kamera: a többiek nem látnak.",
			"The browser blocks the camera: others cannot see you.":
				"A böngésző letiltja a kamerát: a többiek nem látnak.",
			"Asking for the camera…": "Kameraengedély kérése…",
			"Video is not available on this device.":
				"A videó nem érhető el ezen az eszközön.",
			Retry: "Újrapróbálás",
			"Retry {name}": "{name} újrapróbálása",
			"Retry call connection to {name}":
				"Újrapróbálkozás a híváskapcsolattal: {name}",
			Message: "Üzenet",
			"Clipboard access is unavailable.": "A vágólap nem érhető el.",
			"Copied.": "Másolva.",
			"Could not copy the link. Allow clipboard access and try again.":
				"Nem sikerült másolni a hivatkozást. Engedélyezd a vágólap elérését, majd próbáld újra.",
			Cancel: "Mégse",
			"OpenRouter spending total": "OpenRouter-kiadások összesen",
			"Room call": "Szobahívás",
			Storage: "Tárhely",
			failed: "sikertelen",
			"Send this link to the three other players. Each one opens it and takes a seat.":
				"Küldd el ezt a hivatkozást a másik három játékosnak. Mindenki nyissa meg és foglaljon helyet.",
			"At most {count} tracker URLs are allowed (VITE_TRACKER_URLS).":
				"Legfeljebb {count} tracker URL használható (VITE_TRACKER_URLS).",
			"Not a valid wss: tracker URL in VITE_TRACKER_URLS: {url}":
				"Érvénytelen wss: tracker URL a VITE_TRACKER_URLS értékben: {url}",
			"At most {count} STUN URLs are allowed (VITE_STUN_URLS).":
				"Legfeljebb {count} STUN URL használható (VITE_STUN_URLS).",
			"Not a valid stun: or stuns: URL in VITE_STUN_URLS: {url}":
				"Érvénytelen stun: vagy stuns: URL a VITE_STUN_URLS értékben: {url}",
			"TURN URLs are not supported; VITE_STUN_URLS takes stun: and stuns: URLs only.":
				"A TURN URL-ek nem támogatottak; a VITE_STUN_URLS csak stun: és stuns: URL-eket fogad el.",
		},
		no: {
			Language: "Språk",
			Automatic: "Automatisk",
			North: "Nord",
			East: "Øst",
			South: "Sør",
			West: "Vest",
			N: "N",
			E: "Ø",
			S: "S",
			W: "V",
			and: "og",
			"Room lobby": "Romlobby",
			"Waiting for {players} to come back":
				"Venter på at {players} kommer tilbake",
			"CONNECTING TO HOST": "KOBLER TIL VERTEN",
			"Enable autoplay (bot)": "Slå på automatisk spilling (bot)",
			"Autoplay is using this host's OpenRouter key.":
				"Automatisk spilling bruker vertens OpenRouter-nøkkel.",
			"Disable autoplay": "Slå av automatisk spilling",
			"Stop autoplay": "Stopp automatisk spilling",
			"Sending autoplay request…": "Sender forespørsel om automatisk spilling…",
			"The host is playing your seat.": "Verten spiller på plassen din.",
			"Autoplay stopped.": "Automatisk spilling er stoppet.",
			"Autoplay is unavailable on this host.":
				"Automatisk spilling er ikke tilgjengelig hos denne verten.",
			"Autoplay request failed.":
				"Forespørselen om automatisk spilling mislyktes.",
			"Autoplay stopped by the host.": "Verten stoppet automatisk spilling.",
			"Switch to bot": "Bytt til bot",
			"Switch to player": "Bytt til spiller",
			"Open this page over HTTPS.": "Åpne denne siden via HTTPS.",
			"The game has expired or is no longer available":
				"Spillet er utløpt eller ikke lenger tilgjengelig.",
			"This browser cannot make calls.": "Nettleseren kan ikke ringe.",
			"This browser does not allow storing data, so it cannot create a table":
				"Nettleseren tillater ikke lagring og kan derfor ikke opprette et bord.",
			"This browser cannot store the table":
				"Nettleseren kan ikke lagre bordet.",
			Connecting: "Kobler til",
			"Choose your seat": "Velg plass",
			"Create new game": "Opprett nytt spill",
			"Create game": "Opprett spill",
			"Creating…": "Oppretter…",
			"Optional automated players": "Valgfrie automatiske spillere",
			Seat: "Plass",
			Name: "Navn",
			You: "Du",
			Bot: "Bot",
			"This is me": "Dette er meg",
			"OpenRouter API key": "OpenRouter API-nøkkel",
			Retries: "Nye forsøk",
			"Wait between retries (seconds)": "Vent mellom forsøk (sekunder)",
			"All seats are taken.": "Alle plassene er opptatt.",
			"Make me the host": "Gjør meg til vert",
			"Try seat again": "Prøv plassen igjen",
			Reload: "Last inn på nytt",
			Network: "Nettverk",
			"Copy link": "Kopier lenke",
			"Set API key": "Angi API-nøkkel",
			"Set OpenRouter API key": "Angi OpenRouter API-nøkkel",
			"Save key": "Lagre nøkkel",
			"Choose bot model": "Velg botmodell",
			"Use model": "Bruk modell",
			"Pause bots": "Sett botene på pause",
			"Resume bots": "Fortsett med botene",
			Reset: "Tilbakestill",
			"Approve reset": "Godkjenn tilbakestilling",
			"Reject reset": "Avvis tilbakestilling",
			"Cancel reset": "Avbryt tilbakestilling",
			"Reset not sent: {reason}": "Tilbakestillingen ble ikke sendt: {reason}",
			"Reset approval not sent: {reason}":
				"Godkjenningen av tilbakestillingen ble ikke sendt: {reason}",
			"Reset decision not sent: {reason}":
				"Avgjørelsen om tilbakestilling ble ikke sendt: {reason}",
			"Reset cancellation not sent: {reason}":
				"Avbrytelsen av tilbakestillingen ble ikke sendt: {reason}",
			"Waiting for {players} to approve the reset.":
				"Venter på at {players} godkjenner tilbakestillingen.",
			"{requester} asks to reset the game.":
				"{requester} ber om å tilbakestille spillet.",
			Exit: "Avslutt",
			Players: "Spillere",
			Messages: "Meldinger",
			"Bots paused.": "Botene er satt på pause.",
			"No bot seats are active.": "Ingen botplasser er aktive.",
			Online: "Tilkoblet",
			Offline: "Frakoblet",
			Free: "Ledig",
			Sending: "Sender",
			"Waiting for the host": "Venter på verten",
			"Not accepted": "Ikke godtatt",
			"Undone after a host change": "Angret etter et vertsskifte",
			"Stored; sent when a host is connected":
				"Lagret; sendes når en vert er tilkoblet.",
			Primary: "Primær",
			Fallback: "Reserve",
			Backup: "Ekstra reserve",
			"Bot model priority": "Rekkefølge for botmodeller",
			"Move {model} up": "Flytt {model} opp",
			"Move {model} down": "Flytt {model} ned",
			"Join call": "Bli med",
			"Leave call": "Legg på",
			"Rejoin the call": "Bli med igjen",
			Optional: "Valgfritt",
			"room call": "romsamtale",
			"Room call": "Romsamtale",
			"Game actions": "Spillhandlinger",
			"Send mic": "Send lyd",
			"Send mic audio": "Send lyd",
			"Hear others": "Motta lyd",
			"Hear others: receive audio": "Motta lyd",
			"Send camera": "Send video",
			"Send camera video": "Send video",
			"Camera preview": "Kameraforhåndsvisning",
			"Choose camera": "Velg kamera",
			"The camera preview is no longer available.":
				"Forhåndsvisningen av kameraet er ikke lenger tilgjengelig.",
			"Starting camera preview…": "Starter kameraforhåndsvisning…",
			"No camera is available.": "Ingen kamera er tilgjengelig.",
			"Camera access was denied.": "Kameratilgang ble avslått.",
			"The camera is in use or unavailable.":
				"Kameraet er i bruk eller utilgjengelig.",
			"The camera could not be started.": "Kameraet kunne ikke startes.",
			"Camera {number}": "Kamera {number}",
			"See cameras": "Motta video",
			"See cameras: receive video": "Motta video",
			"This seat cannot be taken.": "Denne plassen kan ikke tas.",
			"The host changed. Try again.": "Verten er byttet ut. Prøv igjen.",
			"The player is online again.": "Spilleren er tilkoblet igjen.",
			"This seat cannot be released.": "Denne plassen kan ikke frigis.",
			"Only a seated player can become the host":
				"Bare en spiller med plass kan bli vert.",
			"This client cannot host the table":
				"Denne klienten kan ikke være vert for bordet.",
			"This table cannot change its host again":
				"Verten for dette bordet kan ikke byttes igjen.",
			"Another player must be online to confirm":
				"En annen spiller må være tilkoblet for å bekrefte.",
			"another tab of this browser holds this seat now":
				"En annen fane i denne nettleseren har nå denne plassen.",
			"another device holds this seat now":
				"En annen enhet har nå denne plassen.",
			"This page already holds a seat.": "Denne siden har allerede en plass.",
			"Becoming host…": "Blir vert…",
			"A new host is taking over…": "En ny vert tar over…",
			"Waiting for the host ({seconds} s)": "Venter på verten ({seconds} s)",
			"Trackers reachable": "Sporingstjenester nås",
			"Direct connections": "Direkte tilkoblinger",
			"Players checked": "Spillere kontrollert",
			"Pages not reachable directly": "Sider som ikke kan nås direkte",
			"Link repair rooms": "Reparasjonsrom for lenker",
			"Rejoins with no links": "Nye tilkoblinger uten lenker",
			"Public address found": "Offentlig adresse funnet",
			"Ignored wrong-key attempts": "Forsøk med feil nøkkel ignorert",
			"not started": "ikke startet",
			none: "ingen",
			yes: "ja",
			no: "nei",
			"after connecting": "etter tilkobling",
			open: "åpen",
			repaired: "reparert",
			"timed out": "tidsavbrudd",
			"kept by the browser": "beholdt av nettleseren",
			"stored; the browser may clear it": "lagret; nettleseren kan slette det",
			"stored in this browser": "lagret i denne nettleseren",
			"Your hand": "Hånden din",
			"Share URL": "Del URL",
			"Share action completed.": "Delingen er fullført.",
			Host: "Vert",
			Release: "Frigi",
			"Confirm release": "Bekreft frigivelse",
			"Received by {receivedBy} of {of}": "Mottatt av {receivedBy} av {of}",
			"Pending — waiting for the host": "Venter på verten",
			"Not sent: {reason}": "Ikke sendt: {reason}",
			"Not sent: {reason}.": "Ikke sendt: {reason}.",
			"Release failed: {reason}": "Frigivelsen mislyktes: {reason}",
			"All players connected": "Alle spillerne er tilkoblet",
			"Host changed. Bots stopped.": "Verten er byttet. Botene er stoppet.",
			"Copy table link": "Kopier bordlenken",
			Model: "Modell",
			"This tab was superseded": "Denne fanen ble erstattet",
			Send: "Send",
			"{seat}: enter a name.": "{seat}: skriv inn et navn.",
			"Choose your seat.": "Velg plassen din.",
			"Could not create the game": "Kunne ikke opprette spillet",
			"Connecting to {names}.": "Kobler til {names}.",
			"Connected to {names}.": "Tilkoblet {names}.",
			"Joining the call…": "Kobler til samtalen…",
			Waiting: "Venter",
			"Not in call": "Ikke i samtalen",
			Reconnecting: "Kobler til igjen",
			"Direct connection unavailable": "Direkte tilkobling er utilgjengelig",
			"In the call; waiting for others to join.":
				"I samtalen; venter på at de andre skal bli med.",
			"Call messages are interrupted; reconnecting…":
				"Samtalemeldinger er avbrutt; kobler til igjen…",
			"Audio reception off": "Lyd av",
			"Mic off": "Mikrofon av",
			"Audio + video": "Lyd + video",
			"Audio only": "Bare lyd",
			"Video reception off": "Video av",
			"Video reception off; {audio}": "Video av; {audio}",
			"Asking for the microphone…": "Ber om tilgang til mikrofonen…",
			"Asking for the camera…": "Ber om tilgang til kameraet…",
			"No working microphone: others cannot hear you.":
				"Ingen fungerende mikrofon: de andre kan ikke høre deg.",
			"The browser blocks the microphone: others cannot hear you.":
				"Nettleseren blokkerer mikrofonen: de andre kan ikke høre deg.",
			"No working camera: others cannot see you.":
				"Ingen fungerende kamera: de andre kan ikke se deg.",
			"The browser blocks the camera: others cannot see you.":
				"Nettleseren blokkerer kameraet: de andre kan ikke se deg.",
			"Video is not available on this device.":
				"Video er ikke tilgjengelig på denne enheten.",
			Retry: "Prøv igjen",
			"Retry {name}": "Prøv {name} igjen",
			Message: "Melding",
			"Clipboard access is unavailable.":
				"Tilgang til utklippstavlen er utilgjengelig.",
			"Could not copy the link. Allow clipboard access and try again.":
				"Kunne ikke kopiere lenken. Gi tilgang til utklippstavlen og prøv igjen.",
			"Copied.": "Kopiert.",
			Cancel: "Avbryt",
			"OpenRouter spending total": "Samlet forbruk hos OpenRouter",
			Storage: "Lagring",
			failed: "mislyktes",
			"After a server error, the bot tries the next model in this order.":
				"Etter en serverfeil prøver boten neste modell i denne rekkefølgen.",
			"The bot request failed. Check the model and resume bots.":
				"Botforespørselen mislyktes. Kontroller modellen og start botene igjen.",
			"Another tab changed the table at the same time. Reload the page.":
				"En annen fane endret bordet samtidig. Last inn siden på nytt.",
			"Another player took this seat. Choose another one.":
				"En annen spiller tok denne plassen. Velg en annen.",
			"Another tab of this browser holds this seat.":
				"En annen fane i denne nettleseren har denne plassen.",
			"Another tab of this browser is taking this seat. Try again.":
				"En annen fane i denne nettleseren tar denne plassen. Prøv igjen.",
			"At most {count} STUN URLs are allowed (VITE_STUN_URLS).":
				"Du kan angi maksimalt {count} STUN-URL-er (VITE_STUN_URLS).",
			"At most {count} tracker URLs are allowed (VITE_TRACKER_URLS).":
				"Du kan angi maksimalt {count} tracker-URL-er (VITE_TRACKER_URLS).",
			"Bots could not start. Check that this page is the ready host.":
				"Botene kunne ikke starte. Kontroller at denne siden er verten og er klar.",
			"Check the bot models, retry count, and retry delay.":
				"Kontroller botmodellene, antall forsøk og ventetiden mellom forsøk.",
			"Connection failed: the other players were found, but no direct connection works. Try another network.":
				"Tilkoblingen mislyktes: de andre spillerne ble funnet, men ingen direkte tilkobling fungerer. Prøv et annet nettverk.",
			"Could not share the board URL.": "Kunne ikke dele URL-en til bordet.",
			"Enter an OpenRouter API key to run bot seats in this browser.":
				"Skriv inn en OpenRouter API-nøkkel for å kjøre botplasser i denne nettleseren.",
			"Enter the four players. Choose your seat. Your browser hosts first; anyone at the table can take over.":
				"Skriv inn de fire spillerne. Velg plassen din. Nettleseren din er vert først; hvem som helst ved bordet kan ta over.",
			"Insufficient OpenRouter balance. Bots are paused until you update the API key or balance.":
				"For lav saldo hos OpenRouter. Botene er satt på pause til du oppdaterer API-nøkkelen eller saldoen.",
			"Model priority: the first model is primary; after a server error, the bot tries the next model.":
				"Modellrekkefølge: Den første modellen er primær. Etter en serverfeil prøver boten den neste.",
			"No direct connection to {names}.":
				"Ingen direkte tilkobling til {names}.",
			"Nobody is at this table right now. Keep this page open":
				"Ingen sitter ved bordet nå. La denne siden stå åpen",
			"Not a valid stun: or stuns: URL in VITE_STUN_URLS: {url}":
				"Ugyldig stun:- eller stuns:-URL i VITE_STUN_URLS: {url}",
			"Not a valid wss: tracker URL in VITE_TRACKER_URLS: {url}":
				"Ugyldig wss:-tracker-URL i VITE_TRACKER_URLS: {url}",
			"TURN URLs are not supported; VITE_STUN_URLS takes stun: and stuns: URLs only.":
				"TURN-URL-er støttes ikke. VITE_STUN_URLS godtar bare stun:- og stuns:-URL-er.",
			"Only a seated player can release a seat.":
				"Bare en spiller med plass kan frigi en plass.",
			"Only the current host can run bots in this browser.":
				"Bare den nåværende verten kan kjøre boter i denne nettleseren.",
			"Openrouter rate limit - I will retry in a moment":
				"OpenRouter-grense nådd – prøver igjen om litt",
			"Release failed: no host is connected. Try again later.":
				"Frigivelsen mislyktes: ingen vert er tilkoblet. Prøv igjen senere.",
			"Retry call connection to {name}":
				"Prøv å koble til samtalen med {name} igjen",
			"Running {count} bot seat(s) with {model}.":
				"Kjører {count} botplasser med {model}.",
			"Send this link to the three other players. Each one opens it and takes a seat.":
				"Send denne lenken til de tre andre spillerne. Alle åpner den og velger en plass.",
			"Set an OpenRouter API key before switching a seat to a bot.":
				"Angi en OpenRouter API-nøkkel før du bytter en plass til en bot.",
			"Set an OpenRouter API key to run the bots.":
				"Angi en OpenRouter API-nøkkel for å kjøre botene.",
			"The host could not change that seat.":
				"Verten kunne ikke endre den plassen.",
			"The host could not restore the saved bot seats.":
				"Verten kunne ikke gjenopprette de lagrede botplassene.",
			"The host could not save the table.": "Verten kunne ikke lagre bordet.",
			"The host could not save the table. Try again.":
				"Verten kunne ikke lagre bordet. Prøv igjen.",
			"The host is online, but this device cannot reach it":
				"Verten er tilkoblet, men denne enheten får ikke kontakt med verten",
			"The other players use another version of the app. Reload the page.":
				"De andre spillerne bruker en annen versjon av appen. Last inn siden på nytt.",
			"The request did not reach the host. Try again.":
				"Forespørselen nådde ikke verten. Prøv igjen.",
			"The table is closed. Reload the page.":
				"Bordet er stengt. Last inn siden på nytt.",
			"This browser could not save the table.":
				"Nettleseren kunne ikke lagre bordet.",
			"This browser could not store the OpenRouter API key.":
				"Nettleseren kunne ikke lagre OpenRouter API-nøkkelen.",
			"This browser does not store data ({problem}). You can play, but you cannot become the host, and a reload loses this copy of the table.":
				"Nettleseren lagrer ikke data ({problem}). Du kan spille, men ikke bli vert. Hvis du laster inn siden på nytt, går denne bordkopien tapt.",
			"This link is for another version of the app. Reload the page, or ask the table creator for a new link.":
				"Denne lenken er for en annen versjon av appen. Last inn siden på nytt, eller be den som opprettet bordet om en ny lenke.",
			"This link is for the old version. Ask the table creator for a new link.":
				"Denne lenken er for en eldre versjon. Be den som opprettet bordet om en ny lenke.",
			"This link is not valid. Check that you copied all of it.":
				"Denne lenken er ugyldig. Kontroller at du kopierte hele lenken.",
			"This table has too many open pages":
				"For mange sider for dette bordet er åpne",
			"Too many messages are waiting. Wait until the host is connected.":
				"For mange meldinger venter. Vent til verten er tilkoblet.",
			"memory only: a reload loses this copy":
				"bare i minnet: denne kopien går tapt hvis siden lastes inn på nytt",
			"{seat}: use at most {max} characters.":
				"{seat}: bruk maksimalt {max} tegn.",
		},
		...additionalCatalogs,
	});

export const translatedMessageKeys = [
	...new Set(
		Object.values(catalogs).flatMap((catalog) => Object.keys(catalog)),
	),
];

/** The messages that the catalog of `locale` translates. */
export function catalogKeys(locale: Exclude<Locale, "en">): readonly string[] {
	return Object.keys(catalogs[locale]);
}

export function detectLocale(
	languages: readonly string[] | undefined,
	language: string | undefined,
): Locale {
	const preferences = languages?.length
		? languages
		: language
			? [language]
			: [];
	for (const preference of preferences) {
		const primary = preference.toLowerCase().split("-")[0];
		if (primary === "nb" || primary === "no") return "no";
		if (
			primary === "de" ||
			primary === "hu" ||
			primary === "es" ||
			primary === "pt" ||
			primary === "fr" ||
			primary === "it" ||
			primary === "nl" ||
			primary === "en"
		)
			return primary;
	}
	return "en";
}

export function translator(locale: Locale): Translate {
	const catalog = locale === "en" ? undefined : catalogs[locale];
	return (message, values = {}) => {
		const template = catalog?.[message] ?? message;
		return template.replace(
			/\{([a-zA-Z0-9_]+)\}/g,
			(placeholder, key: string) => String(values[key] ?? placeholder),
		);
	};
}
