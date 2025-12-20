import { Editor } from 'obsidian';
import { Card } from '../types';
import { normalizeNewlines } from '../utils';

export const ANKI_BLOCK_REGEX = /^[\s>]*```anki-cards\s*\n([\s\S]*?)^[\s>]*```$/gm;

export interface AnkiParsedInfo {
	subdeck: string;
	existingCardsText: string;
	deckName: string | null;
	instruction?: string;
	disabledInstruction?: string;
	status?: string;
}

// Helper: Entfernt Blockquote-Prefixe ("> " oder ">")
function stripBlockquotePrefixes(text: string): string {
    return text.replace(/^[ \t]*>[ \t]?/gm, '');
}

// Helper to detect common line prefix (e.g. "> " or "   ") to preserve indentation/callouts
export function detectBlockPrefix(text: string): string {
    const lines = text.split('\n');
    if (lines.length === 0) return '';
    // Look at the first line (fence)
    const match = lines[0].match(/^([\s>]*)/);
    return match ? match[1] : '';
}

export function applyPrefixToBlock(blockContent: string, prefix: string): string {
    if (!prefix) return blockContent;
    const lines = blockContent.split('\n');
    // Don't double prefix if already there? No, blockContent usually clean.
    return lines.map(l => prefix + l).join('\n');
}

// Helper: Formatiert eine einzelne Karte konsistent als Q:/A: Block
function formatSingleCard(card: Card): string[] {
	const lines: string[] = [];

	const qPrefix = 'Q:';
	const qLines = card.q.split('\n');
	qLines.forEach((line, i) => {
		lines.push(i === 0 ? `${qPrefix} ${line}` : line);
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

export function formatCardsToString(deckLine: string, cards: Card[], instruction?: string, status?: string): string {
	const newLines: string[] = [deckLine.trim()];
	if (instruction) newLines.push(`INSTRUCTION: ${instruction.trim()}`);
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

export function findSpecificAnkiBlock(fullContent: string, originalSourceContent: string): { matchIndex: number, originalFullBlockSource: string } {
	ANKI_BLOCK_REGEX.lastIndex = 0;
	const matches = [...fullContent.matchAll(ANKI_BLOCK_REGEX)];
	let originalFullBlockSource = "";
	let matchIndex = -1;

	const normalizedSource = normalizeNewlines(originalSourceContent);

	if (matches.length > 0) {
        // Try exact match first (after stripping potential prefixes from file content)
		const match = Array.from(matches).find(m => {
            const cleanContent = stripBlockquotePrefixes(m[1]);
            return normalizeNewlines(cleanContent) === normalizedSource
        });

		if (match) {
			originalFullBlockSource = match[0];
			matchIndex = match.index ?? -1;
		} else {
            // Fallback: Trimmed match
			const normalizedSourceTrimmed = normalizedSource.trim();
			const fallbackMatch = Array.from(matches).find(m => {
                 const cleanContent = stripBlockquotePrefixes(m[1]);
                 return normalizeNewlines(cleanContent).trim() === normalizedSourceTrimmed
            });
			if (fallbackMatch) {
				originalFullBlockSource = fallbackMatch[0];
				matchIndex = fallbackMatch.index ?? -1;
			} else {
                // Last ditch: just take the last block? 
                // Maybe risky if multiple blocks. But consistent with previous logic.
				const lastMatch = matches[matches.length - 1];
				originalFullBlockSource = lastMatch[0];
				matchIndex = lastMatch.index ?? -1;
			}
		}
	}
	return { matchIndex, originalFullBlockSource };
}

// Helper zum Entfernen von Cloze-Syntax {{c1::Text}} -> Text
function stripClozeSyntax(text: string): string {
	return text.replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '$1');
}

export function parseCardsFromBlockSource(source: string): Card[] {
	const lines = source.trim().split('\n');
	const cards: Card[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmedLine = line.trim();

		if (trimmedLine.length === 0 ||
			trimmedLine.startsWith('TARGET DECK:') ||
			trimmedLine.startsWith('INSTRUCTION:') ||
			trimmedLine.startsWith('STATUS:') ||
			trimmedLine === 'xxx') {
			i++;
			continue;
		}
		// --- INTELLIGENTE LISTEN-ZUSAMMENFÜHRUNG ---
		// Erkennt, ob die KI fälschlicherweise "Q: - Item" geschrieben hat, obwohl es eine Liste sein sollte.
		// Wir prüfen auf "Q: -" oder "Q: 1." (mit Leerzeichen danach)
		const isListFragment = trimmedLine.match(/^Q:\s*(?:(?:-|•|\*)\s|\d+\.\s)/);

		if (isListFragment && cards.length > 0) {
			// Wir haben ein Fragment gefunden! 
			// 1. Inhalt extrahieren (alles nach "Q:")
			let content = trimmedLine.substring(2).trim();

			// 2. Cloze-Syntax entfernen (Listen in Basic-Karten haben keine Lücken)
			content = stripClozeSyntax(content);

			console.log(`[AnkiParser] Merging List Fragment: "${content}" into previous card.`);

			// 3. An die Antwort der VORHERIGEN Karte anhängen
			const lastCard = cards[cards.length - 1];

			// Als neue Zeile anhängen
			if (lastCard.a) {
				lastCard.a += '\n' + content;
			} else {
				lastCard.a = content;
			}

			// Wir konsumieren diese Zeile und springen zur nächsten
			i++;
			continue;
		}
		// ---------------------------------------------

		const isQ = line.startsWith('Q:');
		const isLegacyCloze = !isQ && (line.includes('{{c') || line.includes('____'));

		if (isQ || isLegacyCloze) {
			let q = '';
			if (isQ) {
				q = line.substring(2).trim();
			} else {
				q = line;
			}

			let a = '';
			let id: number | null = null;
			let typeIn = false;
			let currentLineIndex = i + 1;

			// Lese Q (nur für Basic/Cloze, IO hat Q in einer Zeile)
			while (currentLineIndex < lines.length) {
				const nextLine = lines[currentLineIndex];
				const trimmedNext = nextLine.trim();

				if (nextLine.startsWith('A:') ||
					nextLine.startsWith('A (type):') ||
					nextLine.startsWith('ID:') ||
					nextLine.startsWith('Q:') ||
					trimmedNext === 'xxx') break;

				if (isLegacyCloze && (nextLine.includes('{{c') || nextLine.includes('____'))) break;

				q += '\n' + nextLine;
				currentLineIndex++;
			}

			// Lese A
			if (currentLineIndex < lines.length) {
				const nextLine = lines[currentLineIndex];

				let isAnswerStart = nextLine.startsWith('A:') || nextLine.startsWith('A (type):');

				if (isAnswerStart) {
					// Robust prefix stripping to handle cases like "A: A: (type)"
					let rawLine = nextLine;
					while (true) {
						rawLine = rawLine.trim();
						if (rawLine.startsWith('A (type):')) {
							typeIn = true;
							rawLine = rawLine.substring(9);
						} else if (rawLine.startsWith('A:')) {
							rawLine = rawLine.substring(2);
						} else if (rawLine.startsWith('(type):')) {
							typeIn = true;
							rawLine = rawLine.substring(7);
						} else {
							break;
						}
					}
					a = rawLine;

					currentLineIndex++;

					while (currentLineIndex < lines.length) {
						const aNextLine = lines[currentLineIndex];
						if (aNextLine.startsWith('ID:') ||
							aNextLine.startsWith('Q:') ||
							aNextLine.startsWith('INSTRUCTION:') ||
							aNextLine.startsWith('STATUS:') ||
							aNextLine.trim() === 'xxx' ||
							(aNextLine.includes('{{c') || aNextLine.includes('____'))) break;

						a += '\n' + aNextLine;
						currentLineIndex++;
					}
				}
			}

			if (currentLineIndex < lines.length && lines[currentLineIndex].trim().startsWith('ID:')) {
				id = parseInt(lines[currentLineIndex].trim().substring(3).trim(), 10) || null;
				currentLineIndex++;
			}

			let type: 'Basic' | 'Cloze' = 'Basic';
			if (q.includes('{{c') || q.includes('____')) {
				type = 'Cloze';
			}

			// Bereinigung für Basic-Karten: Falls Cloze-Syntax in A: gelandet ist, entfernen
			if (type === 'Basic' && a.includes('{{c')) {
				a = stripClozeSyntax(a);
			}

			const card: Card = { type, q: q.trim(), a: a.trim(), id, typeIn };
			// Reconstruct original text roughly for manual mode
			const originalLines = formatSingleCard(card);
			card.originalText = originalLines.join('\n');
			cards.push(card);
			i = currentLineIndex;
		} else {
			i++;
		}
	}
	return cards;
}

export function parseAnkiSection(editor: Editor, mainDeck: string): AnkiParsedInfo | null {
	const fileContent = editor.getValue();
	const matches = [...fileContent.matchAll(ANKI_BLOCK_REGEX)];

	if (matches.length === 0) return null;

	const lastMatch = matches[matches.length - 1];
	const blockContent = lastMatch[1];
	const lines = blockContent.trim().split('\n');

	const deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:'));
	const instructionLine = lines.find(l => l.trim().startsWith('INSTRUCTION:'));
	const disabledInstructionLine = lines.find(l => l.trim().startsWith('# INSTRUCTION:'));
	const statusLine = lines.find(l => l.trim().startsWith('STATUS:'));

	const fullDeckPath = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;
	const instruction = instructionLine ? instructionLine.replace('INSTRUCTION:', '').trim() : undefined;
	const disabledInstruction = disabledInstructionLine ? disabledInstructionLine.replace('# INSTRUCTION:', '').trim() : undefined;
	const status = statusLine ? statusLine.replace('STATUS:', '').trim() : undefined;

	const subdeck = fullDeckPath && fullDeckPath.startsWith(mainDeck + '::')
		? fullDeckPath.substring(mainDeck.length + 2)
		: '';

	const parsedCards = parseCardsFromBlockSource(blockContent);
	const existingCardsText = formatCardsToExistingCardsString(parsedCards);

	return { subdeck, existingCardsText, deckName: fullDeckPath, instruction, disabledInstruction, status };
}