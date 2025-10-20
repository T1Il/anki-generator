import { App, Editor, MarkdownView, Notice, Plugin, requestUrl } from 'obsidian';
import { AnkiGeneratorSettingTab, DEFAULT_SETTINGS, AnkiGeneratorSettings } from './settings';
import { SubdeckModal } from './ui/SubdeckModal';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { addAnkiNote, addAnkiClozeNote, updateAnkiNoteFields, createAnkiDeck, findAnkiNoteId, getCardCountForDeck } from './anki/AnkiConnect';
import { parseAnkiSection } from './anki/ankiParser';
import { Card } from './types';

export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor('anki-cards', async (source, el, ctx) => {
			el.empty();
			const lines = source.trim().split('\n');

			const deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:'));
			const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;

			el.createEl('h4', { text: 'Anki-Karten' });

			if (deckName) {
				try {
					const count = await getCardCountForDeck(deckName);
					el.createEl('p', { text: `📈 ${count} Karten in diesem Anki-Deck`, cls: 'anki-card-count' });
				} catch (e) {
					el.createEl('p', { text: '⚠️ Anki-Verbindung für Kartenzahl fehlgeschlagen.', cls: 'anki-card-count anki-error' });
				}
			}

			const cards: Card[] = [];
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (line.startsWith('Q:')) {
					const q = line.substring(3).trim();
					let a = '', id = null;
					if (lines[i + 1]?.startsWith('A:')) { a = lines[i + 1].substring(3).trim(); i++; }
					if (lines[i + 1]?.startsWith('ID:')) { id = parseInt(lines[i + 1].substring(4).trim(), 10) || null; i++; }
					cards.push({ type: 'Basic', q, a, id });
				} else if (lines[i + 1]?.trim() === 'xxx') {
					const q = line.trim();
					const a = lines[i + 2]?.trim() || '';
					let id = null;
					if (lines[i + 3]?.startsWith('ID:')) { id = parseInt(lines[i + 3].substring(4).trim(), 10) || null; i++; }
					cards.push({ type: 'Cloze', q, a, id });
					i += 2;
				}
			}

			const buttonContainer = el.createDiv({ cls: 'anki-button-container' });

			const previewButton = buttonContainer.createEl('button', { text: 'Vorschau & Bearbeiten' });
			previewButton.onclick = () => {
				const onSave = async (updatedCards: Card[]) => {
					const notice = new Notice('Speichere Änderungen...', 0);
					try {
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
							if (card.id) {
								newLines.push(`ID: ${card.id}`);
							}
						});

						const fileContent = await this.app.vault.read(file);
						const newBlockContent = newLines.join('\n');
						const updatedContent = fileContent.replace(source, newBlockContent);
						await this.app.vault.modify(file, updatedContent);
						notice.hide();
						new Notice("Änderungen gespeichert!");
					} catch (e) {
						notice.hide();
						new Notice("Fehler beim Speichern: " + e.message);
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
						let newId = card.id;

						if (card.type === 'Basic') {
							newLines.push(`Q: ${card.q}`);
							newLines.push(`A: ${card.a}`);
						} else {
							newLines.push(card.q);
							newLines.push('xxx');
							newLines.push(card.a);
						}

						if (card.id) {
							await updateAnkiNoteFields(card.id, card.q, card.a);
						} else {
							const existingId = await findAnkiNoteId(deckName, card.q);
							if (existingId) {
								newId = existingId;
								await updateAnkiNoteFields(newId, card.q, card.a);
							} else {
								if (card.type === 'Basic') {
									newId = await addAnkiNote(deckName, this.settings.basicModelName, card.q, card.a);
								} else if (card.type === 'Cloze') {
									const clozeText = card.q.replace('____', `{{c1::${card.a}}}`);
									newId = await addAnkiClozeNote(deckName, this.settings.clozeModelName, clozeText);
								}
							}
						}
						newLines.push(`ID: ${newId}`);
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
				const ankiInfo = parseAnkiSection(editor, this.settings.mainDeck);
				const initialSubdeck = ankiInfo ? ankiInfo.subdeck : '';

				new SubdeckModal(this.app, this.settings.mainDeck, initialSubdeck, async (newSubdeck) => {
					const notice = new Notice('Anki-Karten werden generiert...', 0);
					try {
						const noteContent = editor.getValue();
						const existingCards = ankiInfo ? ankiInfo.existingCardsText : 'Keine.';

						const finalPrompt = this.settings.prompt
							.replace('{{noteContent}}', noteContent)
							.replace('{{existingCards}}', existingCards);

						const apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${this.settings.geminiApiKey}`;
						const requestBody = { contents: [{ parts: [{ text: finalPrompt }] }] };

						const response = await requestUrl({
							url: apiUrl, method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(requestBody)
						});

						const generatedText = response.json.candidates[0].content.parts[0].text.trim();
						const fullDeckPath = `${this.settings.mainDeck}::${newSubdeck}`;

						const fileContent = editor.getValue();
						const ankiBlockRegex = /```anki-cards\s*([\s\S]*?)\s*```/g;
						const matches = [...fileContent.matchAll(ankiBlockRegex)];

						if (matches.length > 0) {
							const lastMatch = matches[matches.length - 1];
							const insertionPoint = lastMatch.index + lastMatch[0].length - 3;
							editor.replaceRange(`\n\n${generatedText}`, editor.offsetToPos(insertionPoint));
						} else {
							const output = `\n\n## Anki\n\n\`\`\`anki-cards\nTARGET DECK: ${fullDeckPath}\n\n${generatedText}\n\`\`\``;
							const lastLine = editor.lastLine();
							const endOfDocument = { line: lastLine, ch: editor.getLine(lastLine).length };
							editor.replaceRange(output, endOfDocument);
						}

						notice.hide();
						new Notice('Anki-Block wurde aktualisiert/hinzugefügt.');
					} catch (error) {
						notice.hide();
						console.error("Fehler bei der Kartengenerierung:", error);
						if (error.status === 503) {
							new Notice('Der KI-Dienst ist vorübergehend nicht verfügbar. Bitte versuche es in ein paar Minuten erneut.', 7000);
						} else {
							new Notice('Fehler bei der Kartengenerierung. Prüfe die Konsole.');
						}
					}
				}).open();
			}
		});
	}

	onunload() { }
	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}
