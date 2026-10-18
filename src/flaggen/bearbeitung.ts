import { ChatMessage } from '../types';
import { parseAntwort, schluesselFuer } from '../chat/suggestions';

/**
 * Wie weit ist eine geprüfte Notiz schon bearbeitet?
 *
 * Gezählt werden die Vorschläge der letzten Flaggen-Antwort im Chat und deren
 * Zustand (`applied`/`dismissed`, gespeichert unter demselben Schlüssel wie
 * im ChatPanel). Wer die Notiz von Hand geändert hat, gilt als „angefangen“ –
 * am Zustand der Vorschläge sieht man das nicht.
 */

export const AUFTRAG_KOPF = '**Geflaggte Karten prüfen**';

export interface Bearbeitung {
	/** Gab es überhaupt eine Flaggen-Antwort im Verlauf? */
	gefunden: boolean;
	vorschlaege: number;
	erledigt: number;
	notizGeaendert: boolean;
}

export function bearbeitungsStand(
	verlauf: ChatMessage[] | undefined,
	geprueftAm: string | undefined,
	notizGeaendertAm: number | null
): Bearbeitung {
	const stand: Bearbeitung = { gefunden: false, vorschlaege: 0, erledigt: 0, notizGeaendert: false };

	const seit = geprueftAm ? Date.parse(geprueftAm) : NaN;
	// Kleiner Puffer: der Stapel selbst schreibt nicht in die Notiz, aber Sync
	// und Uhrzeitunterschiede sollen kein „bearbeitet“ erzeugen.
	if (notizGeaendertAm !== null && !Number.isNaN(seit)) stand.notizGeaendert = notizGeaendertAm > seit + 5000;

	if (!verlauf) return stand;
	let antwort: ChatMessage | undefined;
	for (let i = verlauf.length - 1; i > 0; i--) {
		if (verlauf[i].role === 'ai' && verlauf[i - 1].role === 'user' && verlauf[i - 1].content.startsWith(AUFTRAG_KOPF)) {
			antwort = verlauf[i];
			break;
		}
	}
	if (!antwort) return stand;

	stand.gefunden = true;
	for (const teil of parseAntwort(antwort.content)) {
		if (teil.art !== 'vorschlag' || teil.vorschlag.kind === 'invalid') continue;
		stand.vorschlaege++;
		const z = antwort.vorschlaege?.[schluesselFuer(teil.vorschlag)];
		if (z?.status === 'applied' || z?.status === 'dismissed') stand.erledigt++;
	}
	return stand;
}

export type NotizStatus =
	| 'unbearbeitet'
	| 'teilweise'
	| 'offen'
	| 'fehler'
	| 'bearbeitet'
	| 'ohneVorschlag'
	| 'nurUebertragen';

/** Status einer geprüften Notiz aus ihrem Bearbeitungsstand. */
export function statusAus(b: Bearbeitung): NotizStatus {
	if (b.vorschlaege > 0 && b.erledigt === b.vorschlaege) return 'bearbeitet';
	if (b.erledigt > 0 || b.notizGeaendert) return 'teilweise';
	if (b.gefunden && b.vorschlaege === 0) return 'ohneVorschlag';
	return 'unbearbeitet';
}

/** Unbearbeitetes zuerst, was nur noch abgeschlossen werden muss, zuletzt. */
export const STATUS_RANG: Record<NotizStatus, number> = {
	unbearbeitet: 0,
	teilweise: 1,
	offen: 2,
	fehler: 3,
	bearbeitet: 4,
	ohneVorschlag: 5,
	nurUebertragen: 6
};
