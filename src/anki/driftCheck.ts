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
	/** Rohwert aus der Notiz (Markdown). */
	noteValue: string;
	/** Rohwert aus Anki (HTML). */
	ankiValue: string;
	/** Verglichene Fassung - das ist es, was ueber differs entscheidet. */
	noteNorm: string;
	ankiNorm: string;
	differs: boolean;
	/** Art der Abweichung, nicht das Motiv. */
	reason: ChangeDescription;
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

/**
 * LaTeX-Begrenzer entfernen.
 *
 * Der Sync wandelt $x$ -> \(x\) und $$x$$ -> \[x\]. Ohne diesen Schritt gilt
 * jede Karte mit Formel als abweichend, obwohl sich inhaltlich nichts
 * geaendert hat.
 */
function stripMathDelimiters(text: string): string {
	return text
		.replace(/\$\$([\s\S]*?)\$\$/g, '$1')
		.replace(/\\\[([\s\S]*?)\\\]/g, '$1')
		.replace(/\\\(([\s\S]*?)\\\)/g, '$1')
		.replace(/(?<!\\)\$([^$]+?)(?<!\\)\$/g, '$1');
}

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

	// Erst nach dem Entfernen der Tags: \( und \) stehen dort als Klartext.
	text = stripMathDelimiters(text);

	return collapse(text);
}

/** Markdown aus der Notiz auf denselben Nenner bringen. */
export function noteToPlain(markdown: string): string {
	if (!markdown) return '';
	let text = markdown;

	// Mermaid landet in Anki als gerendertes PNG - der Quelltext waere sonst
	// eine Dauerabweichung. Auch unabgeschlossene Bloecke abfangen.
	text = text.replace(/```mermaid[\s\S]*?(?:```|$)/g, ' ');

	// Bild-Einbettungen entfernen (siehe oben).
	text = text.replace(/!\[\[[^\]]*\]\]/g, ' ');
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');

	// Hybrid-Links [[X]](obsidian://...) werden beim Sync auf [[X]] reduziert.
	text = text.replace(/(\]\])\(obsidian:\/\/(?:[^()]|\([^()]*\))*\)/g, '$1');

	text = stripMathDelimiters(text);

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
	// Unterstriche auf BEIDEN Seiten entfernen: die Notiz-Normalisierung wertet
	// '_' als Kursiv-Markierung, in Formeln wie O_2 ist es aber ein Index.
	// Sonst gilt jede Karte mit Tiefstellung als abweichend.
	return stripBullets(text)
		.replace(/_/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

// --- Beschreibung der Aenderung -------------------------------------------

export interface DiffPart {
	text: string;
	changed: boolean;
}

/**
 * Wortweiser Vergleich ueber gemeinsamen Anfang und gemeinsames Ende.
 * Reicht, um zu zeigen WAS sich geaendert hat - ein vollstaendiger
 * Diff-Algorithmus waere hier Overkill.
 */
export function wordDiff(a: string, b: string): [DiffPart[], DiffPart[]] {
	const aw = a.split(' ');
	const bw = b.split(' ');

	let start = 0;
	while (start < aw.length && start < bw.length && aw[start] === bw[start]) start++;

	let end = 0;
	while (
		end < aw.length - start &&
		end < bw.length - start &&
		aw[aw.length - 1 - end] === bw[bw.length - 1 - end]
	) end++;

	const build = (words: string[]): DiffPart[] => {
		const parts: DiffPart[] = [];
		const head = words.slice(0, start).join(' ');
		const mid = words.slice(start, words.length - end).join(' ');
		const tail = words.slice(words.length - end).join(' ');
		if (head) parts.push({ text: head, changed: false });
		if (mid) parts.push({ text: mid, changed: true });
		if (tail) parts.push({ text: tail, changed: false });
		return parts;
	};

	return [build(aw), build(bw)];
}

export interface ChangeDescription {
	label: string;
	detail?: string;
}

function changedText(parts: DiffPart[]): string {
	return parts.filter((p) => p.changed).map((p) => p.text).join(' ').trim();
}

function wordCount(text: string): number {
	return text ? text.split(' ').filter(Boolean).length : 0;
}

/**
 * Beschreibt die ART der Abweichung.
 *
 * Bewusst keine Vermutung ueber das MOTIV: das Plugin sieht nur zwei
 * Textstaende und kann nicht wissen, warum jemand etwas geaendert hat.
 */
export function describeChange(ankiNorm: string, noteNorm: string): ChangeDescription {
	if (!ankiNorm && noteNorm) return { label: 'In Anki leer' };
	if (ankiNorm && !noteNorm) return { label: 'In der Notiz leer' };

	const [ankiParts, noteParts] = wordDiff(ankiNorm, noteNorm);
	const ankiChanged = changedText(ankiParts);
	const noteChanged = changedText(noteParts);

	// Angehaengte Anzahlangabe wie "(7)".
	if (!ankiChanged && /^\(\d+\)[.,;:]?$/.test(noteChanged)) {
		return { label: 'Anzahlangabe ergänzt', detail: noteChanged };
	}
	if (!noteChanged && /^\(\d+\)[.,;:]?$/.test(ankiChanged)) {
		return { label: 'Anzahlangabe entfernt', detail: ankiChanged };
	}

	if (ankiNorm.toLowerCase() === noteNorm.toLowerCase()) {
		return { label: 'Nur Groß-/Kleinschreibung' };
	}

	const lettersOnly = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
	if (lettersOnly(ankiNorm) === lettersOnly(noteNorm)) {
		return { label: 'Nur Zeichensetzung oder Abstände' };
	}

	// Gleicher Satzbau, andere Zahl - der haeufigste inhaltliche Fall.
	const digitsMasked = (text: string) => text.replace(/\d+/g, '#');
	if (digitsMasked(ankiNorm) === digitsMasked(noteNorm)) {
		return { label: 'Zahl geändert', detail: `${ankiChanged} → ${noteChanged}` };
	}

	if (!ankiChanged && noteChanged) {
		return { label: 'Text ergänzt', detail: `+${wordCount(noteChanged)} Wörter` };
	}
	if (ankiChanged && !noteChanged) {
		return { label: 'Text entfernt', detail: `−${wordCount(ankiChanged)} Wörter` };
	}

	return {
		label: 'Umformuliert',
		detail: `${wordCount(ankiChanged)} → ${wordCount(noteChanged)} Wörter`
	};
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
		const noteNorm = noteToPlain(noteValue);
		const ankiNorm = htmlToPlain(ankiValue);
		return [{
			label: 'Lückentext',
			noteValue,
			ankiValue,
			noteNorm,
			ankiNorm,
			differs: noteNorm !== ankiNorm,
			reason: describeChange(ankiNorm, noteNorm)
		}];
	}

	const frontField = card.typeIn ? settings.typeInFront : settings.basicFront;
	const backField = card.typeIn ? settings.typeInBack : settings.basicBack;

	const ankiFront = fieldValue(note, frontField, 0);
	const ankiBack = fieldValue(note, backField, 1);

	const build = (label: string, noteValue: string, ankiValue: string): DriftField => {
		const noteNorm = noteToPlain(noteValue);
		const ankiNorm = htmlToPlain(ankiValue);
		return {
			label, noteValue, ankiValue, noteNorm, ankiNorm,
			differs: noteNorm !== ankiNorm,
			reason: describeChange(ankiNorm, noteNorm)
		};
	};

	return [
		build('Frage', card.q, ankiFront),
		build('Antwort', card.a, ankiBack)
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
