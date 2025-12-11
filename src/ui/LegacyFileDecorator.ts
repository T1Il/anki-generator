import { App, TFile, WorkspaceLeaf, debounce, EventRef } from 'obsidian';
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
        // Disconnect all observers
        for (const observer of this.observers.values()) {
            observer.disconnect();
        }
        this.observers.clear();

        // Remove all decorations
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        const makeMdLeaves = this.app.workspace.getLeavesOfType('mk-path-view');
        // @ts-ignore
        const allLeaves = [...leaves, ...makeMdLeaves];

        for (const leaf of allLeaves) {
            const view = leaf.view as any;
            if (!view.containerEl) continue;
            const decorations = view.containerEl.querySelectorAll('.anki-legacy-decoration');
            decorations.forEach((el: HTMLElement) => el.remove());
        }

        // Detach event listeners
        for (const ref of this.eventRefs) {
            this.app.metadataCache.offref(ref);
            this.app.vault.offref(ref);
            this.app.workspace.offref(ref);
        }
        this.eventRefs = [];
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
                const lines = blockContent.split('\n');
                
                let cardCount = 0;
                let idCount = 0;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('Q:')) {
                        cardCount++;
                    } else if (!line.startsWith('Q:') && (line.includes('{{c') || line.includes('____')) && !line.startsWith('A:') && !line.startsWith('ID:')) {
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
        this.checkAndDecorateElement(node);

        // Also check children, as sometimes a container is added with multiple items
        const fileItems = node.querySelectorAll('.nav-file-title, .mk-file-item, [data-path]');
        fileItems.forEach(item => {
            if (item instanceof HTMLElement) {
                this.checkAndDecorateElement(item);
            }
        });
    }

    checkAndDecorateElement(element: HTMLElement) {
        // Try to find the path
        let path = element.getAttribute('data-path');

        if (!path) {
            // Sometimes the data-path is on a parent or child depending on the view
            const parentWithPath = element.closest('[data-path]');
            if (parentWithPath) {
                path = parentWithPath.getAttribute('data-path');
            }
        }

        if (path && this.filesWithAnki.has(path)) {
            // Check if we found the correct element
            if (element.getAttribute('data-path') === path) {
                this.applyDecoration(element, path);
            } else {
                const parent = element.closest(`[data-path="${CSS.escape(path)}"]`);
                if (parent instanceof HTMLElement) {
                    this.applyDecoration(parent, path);
                }
            }
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
        }
    }

    updateFileDecoration(file: TFile) {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        const makeMdLeaves = this.app.workspace.getLeavesOfType('mk-path-view');
        // @ts-ignore
        const allLeaves = [...leaves, ...makeMdLeaves];

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
    }

    applyDecoration(element: HTMLElement, path: string | null) {
        if (!element) return;

        let targetContainer: HTMLElement | null = null;

        // 1. Standard Obsidian
        if (element.classList.contains('nav-file-title')) {
            targetContainer = element.querySelector('.nav-file-title-content');
        }
        // 2. MAKE.MD
        else if (element.classList.contains('mk-file-item') || element.hasAttribute('data-path')) {
            targetContainer = element.querySelector('.mk-file-name');
            if (!targetContainer) {
                targetContainer = element.querySelector('.nav-file-title-content');
            }
        }

        if (!targetContainer) {
            if (element.classList.contains('nav-file-title-content') || element.classList.contains('mk-file-name')) {
                targetContainer = element;
            }
        }

        if (!targetContainer) return;

        let decoration = targetContainer.querySelector('.anki-legacy-decoration');
        const data = path ? this.filesWithAnki.get(path) : null;

        if (data) {
             const { synced, unsynced } = data;
             const total = synced + unsynced;
             let text = '';
             let title = '';
             let color = '';
             let icon = '';
             
             if (total === 0) {
                 icon = this.plugin.settings.iconEmpty;
                 title = 'Anki-Block vorhanden (leer)';
                 color = '#f1c40f'; // Yellow
             } else if (unsynced > 0) {
                 icon = this.plugin.settings.iconUnsynced;
                 title = `${unsynced} nicht synchronisierte Karten`;
                 color = '#ff5555'; // Red
             } else {
                 icon = this.plugin.settings.iconSynced;
                 title = `${synced} Karten (alle synchronisiert)`;
                 color = '#50fa7b'; // Green
             }
             
             text = icon;
             
             if (this.plugin.settings.decorationTemplate) {
                 const label = this.plugin.settings.decorationTemplate
                    .replace('{count}', String(total))
                    .replace('{synced}', String(synced))
                    .replace('{unsynced}', String(unsynced));
                 text += label;
             }

            if (!decoration) {
                decoration = createSpan({ cls: 'anki-legacy-decoration', text: text });
                if (targetContainer === element) {
                    element.appendChild(decoration);
                } else {
                    targetContainer.appendChild(decoration);
                }
            } else {
                decoration.setText(text);
            }
            
            decoration.setAttribute('title', title);
            decoration.setAttribute('style', `font-size: 0.8em; opacity: 1; margin-left: 5px; color: ${color};`);

        } else {
            if (decoration) {
                decoration.remove();
            }
        }
    }
}
