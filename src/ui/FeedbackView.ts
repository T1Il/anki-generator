import { ItemView, WorkspaceLeaf } from "obsidian";
import AnkiGeneratorPlugin from "../main";
import { renderFeedback } from "./FeedbackRenderer";
import { ChatMessage } from "../types";

export const FEEDBACK_VIEW_TYPE = "anki-generator-feedback-view";

export class FeedbackView extends ItemView {
    plugin: AnkiGeneratorPlugin;
    sourcePath: string | undefined;
    history: ChatMessage[];

    constructor(leaf: WorkspaceLeaf, plugin: AnkiGeneratorPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.history = [];
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
                    this.render();
                }
            }) as any)
        );
    }

    async onOpen() {
        this.render();
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
        this.render();
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

    render() {
        const container = this.contentEl;
        container.empty();
        renderFeedback(container, this.history, this.plugin, this.sourcePath);
    }
}
