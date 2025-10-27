import { App, Editor, MarkdownView, Notice, Plugin, requestUrl, TFile } from 'obsidian';
import { AnkiGeneratorSettingTab, DEFAULT_SETTINGS, AnkiGeneratorSettings } from './settings';
import { SubdeckModal } from './ui/SubdeckModal';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { DebugModal } from './ui/DebugModal';
import {
	addAnkiNote, addAnkiClozeNote, updateAnkiNoteFields, createAnkiDeck,
	findAnkiNoteId, getCardCountForDeck, findAnkiClozeNoteId, updateAnkiClozeNoteFields,
	deleteAnkiNotes
} from './anki/AnkiConnect';
import { parseAnkiSection } from './anki/ankiParser';
import { Card } from './types';

export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

		this.addRibbonIcon('brain-circuit', 'Anki-Karten generieren', (evt: MouseEvent) => {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView) {
				this.triggerCardGeneration(activeView.editor);
			} else {
				new Notice('Bitte öffnen Sie eine Notiz, um Karten zu generieren.');
			}
		});

		this.registerMarkdownCodeBlockProcessor('anki-cards', async (source, el, ctx) => {
			el.empty();
			const lines = source.trim().split('\n');
			const deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:'));
			const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;

			const cards: Card[] = [];
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line) continue;

				if (line.startsWith('Q:')) {
					const q = line.substring(3).trim();
					let a = '';
					let id = null;

					if (lines[i + 1]?.startsWith('A:')) {
						i++;
						a = lines[i].substring(3).trim();

						let j = i + 1;
						while (j < lines.length &&
							!lines[j].startsWith('Q:') &&
							!lines[j].startsWith('ID:') &&
							lines[j].trim() !== 'xxx') {

							if (a.length > 0 || lines[j].trim().length > 0) {
								a += (a.length > 0 ? '\n' : '') + lines[j];
							}
							j++;
						}
						i = j - 1;
					}

					if (lines[i + 1]?.startsWith('ID:')) {
						i++;
						id = parseInt(lines[i].substring(4).trim(), 10) || null;
					}

					cards.push({ type: 'Basic', q, a: a.trim(), id });
				}
				else if (lines[i + 1]?.trim() === 'xxx') {
					const q = line.trim();
					i++;

					let a = '';
					let id = null;

					let j = i + 1;
					while (j < lines.length &&
						!lines[j].startsWith('Q:') &&
						!lines[j].startsWith('ID:') &&
						lines[j].trim() !== 'xxx') {

						if (a.length > 0 || lines[j].trim().length > 0) {
							a += (a.length > 0 ? '\n' : '') + lines[j];
						}
						j++;
					}
					i = j - 1;

					if (lines[i + 1]?.startsWith('ID:')) {
						i++;
						id = parseInt(lines[i].substring(4).trim(), 10) || null;
					}

					cards.push({ type: 'Cloze', q, a: a.trim(), id });
				}
			}

			el.createEl('h4', { text: 'Anki-Karten' });

			if (deckName) {
				const synchronizedCount = cards.filter(card => card.id !== null).length;
				const unsynchronizedCount = cards.length - synchronizedCount;

				const localStatusText = `✅ ${synchronizedCount} Synchronisiert | 📝 ${unsynchronizedCount} Ausstehend`;
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
				if (errorClass) {
					pEl.addClass(errorClass);
				}
			}

			const buttonContainer = el.createDiv({ cls: 'anki-button-container' });

			const previewButton = buttonContainer.createEl('button', { text: 'Vorschau & Bearbeiten' });
			previewButton.onclick = () => {
				const onSave = async (updatedCards: Card[], deletedCardIds: number[]) => {
					const notice = new Notice('Speichere Änderungen...', 0);
					try {
						if (deletedCardIds.length > 0) {
							await deleteAnkiNotes(deletedCardIds);
							new Notice(`${deletedCardIds.length} Karte(n) erfolgreich aus Anki gelöscht!`);
						}

						const file = this.app.workspace.getActiveFile();
						if (!file) throw new Error("Keine aktive Datei.");
						const deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:')) || `TARGET DECK: ${this.settings.mainDeck}::Standard`;
						const newLines = [deckLine, ''];
						updatedCards.forEach(card => {
							if (card.type === 'Basic') {
								newLines.push(`Q: ${card.q}`);
								newLines.push(`A: ${card.a}`);
							} else {
								newLines.push(card.q);
								newLines.push('xxx');
								newLines.push(card.a);
							}
							if (card.id) { newLines.push(`ID: ${card.id}`); }
						});

						const fileContent = await this.app.vault.read(file);
						const newBlockContent = newLines.join('\n');
						const updatedContent = fileContent.replace(source, newBlockContent);
						await this.app.vault.modify(file, updatedContent);

						notice.hide();
						new Notice("Änderungen gespeichert!");
						this.app.workspace.getActiveViewOfType(MarkdownView)?.previewMode.rerender(true);
					} catch (e) {
						notice.hide();
						new Notice("Fehler beim Speichern oder Löschen: " + e.message);
					}
				};

				new CardPreviewModal(this.app, cards, onSave).open();
			};

			const syncButton = buttonContainer.createEl('button', { text: 'Mit Anki synchronisieren' });
			syncButton.onclick = async () => {
				const notice = new Notice('Synchronisiere mit Anki...', 0);
				try {
					const file = this.app.workspace.getActiveFile();
					if (!file) throw new Error("Keine aktive Datei gefunden.");
					if (!deckName) throw new Error("Kein 'TARGET DECK' im anki-cards Block gefunden.");

					await createAnkiDeck(deckName);

					const newLines = [`TARGET DECK: ${deckName}`, ''];

					for (const card of cards) {
						let ankiNoteId = card.id;

						// 1. FINDEN
						if (!ankiNoteId) {
							if (card.type === 'Basic') {
								ankiNoteId = await findAnkiNoteId(card.q);
							} else if (card.type === 'Cloze') {
								ankiNoteId = await findAnkiClozeNoteId(card.q);
							}
						}

						// 2. AKTUALISIEREN
						if (ankiNoteId) {
							try {
								if (card.type === 'Basic') {
									await updateAnkiNoteFields(ankiNoteId, card.q, card.a);
								} else if (card.type === 'Cloze') {
									const clozeText = card.q.replace('____', `{{c1::${card.a}}}`);
									await updateAnkiClozeNoteFields(ankiNoteId, clozeText);
								}
							} catch (e) {
								if (e.message && (e.message.includes("Note was not found") || e.message.includes(ankiNoteId.toString()))) {
									new Notice(`Karte ${ankiNoteId} nicht in Anki gefunden. Erstelle sie neu.`);
									ankiNoteId = null;
								} else {
									throw e;
								}
							}
						}

						// 3. ERSTELLEN
						if (!ankiNoteId) {
							try {
								if (card.type === 'Basic') {
									ankiNoteId = await addAnkiNote(deckName, this.settings.basicModelName, card.q, card.a);
								} else if (card.type === 'Cloze') {
									const clozeText = card.q.replace('____', `{{c1::${card.a}}}`);
									ankiNoteId = await addAnkiClozeNote(deckName, this.settings.clozeModelName, clozeText);
								}
							} catch (e) {
								// 4. DUPLIKAT ABFANGEN
								if (e.message && e.message.includes("cannot create note because it is a duplicate")) {
									new Notice(`Karte ist Duplikat. Suche ID...`, 3000);
									if (card.type === 'Basic') {
										ankiNoteId = await findAnkiNoteId(card.q);
									} else if (card.type === 'Cloze') {
										ankiNoteId = await findAnkiClozeNoteId(card.q);
									}

									if (!ankiNoteId) {
										throw new Error(`Karte "${card.q.substring(0, 20)}..." ist ein Duplikat, ID konnte aber nicht gefunden werden. Sync gestoppt.`);
									} else {
										new Notice(`ID ${ankiNoteId} für Duplikat gefunden. ID wird gespeichert.`);
									}
								} else {
									throw e;
								}
							}
						}

						// 5. IN DATEI SCHREIBEN
						if (card.type === 'Basic') {
							newLines.push(`Q: ${card.q}`);
							newLines.push(`A: ${card.a}`);
						} else {
							newLines.push(card.q);
							newLines.push('xxx');
							newLines.push(card.a);
						}
						newLines.push(`ID: ${ankiNoteId}`);
					}

					const fileContent = await this.app.vault.read(file);
					const newBlockContent = newLines.join('\n');
					const updatedContent = fileContent.replace(source, newBlockContent);
					await this.app.vault.modify(file, updatedContent);

					notice.hide();
					new Notice('Synchronisation erfolgreich!');
					this.app.workspace.getActiveViewOfType(MarkdownView)?.previewMode.rerender(true);
				} catch (error) {
					notice.hide();
					new Notice('Anki-Sync Fehler: ' + error.message, 7000);
					console.error("Anki-Sync Fehler:", error);
				}
			};
		});

		this.addCommand({
			id: 'generate-anki-cards',
			name: 'Generate Anki Cards from Note',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.triggerCardGeneration(editor);
			}
		});

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.addClass('anki-generate-button');
		statusBarItemEl.setText('🧠 Anki-Karten generieren');

		this.registerDomEvent(statusBarItemEl, 'click', () => {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView) {
				this.triggerCardGeneration(activeView.editor);
			} else {
				new Notice('Bitte öffnen Sie eine Notiz, um Karten zu generieren.');
			}
		});
	}

	// --- START: MODIFIZIERTE triggerCardGeneration FUNKTION ---
	async triggerCardGeneration(editor: Editor) {
		const ankiInfo = parseAnkiSection(editor, this.settings.mainDeck);
		const initialSubdeck = ankiInfo ? ankiInfo.subdeck : '';

		new SubdeckModal(this.app, this.settings.mainDeck, initialSubdeck, async (newSubdeck) => {
			const notice = new Notice('Anki-Karten werden generiert...', 0);
			let requestBodyString = "";

			// --- LÖSUNG FÜR REQUEST 2: DECKNAME SOFORT SPEICHERN ---
			let insertionPoint: { line: number, ch: number } | null = null;
			try {
				const fullDeckPath = `${this.settings.mainDeck}::${newSubdeck}`;
				const fileContent = editor.getValue();
				const ankiBlockRegex = /```anki-cards\s*([\s\S]*?)\s*```/g;
				const matches = [...fileContent.matchAll(ankiBlockRegex)];

				if (matches.length > 0) {
					// Block(s) existieren: Finde den letzten
					const lastMatch = matches[matches.length - 1];
					const sourceBlock = lastMatch[0]; // z.B. ```anki-cards...```
					const blockContent = lastMatch[1]; // Inhalt
					const blockLines = blockContent.trim().split('\n');
					const deckLine = blockLines.find(l => l.startsWith('TARGET DECK:'));
					const deckLineIndex = blockLines.findIndex(l => l.startsWith('TARGET DECK:'));

					// Finde den Einfügepunkt (vor den letzten ```)
					const insertionOffset = lastMatch.index + sourceBlock.length - 3;
					insertionPoint = editor.offsetToPos(insertionOffset);

					// Aktualisiere den Decknamen, falls er sich geändert hat ODER fehlt
					if (!deckLine || deckLine.replace('TARGET DECK:', '').trim() !== fullDeckPath) {
						let newBlockContent = "";
						if (deckLineIndex > -1) {
							// Ersetze die existierende Deck-Zeile
							blockLines[deckLineIndex] = `TARGET DECK: ${fullDeckPath}`;
							newBlockContent = blockLines.join('\n');
						} else {
							// Füge die Deck-Zeile oben hinzu
							newBlockContent = `TARGET DECK: ${fullDeckPath}\n${blockLines.join('\n')}`;
						}

						const newAnkiBlockSource = `\`\`\`anki-cards\n${newBlockContent}\n\`\`\``;
						const startPos = editor.offsetToPos(lastMatch.index);
						const endPos = editor.offsetToPos(lastMatch.index + sourceBlock.length);
						editor.replaceRange(newAnkiBlockSource, startPos, endPos);

						// Neuberechnung des Einfügepunkts, da sich der Block geändert hat
						const newOffset = lastMatch.index + newAnkiBlockSource.length - 3;
						insertionPoint = editor.offsetToPos(newOffset);
					}
				} else {
					// Kein Block vorhanden: Erstelle einen neuen, leeren Block
					const output = `\n\n## Anki\n\n\`\`\`anki-cards\nTARGET DECK: ${fullDeckPath}\n\n\`\`\``;
					const lastLine = editor.lastLine();
					const endOfDocument = { line: lastLine, ch: editor.getLine(lastLine).length };
					editor.replaceRange(output, endOfDocument);

					// Setze den Einfügepunkt (vor den letzten ``` des *neuen* Blocks)
					insertionPoint = editor.offsetToPos(editor.getValue().length - 3);
				}
			} catch (e) {
				notice.hide();
				new Notice(`Fehler beim Vorbereiten des Anki-Blocks: ${e.message}`, 7000);
				console.error("Fehler (Block-Vorbereitung):", e);
				return; // Breche die Generierung ab
			}
			// --- ENDE: LÖSUNG FÜR REQUEST 2 ---


			// --- START: LÖSUNG FÜR REQUEST 1 (API-AUFRUF & FEHLERBEHANDLUNG) ---
			try {
				const noteContent = editor.getValue();
				// Wir verwenden das ankiInfo von *vor* unserer Code-Block-Änderung, das ist OK
				const existingCards = ankiInfo ? ankiInfo.existingCardsText : 'Keine.';

				const finalPrompt = this.settings.prompt
					.replace('{{noteContent}}', noteContent)
					.replace('{{existingCards}}', existingCards);

				const apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${this.settings.geminiApiKey}`;

				const requestBody = { contents: [{ parts: [{ text: finalPrompt }] }] };
				requestBodyString = JSON.stringify(requestBody, null, 2);

				const response = await requestUrl({
					url: apiUrl, method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: requestBodyString,
					throw: false // Wirft keinen Fehler bei 4xx/5xx
				});

				const responseJson = response.json;

				// Erfolgsfall (z.B. 200)
				if (response.status < 300) {
					const generatedText = responseJson.candidates[0].content.parts[0].text.trim();
					console.log(generatedText);

					// Füge den generierten Text am gespeicherten Einfügepunkt ein
					const textBeforeInsertion = editor.getRange({ line: 0, ch: 0 }, insertionPoint).trimEnd();
					const prefix = textBeforeInsertion.endsWith('\n\n') ? '' : (textBeforeInsertion.endsWith('\n') ? '\n' : '\n\n');
					editor.replaceRange(`${prefix}${generatedText}`, insertionPoint);

					notice.hide();
					new Notice('Anki-Block wurde aktualisiert/hinzugefügt.');

					// Fehlerfall (z.B. 503, 400)
				} else {
					let userFriendlyMessage = `API Fehler (Status ${response.status})`;
					let errorDetails = JSON.stringify(responseJson, null, 2);
					let isOverloadedError = false;

					if (responseJson && responseJson.error && responseJson.error.message) {
						const apiMessage = responseJson.error.message;
						userFriendlyMessage = `API Fehler (${response.status}): ${apiMessage}`;
						// Prüfe auf den spezifischen 503-Fehler
						if (response.status === 503 && apiMessage.toLowerCase().includes("overloaded")) {
							isOverloadedError = true;
						}
					}

					const error = new Error(userFriendlyMessage);
					// @ts-ignore
					error.debugDetails = errorDetails;
					// @ts-ignore
					error.isOverloaded = isOverloadedError;
					throw error;
				}

				// Fängt Netzwerkfehler ODER unsere manuell geworfenen API-Fehler
			} catch (error) {
				notice.hide();
				console.error("Fehler bei der Kartengenerierung:", error);

				// @ts-ignore
				const isOverloaded = error.isOverloaded === true;
				// @ts-ignore
				const userMessage = error.message || "Unbekannter Fehler. Details im Debug-Modal.";

				// --- LÖSUNG FÜR REQUEST 1: ZEIGE MODAL NUR WENN NÖTIG ---
				if (isOverloaded) {
					// Zeige *nur* die Notice beim 503-Fehler
					new Notice(userMessage, 10000);
				} else {
					// Zeige das Debug-Modal für *alle anderen* Fehler
					// @ts-ignore
					let details = error.debugDetails || `--- MESSAGE ---\n${error.message}\n\n--- STACK ---\n${error.stack}`;
					new DebugModal(this.app, requestBodyString, details).open();
					new Notice(userMessage, 10000);
				}
			}
			// --- ENDE: LÖSUNG FÜR REQUEST 1 ---
		}).open();
	}
	// --- ENDE: MODIFIZIERTE triggerCardGeneration FUNKTION ---


	onunload() { }
	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}
