// src/generationManager.ts

import { Editor, Notice, TFile, normalizePath } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { SubdeckModal } from './ui/SubdeckModal';
import { ModelSelectionModal } from './ui/ModelSelectionModal';
// DebugModal wird in aiGenerator verwendet
import { parseAnkiSection } from './anki/ankiParser';
import { getDeckNames } from './anki/AnkiConnect';
import { generateCardsWithAI } from './aiGenerator';
import { ImageInput } from './types';
import { arrayBufferToBase64, getMimeType } from './utils';
import { t } from './lang/helpers';

const ANKI_BLOCK_REGEX = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;

export async function triggerCardGeneration(plugin: AnkiGeneratorPlugin, editor: Editor) {
	const initialAnkiInfo = parseAnkiSection(editor, plugin.settings.mainDeck);
	const initialSubdeck = initialAnkiInfo ? initialAnkiInfo.subdeck : '';

	const geminiAvailable = !!plugin.settings.geminiApiKey;
	const openAiAvailable = !!plugin.settings.openAiApiKey;
	const ollamaAvailable = plugin.settings.ollamaEnabled && !!plugin.settings.ollamaEndpoint && !!plugin.settings.ollamaModel;

	const startGen = (provider: 'gemini' | 'ollama' | 'openai') => {
		let subdeckToUse = initialSubdeck;
		if (!subdeckToUse) {
			const activeFile = plugin.app.workspace.getActiveFile();
			if (activeFile && activeFile.parent) {
				// Use parent folder path as default deck structure
				// Replace slashes with double colons for Anki deck structure
				// e.g. "Folder/Subfolder" -> "Folder::Subfolder"
				// We strip the root "/" if present (though obsidian paths usually don't start with it)
				const parentPath = activeFile.parent.path;
				if (parentPath !== '/') {
					subdeckToUse = parentPath.replace(/\//g, '::');
				}
			}
		}
		// Rufe startGenerationProcess direkt auf, der Modal wird dort geöffnet
		startGenerationProcess(plugin, editor, provider, subdeckToUse);
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
		new Notice(t('notice.noAiModel'), 7000);
	}
}

async function startGenerationProcess(
	plugin: AnkiGeneratorPlugin,
	editor: Editor,
	provider: 'gemini' | 'ollama' | 'openai',
	initialSubdeck: string
) {
	// Fetch deck names for suggestions
	let deckNames: string[] = [];
	try {
		deckNames = await getDeckNames();
	} catch (e) {
		console.warn("Could not fetch deck names for suggestions:", e);
	}

	// Öffne den SubdeckModal, der jetzt auch die zusätzlichen Anweisungen sammelt
	new SubdeckModal(plugin.app, plugin.settings.mainDeck, initialSubdeck, deckNames, async (newSubdeck, additionalInstructions, isBlockOnly) => {
		// Rufe die ausgelagerte Logik auf
		await runGenerationProcess(plugin, editor, provider, newSubdeck, additionalInstructions, false, isBlockOnly);
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
	additionalInstructions: string = '',
	isRevision: boolean = false,
	isBlockOnly: boolean = false
): Promise<string> {
	let notice = new Notice(isBlockOnly ? "Erstelle Anki-Block..." : t('notice.preparing', { provider }), 0);

	try {
		const sub = subdeck || 'Standard';
		const fullDeckPath = `${plugin.settings.mainDeck}::${sub}`;

		// Ensure block exists AND update header (Instruction, clear Status)
		// Pass undefined for instruction if it's empty string, so we don't overwrite existing instruction with empty.
		const instructionToUpdate = additionalInstructions && additionalInstructions.trim().length > 0 ? additionalInstructions : undefined;
		const { blockStartIndex, blockEndIndex, insertionPoint } = await ensureAnkiBlock(editor, fullDeckPath, instructionToUpdate, undefined);
		console.log(`ensureAnkiBlock completed. Start: ${blockStartIndex}, InsertionPoint Line: ${insertionPoint.line}, Ch: ${insertionPoint.ch}`);

		if (isBlockOnly) {
			notice.hide();
			new Notice("Anki-Block erstellt/aktualisiert.");
			return "";
		}

		notice.setMessage(t('notice.readingCards'));
		const currentAnkiInfo = parseAnkiSection(editor, plugin.settings.mainDeck);
		const existingCards = currentAnkiInfo?.existingCardsText || 'Keine.';
		console.log("--- Existing Cards sent to AI (after ensureAnkiBlock) ---\n", existingCards, "\n--- End Existing Cards ---");

		notice.setMessage(t('notice.searchingImages'));
		const currentContentForAI = editor.getValue();

		// Bilder extrahieren und Content vorbereiten
		const activeFile = plugin.app.workspace.getActiveFile();
		const fileTitle = activeFile ? activeFile.basename : "Unbenannt";
		const { images, preparedContent: preparedBody } = await extractImagesAndPrepareContent(plugin, currentContentForAI, activeFile ? activeFile.path : '');

		// Add Title to Content
		const preparedContent = `# ${fileTitle}\n\n${preparedBody}`;

		if (images.length > 0) {
			notice.setMessage(t('notice.foundImages', { count: images.length, provider }));
		} else {
			notice.setMessage(t('notice.generating', { provider }));
		}

		// Determine instructions to use: prefer passed instructions, fallback to existing block instruction
		const instructionsToUse = (additionalInstructions && additionalInstructions.trim().length > 0)
			? additionalInstructions
			: (currentAnkiInfo?.instruction || "");

		// --- ÜBERGABE der images an generateCardsWithAI ---
		const { cards: generatedTextRaw, feedback } = await generateCardsWithAI(
			plugin.app,
			preparedContent, // Nutze den vorbereiteten Content mit Bild-Markern
			existingCards,
			provider,
			plugin.settings,
			instructionsToUse, // Use determined instructions
			images, // Bilder übergeben
			isRevision // Revision Flag
		);
		// --- ENDE ÜBERGABE ---

		console.log("runGenerationProcess received feedback:", feedback ? "YES (Length: " + feedback.length + ")" : "NO");

		if (!generatedTextRaw) {
			new Notice(t('notice.noCardsGenerated'));
			return "";
		}

		// Store feedback in cache BEFORE modifying the file (which triggers re-render)
		if (feedback) {
			const activeFile = plugin.app.workspace.getActiveFile();
			if (activeFile) {
				console.log("Caching feedback for:", activeFile.path);
				// Update feedback cache with ChatMessage[]
				plugin.feedbackCache.set(activeFile.path, [{ role: 'ai', content: feedback }]);
			}
		}

		// --- NEU: LOGGING DES ROHEN AI-OUTPUTS ---
		console.log("%c=== RAW AI OUTPUT (UNBEREINIGT) START ===", "color: red; font-weight: bold; font-size: 12px;");
		console.log(generatedTextRaw);
		console.log("%c=== RAW AI OUTPUT (UNBEREINIGT) END ===", "color: red; font-weight: bold; font-size: 12px;");
		// ------------------------------------------

		const generatedText = cleanAiGeneratedText(generatedTextRaw);
		console.log("Generierter Text (bereinigt):", JSON.stringify(generatedText));

		if (generatedText) {
			if (isRevision) {
				// REVISION MODE: Replace existing cards
				console.log("Replacing existing cards with revised content.");
				// We need to find the range of the existing cards within the block.
				// ensureAnkiBlock gives us blockStartIndex and blockEndIndex.
				// We can reconstruct the block with the NEW cards.

				// Re-read block content to be safe
				const fileContent = editor.getValue();
				const blockContent = fileContent.substring(blockStartIndex, blockEndIndex);

				// We want to keep the header (Deck, Instruction, Status) but replace the body.
				// The body starts after the header lines.
				const lines = blockContent.split('\n');
				const headerLines = [];
				let bodyStartIndex = -1;

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i].trim();
					if (line.startsWith('```anki-cards') ||
						line.startsWith('TARGET DECK:') ||
						line.startsWith('INSTRUCTION:') ||
						line.startsWith('# INSTRUCTION:') ||
						line.startsWith('STATUS:')) {
						headerLines.push(lines[i]);
					} else if (line === '') {
						// Empty line after header?
						if (bodyStartIndex === -1) headerLines.push(lines[i]);
					} else {
						// First non-header line (likely start of cards or empty lines before cards)
						// Actually, let's just keep the header lines we know and discard the rest.
						// But we need to be careful not to discard the closing ``` if it's there?
						// No, blockContent includes the closing ```.
						// Let's just reconstruct the block completely.
					}
				}

				// Simpler approach: Use the same logic as ensureAnkiBlock to reconstruct header, 
				// then append the NEW generated text, then close block.

				// Let's parse the header info again or use what we have.
				// We have fullDeckPath, instructionToUpdate (or currentAnkiInfo.instruction).

				let newBlockContent = `TARGET DECK: ${fullDeckPath}`;
				if (instructionsToUse) {
					newBlockContent += `\nINSTRUCTION: ${instructionsToUse}`;
				}
				// Preserve disabled instruction if exists
				if (currentAnkiInfo?.disabledInstruction) {
					newBlockContent += `\n# INSTRUCTION: ${currentAnkiInfo.disabledInstruction}`;
				}
				// Clear status on revision? Or keep? Usually clear or set to something?
				// Let's clear it as we just generated new cards.

				newBlockContent += `\n\n${generatedText}`;

				const newBlockSource = `\`\`\`anki-cards\n${newBlockContent}\n\`\`\``;

				const startPos = editor.offsetToPos(blockStartIndex);
				const endPos = editor.offsetToPos(blockEndIndex);
				editor.replaceRange(newBlockSource, startPos, endPos);

			} else {
				// NORMAL MODE: Append
				if (insertionPoint) {
					console.log("Inserting generated text at:", insertionPoint);
					insertGeneratedText(editor, blockStartIndex, insertionPoint, generatedText);
				} else {
					throw new Error("Interner Fehler: Einfügepunkt war ungültig.");
				}
			}

			notice.hide();
			new Notice(t('notice.updated', { provider }));
			return feedback;
		} else {
			notice.hide();
			new Notice(t('notice.noNewText', { provider }), 7000);
			return "";
		}

	} catch (error) {
		notice.hide();
		console.error(`Fehler bei der Kartengenerierung mit ${provider} (in runGenerationProcess):`, error);

		// Check for Overload
		if ((error as any).isOverloaded) {
			// Update block with OVERLOADED status
			const sub = subdeck || 'Standard';
			const fullDeckPath = `${plugin.settings.mainDeck}::${sub}`;
			await ensureAnkiBlock(editor, fullDeckPath, additionalInstructions, 'OVERLOADED');
			new Notice(t('anki.status.overloaded'), 10000);
			return "";
		}

		if (!(error instanceof Error && (error.message.startsWith("API Fehler") || error.message.startsWith("Netzwerkfehler")))) {
			new Notice(`Fehler: ${error.message}`, 7000);
		}
		return "";
	}
}

// Neue Funktion zum Extrahieren und Laden von Bildern UND Vorbereiten des Contents
async function extractImagesAndPrepareContent(plugin: AnkiGeneratorPlugin, content: string, sourcePath: string): Promise<{ images: ImageInput[], preparedContent: string }> {
	const images: ImageInput[] = [];
	let preparedContent = content;

	// Regex für ![[bild.png]] und ![alt](bild.png)
	// Wir nutzen capture groups um den ganzen Match zu identifizieren
	const imageRegex = /(!\[\[((?:[^|\]]+)(?:\|[^\]]+)?)\]\]|!\[[^\]]*\]\(([^)]+)\))/g;

	// Wir müssen die Matches sammeln und dann den Content bearbeiten.
	// Da sich die Indizes verschieben, wenn wir Text einfügen, arbeiten wir von hinten nach vorne oder nutzen Split/Join.
	// Einfacher: Wir bauen den Content neu auf oder nutzen replace mit einer Funktion, aber wir brauchen async für das Laden der Bilder.
	// Da replace keine async funktion unterstützt, sammeln wir erst alle Infos.

	const matches = Array.from(content.matchAll(imageRegex));
	const replacements: { index: number, length: number, replacement: string }[] = [];

	for (const match of matches) {
		const fullMatch = match[1];
		let imageName = match[2]?.trim(); // Wiki-Link (ohne Pipe) - wait match[2] includes pipe? Regex above: ([^|\]]+) is inside match[2]? No.
		// Let's adjust regex logic slightly for clarity or rely on existing.
		// Existing: /!\[\[([^|\]]+)(?:\|[^\]]+)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g
		// My new regex: /(!\[\[((?:[^|\]]+)(?:\|[^\]]+)?)\]\]|!\[[^\]]*\]\(([^)]+)\))/g
		// Group 1: Full match
		// Group 2: Wiki inner (potentially with pipe? No, the regex is tricky).

		// Let's stick to the logic: extract name, load image, if success -> mark.

		// Re-using the logic from before but careful with groups.
		// match[0] is full match.
		// match[1] is also full match because of outer parens in regex.
		// match[2] is Wiki link content (inner).
		// match[3] is Markdown link URL.

		let extractedName = match[2]?.trim();
		if (!extractedName && match[3]) {
			try { extractedName = decodeURIComponent(match[3]); } catch (e) { extractedName = match[3]; }
		}

		if (!extractedName) continue;

		// Clean name
		let cleanName = extractedName.split('#')[0].split('?')[0];
		if (!cleanName.match(/\.(jpg|jpeg|png|webp|heic|heif)$/i)) continue;

		try {
			const file = plugin.app.metadataCache.getFirstLinkpathDest(normalizePath(cleanName), sourcePath);
			if (file instanceof TFile) {
				const arrayBuffer = await plugin.app.vault.readBinary(file);
				const base64 = arrayBufferToBase64(arrayBuffer);
				const mimeType = getMimeType(file.extension);

				// Check if already added
				let imgIndex = images.findIndex(img => img.filename === file.name);
				if (imgIndex === -1) {
					images.push({ base64, mimeType, filename: file.name });
					imgIndex = images.length - 1;
				}

				// Mark this match in content
				// We want to append (Image X) to the match.
				// match[0] is the link.
				if (match.index !== undefined) {
					replacements.push({
						index: match.index,
						length: match[0].length,
						replacement: `${match[0]} <!-- Image ${imgIndex + 1}: ${file.name} -->`
					});
				}
			}
		} catch (e) {
			console.warn(`Konnte Bild ${cleanName} nicht laden:`, e);
		}
	}

	// Apply replacements from back to front to avoid index shifts
	replacements.sort((a, b) => b.index - a.index);

	for (const rep of replacements) {
		preparedContent = preparedContent.substring(0, rep.index) + rep.replacement + preparedContent.substring(rep.index + rep.length);
	}

	return { images, preparedContent };
}

// Stellt sicher, dass ein Anki-Block existiert und aktualisiert Header-Daten (Deck, Instruction, Status)
async function ensureAnkiBlock(editor: Editor, fullDeckPath: string, instruction?: string, status?: string | null): Promise<{ blockStartIndex: number, blockEndIndex: number, insertionPoint: CodeMirror.Position }> {
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
		const currentDeck = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;

		const instructionLine = blockLines.find(l => l.trim().startsWith('INSTRUCTION:'));
		const currentInstruction = instructionLine ? instructionLine.replace('INSTRUCTION:', '').trim() : null;

		const disabledInstructionLine = blockLines.find(l => l.trim().startsWith('# INSTRUCTION:'));
		const currentDisabledInstruction = disabledInstructionLine ? disabledInstructionLine.replace('# INSTRUCTION:', '').trim() : null;

		const statusLine = blockLines.find(l => l.trim().startsWith('STATUS:'));
		const currentStatus = statusLine ? statusLine.replace('STATUS:', '').trim() : null;

		blockStartIndex = lastMatch.index;
		blockSourceLength = sourceBlock.length;

		// Check if update is needed
		const deckNeedsUpdate = currentDeck !== fullDeckPath;
		const instructionNeedsUpdate = instruction !== undefined && currentInstruction !== instruction;
		// If status is passed (string or null/empty to clear), check if it differs. 
		// If status is undefined, we ignore it (don't update).
		// But we want to clear it if null/empty is passed.
		const statusNeedsUpdate = status !== undefined && currentStatus !== (status || null); // Treat empty string as null for comparison

		if (deckNeedsUpdate || instructionNeedsUpdate || statusNeedsUpdate) {
			console.log("Block header needs update. Reconstructing block.");

			// Filter out header lines to keep content
			const linesToKeep = blockLines.filter(l =>
				!l.trim().startsWith('TARGET DECK:') &&
				!l.trim().startsWith('INSTRUCTION:') &&
				!l.trim().startsWith('# INSTRUCTION:') &&
				!l.trim().startsWith('STATUS:')
			);

			let newBlockInternalContent = `TARGET DECK: ${fullDeckPath}`;

			// Instruction
			if (instruction !== undefined) {
				if (instruction && instruction.trim().length > 0) {
					newBlockInternalContent += `\nINSTRUCTION: ${instruction.trim()}`;
					// If we set a new instruction, we should probably remove the disabled one if it's the same?
					// Or just keep it. Let's keep existing disabled instruction unless it conflicts?
					// Actually, if we set a new instruction, we might want to keep the disabled one if it's different.
					// But usually 'instruction' argument comes from the modal (additional instructions).
					// If the user adds a NEW instruction via modal, it becomes the active one.
					if (currentDisabledInstruction) {
						newBlockInternalContent += `\n# INSTRUCTION: ${currentDisabledInstruction}`;
					}
				}
				// If instruction is empty string, we don't add the line.
				// But we should preserve the disabled one if it exists.
				else if (currentDisabledInstruction) {
					newBlockInternalContent += `\n# INSTRUCTION: ${currentDisabledInstruction}`;
				}
			} else {
				// Keep existing if not provided
				if (currentInstruction) {
					newBlockInternalContent += `\nINSTRUCTION: ${currentInstruction}`;
				}
				if (currentDisabledInstruction) {
					newBlockInternalContent += `\n# INSTRUCTION: ${currentDisabledInstruction}`;
				}
			}

			// Status
			if (status !== undefined) {
				if (status && status.trim().length > 0) {
					newBlockInternalContent += `\nSTATUS: ${status.trim()}`;
				}
				// If status is null/empty, we don't add the line (removing it)
			} else if (currentStatus) {
				// Keep existing if not provided
				newBlockInternalContent += `\nSTATUS: ${currentStatus}`;
			}

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
		let newBlockInternalContent = `TARGET DECK: ${fullDeckPath}`;
		if (instruction && instruction.trim().length > 0) {
			newBlockInternalContent += `\nINSTRUCTION: ${instruction.trim()}`;
		}
		if (status && status.trim().length > 0) {
			newBlockInternalContent += `\nSTATUS: ${status.trim()}`;
		}

		const output = `\n\n## Anki\n\n\`\`\`anki-cards\n${newBlockInternalContent}\n\n\`\`\``;
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
	let textToProcess = rawText.trim();

	// Remove outer code blocks if present (e.g. ```anki-cards ... ``` or just ``` ... ```)
	// We check if it starts with ``` and ends with ```
	if (textToProcess.startsWith('```')) {
		const lines = textToProcess.split('\n');
		if (lines.length >= 2 && lines[lines.length - 1].trim().startsWith('```')) {
			// Remove first and last line
			textToProcess = lines.slice(1, -1).join('\n').trim();
		}
	}

	const lines = textToProcess.split('\n');
	const validCardLines: string[] = [];
	let isInsideCard = false;

	for (const line of lines) {
		const trimmedLine = line.trim();

		// We still want to ignore internal code blocks if they are not part of the card content?
		// But usually we don't expect nested code blocks in the AI output for cards unless it's code snippets IN the card.
		// If it is code snippets in the card, we WANT to keep them.
		// The previous logic was:
		// if (trimmedLine.startsWith('```')) { insideNestedBlock = !insideNestedBlock; continue; }
		// if (insideNestedBlock) { continue; }
		// This logic removed ALL code blocks. If a card had code, it was removed.
		// If the whole output was a code block, it was removed.

		// Let's assume we just want to extract Q/A lines and related content.
		// We should filter out "Here is..." text, but keep code blocks if they are part of an answer.

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
			lowerTrimmed.startsWith("instruction:") ||
			lowerTrimmed.startsWith("# instruction:") ||
			lowerTrimmed.startsWith("status:") ||
			lowerTrimmed.startsWith("---")
		) {
			continue;
		}

		// Also skip ```anki-cards if it was left over or inside
		if (lowerTrimmed.startsWith("```anki-cards")) continue;
		if (lowerTrimmed === "```") continue; // Skip standalone backticks if they are artifacts of the wrapper

		const isStartMarker = trimmedLine.startsWith('Q:') ||
			trimmedLine.startsWith('A:') ||
			trimmedLine.startsWith('ID:') ||
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
			// console.warn("CleanAI: Ignoriere ungültige Zeile (kein Start-Marker und nicht in einer Karte):", line);
			// Maybe it's a continuation of a card but didn't look like one?
			// If we are NOT isInsideCard, we ignore it.
			// If we ARE isInsideCard, we keep it (handled above).
		}
	}

	while (validCardLines.length > 0 && validCardLines[validCardLines.length - 1].trim().length === 0) {
		validCardLines.pop();
	}

	return validCardLines.join('\n');
}
