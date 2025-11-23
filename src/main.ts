import { App, Editor, MarkdownView, Notice, Plugin, requestUrl } from 'obsidian';
import { AnkiGeneratorSettingTab, DEFAULT_SETTINGS, AnkiGeneratorSettings } from './settings';
import { processAnkiCardsBlock } from './ankiBlockProcessor';
import { triggerCardGeneration } from './generationManager';
import { parseAnkiSection as parseAnkiSectionType } from './anki/ankiParser'; // Nur für Typdeklaration
import { SyncReviewModal } from './ui/SyncReviewModal';
import { QuestionSearchModal } from './ui/QuestionSearchModal';
import { t } from './lang/helpers';

export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;
	feedbackCache: Map<string, string> = new Map(); // Stores feedback by file path to persist across re-renders

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

		// Check for updates
		this.checkForUpdates();

		// Ribbon Icon - Generate Cards
		this.addRibbonIcon('brain-circuit', t('anki.generateGemini'), (evt: MouseEvent) => { // Using generic generate label or specific? Let's use generic "Generate Cards" if available or just one of them. 
			// Actually, the ribbon icon is general. Let's use a new key or just hardcode "Anki-Karten generieren" if not in lang file?
			// "Anki-Karten generieren" is not in lang file yet as a generic term. 
			// Let's use "anki.generateGemini" as a placeholder or add a generic one?
			// The user wants German default.
			// Let's add "ribbon.generate" to lang file later. For now, I'll use a hardcoded string or existing key.
			// "settings.title" is "Anki Generator Einstellungen".
			// Let's just use the hardcoded string for now if I don't want to edit lang file yet, OR update lang file.
			// I'll stick to hardcoded for now and update lang file in next step to be clean.
			// Wait, I should use t() if I can.
			// I'll use 'Anki-Karten generieren' for now and update lang file in a separate step to be comprehensive.
			// Actually, I can just add it to the lang file in the next step.
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

	onunload() {
		// Cleanup logic, if needed in the future
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
