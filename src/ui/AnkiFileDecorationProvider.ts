import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
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
    private filesWithAnki = new Map<string, { synced: number, unsynced: number }>();

    constructor(app: App, plugin: AnkiGeneratorPlugin) {
        this.app = app;
        this.plugin = plugin;
        this.load();
    }

    provideFileDecoration(file: TAbstractFile): FileDecoration | null {
        if (!this.plugin.settings.fileDecorations) return null;

        // Check for Explicit Ignore (Files AND Folders)
        if (this.plugin.settings.ignoredFiles && this.plugin.settings.ignoredFiles.includes(file.path)) {
            return {
                badge: this.plugin.settings.iconIgnored,
                tooltip: "Wird für Anki-Sync ignoriert",
                color: "#7f8c8d" // Grey
            };
        }

        // Handle Folders
        if (file instanceof TFolder) {
            // console.log("Checking folder:", file.path);
            if (!this.plugin.settings.folderDecorations) {
                 // console.log("Folder decorations disabled in settings");
                 return null;
            }
            if (!this.plugin.settings.folderDecorations) return null;
            
            // Strict Logic: All files must have Anki cards and be synced. 
            // Exception: File name matches folder name.
            
            // Helper function for recursive strict check
            const checkFolderRecursive = (folder: TFolder): { 
                hasUnsynced: boolean; 
                filesWithCards: number; 
                totalMdFiles: number; 
                ignoredCount: number;
            } => {
                let anyUnsynced = false;
                let ankiFileCount = 0;
                let mdFileCount = 0;
                let ignoredCount = 0;

                for (const child of folder.children) {
                    if (child instanceof TFolder) {
                        if (child.name === 'space' || child.name === '.space') continue; 
                        
                        // Check if folder is ignored
                        if (this.plugin.settings.ignoredFiles && this.plugin.settings.ignoredFiles.includes(child.path)) {
                            ignoredCount++;
                            continue;
                        }

                        const result = checkFolderRecursive(child);
                        if (result.hasUnsynced) anyUnsynced = true;
                        ankiFileCount += result.filesWithCards;
                        mdFileCount += result.totalMdFiles;
                        ignoredCount += result.ignoredCount;

                    } else if (child instanceof TFile && child.extension === 'md') {
                        // Check for explicit ignore setting
                        if (this.plugin.settings.ignoredFiles && this.plugin.settings.ignoredFiles.includes(child.path)) {
                            ignoredCount++;
                            continue;
                        }

                        mdFileCount++;
                        
                        const stats = this.filesWithAnki.get(child.path);
                        if (folder.name === 'Anatomie' || folder.name === 'Pathophysiologie') {
                             console.log(`[AnkiDebug] Check File: ${child.name} | Path: ${child.path} | Stats found: ${stats ? JSON.stringify(stats) : 'NULL'}`);
                        }

                        if (stats) {
                             if (stats.unsynced > 0) {
                                 anyUnsynced = true;
                             }
                             // ONLY count as "Anki File" if it actually has cards (synced or unsynced).
                             // Empty blocks (0/0) should be treated as "Normal Files" (ignored).
                             if (stats.synced > 0 || stats.unsynced > 0) {
                                 ankiFileCount++;
                             }
                        }
                    }
                }
                
                if (folder.name === 'Pathophysiologie') {
                     // console.log(`[AnkiDebug] Pathophysiologie: MD=${mdFileCount}, Anki=${ankiFileCount}`);
                }

                return { hasUnsynced: anyUnsynced, filesWithCards: ankiFileCount, totalMdFiles: mdFileCount, ignoredCount };
            };
            

            const { hasUnsynced, filesWithCards, totalMdFiles, ignoredCount } = checkFolderRecursive(file);

            if (hasUnsynced) {
                return {
                     badge: this.plugin.settings.iconUnsynced,
                     tooltip: `Nicht synchronisierte Karten in diesem Ordner`,
                     color: "#ff5555" // Red
                };
            }

            // Green ONLY if EVERY md file has cards (and thus is synced, since hasUnsynced is false)
            if (totalMdFiles > 0 && filesWithCards === totalMdFiles) {
                  return {
                    badge: this.plugin.settings.iconSynced,
                    tooltip: `Alles synchronisiert (${filesWithCards}/${totalMdFiles} relevante Dateien)`,
                    color: "#50fa7b" // Green
                 };
            } else if (totalMdFiles === 0 && ignoredCount > 0) {
                 // All files are ignored
                  return {
                    badge: this.plugin.settings.iconSynced,
                    tooltip: `Bereit (Alle Dateien werden ignoriert)`,
                    color: "#50fa7b" // Green
                 };
            }
            
            // Debugging Fallback: If we have ANY Anki files but not all match:
            if (filesWithCards > 0 && filesWithCards < totalMdFiles) {
                 return {
                    badge: "?", 
                    tooltip: `DEBUG: Anki-Dateien=${filesWithCards} / Gesamt=${totalMdFiles}`,
                    color: "#aaaaaa"
                 };
            } else if (file.name === 'Anatomie') {
                 // Debug if it falls through (Case A: 0 files detected)
                 return {
                    badge: "0", 
                    tooltip: `DEBUG: Anki=${filesWithCards} | MD=${totalMdFiles} (Keine Anki-Files erkannt)`,
                    color: "#ff00ff"
                 };
            }
        }

        // Handle Files
        if (!(file instanceof TFile)) return null;
        if (file.extension !== 'md') return null;

        const data = this.filesWithAnki.get(file.path);
        if (!data) return null;

        const { synced, unsynced } = data;
        const total = synced + unsynced;
        
        let badge = "";
        let color = "";
        let tooltip = "";

        if (total === 0) {
            // Block exists but no cards found (or empty)
            badge = this.plugin.settings.iconEmpty; 
            tooltip = "Anki-Block vorhanden (leer)";
            color = "#f1c40f"; // Yellow
        } else if (unsynced > 0) {
            // Need sync
            badge = this.plugin.settings.iconUnsynced;
            tooltip = `${unsynced} nicht synchronisierte Anki-Karte(n)`;
            color = "#ff5555"; // Red
        } else {
            // All synced
            badge = this.plugin.settings.iconSynced;
            tooltip = `${synced} Anki-Karten (alle synchronisiert)`;
            color = "#50fa7b"; // Green
        }

        // Apply template
        if (this.plugin.settings.decorationTemplate) {
            const text = this.plugin.settings.decorationTemplate
                .replace('{count}', String(total))
                .replace('{synced}', String(synced))
                .replace('{unsynced}', String(unsynced));
            badge += text;
        }

        return {
            badge,
            tooltip,
            color
        };
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

        // Also listen for deletes/renames to keep Map clean
        this.app.vault.on('delete', (file) => {
            if (file instanceof TFile) this.filesWithAnki.delete(file.path);
        });
        this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile) {
                if (this.filesWithAnki.has(oldPath)) {
                    const data = this.filesWithAnki.get(oldPath);
                    this.filesWithAnki.delete(oldPath);
                    if (data) this.filesWithAnki.set(file.path, data);
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
            // Quick check if file has any Anki block to avoid parsing everything
            if (!content.includes('```anki-cards')) {
                this.filesWithAnki.delete(file.path);
                return;
            }

            // Parse blocks
            // Robust regex handling Windows \r\n and varying whitespace
            const blockMatches = content.matchAll(/^```anki-cards[ \t]*\r?\n([\s\S]*?)\r?\n^```$/gm);
            
            let syncedCount = 0;
            let unsyncedCount = 0;
            let foundBlock = false;
            
            for (const match of blockMatches) {
                foundBlock = true;
                const blockContent = match[1];
                const lines = blockContent.split('\n');
                
                // Naive counting of Q: and ID:
                // This is faster than full parsing and sufficient for decoration
                // A card is roughly defined by Q: (or {{c1::...)
                // A synced card has an ID: line.
                // NOTE: This logic needs to be reasonably accurate.
                
                // Better approach: Count potential cards, count IDs.
                // BUT: One block can have multiple cards. The relationship is 1 ID per Card.
                // So: Count "Cards" and "IDs". Unsynced = Cards - IDs.
                
                let cardCount = 0;
                let idCount = 0;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('Q:')) {
                        cardCount++;
                    } else if (!line.startsWith('Q:') && (line.includes('{{c') || line.includes('____')) && !line.startsWith('A:') && !line.startsWith('ID:')) {
                        // Likely a cloze card start if it's not an Answer or ID line
                        // (Simple heuristic)
                        cardCount++;
                    }
                    
                    if (line.startsWith('ID:')) {
                        idCount++;
                    }
                }
                
                syncedCount += idCount;
                unsyncedCount += Math.max(0, cardCount - idCount);
            }

            if (foundBlock) {
                this.filesWithAnki.set(file.path, { synced: syncedCount, unsynced: unsyncedCount });
            } else {
                this.filesWithAnki.delete(file.path);
            }

        } catch (e) {
            console.error("Error checking file for Anki cards:", e);
        }
    }
}
