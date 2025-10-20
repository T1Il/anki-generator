// Die Importe werden erweitert um 'Notice' für Benachrichtigungen
import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';

// Interface für Einstellungen (unverändert)
interface AnkiGeneratorSettings {
	geminiApiKey: string;
}

// Standard-Einstellungen (unverändert)
const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	geminiApiKey: ''
}

// Hauptklasse des Plugins
export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

		// Der Befehl wird jetzt um die API-Logik erweitert
		this.addCommand({
			id: 'generate-anki-cards',
			name: 'Generate Anki Cards from Note',
			// Die Funktion wird als 'async' markiert, weil wir auf die API-Antwort warten.
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				if (!this.settings.geminiApiKey) {
					new Notice('Bitte gib zuerst deinen Gemini API-Schlüssel in den Plugin-Einstellungen ein.');
					return;
				}

				new Notice('Generiere Anki-Karten... bitte habe einen Moment Geduld.');

				try {
					const noteContent = editor.getValue();
					const prompt = `
            Erstelle aus dem folgenden Text Anki-Karteikarten.
            Die Karten sollen wichtige Konzepte, Definitionen und Zusammenhänge abfragen.
            Verwende DYNAMISCH eines der folgenden zwei Formate, je nachdem, was sinnvoller ist:

            FORMAT 1: Standard-Frage-Antwort
            Syntax:
            Q: [Hier steht die Frage?]
            A: [Hier steht die Antwort.]

            FORMAT 2: Lückentext / Kurzantwort
            Syntax:
            [Die Frage, die eine Lücke impliziert?]
            xxx
            [Die exakte, kurze Antwort!]

            Wähle intelligent zwischen den beiden Formaten. Stelle sicher, dass Fragen für Format 2 wirklich nur eine kurze Antwort erfordern. Generiere eine gute Mischung aus beiden Typen.

            Hier ist der Text, aus dem du die Karten erstellen sollst:
            ---
            ${noteContent}
            ---
        `;

					// Use the correct model name you discovered
					const apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${this.settings.geminiApiKey}`;

					const requestBody = {
						contents: [{ parts: [{ text: prompt }] }]
					};

					const response = await requestUrl({
						url: apiUrl,
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(requestBody)
					});

					const generatedText = response.json.candidates[0].content.parts[0].text;

					// --- THE FIX IS HERE ---
					// This is a safer way to find the end of the note.
					const lastLine = editor.lastLine();
					const endOfDocument = {
						line: lastLine,
						ch: editor.getLine(lastLine).length
					};

					// Add the generated text at the calculated end position.
					editor.replaceRange(
						`\n\n---\n### Generierte Anki-Karten\n${generatedText}`,
						endOfDocument
					);

					new Notice('Anki-Karten wurden erfolgreich hinzugefügt!');

				} catch (error) {
					// Final, user-friendly error handling
					console.error('Fehler bei der Anfrage an die Gemini API:', error);
					new Notice('Es ist ein Fehler aufgetreten. Überprüfe die Entwicklerkonsole für Details.');
				}
			}
		});
	}

	// Rest der Datei (onunload, loadSettings, saveSettings, SettingTab) bleibt unverändert...
	onunload() { }

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AnkiGeneratorSettingTab extends PluginSettingTab {
	plugin: AnkiGeneratorPlugin;

	constructor(app: App, plugin: AnkiGeneratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName('Gemini API Key')
			.setDesc('Dein persönlicher API-Schlüssel für die Google Gemini API.')
			.addText(text => text
				.setPlaceholder('Gib deinen Schlüssel ein...')
				.setValue(this.plugin.settings.geminiApiKey)
				.onChange(async (value) => {
					this.plugin.settings.geminiApiKey = value;
					await this.plugin.saveSettings();
				}));
	}
}
