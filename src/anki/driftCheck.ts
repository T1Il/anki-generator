import { App, TFile } from 'obsidian';
import { Card } from '../types';
import { AnkiGeneratorSettings } from '../settings';
import { getNotesInfo } from './AnkiConnect';
import { getAnkiBlocks, parseCardsFromBlockSource, parseBlockHeader, hasCloze } from './ankiParser';
import { normalizeText } from '../chat/textLocator';

/**
 * Vergleicht die Karten in den Notizen mit dem, was tatsächlich in Anki steht.
 *
 * Bewusst ein TEXTVERGLEICH und keine Nachbildung der Sync-Pipeline: die
 * erzeugt HTML, lädt Bilder hoch und rendert Mermaid-Diagramme. Das hätte
 * Nebenwirkungen und würde außerdem jede Karte mit Bild als "abweichend"
 * melden, weil sich die Dateinamen unterscheiden.
 */

export interface DriftField {
	label: string;
	noteValue: string;
	ankiValue: string;
	differs: boolean;
}

export interface DriftItem {
	file: TFile;
	deckName: string | null;
	/** Inhalt des Blocks, aus dem die Karte stammt - für syncAnkiBlock. */
	blockSource: string;
	/** Alle Karten des Blocks, in Originalreihenfolge. */
	blockCards: Card[];
	cardIndex: number;
	card: Card;
	noteId: number;
	status: 'changed' | 'missing';
	fields: DriftField[];
}

export interface DriftReport {
	items: DriftItem[];
	/** Karten mit ID, die geprüft werden konnten. */
	checked: number;
	/** Karten ohne ID (nie synchronisiert). */
	withoutId: number;
	filesScanned: number;
}

// --- Normalisierung -------------------------------------------------------

const ENTITIES: Record<string, string> = {
	'&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
	'&quot;': '"', '&#39;': "'", '&apos;': "'"
};

/** Anki speichert HTML. Daraus vergleichbaren Klartext machen. */
export function htmlToPlain(html: string): string {
	if (!html) return '';
	let text = html;

	// Blockelemente werden zu Zeilenumbrüchen, damit nichts zusammenklebt.
	text = text.replace(/<br\s*\/?>/gi, '\n');
	text = text.replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n');
	text = text.replace(/<li[^>]*>/gi, '\n');

	// Bilder tragen in Anki gehashte Dateinamen - für den Vergleich raus.
	text = text.replace(/<img[^>]*>/gi, ' ');

	text = text.replace(/<[^>]+>/g, '');
	text = text.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ');

	return collapse(text);
}

/** Markdown aus der Notiz auf denselben Nenner bringen. */
export function noteToPlain(markdown: string): string {
	if (!markdown) return '';
	let text = markdown;

	// Bild-Einbettungen entfernen (siehe oben).
	text = text.replace(/!\[\[[^\]]*\]\]/g, ' ');
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');

	// Aufzaehlungszeichen MUESSEN vor normalizeText weg: das fasst
	// Whitespace-Laeufe inkl. Zeilenumbruechen zu Leerzeichen zusammen,
	// danach sind Zeilenanfaenge nicht mehr erkennbar.
	text = stripBullets(text);

	// Wikilinks, Markdown-Links, Hervorhebungen, Typografie.
	text = normalizeText(text);

	return collapse(text);
}

/**
 * Aufzaehlungszeichen tragen keine Information und sehen auf beiden Seiten
 * anders aus (Notiz: '- A', Anki: '<li>A' oder '- A<br>').
 * NUMMERN werden bewusst NICHT entfernt - eine falsche Nummer ist eine
 * echte inhaltliche Abweichung.
 */
function stripBullets(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/^[ \t]*[-*•][ \t]+/, ''))
		.join('\n');
}

function collapse(text: string): string {
	return stripBullets(text).replace(/\s+/g, ' ').trim();
}

// --- Erwartete Anki-Inhalte aus einer Karte -------------------------------

/**
 * Der Cloze-Text so, wie ihn der Sync erzeugen würde.
 * Muss mit der Logik in syncManager übereinstimmen.
 */
export function expectedClozeText(card: Card): string {
	const q = card.q;
	const a = card.a;
	const blank = /(?<!\w)____(?!\w)/;

	if (hasCloze(q)) return q;
	if (blank.test(q)) return q.replace(blank, `{{c1::${a}}}`);
	if (a && a.trim().length > 0) return `${q} {{c1::${a}}}`;
	return q;
}

function fieldValue(note: any, preferredName: string, order: number): string {
	const fields = note?.fields;
	if (!fields) return '';

	if (preferredName && fields[preferredName]) {
		return fields[preferredName].value ?? '';
	}

	// Fallback über die Feldreihenfolge, falls die Namen abweichen.
	const sorted = Object.keys(fields)
		.map((name) => ({ name, order: fields[name].order ?? 0, value: fields[name].value ?? '' }))
		.sort((a, b) => a.order - b.order);

	return sorted[order]?.value ?? '';
}

function compareCard(card: Card, note: any, settings: AnkiGeneratorSettings): DriftField[] {
	if (card.type === 'Cloze') {
		const noteValue = expectedClozeText(card);
		const ankiValue = fieldValue(note, settings.clozeText, 0);
		return [{
			label: 'Lückentext',
			noteValue,
			ankiValue,
			differs: noteToPlain(noteValue) !== htmlToPlain(ankiValue)
		}];
	}

	const frontField = card.typeIn ? settings.typeInFront : settings.basicFront;
	const backField = card.typeIn ? settings.typeInBack : settings.basicBack;

	const ankiFront = fieldValue(note, frontField, 0);
	const ankiBack = fieldValue(note, backField, 1);

	return [
		{
			label: 'Frage',
			noteValue: card.q,
			ankiValue: ankiFront,
			differs: noteToPlain(card.q) !== htmlToPlain(ankiFront)
		},
		{
			label: 'Antwort',
			noteValue: card.a,
			ankiValue: ankiBack,
			differs: noteToPlain(card.a) !== htmlToPlain(ankiBack)
		}
	];
}

// --- Hauptlauf ------------------------------------------------------------

interface Pending {
	file: TFile;
	deckName: string | null;
	blockSource: string;
	blockCards: Card[];
	cardIndex: number;
	card: Card;
	noteId: number;
}

export async function checkDrift(
	app: App,
	settings: AnkiGeneratorSettings,
	files: TFile[],
	onProgress?: (done: number, total: number) => void
): Promise<DriftReport> {
	const pending: Pending[] = [];
	let withoutId = 0;

	for (let f = 0; f < files.length; f++) {
		const file = files[f];
		let content: string;
		try {
			content = await app.vault.read(file);
		} catch (e) {
			continue;
		}

		if (!content.includes('anki-cards')) continue;

		for (const block of getAnkiBlocks(content)) {
			const cards = parseCardsFromBlockSource(block.innerClean);
			const header = parseBlockHeader(block.innerClean);

			cards.forEach((card, cardIndex) => {
				if (!card.id) {
					withoutId++;
					return;
				}
				pending.push({
					file,
					deckName: header.deckName,
					blockSource: block.innerClean,
					blockCards: cards,
					cardIndex,
					card,
					noteId: card.id
				});
			});
		}

		if (onProgress) onProgress(f + 1, files.length);
	}

	// Anki in Blöcken abfragen - notesInfo verträgt keine beliebig langen Listen.
	const items: DriftItem[] = [];
	const CHUNK = 200;

	for (let i = 0; i < pending.length; i += CHUNK) {
		const slice = pending.slice(i, i + CHUNK);
		const infos = await getNotesInfo(slice.map((p) => p.noteId));

		slice.forEach((p, k) => {
			const note = infos[k];
			// AnkiConnect liefert fuer unbekannte IDs ein leeres Objekt.
			const exists = note && note.noteId;

			if (!exists) {
				items.push({
					file: p.file,
					deckName: p.deckName,
					blockSource: p.blockSource,
					blockCards: p.blockCards,
					cardIndex: p.cardIndex,
					card: p.card,
					noteId: p.noteId,
					status: 'missing',
					fields: []
				});
				return;
			}

			const fields = compareCard(p.card, note, settings);
			if (fields.some((f) => f.differs)) {
				items.push({
					file: p.file,
					deckName: p.deckName,
					blockSource: p.blockSource,
					blockCards: p.blockCards,
					cardIndex: p.cardIndex,
					card: p.card,
					noteId: p.noteId,
					status: 'changed',
					fields
				});
			}
		});
	}

	return {
		items,
		checked: pending.length,
		withoutId,
		filesScanned: files.length
	};
}
