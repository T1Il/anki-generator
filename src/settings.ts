import { App, PluginSettingTab, Setting } from 'obsidian';
import AnkiGeneratorPlugin from './main';

export interface AnkiGeneratorSettings {
	geminiApiKey: string;
	prompt: string;
	mainDeck: string;
	basicModelName: string;
	clozeModelName: string;
}

export const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	geminiApiKey: '',
	mainDeck: 'Mein Hauptdeck',
	prompt: `Du bist ein Assistent, der Lerninhalte in Anki-Karteikarten umwandelt. Deine einzige Aufgabe ist es, die formatierten Karten zu erstellen. Gib KEINEN einleitenden oder abschließenden Text aus.

		Erstelle aus dem Quelltext NEUE, sinnvolle Anki-Karteikarten, die die bereits existierenden Karten ergänzen. VERMEIDE es, Duplikate oder sehr ähnliche Fragen zu den existierenden Karten zu erstellen. Sei gründlich und erstelle so viele sinnvolle Fragen, wie der Text hergibt. Qualität und Vollständigkeit sind wichtig.

		Denke dir NIEMALS Fakten aus und benutze AUSSCHLIESSLICH Informationen aus dem Aufschrieb. Falls im Aufschrieb Fußnoten mit Links zu bspw. Zotero verwendet werden, füge diese auch zu den jeweiligen Fragen hinzu. 

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
		`, 
	basicModelName: 'Basic',
	clozeModelName: 'Lückentext',
};

export class AnkiGeneratorSettingTab extends PluginSettingTab {
	plugin: AnkiGeneratorPlugin;

	constructor(app: App, plugin: AnkiGeneratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Anki Generator Einstellungen' });

		new Setting(containerEl).setName('Gemini API Key').addText(text => text.setPlaceholder('Gib deinen Schlüssel ein...').setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => { this.plugin.settings.geminiApiKey = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Anki Hauptdeck').addText(text => text.setPlaceholder('z.B. Medizin').setValue(this.plugin.settings.mainDeck).onChange(async (value) => { this.plugin.settings.mainDeck = value; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Name für Basic-Kartentyp')
			.setDesc('Der exakte Name des "Basic" Notiztyps in Anki.')
			.addText(text => text
				.setValue(this.plugin.settings.basicModelName)
				.onChange(async (value) => {
					this.plugin.settings.basicModelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Name für Lückentext-Kartentyp')
			.setDesc('Der exakte Name des "Cloze" / "Lückentext" Notiztyps in Anki.')
			.addText(text => text
				.setValue(this.plugin.settings.clozeModelName)
				.onChange(async (value) => {
					this.plugin.settings.clozeModelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('System Prompt').setDesc('Die Anweisung für die KI. {{noteContent}} und {{existingCards}} werden automatisch ersetzt.').addTextArea(text => text.setValue(this.plugin.settings.prompt).onChange(async (value) => { this.plugin.settings.prompt = value; await this.plugin.saveSettings(); }).inputEl.rows = 15);
	}
}
