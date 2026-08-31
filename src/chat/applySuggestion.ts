import { App, TFile, Notice } from 'obsidian';
import { Card } from '../types';
import { CardSuggestion, EditSuggestion, Suggestion } from './suggestions';
import { applyFindReplace, locate } from './textLocator';
import {
	getAnkiBlocks,
	parseCardsFromBlockSource,
	parseBlockHeader,
	formatCardsToString,
	buildFullBlock,
	spliceBlock
} from '../anki/ankiParser';

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

/** Prüft, ob sich der FIND-Text überhaupt finden lässt (für die Vorschau). */
export async function canLocateEdit(
	app: App,
	sourcePath: string | undefined,
	suggestion: EditSuggestion
): Promise<boolean> {
	const file = getFile(app, sourcePath);
	if (!file) return false;
	const content = await app.vault.read(file);
	return locate(content, suggestion.find) !== null;
}

/**
 * Kartenänderung anwenden. Läuft rein über die Karten-ID bzw. über Anhängen -
 * hier ist keine Textsuche nötig, deshalb ist dieser Weg der zuverlässigere.
 */
export async function applyCardSuggestion(
	app: App,
	sourcePath: string | undefined,
	suggestion: CardSuggestion
): Promise<ApplyResult> {
	const file = getFile(app, sourcePath);
	if (!file) return { ok: false, message: 'Notiz nicht gefunden.' };

	let result: ApplyResult = { ok: false, message: 'Kein anki-cards-Block in der Notiz.' };

	await app.vault.process(file, (content) => {
		const blocks = getAnkiBlocks(content);
		if (blocks.length === 0) return content;

		// Den Block nehmen, der die Karte enthält; sonst den letzten.
		let target = blocks[blocks.length - 1];
		if (suggestion.id !== null) {
			const owner = blocks.find(b =>
				parseCardsFromBlockSource(b.innerClean).some(c => c.id === suggestion.id));
			if (owner) {
				target = owner;
			} else if (suggestion.op !== 'add') {
				result = { ok: false, message: `Karte mit ID ${suggestion.id} nicht gefunden.` };
				return content;
			}
		}

		const cards = parseCardsFromBlockSource(target.innerClean);
		const header = parseBlockHeader(target.innerClean);

		if (suggestion.op === 'delete') {
			const before = cards.length;
			const kept = cards.filter(c => c.id !== suggestion.id);
			if (kept.length === before) {
				result = { ok: false, message: `Karte mit ID ${suggestion.id} nicht gefunden.` };
				return content;
			}
			result = { ok: true, message: 'Karte gelöscht.' };
			return writeBack(content, target, header, kept);
		}

		const newCard: Card = {
			type: /\{\{c\d+::/.test(suggestion.q) ? 'Cloze' : 'Basic',
			q: suggestion.q,
			a: suggestion.a,
			id: suggestion.id,
			typeIn: suggestion.typeIn
		};

		if (suggestion.op === 'add') {
			cards.push(newCard);
			result = { ok: true, message: 'Karte hinzugefügt.' };
			return writeBack(content, target, header, cards);
		}

		// update
		const index = cards.findIndex(c => c.id === suggestion.id);
		if (index === -1) {
			result = { ok: false, message: `Karte mit ID ${suggestion.id} nicht gefunden.` };
			return content;
		}

		// typeIn nur überschreiben, wenn der Vorschlag es explizit setzt.
		cards[index] = {
			...cards[index],
			q: newCard.q,
			a: newCard.a,
			type: newCard.type,
			typeIn: suggestion.typeIn || cards[index].typeIn
		};
		result = { ok: true, message: 'Karte aktualisiert.' };
		return writeBack(content, target, header, cards);
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
	suggestion: Suggestion
): Promise<ApplyResult> {
	const result = suggestion.kind === 'edit'
		? await applyEditSuggestion(app, sourcePath, suggestion)
		: await applyCardSuggestion(app, sourcePath, suggestion);

	new Notice(result.message, result.ok ? 3000 : 6000);
	return result;
}
