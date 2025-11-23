import { App, Editor, MarkdownView, Notice, Plugin } from 'obsidian';
import { AnkiGeneratorSettingTab, DEFAULT_SETTINGS, AnkiGeneratorSettings } from './settings';
import { processAnkiCardsBlock } from './ankiBlockProcessor';
import { triggerCardGeneration } from './generationManager';
import { parseAnkiSection as parseAnkiSectionType } from './anki/ankiParser'; // Nur für Typdeklaration
import { SyncReviewModal } from './ui/SyncReviewModal';
import { QuestionSearchModal } from './ui/QuestionSearchModal';

export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;
	feedbackCache: Map<string, string> = new Map(); // Stores feedback by file path to persist across re-renders

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

		// Ribbon Icon - Generate Cards
		this.addRibbonIcon('brain-circuit', 'Anki-Karten generieren', (evt: MouseEvent) => {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView) {
				triggerCardGeneration(this, activeView.editor);
			} else {
				new Notice('Bitte öffnen Sie eine Notiz, um Karten zu generieren.');
			}
		});

		// Ribbon Icon - Sync Unsynced
		this.addRibbonIcon('rotate-cw', 'Nicht synchronisierte Anki-Karten finden', (evt: MouseEvent) => {
			new SyncReviewModal(this.app, this).open();
		});

		// Markdown Code Block Processor Registrierung
		this.registerMarkdownCodeBlockProcessor('anki-cards', async (source, el, ctx) => {
			await processAnkiCardsBlock(this, source, el, ctx);
		});

		// Command Registrierung
		this.addCommand({
			id: 'generate-anki-cards',
			name: 'Generate Anki Cards from Note',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				triggerCardGeneration(this, editor);
			}
		});

		this.addCommand({
			id: 'sync-unsynced-anki-cards',
			name: 'Sync all unsynced Anki cards in Vault',
			callback: () => {
				new SyncReviewModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'search-anki-questions',
			name: 'Search notes with Anki cards',
			callback: () => {
				new QuestionSearchModal(this.app).open();
			}
		});

		// Status Bar Item
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.addClass('anki-generate-button');
		statusBarItemEl.setText('🧠 Anki-Karten generieren');
		this.registerDomEvent(statusBarItemEl, 'click', () => {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView) {
				triggerCardGeneration(this, activeView.editor);
			} else {
				new Notice('Bitte öffnen Sie eine Notiz, um Karten zu generieren.');
			}
		});
	}

	onunload() {
		// Cleanup logic, if needed in the future
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
