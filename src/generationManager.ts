import { Editor, Notice, MarkdownView } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { SubdeckModal } from './ui/SubdeckModal';
import { ModelSelectionModal } from './ui/ModelSelectionModal';
import { DebugModal } from './ui/DebugModal';
import { parseAnkiSection } from './anki/ankiParser';
import { generateCardsWithAI } from './aiGenerator';

export async function triggerCardGeneration(plugin: AnkiGeneratorPlugin, editor: Editor) {

	const ankiInfo = parseAnkiSection(editor, plugin.settings.mainDeck);
	const initialSubdeck = ankiInfo ? ankiInfo.subdeck : '';

	const geminiAvailable = !!plugin.settings.geminiApiKey;
	const ollamaAvailable = plugin.settings.ollamaEnabled && !!plugin.settings.ollamaEndpoint && !!plugin.settings.ollamaModel;

	if (geminiAvailable && ollamaAvailable) {
		new ModelSelectionModal(plugin.app, geminiAvailable, ollamaAvailable, (selectedProvider) => {
			startGenerationProcess(plugin, editor, selectedProvider, initialSubdeck);
		}).open();
	} else if (geminiAvailable) {
		startGenerationProcess(plugin, editor, 'gemini', initialSubdeck);
	} else if (ollamaAvailable) {
		startGenerationProcess(plugin, editor, 'ollama', initialSubdeck);
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
	new SubdeckModal(plugin.app, plugin.settings.mainDeck, initialSubdeck, async (newSubdeck) => {
		let notice = new Notice(`Bereite Anki-Block für ${provider}...`, 0);
		let requestBodyString = ""; // Für Debugging im Fehlerfall

		try {
			const fullDeckPath = `${plugin.settings.mainDeck}::${newSubdeck || 'Standard'}`; // Fallback für leeres Subdeck

			// Finde oder erstelle den Anki-Block und bestimme den Einfügepunkt
			const { blockStartIndex, blockEndIndex, insertionPoint } = await ensureAnkiBlock(editor, fullDeckPath);

			notice.setMessage(`Generiere Karten mit ${provider}...`);
			const currentContentForAI = editor.getValue();
			const currentAnkiInfo = parseAnkiSection(editor, plugin.settings.mainDeck);
			const existingCards = currentAnkiInfo?.existingCardsText || 'Keine.';

			// Rufe die ausgelagerte AI-Funktion auf
			const generatedTextRaw = await generateCardsWithAI(currentContentForAI, existingCards, provider, plugin.settings);
			const generatedText = generatedTextRaw.trim().replace(/^```(anki-cards)?|```$/g, '').trim(); // Entferne optionales ```anki-cards

			console.log("Generierter Text (bereinigt):", generatedText);

			if (insertionPoint && generatedText) {
				// Füge den generierten Text ein
				insertGeneratedText(editor, blockStartIndex, insertionPoint, generatedText);
				notice.hide();
				new Notice(`Anki-Block wurde mit ${provider} aktualisiert/hinzugefügt.`);
			} else if (!generatedText) {
				notice.hide();
				new Notice(`Kein neuer Text von ${provider} generiert.`, 5000);
			} else {
				throw new Error("Interner Fehler: Einfügepunkt war ungültig.");
			}

		} catch (error) {
			// Zentrale Fehlerbehandlung
			notice.hide();
			console.error(`Fehler bei der Kartengenerierung mit ${provider}:`, error);
			// @ts-ignore Hole zusätzliche Infos aus dem geworfenen Fehlerobjekt
			const isOverloaded = error.isOverloaded === true;
			// @ts-ignore
			const userMessage = error.message || "Unbekannter Fehler.";

			if (isOverloaded && provider === 'gemini') {
				new Notice(userMessage, 10000);
			} else {
				// @ts-ignore
				let details = error.debugDetails || `--- MESSAGE ---\n${error.message}\n\n--- STACK ---\n${error.stack}`;
				// @ts-ignore
				requestBodyString = error.requestBody || requestBodyString; // Zeige den letzten bekannten Request Body
				new DebugModal(plugin.app, requestBodyString, details).open();
				new Notice(userMessage + " Details im Modal.", 10000);
			}
		}
	}).open();
}

// Stellt sicher, dass ein Anki-Block existiert (oder erstellt ihn) und gibt Start-/End-Index + Einfügepunkt zurück
async function ensureAnkiBlock(editor: Editor, fullDeckPath: string): Promise<{ blockStartIndex: number, blockEndIndex: number, insertionPoint: CodeMirror.Position }> {
	let fileContent = editor.getValue();
	const blockRegex = /^```anki-cards\s*([\s\S]*?)^```/gm;
	let matches = [...fileContent.matchAll(blockRegex)];
	let blockStartIndex = -1;
	let blockEndIndex = -1;
	let blockSourceLength = 0;

	if (matches.length > 0) {
		// Block existiert, nimm den letzten
		const lastMatch = matches[matches.length - 1];
		if (lastMatch.index === undefined) throw new Error("Konnte Startindex des letzten Blocks nicht finden.");

		const sourceBlock = lastMatch[0];
		const blockContent = lastMatch[1];
		const blockLines = blockContent.trim().split('\n');
		const deckLine = blockLines.find(l => l.trim().startsWith('TARGET DECK:'));
		const deckLineIndex = blockLines.findIndex(l => l.trim().startsWith('TARGET DECK:'));

		blockStartIndex = lastMatch.index;
		blockSourceLength = sourceBlock.length;

		// Prüfe und aktualisiere ggf. das Deck
		if (!deckLine || deckLine.replace('TARGET DECK:', '').trim() !== fullDeckPath) {
			let newBlockInternalContent = "";
			if (deckLineIndex > -1) {
				blockLines[deckLineIndex] = `TARGET DECK: ${fullDeckPath}`;
				newBlockInternalContent = blockLines.join('\n');
			} else {
				newBlockInternalContent = `TARGET DECK: ${fullDeckPath}\n${blockLines.join('\n')}`;
			}
			const newAnkiBlockSource = `\`\`\`anki-cards\n${newBlockInternalContent}\n\`\`\``;
			const startPos = editor.offsetToPos(blockStartIndex);
			const endPos = editor.offsetToPos(blockStartIndex + blockSourceLength);
			editor.replaceRange(newAnkiBlockSource, startPos, endPos);
			blockSourceLength = newAnkiBlockSource.length; // Update Länge
		}
		blockEndIndex = blockStartIndex + blockSourceLength;

	} else {
		// Neuen Block am Ende erstellen
		const output = `\n\n## Anki\n\n\`\`\`anki-cards\nTARGET DECK: ${fullDeckPath}\n\n\`\`\``;
		const lastLine = editor.lastLine();
		const endOfDocument = { line: lastLine, ch: editor.getLine(lastLine).length };
		editor.replaceRange(output, endOfDocument);

		// Indizes des neu erstellten Blocks holen
		fileContent = editor.getValue(); // Aktualisierten Inhalt holen
		matches = [...fileContent.matchAll(blockRegex)];
		if (matches.length > 0) {
			const newMatch = matches[matches.length - 1];
			if (newMatch.index !== undefined) {
				blockStartIndex = newMatch.index;
				blockSourceLength = newMatch[0].length;
				blockEndIndex = blockStartIndex + blockSourceLength;
			} else {
				throw new Error("Index des neu erstellten Blocks ist undefiniert.");
			}
		} else {
			throw new Error("Konnte den neu erstellten Anki-Block nicht finden.");
		}
		if (blockStartIndex < 0 || blockEndIndex <= blockStartIndex) {
			throw new Error("Indizes des neu erstellten Blocks sind ungültig.");
		}
	}

	// Einfügepunkt bestimmen (vor den letzten ```)
	const finalInsertionOffset = blockEndIndex - 3;
	if (finalInsertionOffset < blockStartIndex || finalInsertionOffset > editor.getValue().length) {
		console.error("Ungültiger finaler Einfüge-Offset:", finalInsertionOffset, { blockStartIndex, blockEndIndex });
		throw new Error("Fehler bei Berechnung des Einfügepunkts im Block.");
	}
	const insertionPoint = editor.offsetToPos(finalInsertionOffset);

	return { blockStartIndex, blockEndIndex, insertionPoint };
}

// Fügt den generierten Text korrekt in den Block ein
function insertGeneratedText(editor: Editor, blockStartIndex: number, insertionPoint: CodeMirror.Position, generatedText: string) {
	const blockStartOffset = blockStartIndex + "```anki-cards\n".length;
	// Stelle sicher, dass der Startoffset gültig ist (kann nicht vor dem Blockstart liegen)
	const validStartOffset = Math.max(blockStartOffset, 0);

	// Hole den Inhalt zwischen dem Start des Blocks (nach ```anki-cards\n) und dem Einfügepunkt
	const contentBeforeInsertionInBlock = editor.getRange(
		editor.offsetToPos(validStartOffset),
		insertionPoint
	).trimEnd(); // Entferne Whitespace am Ende

	let prefix = "";
	const isEmptyOrOnlyDeck = contentBeforeInsertionInBlock.length === 0 ||
		(contentBeforeInsertionInBlock.startsWith("TARGET DECK:") && contentBeforeInsertionInBlock.split('\n').filter(l => l.trim().length > 0).length <= 1);

	// Füge Leerzeilen hinzu, wenn der Block nicht leer ist (oder nur Deck enthält)
	// und der letzte Inhalt nicht bereits auf zwei Leerzeilen endet.
	if (!isEmptyOrOnlyDeck && !contentBeforeInsertionInBlock.endsWith('\n\n')) {
		prefix = contentBeforeInsertionInBlock.endsWith('\n') ? '\n' : '\n\n';
	}
	// Wenn der Block leer oder nur Deck enthält und nicht mit einer Leerzeile endet
	else if (isEmptyOrOnlyDeck && !contentBeforeInsertionInBlock.endsWith('\n') && contentBeforeInsertionInBlock.length > 0) {
		prefix = "\n"; // Nur eine Leerzeile nach der Deck-Zeile
	} else if (isEmptyOrOnlyDeck && contentBeforeInsertionInBlock.length == 0) {
		// Block war komplett leer, kein Prefix nötig
	}


	editor.replaceRange(`${prefix}${generatedText}`, insertionPoint);
}
