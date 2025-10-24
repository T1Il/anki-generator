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

	// --- KORRIGIERTE LOGIK START ---
	// Wir iterieren durch die Zeilen, um die Kartenstruktur (Q/A/ID und Cloze/xxx/A/ID) 
	// korrekt zu erfassen, anstatt nur zu filtern.
	const existingCardsLines: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Überspringe leere Zeilen oder Zeilen, die nicht Teil einer Karte sind
		if (!line || line.trim().length === 0) continue;

		const trimmedLine = line.trim();

		// Standard-Karte (Basic)
		if (trimmedLine.startsWith('Q:')) {
			existingCardsLines.push(line); // Frage (Q:)

			// Suche nach Antwort (A:)
			if (lines[i + 1]?.trim().startsWith('A:')) {
				i++;
				existingCardsLines.push(lines[i]); // Antwort (A:)
			}

			// Suche nach ID (ID:)
			if (lines[i + 1]?.trim().startsWith('ID:')) {
				i++;
				existingCardsLines.push(lines[i]); // ID
			}
		}
		// Lückentext-Karte (Cloze)
		// Wir prüfen, ob die *nächste* Zeile 'xxx' ist
		else if (lines[i + 1]?.trim() === 'xxx') {
			existingCardsLines.push(line); // Lückentext-Frage
			i++;
			existingCardsLines.push(lines[i]); // 'xxx'

			// Suche nach Antwort (die Zeile nach 'xxx')
			if (lines[i + 1] && !lines[i + 1].trim().startsWith('ID:')) {
				i++;
				existingCardsLines.push(lines[i]); // Lückentext-Antwort
			}

			// Suche nach ID (ID:)
			if (lines[i + 1]?.trim().startsWith('ID:')) {
				i++;
				existingCardsLines.push(lines[i]); // ID
			}
		}
		// Andere Zeilen (wie TARGET DECK) werden bewusst ignoriert
	}

	const existingCardsText = existingCardsLines.join('\n');
	// --- KORRIGIERTE LOGIK ENDE ---

	return { subdeck, deckLineNumber: -1, existingCardsText };
}
