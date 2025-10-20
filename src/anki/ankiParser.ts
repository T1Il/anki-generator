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

	const existingCardsText = lines.filter(line =>
		line.trim().startsWith('Q:') ||
		line.trim().startsWith('A:') ||
		line.trim().includes('xxx')
	).join('\n');

	return { subdeck, deckLineNumber: -1, existingCardsText };
}
