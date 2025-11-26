import { App, Editor, MarkdownView, Notice, Plugin, requestUrl } from 'obsidian';
import { AnkiGeneratorSettingTab, DEFAULT_SETTINGS, AnkiGeneratorSettings } from './settings';
import { processAnkiCardsBlock } from './ankiBlockProcessor';
import { triggerCardGeneration } from './generationManager';
import { parseAnkiSection as parseAnkiSectionType } from './anki/ankiParser'; // Nur für Typdeklaration
import { SyncReviewModal } from './ui/SyncReviewModal';
import { QuestionSearchModal } from './ui/QuestionSearchModal';
import { Card, ChatMessage } from './types';
import { t } from './lang/helpers';
import { AnkiFileDecorationProvider } from './ui/AnkiFileDecorationProvider';
import { LegacyFileDecorator } from './ui/LegacyFileDecorator';

export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;
	feedbackCache: Map<string, ChatMessage[]> = new Map(); // Stores feedback history by file path
	legacyFileDecorator: LegacyFileDecorator | null = null;
	ankiFileDecorationProvider: AnkiFileDecorationProvider | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

		// Initialize File Decorations
		if ((this as any).registerFileDecorationProvider) {
			this.ankiFileDecorationProvider = new AnkiFileDecorationProvider(this.app, this);
			(this as any).registerFileDecorationProvider(this.ankiFileDecorationProvider);
		} else {
			// Legacy handling initialized based on settings
			this.updateLegacyFileDecoration();
		}

		// Check for updates
		this.checkForUpdates();

		// Ribbon Icon - Generate Cards
		this.addRibbonIcon('brain-circuit', t('anki.generateGemini'), (evt: MouseEvent) => {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView) {
				triggerCardGeneration(this, activeView.editor);
			} else {
				new Notice(t('notice.noActiveEditor'));
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

		this.addCommand({
			id: 'toggle-file-decorations',
			name: 'Toggle Anki File Decorations',
			callback: async () => {
				this.settings.fileDecorations = !this.settings.fileDecorations;
				await this.saveSettings();

				// Update decorations
				if (this.ankiFileDecorationProvider) {
					this.ankiFileDecorationProvider.triggerUpdate();
				} else {
					this.updateLegacyFileDecoration();
				}

				new Notice(`Anki File Decorations ${this.settings.fileDecorations ? 'enabled' : 'disabled'}`);
			}
		});

		this.addCommand({
			id: 'reload-plugin',
			name: 'Reload Plugin',
			callback: async () => {
				// @ts-ignore
				await this.app.plugins.disablePlugin(this.manifest.id);
				// @ts-ignore
				await this.app.plugins.enablePlugin(this.manifest.id);
				new Notice('Anki Generator Plugin reloaded');
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
				new Notice(t('notice.noActiveEditor'));
			}
		});
	}

	updateLegacyFileDecoration() {
		if (this.settings.fileDecorations) {
			if (!this.legacyFileDecorator) {
				console.log("AnkiGenerator: Enabling legacy file decorator.");
				this.legacyFileDecorator = new LegacyFileDecorator(this.app);
				this.legacyFileDecorator.load();
			}
		} else {
			if (this.legacyFileDecorator) {
				console.log("AnkiGenerator: Disabling legacy file decorator.");
				this.legacyFileDecorator.destroy();
				this.legacyFileDecorator = null;
			}
		}
	}

	onunload() {
		if (this.legacyFileDecorator) {
			this.legacyFileDecorator.destroy();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async checkForUpdates() {
		try {
			const manifest = this.manifest;
			const currentVersion = manifest.version;
			// Replace with your actual GitHub repository details
			const githubRepo = "T1Il/anki-generator";
			const url = `https://api.github.com/repos/${githubRepo}/releases/latest`;

			const response = await requestUrl({ url: url });
			if (response.status === 200) {
				const latestVersion = response.json.tag_name;
				if (latestVersion && latestVersion !== currentVersion && latestVersion > currentVersion) {
					new Notice(t('notice.updateAvailable', { version: latestVersion }), 10000);
				}
			}
		} catch (e) {
			console.log("Update check failed:", e);
		}
	}
}
