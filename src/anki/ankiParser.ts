import { Editor } from 'obsidian';

export interface AnkiInfo {
	subdeck: string;
	deckLineNumber: number;
	existingCardsText: string;
}

export function parseAnkiSection(editor: Editor, mainDeck: string): AnkiInfo | null {
	const lines = editor.getValue().split('\n');
	let ankiSectionStartLine = -1;
	let deckLineNumber = -1;
	let subdeck = '';

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (/^#+\s*Anki\s*$/i.test(line)) { ankiSectionStartLine = i; }
		if (ankiSectionStartLine !== -1 && line === 'TARGET DECK') {
			const deckLine = lines[i + 1]?.trim();
			if (deckLine && deckLine.startsWith(mainDeck + '::')) {
				subdeck = deckLine.substring(mainDeck.length + 2);
				deckLineNumber = i + 1;
				break;
			}
		}
	}
	if (ankiSectionStartLine === -1) return null;

	const cardLines = lines.slice(ankiSectionStartLine);
	const existingCardsText = cardLines.filter(line => line.trim().startsWith('Q:') || line.trim().startsWith('A:') || line.trim().includes('xxx')).join('\n');
	return { subdeck, deckLineNumber, existingCardsText };
}
