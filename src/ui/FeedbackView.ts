import { ItemView, WorkspaceLeaf, TFile, MarkdownView } from "obsidian";
import AnkiGeneratorPlugin from "../main";
import { renderFeedback } from "./FeedbackRenderer";
import { ChatMessage, CardPreviewState, Card } from "../types";
import { getAllCardsForFile } from "../ankiBlockProcessor";

export const FEEDBACK_VIEW_TYPE = "anki-generator-feedback-view";

export class FeedbackView extends ItemView {
    plugin: AnkiGeneratorPlugin;
    sourcePath: string | undefined;
    history: ChatMessage[];
    cardPreviewState: CardPreviewState;
    cards: Card[] = [];
    deckName: string | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: AnkiGeneratorPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.history = [];
        this.cardPreviewState = {
            searchQuery: '',
            sortOrder: 'default',
            filter: 'all',
            expandedIndices: new Set(),
            isAllExpanded: false,
            isChatOpen: true
        };
    }

    getViewType() {
        return FEEDBACK_VIEW_TYPE;
    }

    getDisplayText() {
        return "Anki AI Feedback";
    }

    getIcon() {
        return "bot";
    }

    async onload() {
        super.onload();
        // Register event listener for chat updates
        this.registerEvent(
            this.plugin.app.workspace.on('anki:chat-update' as any, ((sourcePath: string, history: ChatMessage[]) => {
                if (this.sourcePath && this.sourcePath === sourcePath) {
                    this.history = history;
                    this.render('new-message');
                }
            }) as any)
        );

        this.registerEvent(
            this.plugin.app.workspace.on('anki:feedback-updated' as any, ((sourcePath: string) => {
                if (this.sourcePath && this.sourcePath === sourcePath) {
                    const cached = this.plugin.feedbackCache.get(this.sourcePath);
                    this.history = cached || [];
                    this.render();
                }
            }) as any)
        );

        // Listen for active leaf changes
        this.registerEvent(
            this.plugin.app.workspace.on('active-leaf-change', async (leaf) => {
                if (leaf && leaf.view instanceof MarkdownView) {
                    const file = leaf.view.file;
                    if (file) {
                        this.sourcePath = file.path;
                        // Reload history from cache if available
                        const cached = this.plugin.feedbackCache.get(this.sourcePath);
                        this.history = cached || [];
                        await this.updateCards(file);
                    }
                }
            })
        );

        // Listen for file changes to update the card preview
        this.registerEvent(
            this.plugin.app.vault.on('modify', async (file) => {
                if (this.sourcePath && file.path === this.sourcePath && file instanceof TFile) {
                    await this.updateCards(file);
                }
            })
        );
    }

    async onOpen() {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file) {
            this.sourcePath = view.file.path;
            const cached = this.plugin.feedbackCache.get(this.sourcePath);
            this.history = cached || [];
            await this.updateCards(view.file);
        } else {
            this.render();
        }
    }

    async onClose() {
        // Nothing to clean up specifically
    }

    // STATE PERSISTENCE
    async setState(state: any, result: any): Promise<void> {
        if (state.sourcePath) {
            this.sourcePath = state.sourcePath;
        }
        if (state.history) {
            this.history = state.history;
            // Also restore to cache if missing (e.g. after restart)
            if (this.sourcePath && !this.plugin.feedbackCache.has(this.sourcePath)) {
                this.plugin.feedbackCache.set(this.sourcePath, this.history);
            }
        }
        await super.setState(state, result);
        this.render('preserve');
    }

    getState(): any {
        return {
            sourcePath: this.sourcePath,
            history: this.history
        };
    }

    // Method to update the view state (history + source)
    setFeedbackContext(history: ChatMessage[], sourcePath: string) {
        this.history = history;
        this.sourcePath = sourcePath;
        this.render();
    }

    render(scrollBehavior: 'preserve' | 'new-message' | 'default' = 'default') {
        const container = this.contentEl;
        container.empty();
        renderFeedback(container, this.history, this.plugin, this.sourcePath, undefined, this.cardPreviewState, this.cards, this.deckName, true, scrollBehavior);
    }

    async updateCards(file: TFile) {
        const { cards, deckName } = await getAllCardsForFile(this.plugin.app, file);
        this.cards = cards;
        this.deckName = deckName;
        this.render('preserve');
    }
}
