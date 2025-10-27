import { App, Editor, MarkdownView, Notice, Plugin, requestUrl, TFile, normalizePath } from 'obsidian';
import { AnkiGeneratorSettingTab, DEFAULT_SETTINGS, AnkiGeneratorSettings } from './settings';
import { SubdeckModal } from './ui/SubdeckModal';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { DebugModal } from './ui/DebugModal';
import { ModelSelectionModal } from './ui/ModelSelectionModal';
import {
	addAnkiNote, addAnkiClozeNote, updateAnkiNoteFields, createAnkiDeck,
	findAnkiNoteId, getCardCountForDeck, findAnkiClozeNoteId, updateAnkiClozeNoteFields,
	deleteAnkiNotes,
	storeAnkiMediaFile
} from './anki/AnkiConnect';
import { parseAnkiSection } from './anki/ankiParser'; // parseAnkiSection jetzt importieren
import { Card } from './types';

// --- HILFSFUNKTIONEN ---
function arrayBufferToBase64(buffer: ArrayBuffer): string { /* ... */ let binary = ''; const bytes = new Uint8Array(buffer); const len = bytes.byteLength; for (let i = 0; i < len; i++) { binary += String.fromCharCode(bytes[i]); } return btoa(binary); }
function basicMarkdownToHtml(text: string): string { /* ... */ if (!text) return ""; let html = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>'); html = html.replace(/(?!<br>)\n/g, '<br>'); return html; }
// --- ENDE HILFSFUNKTIONEN ---


export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;

	async onload() { /* ... */ await this.loadSettings(); this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this)); this.addRibbonIcon('brain-circuit', 'Anki-Karten generieren', (evt: MouseEvent) => { const activeView = this.app.workspace.getActiveViewOfType(MarkdownView); if (activeView) { this.triggerCardGeneration(activeView.editor); } else { new Notice('Bitte öffnen Sie eine Notiz, um Karten zu generieren.'); } });

		this.registerMarkdownCodeBlockProcessor('anki-cards', async (source, el, ctx) => { /* ... Anzeige-Logik bleibt gleich ... */ el.empty(); const lines = source.trim().split('\n'); const deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:')); const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null; const cards: Card[] = []; let currentCard: Partial<Card> | null = null; let isClozeQuestion = false; let i = 0; while (i < lines.length) { const line = lines[i]; const trimmedLine = line.trim(); if (trimmedLine.length === 0 || trimmedLine.startsWith('TARGET DECK:')) { i++; continue; } if (line.startsWith('Q:')) { if (currentCard) cards.push(currentCard as Card); let q = line.substring(2).trim(); let a = ''; let id: number | null = null; let currentLineIndex = i + 1; while (currentLineIndex < lines.length && !lines[currentLineIndex].startsWith('A:') && !lines[currentLineIndex].startsWith('ID:') && !lines[currentLineIndex].startsWith('Q:') && lines[currentLineIndex].trim() !== 'xxx') { q += '\n' + lines[currentLineIndex]; currentLineIndex++; } if (currentLineIndex < lines.length && lines[currentLineIndex].startsWith('A:')) { a = lines[currentLineIndex].substring(2).trim(); currentLineIndex++; while (currentLineIndex < lines.length && !lines[currentLineIndex].startsWith('ID:') && !lines[currentLineIndex].startsWith('Q:') && lines[currentLineIndex].trim() !== 'xxx') { a += '\n' + lines[currentLineIndex]; currentLineIndex++; } } if (currentLineIndex < lines.length && lines[currentLineIndex].trim().startsWith('ID:')) { id = parseInt(lines[currentLineIndex].trim().substring(3).trim(), 10) || null; currentLineIndex++; } cards.push({ type: 'Basic', q: q.trim(), a: a.trim(), id }); i = currentLineIndex; } else if (line.includes('____') || lines[i + 1]?.trim() === 'xxx' || (!line.startsWith('A:') && !line.startsWith('ID:'))) { let q = line.trim(); let a = ''; let id: number | null = null; let currentLineIndex = i + 1; let potentialCloze = true; while (currentLineIndex < lines.length && lines[currentLineIndex].trim() !== 'xxx' && !lines[currentLineIndex].trim().startsWith('ID:') && !lines[currentLineIndex].trim().startsWith('Q:')) { if (lines[currentLineIndex].includes('____')) { console.warn("Mögliche falsch formatierte Karte (mehrere '____' ohne xxx):", q, lines[currentLineIndex]); potentialCloze = false; break; } q += '\n' + lines[currentLineIndex]; currentLineIndex++; } if (!potentialCloze) { cards.push({ type: 'Basic', q: line.trim(), a: '', id: null }); i++; continue; } if (currentCard) cards.push(currentCard as Card); currentCard = { type: 'Cloze', q: q.trim(), a: '', id: null }; isClozeQuestion = true; if (currentLineIndex < lines.length && lines[currentLineIndex].trim() === 'xxx') { i = currentLineIndex; } else if (line.includes('____')) { console.warn("Cloze-Karte ohne 'xxx' gefunden:", q); currentCard.a = ''; isClozeQuestion = false; i = currentLineIndex - 1; } else { currentCard.type = 'Basic'; isClozeQuestion = false; i = currentLineIndex - 1; } i++; } else if (trimmedLine === 'xxx' && currentCard && currentCard.type === 'Cloze') { isClozeQuestion = true; i++; } else if (!line.startsWith('ID:') && currentCard && currentCard.type === 'Cloze' && isClozeQuestion) { currentCard.a = line.trim(); isClozeQuestion = false; i++; } else if (!line.startsWith('ID:') && currentCard && currentCard.type === 'Cloze' && currentCard.a !== null && currentCard.a.length >= 0) { currentCard.a += (currentCard.a.length > 0 ? '\n' : '') + line; i++; } else if (trimmedLine.startsWith('ID:') && currentCard) { currentCard.id = parseInt(trimmedLine.substring(3).trim(), 10) || null; cards.push(currentCard as Card); currentCard = null; isClozeQuestion = false; i++; } else if (currentCard) { cards.push(currentCard as Card); currentCard = null; isClozeQuestion = false; /* i bleibt gleich */ } else { console.warn("Anki-Block Parser: Ignoriere unerwartete Zeile:", line); i++; } } if (currentCard) { cards.push(currentCard as Card); } cards.forEach(card => { if (card.type === 'Cloze' && !card.q.includes('____') && !lines.slice(lines.indexOf(card.q) + 1).some(l => l.trim() === 'xxx')) { console.warn("Potentiell falsch geparste Karte (als Cloze markiert, aber ohne Marker/xxx):", card.q); card.type = 'Basic'; } if (card.a) card.a = card.a.trim(); }); el.createEl('h4', { text: 'Anki-Karten' }); if (deckName) { /* ... Statusanzeige ... */ const synchronizedCount = cards.filter(card => card.id !== null).length; const unsynchronizedCount = cards.length; const localStatusText = `✅ ${synchronizedCount} Synchronisiert | 📝 ${unsynchronizedCount} Ausstehend`; let ankiStatusText = ''; let errorClass = ''; try { const totalAnkiCount = await getCardCountForDeck(deckName); ankiStatusText = `📈 ${totalAnkiCount} in Anki | `; } catch (e) { ankiStatusText = '⚠️ Anki-Verbindung fehlgeschlagen | '; errorClass = 'anki-error'; } const fullText = ankiStatusText + localStatusText; const pEl = el.createEl('p', { text: fullText, cls: 'anki-card-count' }); if (errorClass) pEl.addClass(errorClass); } const buttonContainer = el.createDiv({ cls: 'anki-button-container' }); const previewButton = buttonContainer.createEl('button', { text: 'Vorschau & Bearbeiten' }); previewButton.onclick = () => { /* ... Preview/Save ... */ const cardsForModal = JSON.parse(JSON.stringify(cards)) as Card[]; const onSave = async (updatedCards: Card[], deletedCardIds: number[]) => { const notice = new Notice('Speichere Änderungen...', 0); try { if (deletedCardIds.length > 0) { await deleteAnkiNotes(deletedCardIds); new Notice(`${deletedCardIds.length} Karte(n) gelöscht!`); } const file = this.app.workspace.getActiveFile(); if (!file) throw new Error("Keine aktive Datei."); const currentContent = await this.app.vault.read(file); const blockRegex = /```anki-cards\s*([\s\S]*?)\s*```/g; const matches = [...currentContent.matchAll(blockRegex)]; let originalBlockSource = source; let matchIndex = -1; if (matches.length > 0) { const match = matches.find(m => m[0] === source) || matches[matches.length - 1]; if (match) { originalBlockSource = match[0]; matchIndex = match.index ?? -1; } else { matchIndex = currentContent.lastIndexOf('```anki-cards'); if (matchIndex === -1) throw new Error("Konnte Anki-Block nicht finden."); const endMatchIndex = currentContent.indexOf('```', matchIndex + 3); if (endMatchIndex === -1) throw new Error("Konnte Ende des Anki-Blocks nicht finden."); originalBlockSource = currentContent.substring(matchIndex, endMatchIndex + 3); } } else { throw new Error("Kein Anki-Block zum Speichern gefunden."); } const originalLines = originalBlockSource.split('\n'); const deckLine = originalLines.find(l => l.trim().startsWith('TARGET DECK:')) || `TARGET DECK: ${this.settings.mainDeck}::Standard`; const newLines: string[] = []; newLines.push(deckLine.trim()); if (updatedCards.length > 0) newLines.push(''); updatedCards.forEach((card, cardIndex) => { if (card.type === 'Basic') { card.q.split('\n').forEach((qLine, index) => { newLines.push(index === 0 ? `Q: ${qLine}` : qLine); }); card.a.split('\n').forEach((aLine, index) => { newLines.push(index === 0 ? `A: ${aLine}` : aLine); }); } else { card.q.split('\n').forEach((qLine) => { newLines.push(qLine); }); newLines.push('xxx'); (card.a || "").split('\n').forEach((aLine) => { newLines.push(aLine); }); } if (card.id) { newLines.push(`ID: ${card.id}`); } if (cardIndex < updatedCards.length - 1) { newLines.push(''); } }); const newBlockContent = newLines.join('\n'); const currentFileContent = await this.app.vault.read(file); let updatedFileContent = currentFileContent; if (matchIndex !== -1) { const finalBlockSource = `\`\`\`anki-cards\n${newBlockContent}\n\`\`\``; updatedFileContent = currentFileContent.substring(0, matchIndex) + finalBlockSource + currentFileContent.substring(matchIndex + originalBlockSource.length); } else { throw new Error("Konnte Blockposition zum Ersetzen nicht bestimmen."); } await this.app.vault.modify(file, updatedFileContent); notice.hide(); new Notice("Änderungen gespeichert!"); const activeLeaf = this.app.workspace.activeLeaf; if (activeLeaf?.view instanceof MarkdownView) { activeLeaf.view.previewMode.rerender(true); } } catch (e) { notice.hide(); new Notice("Fehler beim Speichern: " + e.message, 7000); console.error("Fehler beim Speichern:", e); } }; new CardPreviewModal(this.app, cardsForModal, onSave).open(); };
			const syncButton = buttonContainer.createEl('button', { text: 'Mit Anki synchronisieren' });
			syncButton.onclick = async () => { /* ... Sync bleibt gleich ... */ const notice = new Notice('Synchronisiere mit Anki...', 0); const originalSource = source; try { const activeFile = this.app.workspace.getActiveFile(); if (!activeFile) throw new Error("Keine aktive Datei gefunden."); if (!deckName) throw new Error("Kein 'TARGET DECK' im anki-cards Block gefunden."); await createAnkiDeck(deckName); const newLines = [`TARGET DECK: ${deckName}`, '']; const imageRegex = /!\[\[([^|\]]+)(?:\|[^\]]+)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g; for (const card of cards) { notice.setMessage(`Verarbeite Karte: ${card.q.substring(0, 30)}...`); let ankiNoteId = card.id; const originalQ = card.q; const originalA = card.a; let processedQ = originalQ; let processedA = originalA; const imageProcessedMap = new Map<string, string>(); const processImages = async (text: string): Promise<string> => { let processedText = text; const matches = Array.from(text.matchAll(imageRegex)); for (const match of matches) { const originalLink = match[0]; let imageName = match[1]?.trim(); if (!imageName && match[2]) { const pathParts = match[2].split(/[\\/]/); imageName = pathParts[pathParts.length - 1]?.trim(); if (imageName) imageName = decodeURIComponent(imageName); } if (!imageName) { console.warn("Bildnamen nicht extrahiert:", originalLink); continue; } if (imageProcessedMap.has(imageName)) { processedText = processedText.replaceAll(originalLink, `<img src="${imageProcessedMap.get(imageName)}">`); continue; } try { const file = this.app.metadataCache.getFirstLinkpathDest(normalizePath(imageName), activeFile.path); if (file instanceof TFile) { notice.setMessage(`Lade Bild hoch: ${file.name}...`); const fileData = await this.app.vault.readBinary(file); const base64Data = arrayBufferToBase64(fileData); const ankiFilename = await storeAnkiMediaFile(file.name, base64Data); imageProcessedMap.set(imageName, ankiFilename); processedText = processedText.replaceAll(originalLink, `<img src="${ankiFilename}">`); console.log(`Bild ${imageName} als ${ankiFilename} gespeichert.`); } else { console.warn(`Bilddatei nicht gefunden: ${imageName}`); processedText = processedText.replaceAll(originalLink, `[Bild nicht gefunden: ${imageName}]`); } } catch (imgError) { console.error(`Fehler bei Bild ${imageName}:`, imgError); new Notice(`Fehler bei Bild ${imageName}: ${imgError.message}`, 5000); processedText = processedText.replaceAll(originalLink, `[Fehler bei Bild: ${imageName}]`); } } return processedText; }; processedQ = await processImages(processedQ); processedA = await processImages(processedA); const htmlQ = basicMarkdownToHtml(processedQ); const htmlA = basicMarkdownToHtml(processedA); let ankiFieldQ = htmlQ; let ankiFieldA = htmlA; let ankiClozeTextField = ""; if (card.type === 'Cloze') { const clozeRegex = /(?<!\w)____(?!\w)/; if (clozeRegex.test(htmlQ)) { ankiClozeTextField = htmlQ.replace(clozeRegex, `{{c1::${htmlA}}}`); } else { console.warn(`Cloze-Marker '____' nicht in Frage gefunden: "${htmlQ}".`); ankiClozeTextField = `${htmlQ} {{c1::${htmlA}}}`; } ankiFieldQ = ankiClozeTextField; ankiFieldA = ""; } if (!ankiNoteId) { if (card.type === 'Basic') { ankiNoteId = await findAnkiNoteId(originalQ); } else if (card.type === 'Cloze') { ankiNoteId = await findAnkiClozeNoteId(originalQ); } } if (ankiNoteId) { try { notice.setMessage(`Aktualisiere Karte ${ankiNoteId}...`); if (card.type === 'Basic') { await updateAnkiNoteFields(ankiNoteId, ankiFieldQ, ankiFieldA); } else if (card.type === 'Cloze') { await updateAnkiClozeNoteFields(ankiNoteId, ankiClozeTextField); } } catch (e) { if (e.message?.includes("Note was not found")) { new Notice(`Karte ${ankiNoteId} nicht gefunden. Erstelle neu.`); ankiNoteId = null; } else { throw e; } } } if (!ankiNoteId) { try { notice.setMessage(`Erstelle neue Karte für ${originalQ.substring(0, 30)}...`); if (card.type === 'Basic') { ankiNoteId = await addAnkiNote(deckName, this.settings.basicModelName, ankiFieldQ, ankiFieldA); } else if (card.type === 'Cloze') { ankiNoteId = await addAnkiClozeNote(deckName, this.settings.clozeModelName, ankiClozeTextField); } } catch (e) { if (e.message?.includes("cannot create note because it is a duplicate")) { new Notice(`Duplikat gefunden. Suche ID...`, 3000); if (card.type === 'Basic') { ankiNoteId = await findAnkiNoteId(originalQ); } else if (card.type === 'Cloze') { ankiNoteId = await findAnkiClozeNoteId(originalQ); } if (!ankiNoteId) { throw new Error(`Duplikat "${originalQ.substring(0, 20)}..." ID nicht gefunden.`); } else { new Notice(`ID ${ankiNoteId} für Duplikat gefunden. Update...`); if (card.type === 'Basic') { await updateAnkiNoteFields(ankiNoteId, ankiFieldQ, ankiFieldA); } else if (card.type === 'Cloze') { await updateAnkiClozeNoteFields(ankiNoteId, ankiClozeTextField); } } } else { throw e; } } } if (card.type === 'Basic') { newLines.push(`Q: ${originalQ}`); newLines.push(`A: ${originalA}`); } else { newLines.push(originalQ); newLines.push('xxx'); newLines.push(originalA); } newLines.push(`ID: ${ankiNoteId}`); } const currentFileContent = await this.app.vault.read(activeFile); const newBlockContent = newLines.join('\n'); const blockRegexForReplace = /```anki-cards\s*([\s\S]*?)\s*```/g; const matchesForReplace = [...currentFileContent.matchAll(blockRegexForReplace)]; let updatedFileContent = currentFileContent; if (matchesForReplace.length > 0) { let matchToReplace = matchesForReplace.find(m => m[0] === originalSource); if (!matchToReplace) { console.warn("Original 'source' beim Sync nicht gefunden, ersetze letzten anki-cards Block."); matchToReplace = matchesForReplace[matchesForReplace.length - 1]; } if (matchToReplace && matchToReplace.index !== undefined) { const finalBlockSource = `\`\`\`anki-cards\n${newBlockContent}\n\`\`\``; updatedFileContent = currentFileContent.substring(0, matchToReplace.index) + finalBlockSource + currentFileContent.substring(matchToReplace.index + matchToReplace[0].length); } else { throw new Error("Konnte keinen anki-cards Block zum Ersetzen finden."); } } else { throw new Error("Sync fehlgeschlagen: Kein Anki-Block in der Datei gefunden."); } await this.app.vault.modify(activeFile, updatedFileContent); notice.hide(); new Notice('Synchronisation erfolgreich!'); const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView); if (activeMarkdownView) { activeMarkdownView.previewMode.rerender(true); } } catch (error) { notice.hide(); const errorMsg = error instanceof Error ? error.message : String(error); new Notice('Anki-Sync Fehler: ' + errorMsg, 10000); console.error("Anki-Sync Fehler:", error); } };
		});

		this.addCommand({ /* ... bleibt gleich ... */ id: 'generate-anki-cards', name: 'Generate Anki Cards from Note', editorCallback: (editor: Editor, view: MarkdownView) => { this.triggerCardGeneration(editor); } });
		const statusBarItemEl = this.addStatusBarItem(); statusBarItemEl.addClass('anki-generate-button'); statusBarItemEl.setText('🧠 Anki-Karten generieren');
		this.registerDomEvent(statusBarItemEl, 'click', () => { /* ... bleibt gleich ... */ const activeView = this.app.workspace.getActiveViewOfType(MarkdownView); if (activeView) { this.triggerCardGeneration(activeView.editor); } else { new Notice('Bitte öffnen Sie eine Notiz, um Karten zu generieren.'); } });
	}

	// --- START: triggerCardGeneration mit KORRIGIERTEM AUFRUF VON startGenerationProcess ---
	async triggerCardGeneration(editor: Editor) {
		// --- KORREKTUR: ankiInfo und initialSubdeck *hier* holen ---
		const ankiInfo = parseAnkiSection(editor, this.settings.mainDeck);
		const initialSubdeck = ankiInfo ? ankiInfo.subdeck : '';

		const geminiAvailable = !!this.settings.geminiApiKey;
		const ollamaAvailable = this.settings.ollamaEnabled && !!this.settings.ollamaEndpoint && !!this.settings.ollamaModel;

		// --- DEFINTION VON startGenerationProcess ---
		// Akzeptiert jetzt den Editor als Parameter
		const startGenerationProcess = (provider: 'gemini' | 'ollama', currentEditor: Editor) => {
			// Verwende den übergebenen initialSubdeck
			new SubdeckModal(this.app, this.settings.mainDeck, initialSubdeck, async (newSubdeck) => {
				let notice = new Notice(`Bereite Anki-Block für ${provider}...`, 0);
				let requestBodyString = "";

				try {
					const fullDeckPath = `${this.settings.mainDeck}::${newSubdeck}`;
					let fileContent = currentEditor.getValue(); // Verwende currentEditor
					const ankiBlockRegex = /```anki-cards\s*([\s\S]*?)\s*```/g;
					let matches = [...fileContent.matchAll(ankiBlockRegex)];
					let blockStartIndex = -1;
					let blockEndIndex = -1;
					let blockSourceLength = 0;

					if (matches.length > 0) {
						// Block existiert
						const lastMatch = matches[matches.length - 1];
						const sourceBlock = lastMatch[0];
						const blockContent = lastMatch[1]; // Inhalt vor Update
						const blockLines = blockContent.trim().split('\n');
						const deckLine = blockLines.find(l => l.startsWith('TARGET DECK:'));
						const deckLineIndex = blockLines.findIndex(l => l.startsWith('TARGET DECK:'));
						if (lastMatch.index === undefined) throw new Error("Konnte Startindex nicht finden.");
						blockStartIndex = lastMatch.index;
						blockSourceLength = sourceBlock.length;
						if (!deckLine || deckLine.replace('TARGET DECK:', '').trim() !== fullDeckPath) { /* ... Deck aktualisieren ... */ let newBlockInternalContent = ""; if (deckLineIndex > -1) { blockLines[deckLineIndex] = `TARGET DECK: ${fullDeckPath}`; newBlockInternalContent = blockLines.join('\n'); } else { newBlockInternalContent = `TARGET DECK: ${fullDeckPath}\n${blockLines.join('\n')}`; } const newAnkiBlockSource = `\`\`\`anki-cards\n${newBlockInternalContent}\n\`\`\``; const startPos = currentEditor.offsetToPos(blockStartIndex); const endPos = currentEditor.offsetToPos(blockStartIndex + blockSourceLength); currentEditor.replaceRange(newAnkiBlockSource, startPos, endPos); blockSourceLength = newAnkiBlockSource.length; }
						blockEndIndex = blockStartIndex + blockSourceLength;
					} else {
						// Neuen Block erstellen
						const output = `\n\n## Anki\n\n\`\`\`anki-cards\nTARGET DECK: ${fullDeckPath}\n\n\`\`\``;
						const lastLine = currentEditor.lastLine();
						const endOfDocument = { line: lastLine, ch: currentEditor.getLine(lastLine).length };
						const insertionStartOffset = currentEditor.posToOffset(endOfDocument);
						currentEditor.replaceRange(output, endOfDocument);
						fileContent = currentEditor.getValue(); matches = [...fileContent.matchAll(ankiBlockRegex)];
						if (matches.length > 0) { const newMatch = matches[matches.length - 1]; if (newMatch.index !== undefined) { blockStartIndex = newMatch.index; blockSourceLength = newMatch[0].length; blockEndIndex = blockStartIndex + blockSourceLength; } else { throw new Error("Index des neuen Blocks undefiniert."); } }
						else { throw new Error("Neuen Block nicht gefunden."); }
						if (blockStartIndex < 0 || blockEndIndex <= blockStartIndex) { throw new Error("Indexe des neuen Blocks ungültig."); }
					}

					let insertionPoint: CodeMirror.Position;
					const finalInsertionOffset = blockEndIndex - 3;
					if (finalInsertionOffset >= blockStartIndex && finalInsertionOffset <= currentEditor.getValue().length) {
						insertionPoint = currentEditor.offsetToPos(finalInsertionOffset);
					} else {
						console.error("Ungültiger finaler Einfüge-Offset:", finalInsertionOffset, { blockStartIndex, blockEndIndex });
						throw new Error("Fehler bei Berechnung des Einfügepunkts.");
					}

					notice.setMessage(`Generiere Karten mit ${provider}...`);
					const currentContentForAI = currentEditor.getValue();
					// --- KORREKTUR: Übergebe den editor an parseAnkiSection ---
					const currentAnkiInfo = parseAnkiSection(currentEditor, this.settings.mainDeck);
					const existingCards = currentAnkiInfo?.existingCardsText || 'Keine.';

					const generatedTextRaw = await this.generateCardsWithAI(currentContentForAI, existingCards, provider);
					const generatedText = generatedTextRaw.trim().replace(/^```|```$/g, '').trim();

					console.log("Generierter Text (bereinigt):", generatedText);
					if (insertionPoint && generatedText) {
						const blockStartOffset = blockStartIndex + "```anki-cards\n".length;
						const validStartOffset = Math.min(blockStartOffset, finalInsertionOffset);
						const contentBeforeInsertionInBlock = currentEditor.getRange(currentEditor.offsetToPos(validStartOffset), insertionPoint).trimEnd();
						let prefix = "";
						const isEmptyOrOnlyDeck = contentBeforeInsertionInBlock.length === 0 || (contentBeforeInsertionInBlock.startsWith("TARGET DECK:") && contentBeforeInsertionInBlock.split('\n').filter(l => l.trim().length > 0).length <= 1);
						if (!isEmptyOrOnlyDeck && !contentBeforeInsertionInBlock.endsWith('\n\n')) { prefix = contentBeforeInsertionInBlock.endsWith('\n') ? '\n' : '\n\n'; }
						else if (isEmptyOrOnlyDeck && !contentBeforeInsertionInBlock.endsWith('\n') && contentBeforeInsertionInBlock.length > 0) { prefix = "\n"; }
						currentEditor.replaceRange(`${prefix}${generatedText}`, insertionPoint);

						notice.hide();
						new Notice(`Anki-Block wurde mit ${provider} aktualisiert/hinzugefügt.`);
					} else if (!generatedText) {
						notice.hide();
						new Notice(`Kein neuer Text von ${provider} generiert.`, 5000);
					} else {
						throw new Error("Interner Fehler: Einfügepunkt war ungültig.");
					}

				} catch (error) {
					// ... (Fehlerbehandlung bleibt gleich) ...
					notice.hide(); console.error(`Fehler bei der Kartengenerierung mit ${provider}:`, error); /*@ts-ignore*/ const isOverloaded = error.isOverloaded === true; /*@ts-ignore*/ const userMessage = error.message || "Unbekannter Fehler."; if (isOverloaded && provider === 'gemini') { new Notice(userMessage, 10000); } else { /*@ts-ignore*/ let details = error.debugDetails || `--- MESSAGE ---\n${error.message}\n\n--- STACK ---\n${error.stack}`; /*@ts-ignore*/ requestBodyString = error.requestBody || requestBodyString; new DebugModal(this.app, requestBodyString, details).open(); new Notice(userMessage + " Details im Modal.", 10000); }
				}
			}).open();
		};
		// --- ENDE startGenerationProcess ---


		// --- Logik zur Modellauswahl (unverändert) ---
		if (geminiAvailable && ollamaAvailable) {
			console.log("Beide Modelle verfügbar. Zeige Auswahl.");
			new ModelSelectionModal(this.app, geminiAvailable, ollamaAvailable, (selectedProvider) => {
				console.log("Modell ausgewählt:", selectedProvider);
				startGenerationProcess(selectedProvider, editor); // Übergebe den editor
			}).open();
		} else if (geminiAvailable) {
			console.log("Nur Gemini verfügbar. Starte Prozess.");
			startGenerationProcess('gemini', editor); // Übergebe den editor
		} else if (ollamaAvailable) {
			console.log("Nur Ollama verfügbar. Starte Prozess.");
			startGenerationProcess('ollama', editor); // Übergebe den editor
		} else {
			console.log("Kein Modell verfügbar.");
			new Notice('Kein KI-Modell konfiguriert.', 7000);
		}
	}
	// --- ENDE: triggerCardGeneration mit Modellauswahl ---


	async generateCardsWithAI(noteContent: string, existingCards: string, provider: 'gemini' | 'ollama'): Promise<string> { /* ... bleibt gleich ... */ const finalPrompt = this.settings.prompt.replace('{{noteContent}}', noteContent).replace('{{existingCards}}', existingCards); console.log(`--- Prompt sent to ${provider} ---\n${finalPrompt}\n--- End Prompt ---`); let apiUrl = ""; let requestBody: any = {}; let requestBodyString = ""; if (provider === 'gemini') { if (!this.settings.geminiApiKey) throw new Error("Gemini API Key nicht gesetzt."); apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${this.settings.geminiApiKey}`; requestBody = { contents: [{ parts: [{ text: finalPrompt }] }] }; } else if (provider === 'ollama') { if (!this.settings.ollamaEndpoint || !this.settings.ollamaModel) throw new Error("Ollama Endpunkt oder Modell nicht konfiguriert."); apiUrl = this.settings.ollamaEndpoint; requestBody = { model: this.settings.ollamaModel, prompt: finalPrompt, stream: false }; } else { throw new Error("Ungültiger AI Provider angegeben."); } requestBodyString = JSON.stringify(requestBody); const response = await requestUrl({ url: apiUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBodyString, throw: false }); const responseJson = response.json; if (response.status < 300) { if (provider === 'gemini') { if (!responseJson?.candidates?.[0]?.content?.parts?.[0]?.text) { console.error("Unerwartete Antwortstruktur von Gemini:", responseJson); throw new Error("Unerwartete Antwortstruktur von Gemini."); } return responseJson.candidates[0].content.parts[0].text.trim(); } else if (provider === 'ollama') { if (typeof responseJson?.response !== 'string') { console.error("Unerwartete Antwortstruktur von Ollama:", responseJson); throw new Error("Unerwartete Antwortstruktur von Ollama."); } return responseJson.response.trim(); } } else { let userFriendlyMessage = `API Fehler (${provider}, Status ${response.status})`; let errorDetails = `Status: ${response.status}\nBody:\n${JSON.stringify(responseJson, null, 2)}`; let isOverloaded = false; let isNetworkError = response.status === 0; if (responseJson && responseJson.error && responseJson.error.message) { const apiMessage = responseJson.error.message; userFriendlyMessage = `API Fehler (${provider}, ${response.status}): ${apiMessage}`; if (provider === 'gemini' && response.status === 503 && apiMessage.toLowerCase().includes("overloaded")) { isOverloaded = true; } } else if (response.status >= 500 && !isNetworkError) { isOverloaded = true; userFriendlyMessage = `API Serverfehler (${provider}, Status ${response.status}).`; } else if (!isNetworkError) { userFriendlyMessage = `API Client-Fehler (${provider}, Status ${response.status}).`; } else { userFriendlyMessage = `Netzwerkfehler beim Verbinden mit ${provider}.`; } const error = new Error(userFriendlyMessage); /*@ts-ignore*/ error.debugDetails = errorDetails; /*@ts-ignore*/ error.isOverloaded = isOverloaded; /*@ts-ignore*/ error.isNetworkError = isNetworkError; /*@ts-ignore*/ error.requestBody = requestBodyString; throw error; } return ""; }
	onunload() { }
	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}

// --- Typdeklaration für parseAnkiSection (unverändert) ---
declare module './anki/ankiParser' {
	export function parseAnkiSection(editor: Editor | null, mainDeck: string, blockContentOverride?: string): { subdeck: string; deckLineNumber: number; existingCardsText: string; } | null;
	export function parseAnkiSection(editor: Editor, mainDeck: string): { subdeck: string; deckLineNumber: number; existingCardsText: string; } | null;
}
