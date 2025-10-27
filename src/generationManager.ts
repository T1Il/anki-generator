// src/generationManager.ts

import { Editor, Notice } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { SubdeckModal } from './ui/SubdeckModal';
import { ModelSelectionModal } from './ui/ModelSelectionModal';
// DebugModal wird in aiGenerator verwendet
import { parseAnkiSection } from './anki/ankiParser';
import { generateCardsWithAI } from './aiGenerator';

const ANKI_BLOCK_REGEX = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;

export async function triggerCardGeneration(plugin: AnkiGeneratorPlugin, editor: Editor) {
	const initialAnkiInfo = parseAnkiSection(editor, plugin.settings.mainDeck);
	const initialSubdeck = initialAnkiInfo ? initialAnkiInfo.subdeck : '';

	const geminiAvailable = !!plugin.settings.geminiApiKey;
	const ollamaAvailable = plugin.settings.ollamaEnabled && !!plugin.settings.ollamaEndpoint && !!plugin.settings.ollamaModel;

	const startGen = (provider: 'gemini' | 'ollama') => {
		// Rufe startGenerationProcess direkt auf, der Modal wird dort geöffnet
		startGenerationProcess(plugin, editor, provider, initialSubdeck);
	};

	if (geminiAvailable && ollamaAvailable) {
		new ModelSelectionModal(plugin.app, geminiAvailable, ollamaAvailable, startGen).open();
	} else if (geminiAvailable) {
		startGen('gemini');
	} else if (ollamaAvailable) {
		startGen('ollama');
	} else {
		new Notice('Kein KI-Modell konfiguriert.', 7000);
	}
}

async function startGenerationProcess(
	plugin: AnkiGeneratorPlugin,
	editor: Editor,
	provider: 'gemini' | 'ollama',
	initialSubdeck: string
) {
	// Öffne den SubdeckModal, der jetzt auch die zusätzlichen Anweisungen sammelt
	new SubdeckModal(plugin.app, plugin.settings.mainDeck, initialSubdeck, async (newSubdeck, additionalInstructions) => {
		let notice = new Notice(`Bereite Anki-Block für ${provider}...`, 0);

		try {
			const sub = newSubdeck || 'Standard';
			const fullDeckPath = `${plugin.settings.mainDeck}::${sub}`;

			const { blockStartIndex, insertionPoint } = await ensureAnkiBlock(editor, fullDeckPath);
			console.log(`ensureAnkiBlock completed. Start: ${blockStartIndex}, InsertionPoint Line: ${insertionPoint.line}, Ch: ${insertionPoint.ch}`);

			notice.setMessage(`Lese vorhandene Karten...`);
			const currentAnkiInfo = parseAnkiSection(editor, plugin.settings.mainDeck);
			const existingCards = currentAnkiInfo?.existingCardsText || 'Keine.';
			console.log("--- Existing Cards sent to AI (after ensureAnkiBlock) ---\n", existingCards, "\n--- End Existing Cards ---");


			notice.setMessage(`Generiere Karten mit ${provider}...`);
			const currentContentForAI = editor.getValue();

			// --- ÜBERGABE der additionalInstructions an generateCardsWithAI ---
			const generatedTextRaw = await generateCardsWithAI(
				plugin.app,
				currentContentForAI,
				existingCards,
				provider,
				plugin.settings,
				additionalInstructions // Hier übergeben
			);
			// --- ENDE ÜBERGABE ---

			const generatedText = cleanAiGeneratedText(generatedTextRaw);
			console.log("Generierter Text (bereinigt):", JSON.stringify(generatedText));

			if (insertionPoint && generatedText) {
				console.log("Inserting generated text at:", insertionPoint);
				insertGeneratedText(editor, blockStartIndex, insertionPoint, generatedText);
				notice.hide();
				new Notice(`Anki-Block wurde mit ${provider} aktualisiert/hinzugefügt.`);
			} else if (!generatedText) {
				notice.hide();
				new Notice(`Kein neuer Text von ${provider} generiert.`, 5000);
			} else {
				throw new Error("Interner Fehler: Einfügepunkt war ungültig nach ensureAnkiBlock.");
			}

		} catch (error) {
			notice.hide();
			console.error(`Fehler bei der Kartengenerierung mit ${provider} (in startGenerationProcess):`, error);
			if (!(error instanceof Error && (error.message.startsWith("API Fehler") || error.message.startsWith("Netzwerkfehler")))) {
				new Notice(`Fehler: ${error.message}`, 7000);
			}
		}
	}).open(); // Öffne den Modal hier
}

// --- Rest der Datei (ensureAnkiBlock, insertGeneratedText, cleanAiGeneratedText) bleibt unverändert ---

// Stellt sicher, dass ein Anki-Block existiert und gibt Start-Index + Einfügepunkt zurück
async function ensureAnkiBlock(editor: Editor, fullDeckPath: string): Promise<{ blockStartIndex: number, blockEndIndex: number, insertionPoint: CodeMirror.Position }> {
	let fileContent = editor.getValue();
	ANKI_BLOCK_REGEX.lastIndex = 0;
	let matches = [...fileContent.matchAll(ANKI_BLOCK_REGEX)];
	let blockStartIndex = -1;
	let blockEndIndex = -1;
	let blockSourceLength = 0;

	if (matches.length > 0) {
		const lastMatch = matches[matches.length - 1];
		if (lastMatch.index === undefined) throw new Error("Konnte Startindex des letzten Blocks nicht finden.");

		const sourceBlock = lastMatch[0];
		const blockContent = lastMatch[1] || "";
		const blockLines = blockContent.trim().split('\n');
		const deckLine = blockLines.find(l => l.trim().startsWith('TARGET DECK:'));

		blockStartIndex = lastMatch.index;
		blockSourceLength = sourceBlock.length;

		if (!deckLine || deckLine.replace('TARGET DECK:', '').trim() !== fullDeckPath) {
			console.log("Deck line needs update or is missing. Updating block.");
			const linesToKeep = blockLines.filter(l => !l.trim().startsWith('TARGET DECK:'));
			let newBlockInternalContent = `TARGET DECK: ${fullDeckPath}`;
			if (linesToKeep.length > 0 && linesToKeep.some(l => l.trim().length > 0)) {
				newBlockInternalContent += `\n\n${linesToKeep.join('\n')}`;
			} else {
				newBlockInternalContent += `\n`;
			}

			const newAnkiBlockSource = `\`\`\`anki-cards\n${newBlockInternalContent.trim()}\n\`\`\``;
			const startPos = editor.offsetToPos(blockStartIndex);
			const endPos = editor.offsetToPos(blockStartIndex + blockSourceLength);
			editor.replaceRange(newAnkiBlockSource, startPos, endPos);

			blockSourceLength = newAnkiBlockSource.length;
			blockEndIndex = blockStartIndex + blockSourceLength;
		} else {
			blockEndIndex = blockStartIndex + blockSourceLength;
		}

	} else {
		console.log("No anki-cards block found. Creating a new one.");
		const output = `\n\n## Anki\n\n\`\`\`anki-cards\nTARGET DECK: ${fullDeckPath}\n\n\`\`\``;
		const lastLine = editor.lastLine();
		const endOfDocument = { line: lastLine, ch: editor.getLine(lastLine).length };
		editor.replaceRange(output, endOfDocument);

		fileContent = editor.getValue();
		ANKI_BLOCK_REGEX.lastIndex = 0;
		matches = [...fileContent.matchAll(ANKI_BLOCK_REGEX)];
		if (matches.length > 0) {
			const newMatch = matches[matches.length - 1];
			if (newMatch.index !== undefined) {
				blockStartIndex = newMatch.index;
				blockSourceLength = newMatch[0].length;
				blockEndIndex = blockStartIndex + blockSourceLength;
			} else {
				throw new Error("Index des neu erstellten Blocks ist undefiniert nach der Erstellung.");
			}
		} else {
			console.error("Failed to find the newly created anki-cards block. Content:", fileContent);
			throw new Error("Konnte den neu erstellten Anki-Block nicht finden (Regex-Problem?).");
		}
		if (blockStartIndex < 0 || blockEndIndex <= blockStartIndex) {
			throw new Error("Indizes des neu erstellten Blocks sind ungültig nach der Erstellung.");
		}
	}

	const endPos = editor.offsetToPos(blockEndIndex);
	const lineBeforeEndFence = Math.max(0, endPos.line - 1);
	const insertionPoint = { line: lineBeforeEndFence, ch: editor.getLine(lineBeforeEndFence).length };

	const finalInsertionOffset = editor.posToOffset(insertionPoint);
	if (finalInsertionOffset < blockStartIndex || finalInsertionOffset > blockEndIndex - 1) {
		console.error("Ungültiger Einfügepunkt berechnet:", insertionPoint, { blockStartIndex, blockEndIndex });
		const fallbackOffset = Math.max(blockStartIndex + `\`\`\`anki-cards\n`.length, blockEndIndex - 4);
		console.warn(`Fallback insertion offset: ${fallbackOffset}`);
		const fallbackPoint = editor.offsetToPos(fallbackOffset);
		return { blockStartIndex, blockEndIndex, insertionPoint: fallbackPoint };
	}

	return { blockStartIndex, blockEndIndex, insertionPoint };
}

// Fügt den generierten Text korrekt in den Block ein
function insertGeneratedText(editor: Editor, blockStartIndex: number, insertionPoint: CodeMirror.Position, generatedText: string) {
	const blockStartOffset = blockStartIndex + "```anki-cards\n".length;
	const insertionOffset = editor.posToOffset(insertionPoint);
	const validStartOffset = Math.min(Math.max(blockStartOffset, 0), insertionOffset);

	const rangeStartPos = editor.offsetToPos(validStartOffset);
	const contentBeforeInsertionRaw = editor.getRange(rangeStartPos, insertionPoint);
	const contentBeforeInsertionTrimmedEnd = contentBeforeInsertionRaw.replace(/\s+$/, '');

	console.log("Content before insertion (raw):", JSON.stringify(contentBeforeInsertionRaw));
	console.log("Content before insertion (trimmed end):", JSON.stringify(contentBeforeInsertionTrimmedEnd));

	let prefix = "";

	const linesBeforeTrimmed = contentBeforeInsertionTrimmedEnd.split('\n');
	let lastNonEmptyLineIndex = -1;
	for (let i = linesBeforeTrimmed.length - 1; i >= 0; i--) {
		if (linesBeforeTrimmed[i].trim().length > 0) {
			lastNonEmptyLineIndex = i;
			break;
		}
	}

	if (lastNonEmptyLineIndex === -1) {
		prefix = "";
		console.log("Prefix determined: Empty prefix for effectively empty block.");
	} else {
		const trailingNewlinesRaw = contentBeforeInsertionRaw.substring(contentBeforeInsertionTrimmedEnd.length);
		const numberOfTrailingNewlines = (trailingNewlinesRaw.match(/\n/g) || []).length;

		console.log("Number of trailing newlines in raw content:", numberOfTrailingNewlines);

		if (numberOfTrailingNewlines === 0) {
			prefix = "\n\n";
			console.log("Prefix determined: Double newline (no trailing newline).");
		} else if (numberOfTrailingNewlines === 1) {
			prefix = "\n";
			console.log("Prefix determined: Single newline (already ends with single newline).");
		} else {
			prefix = "";
			console.log("Prefix determined: Empty prefix (already ends with sufficient newlines).");
		}
	}

	console.log("Final prefix:", JSON.stringify(prefix));
	editor.replaceRange(`${prefix}${generatedText}`, insertionPoint);
}


// Bereinigt den KI-Output (bleibt gleich)
function cleanAiGeneratedText(rawText: string): string {
	const lines = rawText.trim().split('\n');
	const validCardLines: string[] = [];
	let insideNestedBlock = false;

	for (const line of lines) {
		const trimmedLine = line.trim();

		if (trimmedLine.startsWith('```')) {
			insideNestedBlock = !insideNestedBlock;
			continue;
		}
		if (insideNestedBlock) {
			continue;
		}
		if (trimmedLine.length === 0) {
			if (validCardLines.length > 0 && validCardLines[validCardLines.length - 1].trim().length > 0) {
				validCardLines.push('');
			}
			continue;
		}
		const lowerTrimmed = trimmedLine.toLowerCase();
		if (lowerTrimmed.startsWith("here are the anki cards") ||
			lowerTrimmed.startsWith("note that i've only created cards") ||
			lowerTrimmed.startsWith("target deck:")
		) {
			continue;
		}

		if (trimmedLine.startsWith('Q:') ||
			trimmedLine.startsWith('A:') ||
			trimmedLine.startsWith('ID:') ||
			trimmedLine === 'xxx' ||
			line.includes('____') ||
			(validCardLines.length > 0 &&
				(validCardLines[validCardLines.length - 1].startsWith('Q:') || validCardLines[validCardLines.length - 1].startsWith('A:') || validCardLines[validCardLines.length - 1] === 'xxx' || validCardLines[validCardLines.length - 1].includes('____')))

		) {
			if (validCardLines.length > 0 && validCardLines[validCardLines.length - 1].trim().length === 0 && line.trim().length > 0) {
				validCardLines.pop();
			}
			validCardLines.push(line);
		} else {
			console.warn("CleanAI: Ignoriere ungültige Zeile:", line);
		}
	}

	while (validCardLines.length > 0 && validCardLines[validCardLines.length - 1].trim().length === 0) {
		validCardLines.pop();
	}

	return validCardLines.join('\n');
}
