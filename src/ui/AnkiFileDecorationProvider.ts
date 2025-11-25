import { App, TAbstractFile, TFile } from 'obsidian';
import AnkiGeneratorPlugin from '../main';

// Polyfill types for older obsidian-typings
export interface FileDecoration {
    badge?: string;
    color?: string;
    tooltip?: string;
}

export interface FileDecorationProvider {
    provideFileDecoration(file: TAbstractFile): FileDecoration | null;
}

export class AnkiFileDecorationProvider implements FileDecorationProvider {
    app: App;
    plugin: AnkiGeneratorPlugin;
    private filesWithAnki = new Set<string>();

    constructor(app: App, plugin: AnkiGeneratorPlugin) {
        this.app = app;
        this.plugin = plugin;
        this.load();
    }

    provideFileDecoration(file: TAbstractFile): FileDecoration | null {
        if (!this.plugin.settings.fileDecorations) return null;
        if (!(file instanceof TFile)) return null;
        if (file.extension !== 'md') return null;

        if (this.filesWithAnki.has(file.path)) {
            return {
                badge: "🗃️",
                tooltip: "Enthält Anki-Karten",
                color: "#ff5555"
            };
        }
        return null;
    }

    async load() {
        // Initial scan
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            await this.checkFile(file);
        }

        // Listen for changes
        this.app.metadataCache.on('changed', async (file) => {
            await this.checkFile(file);
            // Trigger update
            this.triggerUpdate();
        });

        // Also listen for deletes/renames to keep Set clean
        this.app.vault.on('delete', (file) => {
            if (file instanceof TFile) this.filesWithAnki.delete(file.path);
        });
        this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile) {
                if (this.filesWithAnki.has(oldPath)) {
                    this.filesWithAnki.delete(oldPath);
                    this.filesWithAnki.add(file.path);
                    this.triggerUpdate();
                }
            }
        });
    }

    triggerUpdate() {
        // Force a layout change event to refresh decorations
        this.app.workspace.trigger('layout-change');
    }

    async checkFile(file: TFile) {
        if (file.extension !== 'md') return;
        try {
            const content = await this.app.vault.read(file);
            if (content.match(/^```anki-cards/m)) {
                this.filesWithAnki.add(file.path);
            } else {
                this.filesWithAnki.delete(file.path);
            }
        } catch (e) {
            console.error("Error checking file for Anki cards:", e);
        }
    }
}
