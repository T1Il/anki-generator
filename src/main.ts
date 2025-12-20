import { App, Editor, MarkdownView, Notice, Plugin, requestUrl, WorkspaceLeaf, TFile, TFolder } from 'obsidian';
import { AnkiGeneratorSettingTab, DEFAULT_SETTINGS, AnkiGeneratorSettings } from './settings';
import { processAnkiCardsBlock } from './ankiBlockProcessor';
import { triggerCardGeneration } from './generationManager';
import { parseAnkiSection as parseAnkiSectionType } from './anki/ankiParser'; // Nur für Typdeklaration
import { SyncReviewModal } from './ui/SyncReviewModal';
import { QuestionSearchModal } from './ui/QuestionSearchModal';
import { BlockIdManagerModal } from './ui/BlockIdManagerModal';
import { Card, ChatMessage } from './types';
import { t } from './lang/helpers';
import { AnkiFileDecorationProvider } from './ui/AnkiFileDecorationProvider';
import { LegacyFileDecorator } from './ui/LegacyFileDecorator';
import { ensureBlockIdsForCallouts, removeAllBlockIds } from './utils';
import { FeedbackView, FEEDBACK_VIEW_TYPE } from './ui/FeedbackView';
import { InsertCalloutLinkModal } from './ui/InsertCalloutLinkModal';
import { legacyAnkiStateField } from './ui/LegacyAnkiDecorator';

export default class AnkiGeneratorPlugin extends Plugin {
	settings: AnkiGeneratorSettings;
	feedbackCache: Map<string, ChatMessage[]> = new Map(); // Stores feedback history by file path
	activeGenerations: Map<string, AbortController> = new Map(); // Stores abort controllers for active generations
	legacyFileDecorator: LegacyFileDecorator | null = null;
	ankiFileDecorationProvider: AnkiFileDecorationProvider | null = null;

	async onload() {
		await this.loadSettings();

        // console.log("!!! ANKI PLUGIN LOADED !!!");

		// Register ViewPlugin for Legacy Auto-Hide
		this.registerEditorExtension(legacyAnkiStateField);

		// REGISTER FEEDBACK VIEW
		this.registerView(
			FEEDBACK_VIEW_TYPE,
			(leaf) => new FeedbackView(leaf, this)
		);

		// AUTO-DETECT VAULT NAME
		if (!this.settings.vaultName || this.settings.vaultName === 'My Vault') {
			const detectedName = this.app.vault.getName();
			if (detectedName) {
				console.log(`Anki Generator: Auto-detected vault name: ${detectedName}`);
				this.settings.vaultName = detectedName;
				await this.saveSettings();
			}
		}

		this.addSettingTab(new AnkiGeneratorSettingTab(this.app, this));

		// Initialize File Decorations
		if ((this as any).registerFileDecorationProvider) {
            console.log("AnkiGenerator: Registering Native File Decoration Provider..."); // TRACE
			this.ankiFileDecorationProvider = new AnkiFileDecorationProvider(this.app, this);
			(this as any).registerFileDecorationProvider(this.ankiFileDecorationProvider);
            console.log("AnkiGenerator: Provider Registered."); // TRACE

            // Force update on layout ready
            this.app.workspace.onLayoutReady(() => {
                this.ankiFileDecorationProvider?.triggerUpdate();
            });
		} else {
			// Legacy handling initialized based on settings
            this.app.workspace.onLayoutReady(() => {
                console.log("AnkiGenerator: Using LEGACY File Decorator");
			    this.updateLegacyFileDecoration();
            });
		}

		// Check for updates
		this.checkForUpdates();

        // Register File Menu Event (Context Menu)
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if ((file instanceof TFile && file.extension === 'md') || file instanceof TFolder) {
                    const isIgnored = this.settings.ignoredFiles.includes(file.path);
                    
                    menu.addItem((item) => {
                        item
                            .setTitle(isIgnored ? "Anki: Ignorieren aufheben" : "Anki: Datei/Ordner ignorieren")
                            .setIcon(isIgnored ? "check-circle" : "eye-off")
                            .onClick(async () => {
                                if (isIgnored) {
                                    this.settings.ignoredFiles = this.settings.ignoredFiles.filter(p => p !== file.path);
                                    new Notice(`Anki: ${file.name} wird nicht mehr ignoriert.`);
                                } else {
                                    if (!this.settings.ignoredFiles.includes(file.path)) {
                                        this.settings.ignoredFiles.push(file.path);
                                    }
                                    new Notice(`Anki: ${file.name} wird jetzt ignoriert.`);
                                }
                                await this.saveSettings();

                                // Trigger Decoration Update
                                if (this.ankiFileDecorationProvider) {
                                    this.ankiFileDecorationProvider.triggerUpdate();
                                } else if (this.legacyFileDecorator) {
                                    this.legacyFileDecorator.updateAllDecorations();
                                }
                            });
                    });
                }
            })
        );

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

        // Register Editor Extension (CM6)
        this.registerEditorExtension(legacyAnkiStateField);

		// Command Registrierung
 
		this.addCommand({
			id: 'force-reload-anki-data',
			name: 'Generate Anki Cards from Note',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				triggerCardGeneration(this, editor);
			}
		});

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
            id: 'force-reload-decorations',
            name: 'Force Reload Decorations',
            callback: async () => {
                console.log("Force Reload Decorations triggered.");
                if (this.ankiFileDecorationProvider) {
                    console.log("Reloading Native Provider...");
                    await this.ankiFileDecorationProvider.load();
                    this.ankiFileDecorationProvider.triggerUpdate();
                } else if (this.legacyFileDecorator) {
                    console.log("Reloading Legacy Decorator...");
                    this.legacyFileDecorator.destroy(); // Ensure old one is gone
                    this.legacyFileDecorator.load();
                } else {
                     console.log("No active decorator found. Attempting to re-init.");
                     if ((this as any).registerFileDecorationProvider) {
                        console.log("Init Native Provider");
                        this.ankiFileDecorationProvider = new AnkiFileDecorationProvider(this.app, this);
                        (this as any).registerFileDecorationProvider(this.ankiFileDecorationProvider);
                    } else {
                        console.log("Init Legacy Decorator");
                        this.updateLegacyFileDecoration();
                    }
                }
                new Notice("Decorations reloaded. Check console for details.");
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

		this.addCommand({
			id: 'manage-block-ids',
			name: 'Manage Block IDs',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new BlockIdManagerModal(this.app, editor).open();
			}
		});

		this.addCommand({
			id: 'generate-block-ids',
			name: 'Generate Callout Block IDs',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				ensureBlockIdsForCallouts(editor);
				new Notice("Block IDs generated for callouts.");
			}
		});

        this.addCommand({
            id: 'remove-all-block-ids',
            name: 'Remove All Block IDs',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                removeAllBlockIds(editor);
                new Notice("All block IDs removed.");
            }
        });

        this.addCommand({
            id: 'insert-callout-link',
            name: 'Insert Callout Link',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                new InsertCalloutLinkModal(this.app, editor).open();
            }
        });

		this.addCommand({
			id: 'cancel-anki-generation',
			name: 'Cancel Anki Generation',
			callback: () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					const controller = this.activeGenerations.get(activeFile.path);
					if (controller) {
						controller.abort();
						this.activeGenerations.delete(activeFile.path);
						new Notice(`Generation cancelled for ${activeFile.basename}`);
					} else {
						new Notice("No active generation found for this file.");
					}
				} else {
					// Optional: Cancel all? Or just warn.
					// Let's just warn for now as per "cancel one of them" (implied context-aware)
					if (this.activeGenerations.size > 0) {
						// If no file is focused but generations are running, maybe cancel the last one?
						// Or just tell user to focus the file.
						new Notice("Please open the file where generation is running to cancel it.");
					} else {
						new Notice("No active generations.");
					}
				}
			}
		});

		this.addCommand({
			id: 'toggle-dev-tools',
			name: 'Toggle Developer Tools',
			hotkeys: [
				{
					modifiers: ['Mod', 'Shift'],
					key: 'I',
				},
			],
			callback: () => {
				try {
					// @ts-ignore
					const electron = require('electron');
					// @ts-ignore
					const win = electron.remote.getCurrentWindow();
					win.toggleDevTools();
				} catch (e) {
					new Notice("Could not open DevTools: " + e.message);
					console.error("DevTools error:", e);
				}
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
				this.legacyFileDecorator = new LegacyFileDecorator(this.app, this);
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

	addActiveGeneration(filePath: string, controller: AbortController) {
		this.activeGenerations.set(filePath, controller);
	}

	removeActiveGeneration(filePath: string) {
		this.activeGenerations.delete(filePath);
	}

    // ACTIVATE VIEW HELPER
    async activateFeedbackView(history: ChatMessage[], sourcePath: string) {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(FEEDBACK_VIEW_TYPE);

        if (leaves.length > 0) {
            // Use existing leaf
            leaf = leaves[0];
        } else {
            // Open in right sidebar
            leaf = workspace.getRightLeaf(false);
            if(leaf) await leaf.setViewState({ type: FEEDBACK_VIEW_TYPE, active: true });
        }
        
        if (leaf) {
            workspace.revealLeaf(leaf);
            if (leaf.view instanceof FeedbackView) {
                leaf.view.setFeedbackContext(history, sourcePath);
            }
        }
    }
}
