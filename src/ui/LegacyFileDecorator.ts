import { App, TFile, WorkspaceLeaf, debounce, EventRef, TFolder } from 'obsidian';
import AnkiGeneratorPlugin from '../main';

export class LegacyFileDecorator {
    app: App;
    plugin: AnkiGeneratorPlugin;
    filesWithAnki = new Map<string, { synced: number, unsynced: number }>();
    observers: Map<string, MutationObserver> = new Map();
    debouncedUpdateAll: () => void;
    private eventRefs: EventRef[] = [];

    constructor(app: App, plugin: AnkiGeneratorPlugin) {
        this.app = app;
        this.plugin = plugin;
        this.debouncedUpdateAll = debounce(this.updateAllDecorations.bind(this), 500, true);
    }

    async load() {
        // Initial scan of all files
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            await this.checkFile(file);
        }

        // Initial decoration application
        this.updateAllDecorations();
        this.registerObservers();

        // Listen for file changes
        this.eventRefs.push(
            this.app.metadataCache.on('changed', async (file) => {
                const hadAnki = this.filesWithAnki.has(file.path);
                await this.checkFile(file);
                const hasAnki = this.filesWithAnki.has(file.path);

                // Only update if state changed
                if (hadAnki !== hasAnki || (hadAnki && hasAnki)) { 
                    this.updateFileDecoration(file);
                }
            })
        );

        // Listen for deletes/renames
        this.eventRefs.push(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) this.filesWithAnki.delete(file.path);
            })
        );
        this.eventRefs.push(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) {
                    if (this.filesWithAnki.has(oldPath)) {
                        const data = this.filesWithAnki.get(oldPath);
                        this.filesWithAnki.delete(oldPath);
                        if (data) this.filesWithAnki.set(file.path, data);
                        this.updateFileDecoration(file);
                    }
                }
            })
        );

        // Re-register observers on layout changes (e.g. opening new windows/tabs)
        this.eventRefs.push(
            this.app.workspace.on('layout-change', () => {
                this.registerObservers();
                this.debouncedUpdateAll();
            })
        );
    }

    destroy() {
        console.log("LegacyFileDecorator destroy called.");
        // Disconnect all observers
        for (const observer of this.observers.values()) {
            observer.disconnect();
        }
        this.observers.clear();

        // Remove all decorations globally to be safe
        const decorations = document.querySelectorAll('.anki-legacy-decoration');
        decorations.forEach((el) => el.remove());

        // Detach event listeners
        for (const ref of this.eventRefs) {
            if (this.app.metadataCache.offref) this.app.metadataCache.offref(ref);
            if (this.app.vault.offref) this.app.vault.offref(ref);
            if (this.app.workspace.offref) this.app.workspace.offref(ref);
        }
        this.eventRefs = [];
        console.log("LegacyFileDecorator destroyed and cleaned up.");
    }

    async checkFile(file: TFile) {
        if (file.extension !== 'md') return;
        try {
            const content = await this.app.vault.read(file);
            if (!content.includes('```anki-cards')) {
                this.filesWithAnki.delete(file.path);
                return;
            }

            // Robust regex handling Windows \r\n and varying whitespace
            const blockMatches = content.matchAll(/^```anki-cards[ \t]*\r?\n([\s\S]*?)\r?\n^```$/gm);
            
            let syncedCount = 0;
            let unsyncedCount = 0;
            let foundBlock = false;

            for (const match of blockMatches) {
                foundBlock = true;
                const blockContent = match[1];
                const lines = blockContent.replace(/\r\n/g, '\n').split('\n');
                
                let noteCount = 0;
                let idCount = 0;

                // Improved Note Counting matching ankiParser logic
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    // Skip metadata lines
                    if (line.startsWith('TARGET DECK:') || 
                        line.startsWith('INSTRUCTION:') || 
                        line.startsWith('STATUS:') || 
                        line.trim() === 'xxx') {
                        continue;
                    }

                    // Count IDs (one per note)
                    if (line.startsWith('ID:')) {
                        idCount++;
                        continue;
                    }

                    // Check for Note Start
                    const isQ = line.startsWith('Q:');
                    // Legacy Cloze: contains {{c or ____, but check it's not a Q line (rare edge case)
                    // and also not an ID line (handled above) or metadata.
                    // Also ensure we don't double count if a single line has multiple clozes (it's still 1 note).
                    // Logic: If line has clozes, it's a note start (unless it's part of previous headerless note? 
                    // ankiParser breaks on new cloze line, so treating as new note is safest).
                    const isLeacyCloze = !isQ && (line.includes('{{c') || line.includes('____'));

                    if (isQ || isLeacyCloze) {
                        noteCount++;
                    }
                }
                
                syncedCount += idCount;
                unsyncedCount += Math.max(0, noteCount - idCount);
            }

            if (foundBlock) {
                this.filesWithAnki.set(file.path, { synced: syncedCount, unsynced: unsyncedCount });
            } else {
                this.filesWithAnki.delete(file.path);
            }
        } catch (e) {
            // Ignore errors
        }
    }

    registerObservers() {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        const makeMdLeaves = this.app.workspace.getLeavesOfType('mk-path-view');
        // @ts-ignore
        const allLeaves = [...leaves, ...makeMdLeaves];

        // Cleanup old observers for closed leaves
        const currentLeafIds = new Set(allLeaves.map(l => (l as any).id));
        for (const [id, observer] of this.observers) {
            if (!currentLeafIds.has(id as string)) {
                observer.disconnect();
                this.observers.delete(id as string);
            }
        }

        for (const leaf of allLeaves) {
            const leafId = (leaf as any).id;
            if (this.observers.has(leafId)) continue;

            const view = leaf.view as any;
            const container = view.containerEl;

            if (!container) continue;

            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node instanceof HTMLElement) {
                                this.handleDomNode(node);
                            }
                        });
                    }
                }
            });

            observer.observe(container, { childList: true, subtree: true });
            this.observers.set(leafId, observer);
        }
    }

    handleDomNode(node: HTMLElement) {
        // Check if the node itself is a file item
        this.processNode(node);

        // Also check children, as sometimes a container is added with multiple items
        const fileItems = node.querySelectorAll('.nav-file-title, .mk-file-item, [data-path]');
        fileItems.forEach(item => {
            if (item instanceof HTMLElement) {
                this.processNode(item);
            }
        });
    }

    processNode(element: HTMLElement) {
        if (!element) return;

        let path = element.getAttribute('data-path');

        if (!path) {
             // Fallback for Make.MD or other themes where data-path might be on parent
             const parent = element.parentElement;
             if (parent && parent.getAttribute('data-path')) {
                 path = parent.getAttribute('data-path');
             }
        }
        
        if (path) {
            this.applyDecoration(element, path);
        }
    }

    updateAllDecorations() {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        const makeMdLeaves = this.app.workspace.getLeavesOfType('mk-path-view');
        // @ts-ignore
        const allLeaves = [...leaves, ...makeMdLeaves];

        for (const leaf of allLeaves) {
            const view = leaf.view as any;
            if (!view.containerEl) continue;

            // Update Files
            this.filesWithAnki.forEach((_, path) => {
                try {
                    const escapedPath = CSS.escape(path);
                    const selector = `[data-path="${escapedPath}"]`;
                    const elements = view.containerEl.querySelectorAll(selector);
                    elements.forEach((el: HTMLElement) => this.applyDecoration(el, path));
                } catch (e) {
                    // Ignore
                }
            });

            // Update Folders
            // Re-query all items with data-path and check them.
            const allItems = view.containerEl.querySelectorAll('[data-path]');
            allItems.forEach((el: HTMLElement) => {
                this.processNode(el);
            });
        }
    }

    updateFileDecoration(file: TFile) {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        const makeMdLeaves = this.app.workspace.getLeavesOfType('mk-path-view');
        // @ts-ignore
        const allLeaves = [...leaves, ...makeMdLeaves];

        // 1. Update the file itself
        for (const leaf of allLeaves) {
            const view = leaf.view as any;
            if (!view.containerEl) continue;

            try {
                const escapedPath = CSS.escape(file.path);
                const selector = `[data-path="${escapedPath}"]`;
                const elements = view.containerEl.querySelectorAll(selector);
                const hasAnki = this.filesWithAnki.has(file.path);
                
                if (hasAnki) {
                    elements.forEach((el: HTMLElement) => this.applyDecoration(el, file.path));
                } else {
                    // Remove decoration
                    elements.forEach((el: HTMLElement) => this.applyDecoration(el, null));
                }
            } catch (e) {
                // Ignore
            }
        }

        // 2. Update parent folders
        // We traverse up to root
        let parent = file.parent;
        while (parent) {
             for (const leaf of allLeaves) {
                const view = leaf.view as any;
                if (!view.containerEl) continue;
                try {
                    const escapedPath = CSS.escape(parent.path);
                    const selector = `[data-path="${escapedPath}"]`;
                    const elements = view.containerEl.querySelectorAll(selector);
                    elements.forEach((el: HTMLElement) => this.applyDecoration(el, parent!.path));
                } catch (e) {
                    // Ignore
                }
            }
            parent = parent.parent;
        }
    }

    applyDecoration(element: HTMLElement, path: string | null) {
        if (!element || !path) {
             // Clean up
             return;
        }

        let targetContainer: HTMLElement | null = null;

        // 0. Prioritize MAKE.MD High-Specificity Classes
        if (element.classList.contains('mk-tree-item') || element.classList.contains('mk-file-item') || element.classList.contains('mk-folder-item')) {
             targetContainer = element.querySelector('.mk-file-name') || element.querySelector('.mk-folder-name') || element.querySelector('.mk-tree-text');
        }

        // 1. Standard Obsidian (Fallback or if not Make.MD specific)
        if (!targetContainer && (element.classList.contains('nav-file-title') || element.classList.contains('nav-folder-title'))) {
            targetContainer = element.querySelector('.nav-file-title-content') || element.querySelector('.nav-folder-title-content');
        }
        
        // 2. Generic Data Path Check (Last resort for Make.MD or others)
        if (!targetContainer && element.hasAttribute('data-path')) {
             targetContainer = element.querySelector('.mk-file-name') || element.querySelector('.mk-folder-name');
        }
        
        // 3. Self-check
        if (!targetContainer) {
            if (element.classList.contains('nav-file-title-content') || element.classList.contains('mk-file-name') || element.classList.contains('nav-folder-title-content')) {
                targetContainer = element;
            }
        }

        if (!targetContainer) return;

        let data: { synced: number, unsynced: number } | null = null;
        let isFolder = false;
        
        // 1. Try to get existing file data
        if (this.filesWithAnki.has(path)) {
            data = this.filesWithAnki.get(path)!;
        } else {
            // 2. If not a known file, check if it's a folder in standard Obsidian or Make.MD
            // We verify with vault to be sure.
            const abstractFile = this.app.vault.getAbstractFileByPath(path);
            if (abstractFile instanceof TFolder) {
                 isFolder = true;
                 const folder = abstractFile;
                 
                 const checkFolderRecursive = (dir: TFolder): { complete: boolean, hasUnsynced: boolean, validFiles: number, folderUnsyncedSum: number } => {
                     let allComplete = true;
                     let anyUnsynced = false;
                     let totalFiles = 0;
                     let unsyncedSum = 0;

                     for (const child of dir.children) {
                         if (child instanceof TFolder) {
                             if (child.name === 'space' || child.name === '.space') continue; 
                             
                             const result = checkFolderRecursive(child);
                             if (!result.complete) {
                                  allComplete = false;
                             }
                             if (result.hasUnsynced) anyUnsynced = true;
                             totalFiles += result.validFiles;
                             unsyncedSum += result.folderUnsyncedSum;
                         } else if (child instanceof TFile && child.extension === 'md') {
                             // We DO NOT ignore folder notes anymore. If they have unsynced cards, the folder is unsynced.
                             // if (child.basename === dir.name) { continue; }

                             const stats = this.filesWithAnki.get(child.path);
                             if (stats) {
                                 unsyncedSum += stats.unsynced;
                                 if (stats.unsynced > 0) {
                                      anyUnsynced = true;
                                      allComplete = false;
                                 } 
                                 // If file has cards, count it. If 0/0, it's neutral.
                                 if (stats.synced > 0 || stats.unsynced > 0) {
                                      totalFiles++;
                                 }
                             }
                             // If no stats, ignore the file completely (don't break 'allComplete')
                         }
                     }
                     return { complete: allComplete, hasUnsynced: anyUnsynced, validFiles: totalFiles, folderUnsyncedSum: unsyncedSum };
                 };

                 const { complete, hasUnsynced, validFiles, folderUnsyncedSum } = checkFolderRecursive(folder);

                 // Determine Folder Status
                 if (validFiles > 0 && complete) {
                     // All valid files are synced -> Green
                     data = { synced: 1, unsynced: 0 }; 
                 } else if (hasUnsynced) {
                     // At least one unsynced -> Red
                     data = { synced: 0, unsynced: folderUnsyncedSum || 1 }; 
                 } else {
                     // Incomplete or empty -> No decoration (null)
                     data = null; 
                 }
            }
        }
        
        let decoration = targetContainer.querySelector('.anki-legacy-decoration');

        // 3. Render
        if (data) {
             const { synced, unsynced } = data;
             const total = synced + unsynced; // For folders this is fake '1' or '0' but logic holds.
             let text = '';
             let title = '';
             let color = '';
             let icon = '';

             if (total === 0) {
                 // Empty Logic (Yellow) - Mostly for files
                 icon = this.plugin.settings.iconEmpty;
                 title = 'Anki-Block vorhanden (leer)';
                 color = '#f1c40f'; 
             } else if (unsynced > 0) {
                 // Unsynced Logic (Red)
                 icon = this.plugin.settings.iconUnsynced;
                 title = isFolder ? 'Nicht synchronisierte Änderungen im Ordner' : `${unsynced} nicht synchronisierte Änderungen`;
                 color = '#e74c3c'; 
             } else {
                 // Synced Logic (Green)
                 icon = this.plugin.settings.iconSynced;
                 title = isFolder ? 'Ordner vollständig synchronisiert' : 'Synchronisiert';
                 color = '#2ecc71'; 
             }
             
             // Custom Text Template (Only for files usually, but we can support folders if we want)
             // For now, keep icon only for folders unless user wants counts.
             text = icon;
             
             if (!isFolder && this.plugin.settings.decorationTemplate) {
                 const label = this.plugin.settings.decorationTemplate
                    .replace('{count}', String(total))
                    .replace('{synced}', String(synced))
                    .replace('{unsynced}', String(unsynced));
                 text += label;
             }

             this.renderDecoration(decoration as HTMLElement, targetContainer, text, color, title);

        } else {
             if (decoration) {
                 decoration.remove();
             }
        }
    }

    renderDecoration(existingDecoration: HTMLElement | null | undefined, container: HTMLElement, text: string, color: string, title: string) {
        let decoration = existingDecoration;
        if (!decoration) {
             decoration = createSpan({ cls: 'anki-legacy-decoration', text: text });
             container.appendChild(decoration);
        } else {
             decoration.setText(text);
        }
        
        decoration.setAttribute('title', title);
        decoration.setAttribute('style', `font-size: 0.8em; opacity: 1; margin-left: 5px; color: ${color};`);
    }
}



