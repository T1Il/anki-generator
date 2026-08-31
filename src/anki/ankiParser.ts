import { Editor } from 'obsidian';
import { Card } from '../types';
import { normalizeNewlines } from '../utils';

/**
 * Nur noch als Kompatibilitäts-Export vorhanden. Für neue Aufrufe bitte
 * getAnkiBlocks() benutzen - das Regex hier kann weder CRLF noch verschachtelte
 * Code-Fences und schluckt Leerzeilen oberhalb des Blocks.
 */
export const ANKI_BLOCK_REGEX = /^[ \t>]*```anki-cards[ \t]*\r?\n([\s\S]*?)^[ \t>]*```[ \t]*\r?$/gm;

/** Öffnende Fence: beliebiger Blockquote-/Einrückungs-Prefix, 3 oder mehr Backticks. */
const OPEN_FENCE = /^([ \t>]*)(`{3,})anki-cards[ \t]*\r?$/;

export interface AnkiBlock {
	/** Index der öffnenden Fence im Dateiinhalt. */
	start: number;
	/** Index direkt hinter der schließenden Fence (ohne deren Zeilenumbruch). */
	end: number;
	/** Zeilen-Prefix, z. B. "> " in einem Callout. */
	prefix: string;
	/** Die verwendeten Backticks (``` oder mehr). */
	fence: string;
	/** Roher Inhalt zwischen den Fences, unverändert. */
	inner: string;
	/** Inhalt ohne CRLF und ohne Blockquote-Prefixe - das, was geparst werden soll. */
	innerClean: string;
}

export interface AnkiParsedInfo {
	subdeck: string;
	existingCardsText: string;
	deckName: string | null;
	instruction?: string;
	disabledInstruction?: string;
	status?: string;
}

// --- Textbereinigung ------------------------------------------------------

/** Entfernt Blockquote-Prefixe ("> " oder ">") sowie führende Einrückung. */
export function stripBlockquotePrefixes(text: string): string {
	return text.replace(/^[ \t]*>[ \t]?/gm, '');
}

/** Wie viele '>' der Block selbst als Prefix trägt (Callout-Verschachtelung). */
function prefixDepth(prefix: string): number {
	const found = prefix.match(/>/g);
	return found ? found.length : 0;
}

/** Genau `depth` Blockquote-Ebenen abtragen, nicht mehr. */
function stripDepth(text: string, depth: number): string {
	if (depth <= 0) return text;
	return text
		.split('\n')
		.map((line) => {
			let rest = line;
			for (let d = 0; d < depth; d++) {
				const m = rest.match(/^[ \t]*>[ \t]?/);
				if (!m) break;
				rest = rest.substring(m[0].length);
			}
			return rest;
		})
		.join('\n');
}

/**
 * Der Inhalt, auf dem alle Vergleiche und das Karten-Parsing arbeiten.
 *
 * WICHTIG: Es wird nur der Prefix abgetragen, den der BLOCK selbst hat.
 * Früher wurde jede Zeile entprefixt - dadurch verschwand ein Zitat
 * ("> Laut Leitlinie ...") innerhalb einer Antwort und war beim nächsten
 * Schreibvorgang dauerhaft weg.
 */
export function cleanBlockInner(inner: string, prefix = ''): string {
	return stripDepth(normalizeNewlines(inner), prefixDepth(prefix));
}

// Helper to detect common line prefix (e.g. "> " or "   ") to preserve indentation/callouts
export function detectBlockPrefix(text: string): string {
	const lines = text.split('\n');
	if (lines.length === 0) return '';
	const match = lines[0].match(/^([\s>]*)/);
	return match ? match[1] : '';
}

export function applyPrefixToBlock(blockContent: string, prefix: string): string {
	if (!prefix) return blockContent;
	return blockContent.split('\n').map(l => prefix + l).join('\n');
}

// --- Blocksuche -----------------------------------------------------------

/**
 * Findet alle anki-cards-Blöcke inklusive exakter Zeichenpositionen.
 *
 * Bewusst zeilenbasiert statt per Regex, weil damit drei Fehlerquellen
 * verschwinden: CRLF, Leerzeilen die vom Prefix mitgefressen werden, und
 * Code-Fences innerhalb einer Antwort (eine mit ```` geöffnete Karte wird
 * erst von ```` wieder geschlossen).
 */
export function getAnkiBlocks(content: string): AnkiBlock[] {
	const blocks: AnkiBlock[] = [];
	const lines = content.split('\n');

	// Zeichen-Offset jeder Zeile vorberechnen.
	const lineStarts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineStarts.push(offset);
		offset += line.length + 1; // +1 für das entfernte '\n'
	}

	let i = 0;
	while (i < lines.length) {
		const open = lines[i].match(OPEN_FENCE);
		if (!open) {
			i++;
			continue;
		}

		const prefix = open[1];
		const fence = open[2];
		// Geschlossen wird nur von mindestens genauso vielen Backticks.
		const closeRe = new RegExp('^[ \\t>]*`{' + fence.length + ',}[ \\t]*\\r?$');

		let j = i + 1;
		while (j < lines.length && !closeRe.test(lines[j])) j++;

		if (j >= lines.length) {
			// Unabgeschlossener Block. Haeufigste Ursache: die schliessende Fence
			// klebt an der letzten Inhaltszeile ("...Text```" statt eigener Zeile).
			// Obsidian rendert den Block dann ebenfalls nicht - deshalb laut melden,
			// statt still 0 Karten zu liefern.
			console.warn(
				`[AnkiParser] anki-cards-Block ab Zeile ${i + 1} hat keine schliessende Fence. ` +
				`Steht das abschliessende ${fence} vielleicht am Ende einer Inhaltszeile?`
			);
			i++;
			continue;
		}

		const inner = lines.slice(i + 1, j).join('\n');
		blocks.push({
			start: lineStarts[i],
			end: lineStarts[j] + lines[j].length,
			prefix,
			fence,
			inner,
			innerClean: cleanBlockInner(inner, prefix)
		});

		i = j + 1;
	}

	return blocks;
}

/**
 * Drop-in-Ersatz für `[...content.matchAll(ANKI_BLOCK_REGEX)]`.
 * m[0] = vollständige Blockquelle, m[1] = BEREINIGTER Inhalt, m.index = Startindex.
 * Dadurch funktionieren Blöcke in Callouts und CRLF-Dateien überall auf einen Schlag.
 */
export interface AnkiBlockMatch extends Array<string> {
	index: number;
	block: AnkiBlock;
}

export function getAnkiBlockMatches(content: string): AnkiBlockMatch[] {
	return getAnkiBlocks(content).map(b => {
		const arr = [content.substring(b.start, b.end), b.innerClean] as any as AnkiBlockMatch;
		arr.index = b.start;
		arr.block = b;
		return arr;
	});
}

/** Ersetzt den Inhalt eines Blocks positionsgenau. Kein String.replace - das würde `$&` interpretieren. */
export function spliceBlock(content: string, block: AnkiBlock, newFullBlock: string): string {
	return content.substring(0, block.start) + newFullBlock + content.substring(block.end);
}

/** Baut die vollständige Blockquelle (inkl. Fences und Prefix) neu auf. */
export function buildFullBlock(block: AnkiBlock, newInner: string): string {
	const lines = [block.fence + 'anki-cards']
		.concat(newInner.split('\n'))
		.concat([block.fence]);
	return lines.map(l => (block.prefix ? block.prefix + l : l)).join('\n');
}

/**
 * Sucht den Block, dessen Inhalt zu `originalSourceContent` passt.
 * Gibt matchIndex -1 zurück, wenn nichts passt - früher wurde hier
 * stillschweigend der letzte Block genommen, was fremde Blöcke überschrieben hat.
 */
export function findSpecificAnkiBlock(
	fullContent: string,
	originalSourceContent: string
): { matchIndex: number, originalFullBlockSource: string, block: AnkiBlock | null } {
	const blocks = getAnkiBlocks(fullContent);
	const normalizedSource = cleanBlockInner(originalSourceContent);

	const exact = blocks.find(b => b.innerClean === normalizedSource);
	const hit = exact || blocks.find(b => b.innerClean.trim() === normalizedSource.trim());

	if (!hit) {
		return { matchIndex: -1, originalFullBlockSource: "", block: null };
	}

	return {
		matchIndex: hit.start,
		originalFullBlockSource: fullContent.substring(hit.start, hit.end),
		block: hit
	};
}

/** Findet den Block, der zu einem vom Markdown-Prozessor gelieferten `source` gehört. */
export function findBlockBySource(content: string, source: string): AnkiBlock | null {
	const blocks = getAnkiBlocks(content);
	const target = cleanBlockInner(source);
	return blocks.find(b => b.innerClean === target)
		|| blocks.find(b => b.innerClean.trim() === target.trim())
		|| null;
}

// --- Kartenformatierung ---------------------------------------------------

/** Entfernt Cloze-Syntax {{c1::Text}} -> Text, klammersicher (LaTeX!). */
export function stripClozeSyntax(text: string): string {
	let out = '';
	let i = 0;

	while (i < text.length) {
		const start = text.indexOf('{{c', i);
		if (start === -1) {
			out += text.substring(i);
			break;
		}

		const header = text.substring(start).match(/^\{\{c\d+::/);
		if (!header) {
			out += text.substring(i, start + 3);
			i = start + 3;
			continue;
		}

		out += text.substring(i, start);

		// Ab hier Klammern zählen, damit {{c1::\frac{a}{b}}} korrekt endet.
		let depth = 1;
		let k = start + header[0].length;
		let inner = '';
		while (k < text.length && depth > 0) {
			if (text.startsWith('{{', k)) { depth++; inner += '{{'; k += 2; continue; }
			if (text.startsWith('}}', k)) {
				depth--;
				if (depth === 0) { k += 2; break; }
				inner += '}}';
				k += 2;
				continue;
			}
			inner += text[k];
			k++;
		}

		// Optionalen Hinweis (::hint) abschneiden.
		const hintIdx = inner.lastIndexOf('::');
		if (hintIdx > -1 && !inner.substring(hintIdx + 2).includes('{')) {
			inner = inner.substring(0, hintIdx);
		}

		out += inner;
		i = k;
	}

	return out;
}

/** Enthält der Text echte Cloze-Lücken? `____` allein reicht nicht. */
export function hasCloze(text: string): boolean {
	return /\{\{c\d+::/.test(text);
}

function formatSingleCard(card: Card): string[] {
	const lines: string[] = [];

	const qLines = card.q.split('\n');
	qLines.forEach((line, i) => {
		lines.push(i === 0 ? `Q: ${line}` : line);
	});

	if (card.a && card.a.trim().length > 0) {
		const answerPrefix = card.typeIn ? 'A (type):' : 'A:';
		const aLines = card.a.split('\n');
		aLines.forEach((line, i) => {
			lines.push(i === 0 ? `${answerPrefix} ${line}` : line);
		});
	} else if (card.type === 'Basic') {
		lines.push(card.typeIn ? 'A (type):' : 'A:');
	}

	if (card.id) {
		lines.push(`ID: ${card.id}`);
	}

	return lines;
}

export function formatCardsToExistingCardsString(cards: Card[]): string {
	if (!cards || cards.length === 0) {
		return 'Keine.';
	}
	const allLines: string[] = [];
	cards.forEach((card, index) => {
		allLines.push(...formatSingleCard(card));
		if (index < cards.length - 1) allLines.push('');
	});
	return allLines.join('\n');
}

export function formatCardsToString(
	deckLine: string,
	cards: Card[],
	instruction?: string,
	status?: string,
	/** Weitere Instruction-Zeilen (inkl. deaktivierter "# INSTRUCTION:"), damit sie beim Sync nicht verloren gehen. */
	extraHeaderLines?: string[]
): string {
	const newLines: string[] = [deckLine.trim()];
	if (instruction) newLines.push(`INSTRUCTION: ${instruction.trim()}`);
	if (extraHeaderLines) extraHeaderLines.forEach(l => newLines.push(l.trim()));
	if (status) newLines.push(`STATUS: ${status.trim()}`);

	if (cards.length > 0) newLines.push('');

	cards.forEach((card, index) => {
		newLines.push(...formatSingleCard(card));
		if (index < cards.length - 1) {
			newLines.push('');
		}
	});
	return newLines.join('\n').trimEnd();
}

// --- Kartenparser ---------------------------------------------------------

const HEADER_LINE = /^(TARGET DECK|INSTRUCTION|STATUS)[ \t]*:/i;
const DISABLED_INSTRUCTION_LINE = /^#[ \t]*INSTRUCTION[ \t]*:/i;
const ID_LINE = /^ID:[ \t]*(\d+)[ \t]*$/;
const LIST_ITEM = /^(?:[-•*]|\d+\.)[ \t]+/;

function isHeaderLine(trimmed: string): boolean {
	return HEADER_LINE.test(trimmed) || DISABLED_INSTRUCTION_LINE.test(trimmed);
}

/** Beginnt hier eine neue Karte bzw. endet der aktuelle Abschnitt? */
function isCardBoundary(trimmed: string): boolean {
	return /^Q:/.test(trimmed)
		|| ID_LINE.test(trimmed)
		|| isHeaderLine(trimmed)
		|| trimmed === 'xxx';
}

export function parseCardsFromBlockSource(source: string): Card[] {
	// Selbstverteidigung: der Aufrufer sollte innerClean liefern, aber ein roher
	// Callout-Block darf nicht stillschweigend 0 Karten ergeben.
	// Selbstverteidigung fuer den Fall, dass jemand rohen Callout-Inhalt
	// hereinreicht: nur dann entprefixen, wenn WIRKLICH jede nicht-leere Zeile
	// ein '>' traegt. Ein einzelnes Zitat in einer Antwort bleibt so erhalten.
	const normalized = normalizeNewlines(source);
	const contentLines = normalized.split('\n').filter((l) => l.trim().length > 0);
	const allQuoted = contentLines.length > 0 && contentLines.every((l) => /^[ \t]*>/.test(l));

	const lines = (allQuoted ? stripDepth(normalized, 1) : normalized).trim().split('\n');
	const cards: Card[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmedLine = line.trim();

		if (trimmedLine.length === 0 || isHeaderLine(trimmedLine) || trimmedLine === 'xxx') {
			i++;
			continue;
		}

		// --- LISTEN-ZUSAMMENFÜHRUNG ---
		// Die KI splittet Listen manchmal fälschlich in mehrere "Q: - Item"-Zeilen.
		// Sehr eng gefasst, weil sonst echte Fragen wie "Q: 1. Hilfe bei X"
		// stillschweigend in der Vorkarte verschwinden.
		const listFragment = trimmedLine.match(/^Q:[ \t]*((?:[-•*]|\d+\.)[ \t]+.*)$/);
		if (listFragment && cards.length > 0) {
			const lastCard = cards[cards.length - 1];
			const lastAnswerLine = (lastCard.a || '').split('\n').pop() || '';
			const previousIsList = LIST_ITEM.test(lastAnswerLine.trim());
			const looksLikeQuestion = trimmedLine.includes('?');

			if (previousIsList && !looksLikeQuestion) {
				const content = stripClozeSyntax(listFragment[1].trim());
				console.log(`[AnkiParser] Merging List Fragment: "${content}" into previous card.`);
				lastCard.a = lastCard.a ? lastCard.a + '\n' + content : content;
				i++;
				continue;
			}
		}

		const isQ = /^Q:/.test(trimmedLine);
		const isLegacyCloze = !isQ && (hasCloze(trimmedLine) || trimmedLine.includes('____'));

		if (isQ || isLegacyCloze) {
			let q = isQ ? trimmedLine.substring(2).trim() : line;
			let a = '';
			let id: number | null = null;
			let typeIn = false;
			let currentLineIndex = i + 1;

			// --- Frage (Folgezeilen) ---
			while (currentLineIndex < lines.length) {
				const nextLine = lines[currentLineIndex];
				const trimmedNext = nextLine.trim();

				if (/^A:/.test(trimmedNext) || /^A \(type\):/i.test(trimmedNext) || isCardBoundary(trimmedNext)) break;
				// Legacy-Cloze-Blöcke: jede Zeile ist eine eigene Karte.
				if (isLegacyCloze && (hasCloze(trimmedNext) || trimmedNext.includes('____'))) break;

				q += '\n' + nextLine;
				currentLineIndex++;
			}

			// --- Antwort ---
			if (currentLineIndex < lines.length) {
				const trimmedNext = lines[currentLineIndex].trim();
				const isAnswerStart = /^A:/.test(trimmedNext) || /^A \(type\):/i.test(trimmedNext);

				if (isAnswerStart) {
					// Robustes Prefix-Abtragen für Fälle wie "A: A: (type)".
					let rawLine = trimmedNext;
					for (;;) {
						rawLine = rawLine.trim();
						if (/^A \(type\):/i.test(rawLine)) { typeIn = true; rawLine = rawLine.substring(9); }
						else if (/^\(type\):/i.test(rawLine)) { typeIn = true; rawLine = rawLine.substring(7); }
						else if (/^A:/.test(rawLine)) { rawLine = rawLine.substring(2); }
						else break;
					}
					a = rawLine;
					currentLineIndex++;

					// Antwort läuft bis zur nächsten Karte. Ein "{{c" oder "____"
					// mitten in der Antwort beendet sie NICHT mehr - das erzeugte
					// früher Geisterkarten.
					while (currentLineIndex < lines.length) {
						if (isCardBoundary(lines[currentLineIndex].trim())) break;
						a += '\n' + lines[currentLineIndex];
						currentLineIndex++;
					}
				}
			}

			// --- ID ---
			if (currentLineIndex < lines.length) {
				const idMatch = lines[currentLineIndex].trim().match(ID_LINE);
				if (idMatch) {
					id = parseInt(idMatch[1], 10);
					if (isNaN(id)) id = null;
					currentLineIndex++;
				}
			}

			const type: 'Basic' | 'Cloze' = hasCloze(q) ? 'Cloze' : 'Basic';

			// Cloze-Syntax gehört nicht in die Antwort einer Basic-Karte.
			if (type === 'Basic' && hasCloze(a)) {
				a = stripClozeSyntax(a);
			}

			const card: Card = { type, q: q.trim(), a: a.trim(), id, typeIn };
			card.originalText = formatSingleCard(card).join('\n');
			cards.push(card);
			i = currentLineIndex;
		} else {
			i++;
		}
	}

	return cards;
}

// --- Blockkopf ------------------------------------------------------------

export interface AnkiHeaderInfo {
	deckName: string | null;
	instruction?: string;
	disabledInstruction?: string;
	status?: string;
	/** Alle Instruction-Zeilen außer der ersten aktiven, im Originalwortlaut. */
	extraHeaderLines: string[];
}

export function parseBlockHeader(innerClean: string): AnkiHeaderInfo {
	const lines = innerClean.trim().split('\n');

	const deckLine = lines.find(l => /^TARGET DECK[ \t]*:/i.test(l.trim()));
	const instructionLines = lines.filter(l => /^INSTRUCTION[ \t]*:/i.test(l.trim()));
	const disabledLines = lines.filter(l => DISABLED_INSTRUCTION_LINE.test(l.trim()));
	const statusLine = lines.find(l => /^STATUS[ \t]*:/i.test(l.trim()));

	const strip = (line: string | undefined, key: RegExp) =>
		line ? line.trim().replace(key, '').trim() : undefined;

	return {
		deckName: strip(deckLine, /^TARGET DECK[ \t]*:/i) || null,
		instruction: strip(instructionLines[0], /^INSTRUCTION[ \t]*:/i),
		disabledInstruction: strip(disabledLines[0], /^#[ \t]*INSTRUCTION[ \t]*:/i),
		status: strip(statusLine, /^STATUS[ \t]*:/i),
		// Weitere aktive Instructions + alle deaktivierten unverändert erhalten.
		extraHeaderLines: instructionLines.slice(1).map(l => l.trim()).concat(disabledLines.map(l => l.trim()))
	};
}

export function parseAnkiSection(editor: Editor, mainDeck: string): AnkiParsedInfo | null {
	const blocks = getAnkiBlocks(editor.getValue());
	if (blocks.length === 0) return null;

	const block = blocks[blocks.length - 1];
	const header = parseBlockHeader(block.innerClean);

	const fullDeckPath = header.deckName;
	const subdeck = fullDeckPath && fullDeckPath.startsWith(mainDeck + '::')
		? fullDeckPath.substring(mainDeck.length + 2)
		: '';

	const parsedCards = parseCardsFromBlockSource(block.innerClean);

	return {
		subdeck,
		existingCardsText: formatCardsToExistingCardsString(parsedCards),
		deckName: fullDeckPath,
		instruction: header.instruction,
		disabledInstruction: header.disabledInstruction,
		status: header.status
	};
}
