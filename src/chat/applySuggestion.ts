import { App, TFile, Notice } from 'obsidian';
import { Card } from '../types';
import { CardSuggestion, EditSuggestion, InsertSuggestion, Suggestion } from './suggestions';
import { applyFindReplace, locate } from './textLocator';
import {
	getAnkiBlocks,
	parseCardsFromBlockSource,
	parseBlockHeader,
	formatCardsToString,
	buildFullBlock,
	spliceBlock
} from '../anki/ankiParser';
import { insertAfterAnchor, newAnkiSection } from './insertText';
import { findeKarte, KartenSuche } from './kartenSuche';

export interface ApplyResult {
	ok: boolean;
	message: string;
}

function getFile(app: App, path: string | undefined): TFile | null {
	if (!path) return null;
	const file = app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}

/** FIND/REPLACE im Fließtext der Notiz anwenden. */
export async function applyEditSuggestion(
	app: App,
	sourcePath: string | undefined,
	suggestion: EditSuggestion
): Promise<ApplyResult> {
	const file = getFile(app, sourcePath);
	if (!file) return { ok: false, message: 'Notiz nicht gefunden.' };

	let result: ApplyResult = { ok: false, message: 'Textstelle nicht gefunden.' };

	await app.vault.process(file, (content) => {
		const updated = applyFindReplace(content, suggestion.find, suggestion.replace);
		if (updated === null) return content;
		result = { ok: true, message: 'Änderung übernommen.' };
		return updated;
	});

	return result;
}

/** Text nach einer Ankerzeile einfuegen. */
export async function applyInsertSuggestion(
	app: App,
	sourcePath: string | undefined,
	suggestion: InsertSuggestion
): Promise<ApplyResult> {
	const file = getFile(app, sourcePath);
	if (!file) return { ok: false, message: 'Notiz nicht gefunden.' };

	let result: ApplyResult = { ok: false, message: 'Ankerzeile (NACH:) nicht gefunden.' };
	await app.vault.process(file, (content) => {
		const updated = insertAfterAnchor(content, suggestion.after, suggestion.text);
		if (updated === null) return content;
		result = { ok: true, message: 'Eingefügt.' };
		return updated;
	});
	return result;
}

/** Prüft, ob sich FIND bzw. NACH überhaupt finden lässt (für die Vorschau). */
export async function canLocateEdit(
	app: App,
	sourcePath: string | undefined,
	suggestion: EditSuggestion | InsertSuggestion
): Promise<boolean> {
	const file = getFile(app, sourcePath);
	if (!file) return false;
	const content = await app.vault.read(file);
	return locate(content, suggestion.kind === 'edit' ? suggestion.find : suggestion.after) !== null;
}

/**
 * Vorab pruefen, ob ein update/delete seine Karte findet – damit ein
 * erfundener Bezug schon in der Vorschlagsbox auffaellt, nicht erst beim Klick.
 * null bei `add`: dort gibt es nichts zu finden.
 */
export async function pruefeKartenVorschlag(
	app: App,
	sourcePath: string | undefined,
	suggestion: CardSuggestion
): Promise<KartenSuche | null> {
	if (suggestion.op === 'add') return null;
	const file = getFile(app, sourcePath);
	if (!file) return { ok: false, alteKarte: false, message: 'Notiz nicht gefunden.' };
	const content = await app.vault.read(file);
	const bloecke = getAnkiBlocks(content).map(b => ({ cards: parseCardsFromBlockSource(b.innerClean) }));
	return findeKarte(content, bloecke, suggestion);
}

/**
 * Stapel fuer einen neuen Kartenblock: der erste TARGET DECK einer Notiz im
 * selben Ordner (oder darueber), sonst der Hauptstapel aus den Einstellungen.
 */
async function deckFuerNeuenBlock(app: App, file: TFile, fallback: string): Promise<string> {
	let folder = file.parent;
	for (let tiefe = 0; folder && tiefe < 3; tiefe++, folder = folder.parent) {
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== 'md' || child.path === file.path) continue;
			const text = await app.vault.cachedRead(child);
			const m = text.match(/^[ \t>]*TARGET DECK:\s*(\S.*)$/m);
			if (m) return m[1].trim();
		}
	}
	return fallback;
}

/**
 * Kartenänderung anwenden. Läuft rein über die Karten-ID bzw. über Anhängen -
 * hier ist keine Textsuche nötig, deshalb ist dieser Weg der zuverlässigere.
 */
export async function applyCardSuggestion(
	app: App,
	sourcePath: string | undefined,
	suggestion: CardSuggestion,
	mainDeck = ''
): Promise<ApplyResult> {
	const file = getFile(app, sourcePath);
	if (!file) return { ok: false, message: 'Notiz nicht gefunden.' };

	let result: ApplyResult = { ok: false, message: 'Kein anki-cards-Block in der Notiz.' };
	// Nur fuer den Fall „noch kein Block" gebraucht, aber vor process() holen:
	// die Callback-Funktion dort darf nicht asynchron sein.
	const deck = suggestion.op === 'add' ? await deckFuerNeuenBlock(app, file, mainDeck) : '';

	await app.vault.process(file, (content) => {
		const blocks = getAnkiBlocks(content);
		if (blocks.length === 0) {
			// Erste Karte einer Notiz: Abschnitt „## Anki" samt Block anlegen.
			if (suggestion.op !== 'add') return content;
			const card: Card = {
				type: /\{\{c\d+::/.test(suggestion.q) ? 'Cloze' : 'Basic',
				q: suggestion.q, a: suggestion.a, id: null, typeIn: suggestion.typeIn
			};
			const inner = formatCardsToString(`TARGET DECK: ${deck}`.trimEnd(), [card], '', undefined, []);
			result = { ok: true, message: 'Kartenblock angelegt, Karte hinzugefügt.' };
			return content.replace(/\s*$/, '') + '\n\n' + newAnkiSection(inner) + '\n';
		}

		// Gleiche Reihenfolge wie im Prompt: alle Blöcke, alle Karten. Die
		// CARD-Nummer aus dem Vorschlag zählt 1-basiert über diese Liste.
		const parsed = blocks.map(b => ({
			block: b,
			cards: parseCardsFromBlockSource(b.innerClean)
		}));
		const flat: { bi: number; ci: number }[] = [];
		parsed.forEach((p, bi) => p.cards.forEach((_, ci) => flat.push({ bi, ci })));

		const newCard: Card = {
			type: /\{\{c\d+::/.test(suggestion.q) ? 'Cloze' : 'Basic',
			q: suggestion.q,
			a: suggestion.a,
			id: suggestion.id,
			typeIn: suggestion.typeIn
		};

		if (suggestion.op === 'add') {
			// In den Block, auf den sich CARD: bezieht; sonst in den letzten.
			const pos = suggestion.ref !== null ? flat[suggestion.ref - 1] : undefined;
			const bi = pos ? pos.bi : parsed.length - 1;
			parsed[bi].cards.push(newCard);
			result = { ok: true, message: 'Karte hinzugefügt.' };
			return writeBack(content, parsed[bi].block,
				parseBlockHeader(parsed[bi].block.innerClean), parsed[bi].cards);
		}

		// update/delete: ID, dann CARD-Nummer, dann Aehnlichkeit der Frage.
		// Der ID-Weg bleibt vorn, weil er auch nach Umsortieren noch stimmt.
		const suche = findeKarte(content, parsed, suggestion);
		if (!suche.ok) {
			result = { ok: false, message: suche.message };
			return content;
		}
		const hit = suche.treffer;

		const { block, cards } = parsed[hit.bi];
		const header = parseBlockHeader(block.innerClean);

		if (suggestion.op === 'delete') {
			cards.splice(hit.ci, 1);
			result = { ok: true, message: 'Karte gelöscht.' };
			return writeBack(content, block, header, cards);
		}

		// typeIn nur überschreiben, wenn der Vorschlag es explizit setzt.
		cards[hit.ci] = {
			...cards[hit.ci],
			q: newCard.q,
			a: newCard.a,
			type: newCard.type,
			typeIn: suggestion.typeIn || cards[hit.ci].typeIn
		};
		result = { ok: true, message: 'Karte aktualisiert.' };
		return writeBack(content, block, header, cards);
	});

	return result;
}

function writeBack(
	content: string,
	block: ReturnType<typeof getAnkiBlocks>[number],
	header: ReturnType<typeof parseBlockHeader>,
	cards: Card[]
): string {
	const deckLine = header.deckName ? `TARGET DECK: ${header.deckName}` : 'TARGET DECK:';
	const inner = formatCardsToString(deckLine, cards, header.instruction, header.status, header.extraHeaderLines);
	return spliceBlock(content, block, buildFullBlock(block, inner));
}

export async function applySuggestion(
	app: App,
	sourcePath: string | undefined,
	suggestion: Suggestion,
	mainDeck = ''
): Promise<ApplyResult> {
	if (suggestion.kind === 'invalid') {
		const result = { ok: false, message: suggestion.reason };
		new Notice(result.message, 6000);
		return result;
	}

	const result = suggestion.kind === 'edit'
		? await applyEditSuggestion(app, sourcePath, suggestion)
		: suggestion.kind === 'insert'
			? await applyInsertSuggestion(app, sourcePath, suggestion)
			: await applyCardSuggestion(app, sourcePath, suggestion, mainDeck);

	new Notice(result.message, result.ok ? 3000 : 6000);
	return result;
}
