import { App, Editor, MarkdownView, Notice, Plugin, requestUrl } from 'obsidian';
import { AnkiGeneratorSettingTab, DEFAULT_SETTINGS, AnkiGeneratorSettings } from './settings';
import { SubdeckModal } from './ui/SubdeckModal';
import { addAnkiNote, updateAnkiNoteFields } from './anki/AnkiConnect';
import { parseAnkiSection } from './anki/ankiParser';

export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

        this.registerMarkdownCodeBlockProcessor('anki-cards', (source, el, ctx) => {
            // ... (Hier bleibt die Logik des PostProcessors exakt gleich wie zuvor)
        });

		this.addCommand({
			id: 'generate-anki-cards',
			name: 'Generate Anki Cards from Note',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const ankiInfo = parseAnkiSection(editor, this.settings.mainDeck);
                const initialSubdeck = ankiInfo ? ankiInfo.subdeck : '';

				new SubdeckModal(this.app, this.settings.mainDeck, initialSubdeck, async (newSubdeck) => {
					// ... (Hier bleibt die Logik des generate-Befehls exakt gleich wie zuvor)
				}).open();
			}
		});
	}

	onunload() { }
	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}
