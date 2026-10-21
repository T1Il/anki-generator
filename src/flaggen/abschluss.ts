import AnkiGeneratorPlugin from '../main';
import { deleteAnkiNotes, setzeFlagge, ankiSync, updateNoteFieldsBatch } from '../anki/AnkiConnect';
import { getAnkiBlocks, parseCardsFromBlockSource, parseBlockHeader } from '../anki/ankiParser';
import { syncAnkiBlock } from '../anki/syncManager';
import { basicMarkdownToHtml, convertObsidianLatexToAnki } from '../utils';
import { CardSuggestion, parseSuggestions } from '../chat/suggestions';
import { FlaggenEintrag, dateiFuer } from './sammeln';
import { abschlussPlan } from './flaggen';
import { loescheNotiz } from './ablage';

export interface AbschlussErgebnis {
	uebertragen: number;
	geloescht: number;
	entflaggt: number;
}

/**
 * Eine Notiz abschließen: was im Vault steht, nach Anki bringen, in Anki
 * löschen, was im Vault gelöscht wurde, Flaggen entfernen.
 *
 * Bewusst getrennt vom Übernehmen im Chat: dort entstehen oft mehrere
 * Änderungen nacheinander, und erst hier steht fest, was gilt. Den
 * AnkiWeb-Sync stößt der Aufrufer einmal am Ende an (`syncNachAnkiWeb`).
 */
export async function schliesseNotizAb(
	plugin: AnkiGeneratorPlugin,
	pfad: string,
	eintraege: FlaggenEintrag[]
): Promise<AbschlussErgebnis> {
	const datei = dateiFuer(plugin, pfad);
	if (!datei) throw new Error('Notiz nicht gefunden: ' + pfad);

	const lies = async () => {
		const content = await plugin.app.vault.read(datei);
		return getAnkiBlocks(content).map((b) => ({ block: b, karten: parseCardsFromBlockSource(b.innerClean) }));
	};

	const vorher = await lies();
	const plan = abschlussPlan(eintraege, vorher.map((b) => b.karten));

	let uebertragen = 0;
	// Von hinten nach vorn: syncAnkiBlock schreibt IDs in den Block, die
	// Quelle der Blöcke davor bleibt damit unberührt. Trotzdem jedes Mal frisch
	// lesen – der Block wird über seinen Inhalt wiedergefunden.
	const reihenfolge = Array.from(plan.uebertragen.keys()).sort((a, b) => b - a);
	for (const b of reihenfolge) {
		const aktuell = (await lies())[b];
		if (!aktuell) continue;
		const indizes = plan.uebertragen.get(b) as number[];
		await syncAnkiBlock(
			plugin,
			aktuell.block.innerClean,
			parseBlockHeader(aktuell.block.innerClean).deckName,
			aktuell.karten,
			datei,
			indizes
		);
		uebertragen += indizes.length;
	}

	if (plan.loeschen.length) await deleteAnkiNotes(plan.loeschen);
	if (plan.entflaggen.length) await setzeFlagge(plan.entflaggen, 0);

	await loescheNotiz(plugin, pfad);

	return { uebertragen, geloescht: plan.loeschen.length, entflaggt: plan.entflaggen.length };
}

/** Karten sind doch in Ordnung: nur die Flagge weg. */
export async function entferneFlaggen(cardIds: number[]): Promise<void> {
	await setzeFlagge(cardIds, 0);
}

/** Damit die Änderungen auf dem Handy ankommen. Wirft nicht. */
export async function syncNachAnkiWeb(): Promise<boolean> {
	try {
		await ankiSync();
		return true;
	} catch (e) {
		console.warn('[Flaggen] AnkiWeb-Sync fehlgeschlagen', e);
		return false;
	}
}

// --- Karten ohne Notiz -------------------------------------------------------

/** Die Vorschläge der KI für eine Karte ohne Notiz. */
export function waisenVorschlaege(antwort: string, noteId: number): CardSuggestion[] {
	return parseSuggestions(antwort)
		.filter((v): v is CardSuggestion => v.kind === 'card' && v.op !== 'add' && v.id === noteId);
}

/**
 * Vorschlag direkt in Anki übernehmen – es gibt keine Notiz, in die er
 * gehören könnte. Markdown wird wie beim Sync zu HTML.
 */
export async function uebernimmWaise(
	eintrag: FlaggenEintrag,
	v: CardSuggestion
): Promise<void> {
	if (v.op === 'delete') {
		await deleteAnkiNotes([eintrag.noteId]);
		return;
	}
	const namen = eintrag.anki.feldNamen ?? [];
	if (!namen.length) throw new Error('Feldnamen der Karte unbekannt.');
	const html = (t: string) => basicMarkdownToHtml(convertObsidianLatexToAnki(t));
	const felder: Record<string, string> = {};
	if (namen.length === 1 || /\{\{c\d+::/.test(v.q)) {
		felder[namen[0]] = html(v.q);
	} else {
		felder[namen[0]] = html(v.q);
		felder[namen[1]] = html(v.a);
	}
	const [fehler] = await updateNoteFieldsBatch([{ noteId: eintrag.noteId, fields: felder }]);
	if (fehler) throw new Error(fehler);
	await setzeFlagge([eintrag.cardId], 0);
}
