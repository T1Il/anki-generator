import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import AnkiGeneratorPlugin from './main'; // Import der Hauptklasse

export interface AnkiGeneratorSettings {
	geminiApiKey: string;
	prompt: string;
	mainDeck: string;
}

export const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	geminiApiKey: '',
	mainDeck: 'Mein Hauptdeck',
	prompt: `Du bist ein Assistent... (dein kompletter Prompt)` // Hier zur Kürze weggelassen
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
		new Setting(containerEl).setName('System Prompt').setDesc('Die Anweisung für die KI. {{noteContent}} und {{existingCards}} werden automatisch ersetzt.').addTextArea(text => text.setValue(this.plugin.settings.prompt).onChange(async (value) => { this.plugin.settings.prompt = value; await this.plugin.saveSettings(); }).inputEl.rows = 15);
	}
}
