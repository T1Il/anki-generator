import { MarkdownPostProcessorContext, Notice, TFile, normalizePath } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { Card } from './types';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { deleteAnkiNotes, createAnkiDeck, getCardCountForDeck, findAnkiNoteId, findAnkiClozeNoteId, updateAnkiNoteFields, updateAnkiClozeNoteFields, addAnkiNote, addAnkiClozeNote, storeAnkiMediaFile } from './anki/AnkiConnect';
import { arrayBufferToBase64, basicMarkdownToHtml, normalizeNewlines } from './utils';
import { parseCardsFromBlockSource } from './anki/ankiParser';

// --- NEUE, ROBUSTERE REGEX ---
const ANKI_BLOCK_REGEX = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;

// Hauptfunktion für den Markdown Code Block Prozessor
export async function processAnkiCardsBlock(plugin: AnkiGeneratorPlugin, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
	el.empty();

	const linesForDeck = source.trim().split('\n');
	const deckLine = linesForDeck.find(l => l.trim().startsWith('TARGET DECK:'));
	const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;
	const cards = parseCardsFromBlockSource(source);

	el.createEl('h4', { text: 'Anki-Karten' });

	if (deckName) {
		const synchronizedCount = cards.filter(card => card.id !== null).length;
		const totalCardCount = cards.length;
		const localStatusText = `✅ ${synchronizedCount} Synchronisiert | 📝 ${totalCardCount} Lokal`;
		let ankiStatusText = '';
		let errorClass = '';
		try {
			const totalAnkiCount = await getCardCountForDeck(deckName);
			ankiStatusText = `📈 ${totalAnkiCount} in Anki | `;
		} catch (e) {
			ankiStatusText = '⚠️ Anki-Verbindung fehlgeschlagen | ';
			errorClass = 'anki-error';
		}
		const fullText = ankiStatusText + localStatusText;
		const pEl = el.createEl('p', { text: fullText, cls: 'anki-card-count' });
		if (errorClass) pEl.addClass(errorClass);
	}

	const buttonContainer = el.createDiv({ cls: 'anki-button-container' });

	const previewButton = buttonContainer.createEl('button', { text: 'Vorschau & Bearbeiten' });
	previewButton.onclick = () => {
		const cardsForModal = JSON.parse(JSON.stringify(cards)) as Card[];
		const onSave = async (updatedCards: Card[], deletedCardIds: number[]) => {
			await saveAnkiBlockChanges(plugin, source, updatedCards, deletedCardIds);
		};
		new CardPreviewModal(plugin.app, cardsForModal, onSave).open();
	};

	const syncButton = buttonContainer.createEl('button', { text: 'Mit Anki synchronisieren' });
	syncButton.onclick = async () => {
		await syncAnkiBlock(plugin, source, deckName, cards);
	};
}


// Speichern der Änderungen aus dem Preview Modal
async function saveAnkiBlockChanges(plugin: AnkiGeneratorPlugin, originalSourceContent: string, updatedCards: Card[], deletedCardIds: number[]) {
	const notice = new Notice('Speichere Änderungen...', 0);
	try {
		if (deletedCardIds.length > 0) {
			await deleteAnkiNotes(deletedCardIds);
			new Notice(`${deletedCardIds.length} Karte(n) gelöscht!`);
		}
		const file = plugin.app.workspace.getActiveFile();
		if (!file) throw new Error("Keine aktive Datei.");
		const currentFileContent = await plugin.app.vault.read(file);

		// Verwende die robustere Funktion zum Finden des Blocks
		const { matchIndex, originalFullBlockSource } = findSpecificAnkiBlock(currentFileContent, originalSourceContent);

		if (matchIndex === -1) {
			throw new Error("Konnte den zu speichernden Anki-Block nicht finden.");
		}

		const deckLine = originalFullBlockSource.split('\n').find(l => l.trim().startsWith('TARGET DECK:')) || `TARGET DECK: ${plugin.settings.mainDeck}::Standard`;
		const newBlockContent = formatCardsToString(deckLine, updatedCards);

		// Formatierung: ```anki-cards\n[CONTENT]\n```
		const finalBlockSource = `\`\`\`anki-cards\n${newBlockContent}\n\`\`\``;
		const updatedFileContent = currentFileContent.substring(0, matchIndex) + finalBlockSource + currentFileContent.substring(matchIndex + originalFullBlockSource.length);

		await plugin.app.vault.modify(file, updatedFileContent);
		notice.hide();
		new Notice("Änderungen gespeichert!");
		plugin.app.workspace.trigger('markdown-preview-rerender');

	} catch (e) {
		notice.hide();
		new Notice("Fehler beim Speichern: " + e.message, 7000);
		console.error("Fehler beim Speichern:", e);
	}
}

// Synchronisation mit AnkiConnect
async function syncAnkiBlock(plugin: AnkiGeneratorPlugin, originalSourceContent: string, deckName: string | null, cards: Card[]) {
	const notice = new Notice('Synchronisiere mit Anki...', 0);
	try {
		const activeFile = plugin.app.workspace.getActiveFile();
		if (!activeFile) throw new Error("Keine aktive Datei gefunden.");
		if (!deckName) throw new Error("Kein 'TARGET DECK' im anki-cards Block gefunden.");
		await createAnkiDeck(deckName);

		const updatedCardsWithIds: Card[] = [];
		const imageRegex = /!\[\[([^|\]]+)(?:\|[^\]]+)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g;

		for (const card of cards) {
			notice.setMessage(`Verarbeite Karte: ${card.q.substring(0, 30)}...`);
			let ankiNoteId = card.id;
			const originalQ = card.q;
			const originalA = card.a;
			let processedQ = originalQ;
			let processedA = originalA;
			const imageProcessedMap = new Map<string, string>();

			const processImages = async (text: string): Promise<string> => {
				let processedText = text;
				const matches = Array.from(text.matchAll(imageRegex));
				for (const match of matches) {
					const originalLink = match[0];
					let imageName = match[1]?.trim();
					if (!imageName && match[2]) {
						const pathParts = match[2].split(/[\\/]/);
						imageName = pathParts[pathParts.length - 1]?.trim();
						if (imageName) imageName = decodeURIComponent(imageName);
					}
					if (!imageName) continue;
					if (imageProcessedMap.has(imageName)) {
						processedText = processedText.replaceAll(originalLink, `<img src="${imageProcessedMap.get(imageName)}">`);
						continue;
					}
					try {
						const file = plugin.app.metadataCache.getFirstLinkpathDest(normalizePath(imageName), activeFile.path);
						if (file instanceof TFile) {
							notice.setMessage(`Lade Bild hoch: ${file.name}...`);
							const fileData = await plugin.app.vault.readBinary(file);
							const base64Data = arrayBufferToBase64(fileData);
							const ankiFilename = await storeAnkiMediaFile(file.name, base64Data);
							imageProcessedMap.set(imageName, ankiFilename);
							processedText = processedText.replaceAll(originalLink, `<img src="${ankiFilename}">`);
						} else {
							console.warn(`Bilddatei nicht gefunden beim Sync: ${imageName}`);
							processedText = processedText.replaceAll(originalLink, `[Bild nicht gefunden: ${imageName}]`);
						}
					} catch (imgError) {
						console.error(`Fehler bei Bild ${imageName} beim Sync:`, imgError);
						new Notice(`Fehler bei Bild ${imageName}: ${imgError.message}`, 5000);
						processedText = processedText.replaceAll(originalLink, `[Fehler bei Bild: ${imageName}]`);
					}
				}
				return processedText;
			};

			processedQ = await processImages(processedQ);
			processedA = await processImages(processedA);
			const htmlQ = basicMarkdownToHtml(processedQ);
			const htmlA = basicMarkdownToHtml(processedA);
			let ankiFieldQ = htmlQ;
			let ankiFieldA = htmlA;
			let ankiClozeTextField = "";

			if (card.type === 'Cloze') {
				const clozeRegex = /(?<!\w)____(?!\w)/;
				ankiClozeTextField = clozeRegex.test(htmlQ)
					? htmlQ.replace(clozeRegex, `{{c1::${htmlA}}}`)
					: `${htmlQ} {{c1::${htmlA}}}`;
				ankiFieldQ = ankiClozeTextField;
				ankiFieldA = "";
			}

			if (!ankiNoteId) {
				ankiNoteId = card.type === 'Basic'
					? await findAnkiNoteId(originalQ)
					: await findAnkiClozeNoteId(originalQ);
			}

			if (ankiNoteId) {
				try {
					notice.setMessage(`Aktualisiere Karte ${ankiNoteId}...`);
					if (card.type === 'Basic') {
						await updateAnkiNoteFields(ankiNoteId, ankiFieldQ, ankiFieldA);
					} else {
						await updateAnkiClozeNoteFields(ankiNoteId, ankiClozeTextField);
					}
				} catch (e) {
					if (e.message?.includes("Note was not found")) {
						new Notice(`Karte ${ankiNoteId} nicht gefunden. Erstelle neu.`);
						ankiNoteId = null;
					} else { throw e; }
				}
			}

			if (!ankiNoteId) {
				try {
					notice.setMessage(`Erstelle neue Karte für ${originalQ.substring(0, 30)}...`);
					ankiNoteId = card.type === 'Basic'
						? await addAnkiNote(deckName, plugin.settings.basicModelName, ankiFieldQ, ankiFieldA)
						: await addAnkiClozeNote(deckName, plugin.settings.clozeModelName, ankiClozeTextField);
				} catch (e) {
					if (e.message?.includes("cannot create note because it is a duplicate")) {
						new Notice(`Duplikat gefunden. Suche ID...`, 3000);
						ankiNoteId = card.type === 'Basic'
							? await findAnkiNoteId(originalQ)
							: await findAnkiClozeNoteId(originalQ);
						if (!ankiNoteId) {
							throw new Error(`Duplikat "${originalQ.substring(0, 20)}..." ID nicht gefunden.`);
						} else {
							new Notice(`ID ${ankiNoteId} für Duplikat gefunden. Update...`);
							if (card.type === 'Basic') {
								await updateAnkiNoteFields(ankiNoteId, ankiFieldQ, ankiFieldA);
							} else {
								await updateAnkiClozeNoteFields(ankiNoteId, ankiClozeTextField);
							}
						}
					} else { throw e; }
				}
			}
			updatedCardsWithIds.push({ ...card, id: ankiNoteId });
		}

		const currentFileContent = await plugin.app.vault.read(activeFile);
		// Verwende die robustere Funktion zum Finden des Blocks
		const { matchIndex, originalFullBlockSource } = findSpecificAnkiBlock(currentFileContent, originalSourceContent);

		if (matchIndex === -1) {
			throw new Error("Konnte den zu synchronisierenden Anki-Block nicht finden.");
		}

		const deckLine = `TARGET DECK: ${deckName}`;
		const newBlockContent = formatCardsToString(deckLine, updatedCardsWithIds);

		// Formatierung: ```anki-cards\n[CONTENT]\n```
		const finalBlockSource = `\`\`\`anki-cards\n${newBlockContent}\n\`\`\``;
		const updatedFileContent = currentFileContent.substring(0, matchIndex) + finalBlockSource + currentFileContent.substring(matchIndex + originalFullBlockSource.length);

		await plugin.app.vault.modify(activeFile, updatedFileContent);
		notice.hide();
		new Notice('Synchronisation erfolgreich!');
		plugin.app.workspace.trigger('markdown-preview-rerender');

	} catch (error) {
		notice.hide();
		const errorMsg = error instanceof Error ? error.message : String(error);
		new Notice('Anki-Sync Fehler: ' + errorMsg, 10000);
		console.error("Anki-Sync Fehler:", error);
	}
}


// Hilfsfunktion zum Formatieren der Kartenliste in einen String
function formatCardsToString(deckLine: string, cards: Card[]): string {
	const newLines: string[] = [deckLine.trim()];
	if (cards.length > 0) newLines.push('');

	cards.forEach((card, cardIndex) => {
		if (card.type === 'Basic') {
			card.q.split('\n').forEach((qLine, index) => newLines.push(index === 0 ? `Q: ${qLine}` : qLine));
			if (card.a && card.a.trim().length > 0) {
				card.a.split('\n').forEach((aLine, index) => newLines.push(index === 0 ? `A: ${aLine}` : aLine));
			} else {
				newLines.push('A:');
			}
		} else { // Cloze
			card.q.split('\n').forEach(qLine => newLines.push(qLine));
			newLines.push('xxx');
			(card.a || "").split('\n').forEach(aLine => newLines.push(aLine));
		}
		if (card.id) {
			newLines.push(`ID: ${card.id}`);
		}
		if (cardIndex < cards.length - 1) {
			newLines.push(''); // Leerzeile
		}
	});
	// Wichtig: trimEnd() entfernt nur Whitespace am Ende, nicht die letzte Leerzeile zwischen Karten
	return newLines.join('\n').trimEnd();
}

// Verbesserte Funktion zum Finden des spezifischen Codeblocks
function findSpecificAnkiBlock(fullContent: string, originalSourceContent: string): { matchIndex: number, originalFullBlockSource: string } {
	// KORREKTUR: Verwende die neue Regex
	ANKI_BLOCK_REGEX.lastIndex = 0; // Reset state
	const matches = [...fullContent.matchAll(ANKI_BLOCK_REGEX)];
	let originalFullBlockSource = "";
	let matchIndex = -1;

	const normalizedSource = normalizeNewlines(originalSourceContent);

	if (matches.length > 0) {
		// 1. Exakter normalisierter Match des *Inhalts* (m[1])
		const match = Array.from(matches).find(m => normalizeNewlines(m[1]) === normalizedSource);
		if (match) {
			originalFullBlockSource = match[0]; // Ganzer Block
			matchIndex = match.index ?? -1;
		} else {
			// 2. Getrimmter normalisierter Match des *Inhalts*
			const normalizedSourceTrimmed = normalizedSource.trim();
			const fallbackMatch = Array.from(matches).find(m => normalizeNewlines(m[1]).trim() === normalizedSourceTrimmed);
			if (fallbackMatch) {
				originalFullBlockSource = fallbackMatch[0];
				matchIndex = fallbackMatch.index ?? -1;
			} else {
				// 3. Fallback: Letzter Block
				console.warn("Konnte spezifischen Anki-Block nicht exakt finden (via source content), verwende letzten Block.");
				const lastMatch = matches[matches.length - 1];
				originalFullBlockSource = lastMatch[0];
				matchIndex = lastMatch.index ?? -1;
			}
		}
	}
	if (matchIndex === -1) {
		console.error("findSpecificAnkiBlock: Konnte keinen Block finden. Regex:", ANKI_BLOCK_REGEX, "Content snippet:", fullContent.substring(0, 500));
	}
	return { matchIndex, originalFullBlockSource };
}
