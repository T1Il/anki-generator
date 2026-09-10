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

		// update/delete: erst über die Anki-ID, dann über die CARD-Nummer.
		// Der ID-Weg bleibt vorn, weil er auch nach Umsortieren noch stimmt.
		let hit: { bi: number; ci: number } | null = null;

		if (suggestion.id !== null) {
			for (let bi = 0; bi < parsed.length && !hit; bi++) {
				const ci = parsed[bi].cards.findIndex(c => c.id === suggestion.id);
				if (ci >= 0) hit = { bi, ci };
			}
		}

		if (!hit && suggestion.ref !== null) {
			const pos = flat[suggestion.ref - 1];
			if (!pos) {
				result = {
					ok: false,
					message: `CARD: ${suggestion.ref} gibt es nicht — die Notiz hat ${flat.length} Karten.`
				};
				return content;
			}
			hit = pos;
		}

		if (!hit) {
			result = {
				ok: false,
				message: suggestion.id !== null
					? `Karte mit ID ${suggestion.id} nicht gefunden.`
					: 'Der Vorschlag nennt weder CARD: noch ID:.'
			};
			return content;
		}

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
	suggestion: Suggestion
): Promise<ApplyResult> {
	if (suggestion.kind === 'invalid') {
		const result = { ok: false, message: suggestion.reason };
		new Notice(result.message, 6000);
		return result;
	}

	const result = suggestion.kind === 'edit'
		? await applyEditSuggestion(app, sourcePath, suggestion)
		: await applyCardSuggestion(app, sourcePath, suggestion);

	new Notice(result.message, result.ok ? 3000 : 6000);
	return result;
}
