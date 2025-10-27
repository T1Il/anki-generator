import { Editor } from 'obsidian';

export interface AnkiInfo {
	subdeck: string;
	deckLineNumber: number;
	existingCardsText: string;
}

export function parseAnkiSection(editor: Editor, mainDeck: string): AnkiInfo | null {
	const fileContent = editor.getValue();
	const ankiBlockRegex = /```anki-cards\s*([\s\S]*?)\s*```/g;
	const matches = [...fileContent.matchAll(ankiBlockRegex)];

	if (matches.length === 0) return null;

	const lastMatch = matches[matches.length - 1];
	const blockContent = lastMatch[1];
	const lines = blockContent.trim().split('\n');

	const deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:'));
	if (!deckLine) return null;

	const fullDeckPath = deckLine.replace('TARGET DECK:', '').trim();
	const subdeck = fullDeckPath.startsWith(mainDeck + '::')
		? fullDeckPath.substring(mainDeck.length + 2)
		: '';

	// --- KORRIGIERTE LOGIK START (MEHRZEILIGE ANTWORTEN) ---
	const existingCardsLines: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		const trimmedLine = line.trim();

		// --- LOGIK FÜR BASIC-KARTEN (Q/A) ---
		if (trimmedLine.startsWith('Q:')) {
			existingCardsLines.push(line); // Frage (Q:)

			if (lines[i + 1]?.startsWith('A:')) {
				i++; // Gehe zur 'A:'-Zeile
				existingCardsLines.push(lines[i]); // Füge die 'A:'-Zeile hinzu

				// (NEU) Sammle alle folgenden Zeilen
				let j = i + 1;
				while (j < lines.length &&
					!lines[j].startsWith('Q:') &&
					!lines[j].startsWith('ID:') &&
					lines[j].trim() !== 'xxx') {

					existingCardsLines.push(lines[j]); // Füge Antwortzeile hinzu
					j++;
				}
				i = j - 1;
			}

			if (lines[i + 1]?.trim().startsWith('ID:')) {
				i++;
				existingCardsLines.push(lines[i]); // ID
			}
		}
		// --- LOGIK FÜR LÜCKENTEXT-KARTEN (xxx) ---
		else if (lines[i + 1]?.trim() === 'xxx') {
			existingCardsLines.push(line); // Lückentext-Frage
			i++;
			existingCardsLines.push(lines[i]); // 'xxx'

			// (NEU) Sammle alle folgenden Zeilen
			let j = i + 1;
			while (j < lines.length &&
				!lines[j].startsWith('Q:') &&
				!lines[j].startsWith('ID:') &&
				lines[j].trim() !== 'xxx') {

				existingCardsLines.push(lines[j]); // Füge Antwortzeile hinzu
				j++;
			}
			i = j - 1;

			if (lines[i + 1]?.trim().startsWith('ID:')) {
				i++;
				existingCardsLines.push(lines[i]); // ID
			}
		}
		// Andere Zeilen (wie TARGET DECK) werden ignoriert
	}

	const existingCardsText = existingCardsLines.join('\n');
	// --- KORRIGIERTE LOGIK ENDE ---

	return { subdeck, deckLineNumber: -1, existingCardsText };
}
