import { App, TFile, WorkspaceLeaf, debounce, EventRef } from 'obsidian';

export class LegacyFileDecorator {
    app: App;
    filesWithAnki = new Set<string>();
    observers: Map<string, MutationObserver> = new Map();
    debouncedUpdateAll: () => void;
    private eventRefs: EventRef[] = [];

    constructor(app: App) {
        this.app = app;
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
                if (hadAnki !== hasAnki) {
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
                        this.filesWithAnki.delete(oldPath);
                        this.filesWithAnki.add(file.path);
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
            if (content.match(/^```anki-cards/m)) {
                this.filesWithAnki.add(file.path);
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
        const allLeaves = [...leaves, ...makeMdLeaves];

        // Cleanup old observers for closed leaves
        const currentLeafIds = new Set(allLeaves.map(l => (l as any).id));
        for (const [id, observer] of this.observers) {
            if (!currentLeafIds.has(id)) {
                observer.disconnect();
                this.observers.delete(id);
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

        // If no data-path on element, try to find it in parent or specific classes
        if (!path) {
            // Sometimes the data-path is on a parent or child depending on the view
            const parentWithPath = element.closest('[data-path]');
            if (parentWithPath) {
                path = parentWithPath.getAttribute('data-path');
            }
        }

        if (path && this.filesWithAnki.has(path)) {
            // We found an element corresponding to an Anki file. Decorate it.
            // We need to find the specific element to attach the icon to.
            // If 'element' is the container, we might need to look inside.

            // For standard Obsidian: .nav-file-title[data-path="..."]
            // For MAKE.MD: .mk-file-item[data-path="..."]

            // If the element ITSELF matches the path, decorate it
            if (element.getAttribute('data-path') === path) {
                this.applyDecoration(element, true);
            } else {
                // If we found the path via closest(), we should decorate that parent
                const parent = element.closest(`[data-path="${CSS.escape(path)}"]`);
                if (parent instanceof HTMLElement) {
                    this.applyDecoration(parent, true);
                }
            }
        }
    }

    updateAllDecorations() {
        // This is a fallback/initial pass. 
        // We iterate visible leaves and try to find elements for our known files.
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        const makeMdLeaves = this.app.workspace.getLeavesOfType('mk-path-view');
        const allLeaves = [...leaves, ...makeMdLeaves];

        for (const leaf of allLeaves) {
            const view = leaf.view as any;
            if (!view.containerEl) continue;

            this.filesWithAnki.forEach(path => {
                try {
                    const escapedPath = CSS.escape(path);
                    const selector = `[data-path="${escapedPath}"]`;
                    const elements = view.containerEl.querySelectorAll(selector);
                    elements.forEach((el: HTMLElement) => this.applyDecoration(el, true));
                } catch (e) {
                    // Ignore
                }
            });
        }
    }

    updateFileDecoration(file: TFile) {
        // Just trigger a targeted update for this file across all views
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        const makeMdLeaves = this.app.workspace.getLeavesOfType('mk-path-view');
        const allLeaves = [...leaves, ...makeMdLeaves];

        for (const leaf of allLeaves) {
            const view = leaf.view as any;
            if (!view.containerEl) continue;

            try {
                const escapedPath = CSS.escape(file.path);
                const selector = `[data-path="${escapedPath}"]`;
                const elements = view.containerEl.querySelectorAll(selector);
                const hasAnki = this.filesWithAnki.has(file.path);
                elements.forEach((el: HTMLElement) => this.applyDecoration(el, hasAnki));
            } catch (e) {
                // Ignore
            }
        }
    }

    applyDecoration(element: HTMLElement, hasAnki: boolean) {
        if (!element) return;

        // Prevent duplicate search if we are already inside a recursion or something, 
        // but here we just want to find the target.

        // We need to find where to put the icon. 
        // Standard Obsidian: .nav-file-title-content
        // MAKE.MD: .mk-file-name or direct append?

        let targetContainer: HTMLElement | null = null;

        // 1. Standard Obsidian
        if (element.classList.contains('nav-file-title')) {
            targetContainer = element.querySelector('.nav-file-title-content');
        }
        // 2. MAKE.MD (often has .mk-file-item class on the container)
        else if (element.classList.contains('mk-file-item') || element.hasAttribute('data-path')) {
            targetContainer = element.querySelector('.mk-file-name');
            if (!targetContainer) {
                // Maybe it's a different structure in MAKE.MD, let's try to find any text container
                // or just append to the element itself if it looks right.
                // Let's try finding .nav-file-title-content again just in case
                targetContainer = element.querySelector('.nav-file-title-content');
            }
        }

        // Fallback: if we can't find a specific container, but we know this element represents the file,
        // we might append to it directly, but we must be careful not to break layout.
        if (!targetContainer) {
            // If the element itself is the title content or name
            if (element.classList.contains('nav-file-title-content') || element.classList.contains('mk-file-name')) {
                targetContainer = element;
            }
        }

        if (!targetContainer) return;

        let decoration = targetContainer.querySelector('.anki-legacy-decoration');

        if (hasAnki) {
            if (!decoration) {
                decoration = createSpan({ cls: 'anki-legacy-decoration', text: ' 🗃️' });
                decoration.setAttribute('title', 'Enthält Anki-Karten');
                decoration.setAttribute('style', 'font-size: 0.8em; opacity: 0.8; margin-left: 5px;');

                if (targetContainer === element) {
                    // If we are appending to the text container itself, just append
                    element.appendChild(decoration);
                } else {
                    targetContainer.appendChild(decoration);
                }
            }
        } else {
            if (decoration) {
                decoration.remove();
            }
        }
    }
}
