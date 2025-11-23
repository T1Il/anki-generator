// src/generationManager.ts

import { Editor, Notice, TFile, normalizePath } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { SubdeckModal } from './ui/SubdeckModal';
import { ModelSelectionModal } from './ui/ModelSelectionModal';
// DebugModal wird in aiGenerator verwendet
import { parseAnkiSection } from './anki/ankiParser';
import { generateCardsWithAI } from './aiGenerator';
import { ImageInput } from './types';
import { arrayBufferToBase64, getMimeType } from './utils';

const ANKI_BLOCK_REGEX = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;

export async function triggerCardGeneration(plugin: AnkiGeneratorPlugin, editor: Editor) {
	const initialAnkiInfo = parseAnkiSection(editor, plugin.settings.mainDeck);
	const initialSubdeck = initialAnkiInfo ? initialAnkiInfo.subdeck : '';

	const geminiAvailable = !!plugin.settings.geminiApiKey;
	const openAiAvailable = !!plugin.settings.openAiApiKey;
	const ollamaAvailable = plugin.settings.ollamaEnabled && !!plugin.settings.ollamaEndpoint && !!plugin.settings.ollamaModel;

	const startGen = (provider: 'gemini' | 'ollama' | 'openai') => {
		// Rufe startGenerationProcess direkt auf, der Modal wird dort geöffnet
		startGenerationProcess(plugin, editor, provider, initialSubdeck);
	};

	// Prüfen wie viele Provider verfügbar sind
	const availableProviders = [geminiAvailable, openAiAvailable, ollamaAvailable].filter(Boolean).length;

	if (availableProviders > 1) {
		new ModelSelectionModal(plugin.app, geminiAvailable, ollamaAvailable, openAiAvailable, startGen).open();
	} else if (geminiAvailable) {
		startGen('gemini');
	} else if (openAiAvailable) {
		startGen('openai');
	} else if (ollamaAvailable) {
		startGen('ollama');
	} else {
		new Notice('Kein KI-Modell konfiguriert.', 7000);
	}
}

async function startGenerationProcess(
	plugin: AnkiGeneratorPlugin,
	editor: Editor,
	provider: 'gemini' | 'ollama' | 'openai',
	initialSubdeck: string
) {
	// Öffne den SubdeckModal, der jetzt auch die zusätzlichen Anweisungen sammelt
	new SubdeckModal(plugin.app, plugin.settings.mainDeck, initialSubdeck, async (newSubdeck, additionalInstructions) => {
		// Rufe die ausgelagerte Logik auf
		await runGenerationProcess(plugin, editor, provider, newSubdeck, additionalInstructions);
	}).open();
}

/**
 * Führt den eigentlichen Generierungsprozess durch (ohne Modals).
 * Kann direkt von Buttons aufgerufen werden.
 */
export async function runGenerationProcess(
	plugin: AnkiGeneratorPlugin,
	editor: Editor,
	provider: 'gemini' | 'ollama' | 'openai',
	subdeck: string,
	additionalInstructions: string = ''
): Promise<string> {
	let notice = new Notice(`Bereite Anki-Block für ${provider} vor...`, 0);

	try {
		const sub = subdeck || 'Standard';
		const fullDeckPath = `${plugin.settings.mainDeck}::${sub}`;

		const { blockStartIndex, insertionPoint } = await ensureAnkiBlock(editor, fullDeckPath);
		console.log(`ensureAnkiBlock completed. Start: ${blockStartIndex}, InsertionPoint Line: ${insertionPoint.line}, Ch: ${insertionPoint.ch}`);

		notice.setMessage(`Lese vorhandene Karten...`);
		const currentAnkiInfo = parseAnkiSection(editor, plugin.settings.mainDeck);
		const existingCards = currentAnkiInfo?.existingCardsText || 'Keine.';
		console.log("--- Existing Cards sent to AI (after ensureAnkiBlock) ---\n", existingCards, "\n--- End Existing Cards ---");

		notice.setMessage(`Suche Bilder im Text...`);
		const currentContentForAI = editor.getValue();

		// Bilder extrahieren
		const activeFile = plugin.app.workspace.getActiveFile();
		const images = await extractImagesFromContent(plugin, currentContentForAI, activeFile ? activeFile.path : '');
		if (images.length > 0) {
			notice.setMessage(`Gefunden: ${images.length} Bilder. Generiere Karten mit ${provider}...`);
		} else {
			notice.setMessage(`Generiere Karten mit ${provider}...`);
		}

		// --- ÜBERGABE der images an generateCardsWithAI ---
		const { cards: generatedTextRaw, feedback } = await generateCardsWithAI(
			plugin.app,
			currentContentForAI,
			existingCards,
			provider,
			plugin.settings,
			additionalInstructions,
			images // Bilder übergeben
		);
		// --- ENDE ÜBERGABE ---

		console.log("runGenerationProcess received feedback:", feedback ? "YES (Length: " + feedback.length + ")" : "NO");

		if (!generatedTextRaw) {
			new Notice("Keine Karten generiert.");
			return "";
		}

		// Store feedback in cache BEFORE modifying the file (which triggers re-render)
		if (feedback) {
			const activeFile = plugin.app.workspace.getActiveFile();
			if (activeFile) {
				console.log("Caching feedback for:", activeFile.path);
				plugin.feedbackCache.set(activeFile.path, feedback);
			}
		}

		// --- NEU: LOGGING DES ROHEN AI-OUTPUTS ---
		console.log("%c=== RAW AI OUTPUT (UNBEREINIGT) START ===", "color: red; font-weight: bold; font-size: 12px;");
		console.log(generatedTextRaw);
		console.log("%c=== RAW AI OUTPUT (UNBEREINIGT) END ===", "color: red; font-weight: bold; font-size: 12px;");
		// ------------------------------------------

		const generatedText = cleanAiGeneratedText(generatedTextRaw);
		console.log("Generierter Text (bereinigt):", JSON.stringify(generatedText));

		if (insertionPoint && generatedText) {
			console.log("Inserting generated text at:", insertionPoint);
			insertGeneratedText(editor, blockStartIndex, insertionPoint, generatedText);
			notice.hide();
			new Notice(`Anki-Block wurde mit ${provider} aktualisiert/hinzugefügt.`);
			return feedback;
		} else if (!generatedText) {
			notice.hide();
			new Notice(`Kein neuer Text von ${provider} generiert. Prüfe die Konsole (Strg+Shift+I) für Details.`, 7000);
			return "";
		} else {
			throw new Error("Interner Fehler: Einfügepunkt war ungültig nach ensureAnkiBlock.");
		}

	} catch (error) {
		notice.hide();
		console.error(`Fehler bei der Kartengenerierung mit ${provider} (in runGenerationProcess):`, error);
		if (!(error instanceof Error && (error.message.startsWith("API Fehler") || error.message.startsWith("Netzwerkfehler")))) {
			new Notice(`Fehler: ${error.message}`, 7000);
		}
		return "";
	}
}

// Neue Funktion zum Extrahieren und Laden von Bildern
async function extractImagesFromContent(plugin: AnkiGeneratorPlugin, content: string, sourcePath: string): Promise<ImageInput[]> {
	const images: ImageInput[] = [];
	// Regex für ![[bild.png]] und ![alt](bild.png)
	const imageRegex = /!\[\[([^|\]]+)(?:\|[^\]]+)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
	const matches = Array.from(content.matchAll(imageRegex));

	for (const match of matches) {
		let imageName = match[1]?.trim(); // Wiki-Link Format
		if (!imageName && match[2]) {
			// Markdown Link Format
			try {
				imageName = decodeURIComponent(match[2]);
			} catch (e) {
				imageName = match[2];
			}
		}

		if (!imageName) continue;

		// Entferne Query-Parameter
		imageName = imageName.split('#')[0].split('?')[0];

		// Nur Bilddateien verarbeiten
		if (!imageName.match(/\.(jpg|jpeg|png|webp|heic|heif)$/i)) continue;

		try {
			const file = plugin.app.metadataCache.getFirstLinkpathDest(normalizePath(imageName), sourcePath);
			if (file instanceof TFile) {
				const arrayBuffer = await plugin.app.vault.readBinary(file);
				const base64 = arrayBufferToBase64(arrayBuffer);
				const mimeType = getMimeType(file.extension);

				if (!images.some(img => img.filename === file.name)) {
					images.push({
						base64,
						mimeType,
						filename: file.name
					});
				}
			}
		} catch (e) {
			console.warn(`Konnte Bild ${imageName} nicht laden:`, e);
		}
	}
	return images;
}

// Stellt sicher, dass ein Anki-Block existiert
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
	} else {
		const trailingNewlinesRaw = contentBeforeInsertionRaw.substring(contentBeforeInsertionTrimmedEnd.length);
		const numberOfTrailingNewlines = (trailingNewlinesRaw.match(/\n/g) || []).length;

		if (numberOfTrailingNewlines === 0) {
			prefix = "\n\n";
		} else if (numberOfTrailingNewlines === 1) {
			prefix = "\n";
		} else {
			prefix = "";
		}
	}
	editor.replaceRange(`${prefix}${generatedText}`, insertionPoint);
}

// Bereinigt den KI-Output (Korrigierte Version mit Status-Tracking)
function cleanAiGeneratedText(rawText: string): string {
	const lines = rawText.trim().split('\n');
	const validCardLines: string[] = [];
	let insideNestedBlock = false;
	let isInsideCard = false;

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
			lowerTrimmed.startsWith("target deck:") ||
			lowerTrimmed.startsWith("---")
		) {
			continue;
		}

		const isStartMarker = trimmedLine.startsWith('Q:') ||
			trimmedLine.startsWith('A:') ||
			trimmedLine.startsWith('ID:') ||
			trimmedLine === 'xxx' ||
			line.includes('____');

		if (isStartMarker) {
			isInsideCard = true;
			if (validCardLines.length > 0 && validCardLines[validCardLines.length - 1].trim().length === 0) {
				validCardLines.pop();
			}
			validCardLines.push(line);
		}
		else if (isInsideCard) {
			if (validCardLines.length > 0 && validCardLines[validCardLines.length - 1].trim().length === 0) {
				validCardLines.pop();
			}
			validCardLines.push(line);
		}
		else {
			// --- DEBUG: WARUM WURDE EINE ZEILE IGNORIERT? ---
			console.warn("CleanAI: Ignoriere ungültige Zeile (kein Start-Marker und nicht in einer Karte):", line);
		}
	}

	while (validCardLines.length > 0 && validCardLines[validCardLines.length - 1].trim().length === 0) {
		validCardLines.pop();
	}

	return validCardLines.join('\n');
}
