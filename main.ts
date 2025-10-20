import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';

// --- SETTINGS INTERFACE AND DEFAULTS ---
interface AnkiGeneratorSettings {
	geminiApiKey: string;
	prompt: string;
	mainDeck: string;
}

const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	geminiApiKey: '',
	mainDeck: 'Mein Hauptdeck',
	prompt: `Du bist ein Assistent, der Lerninhalte in Anki-Karteikarten umwandelt. Deine einzige Aufgabe ist es, die formatierten Karten zu erstellen. Gib KEINEN einleitenden oder abschließenden Text aus.

Erstelle aus dem Quelltext NEUE, sinnvolle Anki-Karten, die die bereits existierenden Karten ergänzen. VERMEIDE es, Duplikate oder sehr ähnliche Fragen zu den existierenden Karten zu erstellen.

EXISTIERENDE KARTEN (als Referenz, um Duplikate zu vermeiden):
---
{{existingCards}}
---

Verwende für die NEUEN Karten dynamisch eines der folgenden zwei Formate:

FORMAT 1: Standard-Frage-Antwort
Syntax:
Q: [Frage]
A: [Antwort]

FORMAT 2: Lückentext / Faktenabfrage
Verwende dieses Format NUR für Fakten. Die Antwort darf NUR aus dem fehlenden Fakt bestehen.
Syntax:
[Satz, der den Fakt abfragt]
xxx
[Der exakte Fakt]

QUELLTEXT (zur Erstellung neuer Karten):
---
{{noteContent}}
---
`
}

// --- SUBDECK MODAL ---
class SubdeckModal extends Modal {
	subdeck: string; initialValue: string; mainDeck: string;
	onSubmit: (subdeck: string) => void;

	constructor(app: App, mainDeck: string, initialValue: string, onSubmit: (subdeck: string) => void) {
		super(app);
		this.mainDeck = mainDeck;
		this.initialValue = initialValue;
		this.subdeck = initialValue;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Unterdeck für Anki-Karten" });
		const pathPreviewEl = contentEl.createDiv({ cls: "anki-path-preview" });
		const updatePreview = (subdeckValue: string) => {
			pathPreviewEl.empty();
			pathPreviewEl.createEl("p", { text: "Finaler Pfad:", cls: "anki-path-title" });
			const sanitizedSubdeck = subdeckValue.replace(/->/g, '::');
			const fullPath = `${this.mainDeck}::${sanitizedSubdeck}`;
			const pathParts = fullPath.split('::').filter(p => p.length > 0);
			const listEl = pathPreviewEl.createEl("div", { cls: "anki-path-list" });
			pathParts.forEach((part, index) => {
				const itemEl = listEl.createEl("div", { cls: "anki-path-item" });
				itemEl.style.paddingLeft = `${index * 20}px`;
				const emoji = index === 0 ? '🗂️' : '📂';
				itemEl.setText(`${emoji} ${part}`);
			});
		};

		new Setting(contentEl)
			.setName("Name des Unterdecks")
			.setDesc("Du kannst Unter-Unterdecks mit '::' oder '->' trennen.")
			.addText((text) =>
				text.setValue(this.initialValue).onChange((value) => {
					this.subdeck = value.replace(/->/g, '::');
					updatePreview(this.subdeck);
				}));

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Generieren").setCta().onClick(() => {
					this.close();
					this.onSubmit(this.subdeck || 'Standard');
				}));

		updatePreview(this.initialValue);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --- MAIN PLUGIN CLASS ---
export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor('anki-cards', (source, el, ctx) => {
			const lines = source.trim().split('\n');
			const cards = [];
			let currentQ = '', currentA = '', currentId = null;

			for (const line of lines) {
				if (line.startsWith('Q:')) {
					if (currentQ) cards.push({ q: currentQ, a: currentA, id: currentId });
					currentQ = line.substring(3).trim();
					currentA = '';
					currentId = null;
				} else if (line.startsWith('A:')) {
					currentA = line.substring(3).trim();
				} else if (line.startsWith('ID:')) {
					currentId = parseInt(line.substring(4).trim(), 10) || null;
				}
			}
			if (currentQ) cards.push({ q: currentQ, a: currentA, id: currentId });

			el.createEl('h4', { text: 'Zu synchronisierende Anki-Karten' });
			const listEl = el.createEl('ul');
			cards.forEach(card => {
				const itemEl = listEl.createEl('li');
				const status = card.id ? `✅ (ID: ${card.id})` : '🆕 (Neu)';
				itemEl.setText(`${status} ${card.q}`);
			});

			const button = el.createEl('button', { text: 'Mit Anki synchronisieren' });
			button.onclick = async () => {
				const notice = new Notice('Synchronisiere mit Anki...', 0);
				try {
					const file = this.app.workspace.getActiveFile();
					if (!file) throw new Error("Keine aktive Datei gefunden.");

					const fileContent = await this.app.vault.read(file);
					const deckMatch = fileContent.match(/TARGET DECK\n(.+)/);
					if (!deckMatch) throw new Error("Kein 'TARGET DECK' in der Notiz gefunden.");

					const deckName = deckMatch[1].trim();
					const newLines = [];

					for (const card of cards) {
						newLines.push(`Q: ${card.q}`);
						newLines.push(`A: ${card.a}`);
						if (card.id) {
							await updateAnkiNoteFields(card.id, card.q, card.a);
							newLines.push(`ID: ${card.id}`);
						} else {
							const newId = await addAnkiNote(deckName, card.q, card.a);
							newLines.push(`ID: ${newId}`);
						}
					}

					const newBlockContent = newLines.join('\n');
					const updatedContent = fileContent.replace(source, newBlockContent);
					await this.app.vault.modify(file, updatedContent);

					notice.hide();
					new Notice('Synchronisation erfolgreich!');
				} catch (error) {
					notice.hide();
					new Notice('Fehler bei der Anki-Synchronisation: ' + error.message, 5000);
					console.error("Anki-Sync Fehler:", error);
				}
			};
		});

		this.addCommand({
			id: 'generate-anki-cards',
			name: 'Generate Anki Cards from Note',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new SubdeckModal(this.app, this.settings.mainDeck, '', async (newSubdeck) => {
					const notice = new Notice('Anki-Karten werden generiert...', 0);
					try {
						const noteContent = editor.getValue();
						const finalPrompt = this.settings.prompt.replace('{{noteContent}}', noteContent).replace('{{existingCards}}', "Keine.");
						const apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${this.settings.geminiApiKey}`;
						const requestBody = { contents: [{ parts: [{ text: finalPrompt }] }] };
						const response = await requestUrl({ url: apiUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
						const generatedText = response.json.candidates[0].content.parts[0].text.trim();

						const fullDeckPath = `${this.settings.mainDeck}::${newSubdeck}`;
						const output = `
## Anki
TARGET DECK
${fullDeckPath}

\`\`\`anki-cards
${generatedText}
\`\`\`
`;
						// --- KORREKTUR IST HIER ---
						// Wir ersetzen die fehlerhafte getCursor-Methode
						const lastLine = editor.lastLine();
						const endOfDocument = {
							line: lastLine,
							ch: editor.getLine(lastLine).length
						};
						editor.replaceRange(output, endOfDocument);

						notice.hide();
						new Notice('Anki-Block wurde hinzugefügt. Klicke "Synchronisieren", um die Karten zu Anki zu senden.');
					} catch (error) {
						notice.hide();
						console.error("Fehler bei der Kartengenerierung:", error);
						new Notice('Fehler bei der Kartengenerierung.');
					}
				}).open();
			}
		});
	}

	onunload() { }
	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}

// --- SETTINGS TAB CLASS ---
class AnkiGeneratorSettingTab extends PluginSettingTab {
	plugin: AnkiGeneratorPlugin;
	constructor(app: App, plugin: AnkiGeneratorPlugin) { super(app, plugin); this.plugin = plugin; }
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Anki Generator Einstellungen' });
		new Setting(containerEl).setName('Gemini API Key').addText(text => text.setPlaceholder('Gib deinen Schlüssel ein...').setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => { this.plugin.settings.geminiApiKey = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Anki Hauptdeck').addText(text => text.setPlaceholder('z.B. Medizin').setValue(this.plugin.settings.mainDeck).onChange(async (value) => { this.plugin.settings.mainDeck = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('System Prompt').setDesc('Die Anweisung für die KI. {{noteContent}} und {{existingCards}} werden automatisch ersetzt.').addTextArea(text => text.setValue(this.plugin.settings.prompt).onChange(async (value) => { this.plugin.settings.prompt = value; await this.plugin.saveSettings(); }).inputEl.rows = 15);
	}
}

// --- ANKICONNECT HELPER FUNCTIONS ---
async function ankiConnectRequest(action: string, params: object): Promise<any> {
	try {
		const response = await requestUrl({
			url: 'http://127.0.0.1:8765',
			method: 'POST',
			body: JSON.stringify({ action, version: 6, params }),
			headers: { 'Content-Type': 'application/json' },
		});
		const json = response.json;
		if (json.error) {
			throw new Error(json.error);
		}
		return json.result;
	} catch (e) {
		throw new Error("Konnte AnkiConnect nicht erreichen. Läuft Anki im Hintergrund?");
	}
}

async function addAnkiNote(deckName: string, front: string, back: string): Promise<number> {
	return ankiConnectRequest('addNote', {
		note: {
			deckName,
			modelName: "Basic",
			fields: { Front: front, Back: back },
			tags: []
		}
	});
}

async function updateAnkiNoteFields(id: number, front: string, back: string): Promise<void> {
	return ankiConnectRequest('updateNoteFields', {
		note: {
			id,
			fields: { Front: front, Back: back }
		}
	});
}
