import { Editor } from 'obsidian';
import { Card } from '../types';

export interface AnkiParsedInfo {
	subdeck: string;
	existingCardsText: string; // This text should ONLY contain card data, formatted for the AI
	deckName: string | null;
}

// Formats parsed cards back into the string expected by the AI prompt
function formatCardsToExistingCardsString(cards: Card[]): string {
	// KORREKTUR: Explizit "Keine." zurückgeben, wenn keine Karten vorhanden sind.
	if (!cards || cards.length === 0) {
		return 'Keine.';
	}
	const lines: string[] = [];
	cards.forEach((card, cardIndex) => {
		if (card.type === 'Basic') {
			card.q.split('\n').forEach((qLine, index) => lines.push(index === 0 ? `Q: ${qLine}` : qLine));
			if (card.a && card.a.trim().length > 0) {
				card.a.split('\n').forEach((aLine, index) => lines.push(index === 0 ? `A: ${aLine}` : aLine));
			} else {
				lines.push('A:');
			}
		} else { // Cloze
			card.q.split('\n').forEach(qLine => lines.push(qLine));
			lines.push('xxx');
			(card.a || "").split('\n').forEach(aLine => lines.push(aLine));
		}
		if (card.id) {
			lines.push(`ID: ${card.id}`);
		}
		if (cardIndex < cards.length - 1) {
			lines.push(''); // Add blank line separator ONLY between cards
		}
	});
	return lines.join('\n');
}

// Robust card parsing logic (remains the same)
export function parseCardsFromBlockSource(source: string): Card[] {
	const lines = source.trim().split('\n');
	const cards: Card[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmedLine = line.trim();

		if (trimmedLine.length === 0 || trimmedLine.startsWith('TARGET DECK:')) {
			i++;
			continue;
		}

		if (line.startsWith('Q:')) {
			let q = line.substring(2).trim();
			let a = '';
			let id: number | null = null;
			let currentLineIndex = i + 1;

			while (currentLineIndex < lines.length &&
				!lines[currentLineIndex].startsWith('A:') &&
				!lines[currentLineIndex].startsWith('ID:') &&
				!lines[currentLineIndex].startsWith('Q:')) {
				if (lines[currentLineIndex].trim() === 'xxx' || lines[currentLineIndex].includes('____')) break;
				q += '\n' + lines[currentLineIndex];
				currentLineIndex++;
			}

			if (currentLineIndex < lines.length && lines[currentLineIndex].startsWith('A:')) {
				a = lines[currentLineIndex].substring(2).trim();
				currentLineIndex++;
				while (currentLineIndex < lines.length &&
					!lines[currentLineIndex].startsWith('ID:') &&
					!lines[currentLineIndex].startsWith('Q:')) {
					if (lines[currentLineIndex].trim() === 'xxx' || lines[currentLineIndex].includes('____')) break;
					a += '\n' + lines[currentLineIndex];
					currentLineIndex++;
				}
			}

			if (currentLineIndex < lines.length && lines[currentLineIndex].trim().startsWith('ID:')) {
				id = parseInt(lines[currentLineIndex].trim().substring(3).trim(), 10) || null;
				currentLineIndex++;
			}

			cards.push({ type: 'Basic', q: q.trim(), a: a.trim(), id });
			i = currentLineIndex;

		} else {
			let q = line;
			let a = '';
			let id: number | null = null;
			let currentLineIndex = i + 1;
			let foundXxx = false;

			while (currentLineIndex < lines.length &&
				lines[currentLineIndex].trim() !== 'xxx' &&
				!lines[currentLineIndex].startsWith('Q:') &&
				!lines[currentLineIndex].startsWith('ID:')) {
				if (lines[currentLineIndex].includes('____')) break;
				q += '\n' + lines[currentLineIndex];
				currentLineIndex++;
			}

			if (currentLineIndex < lines.length && lines[currentLineIndex].trim() === 'xxx') {
				foundXxx = true;
				currentLineIndex++;
				while (currentLineIndex < lines.length &&
					!lines[currentLineIndex].startsWith('ID:') &&
					!lines[currentLineIndex].startsWith('Q:')) {
					if (lines[currentLineIndex].trim() === 'xxx' || lines[currentLineIndex].includes('____')) break;
					a += '\n' + lines[currentLineIndex];
					currentLineIndex++;
				}
			}

			if (currentLineIndex < lines.length && lines[currentLineIndex].trim().startsWith('ID:')) {
				id = parseInt(lines[currentLineIndex].trim().substring(3).trim(), 10) || null;
				currentLineIndex++;
			}

			if (foundXxx || q.includes('____')) {
				cards.push({ type: 'Cloze', q: q.trim(), a: a.trim(), id });
			} else {
				if (q.trim().length > 0) {
					// console.warn("Anki Parser (Cards): Ignoriere unerwartete Zeile:", line);
				}
			}
			i = currentLineIndex;
		}
	}
	cards.forEach(card => {
		if (card.a) card.a = card.a.trim();
	});
	return cards;
}

// Parses the last anki-cards block found in the editor content
export function parseAnkiSection(editor: Editor, mainDeck: string): AnkiParsedInfo | null {
	const fileContent = editor.getValue();
	const ankiBlockRegex = /^```anki-cards\s*([\s\S]*?)^```/gm;
	const matches = [...fileContent.matchAll(ankiBlockRegex)];

	if (matches.length === 0) {
		console.log("parseAnkiSection: No anki-cards block found.");
		return null;
	}

	const lastMatch = matches[matches.length - 1];
	const blockContent = lastMatch[1]; // Nur der Inhalt innerhalb der Zäune
	console.log("parseAnkiSection: Found block content:", JSON.stringify(blockContent));
	const lines = blockContent.trim().split('\n');

	const deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:'));
	// WICHTIG: Erlaube Blöcke ohne Deck-Zeile, aber gib deckName als null zurück
	const fullDeckPath = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;
	const subdeck = fullDeckPath && fullDeckPath.startsWith(mainDeck + '::')
		? fullDeckPath.substring(mainDeck.length + 2)
		: ''; // Wenn kein Deck oder kein Subdeck, ist subdeck leer

	// Parse Karten *nur aus dem Blockinhalt*
	const parsedCards = parseCardsFromBlockSource(blockContent);
	console.log("parseAnkiSection: Parsed cards:", parsedCards);
	const existingCardsText = formatCardsToExistingCardsString(parsedCards); // Gibt "Keine." zurück, wenn leer
	console.log("parseAnkiSection: Formatted existingCardsText for AI:", JSON.stringify(existingCardsText));


	// Gib immer ein Objekt zurück, auch wenn deckName null ist, solange ein Block gefunden wurde
	return { subdeck, existingCardsText, deckName: fullDeckPath };
}
