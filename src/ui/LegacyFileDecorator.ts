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
                let inQBlock = false;

                // Improved Note Counting matching ankiParser logic
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    
                    if (!line) {
                        inQBlock = false;
                        continue;
                    }

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
                    if (line.startsWith('Q:')) {
                        noteCount++;
                        inQBlock = true;
                        continue;
                    }

                    // Legacy Cloze: contains {{c or ____, but ONLY count if NOT inside a Q-block
                    // This prevents double counting clozes that are part of a Q-card answer list
                    const isLeacyCloze = !inQBlock && (line.includes('{{c') || line.includes('____'));

                    if (isLeacyCloze) {
                        noteCount++;
                        inQBlock = true; // Assume we are now in a block for this cloze
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

        // Determine if it is a folder
        const abstractFile = this.app.vault.getAbstractFileByPath(path);
        
        // CHECK FOR IGNORE FIRST
        if (abstractFile instanceof TFile && abstractFile.extension === 'md') {
             if (this.plugin.settings.ignoredFiles && this.plugin.settings.ignoredFiles.includes(path)) {
                 data = { synced: -1, unsynced: -1 }; // Special marker for ignored
             }
        }

        if (abstractFile instanceof TFolder) {
            isFolder = true;
            // STRICT FOLDER CHECK LOGIC
            if (this.plugin.settings.folderDecorations) {
                const folderResult = this.checkFolderRecursive(abstractFile);
                if (!folderResult.hasUnsynced && folderResult.totalMdFiles > 0 && folderResult.filesWithCards === folderResult.totalMdFiles) {
                     // All relevant files are synced
                     data = { synced: folderResult.filesWithCards, unsynced: 0 };
                } else if (!folderResult.hasUnsynced && folderResult.totalMdFiles === 0 && folderResult.ignoredCount > 0) {
                     // All files are ignored (or smart-ignored) -> Treat as synced (Green)
                     data = { synced: 0, unsynced: 0 }; 
                } else if (folderResult.hasUnsynced) {
                     // At least one unsynced
                     data = { synced: 0, unsynced: 1 }; // Fake unsynced count to trigger red
                } else {
                     // Not all synced, but no explicitly unsynced files -> Treat as "Empty/Incomplete" -> No decoration (null)
                     data = null;
                }
            }
        } else if (!data) { // Only check map if not already marked as ignored
            // File logic
            if (this.filesWithAnki.has(path)) {
                data = this.filesWithAnki.get(path)!;
            }
        }
        
        // Remove existing decoration if we aborted
        let decoration = targetContainer.querySelector('.anki-legacy-decoration');

        if (!data) {
            if (decoration) decoration.remove();
            return;
        }

        // 3. Render
        if (data) {
             const { synced, unsynced } = data;
             const total = synced + unsynced;
             let text = '';
             let title = '';
             let color = '';
             let icon = '';

             if (total === 0 && !isFolder) { // Only yellow for files
                 // Empty Logic (Yellow)
                 icon = this.plugin.settings.iconEmpty;
                 title = 'Anki-Block vorhanden (leer)';
                 color = '#f1c40f'; 
             } else if (synced === -1 && unsynced === -1) {
                 // Ignored Logic
                 icon = this.plugin.settings.iconIgnored;
                 title = 'Datei wird für Anki-Sync ignoriert';
                 color = '#7f8c8d'; // Grey
             } else if (unsynced > 0) {
                 // Unsynced Logic (Red)
                 icon = this.plugin.settings.iconUnsynced;
                 title = isFolder ? `${unsynced} nicht synchronisierte Dateien` : `${unsynced} nicht synchronisierte Änderungen`;
                 color = '#e74c3c'; 
             } else {
                 // Synced Logic (Green)
                 icon = this.plugin.settings.iconSynced;
                 title = isFolder ? `Alles synchronisiert (${synced} Dateien)` : 'Synchronisiert';
                 color = '#2ecc71'; 
             }

             text = icon;
              
             // Only show count if NOT ignored (total >= 0) and not a folder (unless folders also need it, but generally files)
             if (!isFolder && total >= 0 && this.plugin.settings.decorationTemplate) {
                  const label = this.plugin.settings.decorationTemplate
                     .replace('{count}', String(total))
                     .replace('{synced}', String(synced))
                     .replace('{unsynced}', String(unsynced));
                  text += label;
             }

             this.renderDecoration(decoration as HTMLElement, targetContainer, text, color, title);
        }
    }

    checkFolderRecursive(folder: TFolder): { hasUnsynced: boolean; filesWithCards: number; totalMdFiles: number; ignoredCount: number } {
        let anyUnsynced = false;
        let ankiFileCount = 0;
        let mdFileCount = 0;
        let ignoredCount = 0;

        for (const child of folder.children) {
            if (child instanceof TFolder) {
                if (child.name === 'space' || child.name === '.space') continue; 
                
                // Check if folder is ignored
                if (this.plugin.settings.ignoredFiles && this.plugin.settings.ignoredFiles.includes(child.path)) {
                    ignoredCount++; // Count ignored folder as an ignored item
                    continue;
                }

                const result = this.checkFolderRecursive(child);
                if (result.hasUnsynced) anyUnsynced = true;
                ankiFileCount += result.filesWithCards;
                mdFileCount += result.totalMdFiles;
                ignoredCount += result.ignoredCount;

            } else if (child instanceof TFile && child.extension === 'md') {
                // Check for Explicit Ignore
                if (this.plugin.settings.ignoredFiles && this.plugin.settings.ignoredFiles.includes(child.path)) {
                    ignoredCount++;
                    continue;
                }

                const hasCards = this.filesWithAnki.has(child.path);
                
                // Smart Ignore: Only ignore "Folder Name.md" if it has NO cards.
                // If it has cards, we treat it as content that must be synced.
                // Case-insensitive check to be robust.
                const isFolderNote = child.name.toLowerCase() === (folder.name + '.md').toLowerCase();
                
                if (isFolderNote && !hasCards) {
                    ignoredCount++;
                    continue;
                }

                mdFileCount++;
                if (hasCards) {
                     const stats = this.filesWithAnki.get(child.path);
                     if (stats) {
                         if (stats.unsynced > 0) anyUnsynced = true;
                         // Count as "Anki File" if it has any Anki activity
                         if (stats.synced > 0 || stats.unsynced > 0) ankiFileCount++;
                     }
                }
            }
        }
        return { hasUnsynced: anyUnsynced, filesWithCards: ankiFileCount, totalMdFiles: mdFileCount, ignoredCount };
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



