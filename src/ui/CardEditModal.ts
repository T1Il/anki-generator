import { App, Modal, Setting, TextAreaComponent, TFile } from 'obsidian';
import { Card } from '../types';

export class CardEditModal extends Modal {
    card: Partial<Card>;
    onSubmit: (result: Card, shouldSync?: boolean) => void;

    sourcePath: string;

    constructor(app: App, card: Partial<Card>, sourcePath: string, onSubmit: (result: Card, shouldSync?: boolean) => void) {
        super(app);
        this.card = card;
        this.sourcePath = sourcePath;
        this.onSubmit = onSubmit;
        this.modalEl.addClass('anki-card-edit-modal');
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.card.q ? "Karte bearbeiten" : "Neue Karte erstellen" });

        // Add styles here or in CSS. Inline for now as per request pattern.
        // Layout: Stacked. Labels small, TextAreas big.
        const style = contentEl.createEl('style');
        style.textContent = `
			.anki-card-edit-modal .modal-content {
				display: flex;
				flex-direction: column;
				gap: 15px;
				width: 100%;
			}
			.anki-edit-field {
				display: flex;
				flex-direction: column;
				gap: 5px;
			}
			.anki-edit-label {
				font-weight: 600;
				color: var(--text-muted);
				font-size: 0.9em;
			}
			.anki-edit-textarea {
				width: 100%;
				min-height: 150px; /* Much taller */
				resize: vertical;
				font-family: var(--font-monospace);
				font-size: 14px;
			}
			.anki-suggestion-container {
				position: absolute;
				background: var(--background-primary);
				border: 1px solid var(--background-modifier-border);
				box-shadow: 0 4px 12px rgba(0,0,0,0.2);
				border-radius: 4px;
				z-index: 1000;
				max-height: 200px;
				overflow-y: auto;
				width: 300px;
				display: none;
			}
			.anki-suggestion-item {
				padding: 6px 10px;
				cursor: pointer;
				font-size: 0.9em;
                display: flex;
                justify-content: space-between;
			}
			.anki-suggestion-item:hover, .anki-suggestion-item.is-selected {
				background-color: var(--background-modifier-hover);
			}
            .anki-suggestion-type {
                font-size: 0.8em;
                color: var(--text-muted);
            }
		`;

        let question = this.card.q || '';
        let answer = this.card.a || '';

        // --- Question Field ---
        const qContainer = contentEl.createDiv({ cls: 'anki-edit-field' });
        qContainer.createDiv({ cls: 'anki-edit-label', text: 'Frage / Lückentext' });
        const qText = new TextAreaComponent(qContainer);
        qText.inputEl.addClass('anki-edit-textarea');
        qText.setValue(question);
        qText.onChange(val => question = val);
        this.setupAutocomplete(qText.inputEl);

        // --- Answer Field ---
        const aContainer = contentEl.createDiv({ cls: 'anki-edit-field' });
        aContainer.createDiv({ cls: 'anki-edit-label', text: 'Antwort' });
        const aText = new TextAreaComponent(aContainer);
        aText.inputEl.addClass('anki-edit-textarea');
        aText.setValue(answer);
        aText.onChange(val => answer = val);
        this.setupAutocomplete(aText.inputEl);

        // --- Buttons ---
        const btnContainer = new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText("Speichern")
                .setCta()
                .onClick(() => {
                    const type = question.includes('{{c') || question.includes('____') ? 'Cloze' : 'Basic';
                    this.onSubmit({ q: question, a: answer, id: this.card.id || null, type: this.card.type || type }, false);
                    this.close();
                }));

        // Add Sync Button (Icon only or Text?)
        btnContainer.addButton(btn => btn
            .setIcon("refresh-cw")
            .setTooltip("Speichern & Synchronisieren")
            .onClick(() => {
                const type = question.includes('{{c') || question.includes('____') ? 'Cloze' : 'Basic';
                this.onSubmit({ q: question, a: answer, id: this.card.id || null, type: this.card.type || type }, true);
                this.close();
            }));
    }

    // Simple Autocomplete Implementation
    private cleanupFns: (() => void)[] = [];

    setupAutocomplete(textarea: HTMLTextAreaElement) {
        // ... (Logic)
        // Since we can't use registerDomEvent if it's not on Modal type (it should be on Scope or Component?), 
        // we use native listeners and cleanup manually.

        const suggestionBox = document.createElement('div');
        suggestionBox.addClass('anki-suggestion-container');
        document.body.appendChild(suggestionBox);

        const cleanup = () => {
            suggestionBox.style.display = 'none';
        };

        const blurHandler = () => setTimeout(cleanup, 200);
        textarea.addEventListener('blur', blurHandler);
        this.cleanupFns.push(() => textarea.removeEventListener('blur', blurHandler));

        const inputHandler = (e: Event) => {
            const val = textarea.value;
            const cursor = textarea.selectionStart;
            // Scan backwards for [[
            const textBefore = val.substring(0, cursor);
            const triggerIdx = textBefore.lastIndexOf('[[');

            if (triggerIdx !== -1 && cursor - triggerIdx < 60) { // Increased limit for longer paths 
                const queryRaw = textBefore.substring(triggerIdx + 2);
                if (queryRaw.includes(']]')) { cleanup(); return; }

                // Determine context: File, Header (#), or Block (^)
                let searchTerm = queryRaw;
                let targetFile: TFile | null = null;
                let mode: 'file' | 'heading' | 'block' = 'file';

                // Check for separator in query
                const hashIdx = queryRaw.lastIndexOf('#');
                const caretIdx = queryRaw.lastIndexOf('^');
                const pipeIdx = queryRaw.lastIndexOf('|'); // Alias separator - stop suggestions if pass pipe?

                if (pipeIdx !== -1) { cleanup(); return; } // Don't suggest aliases

                if (hashIdx !== -1) {
                    mode = 'heading';
                    const fileNameObj = queryRaw.substring(0, hashIdx);
                    // If empty filename, use current file
                    targetFile = fileNameObj ? this.app.metadataCache.getFirstLinkpathDest(fileNameObj, this.sourcePath)
                        : this.app.vault.getAbstractFileByPath(this.sourcePath) as TFile;
                    searchTerm = queryRaw.substring(hashIdx + 1).toLowerCase();
                } else if (caretIdx !== -1) {
                    mode = 'block';
                    const fileNameObj = queryRaw.substring(0, caretIdx);
                    targetFile = fileNameObj ? this.app.metadataCache.getFirstLinkpathDest(fileNameObj, this.sourcePath)
                        : this.app.vault.getAbstractFileByPath(this.sourcePath) as TFile;
                    searchTerm = queryRaw.substring(caretIdx + 1).toLowerCase();
                } else {
                    searchTerm = queryRaw.toLowerCase();
                    mode = 'file';
                }

                suggestionBox.empty();
                let matches: { text: string, type: string, insert: string }[] = [];

                if (mode === 'file') {
                    const files = this.app.vault.getFiles();
                    matches = files.filter(f => f.basename.toLowerCase().includes(searchTerm))
                        .slice(0, 10)
                        .map(f => ({ text: f.basename, type: 'File', insert: f.basename }));
                } else if (targetFile && targetFile instanceof TFile) {
                    const cache = this.app.metadataCache.getFileCache(targetFile);
                    if (cache) {
                        if (mode === 'heading' && cache.headings) {
                            matches = cache.headings
                                .filter(h => h.heading.toLowerCase().includes(searchTerm))
                                .map(h => ({ text: h.heading, type: 'H' + h.level, insert: targetFile!.basename + '#' + h.heading }));
                            // If local file, maybe just '#' + heading? Obsidian usually puts full link [[File#Heading]].
                        } else if (mode === 'block' && cache.blocks) {
                            matches = Object.entries(cache.blocks)
                                .filter(([id, block]) => id.toLowerCase().includes(searchTerm))
                                .map(([id, block]) => ({ text: id, type: 'Block', insert: targetFile!.basename + '^' + id }));
                        }
                    }
                }

                if (matches.length > 0) {
                    matches.forEach(m => {
                        const item = suggestionBox.createDiv({ cls: 'anki-suggestion-item' });
                        item.createSpan({ text: m.text });
                        item.createSpan({ cls: 'anki-suggestion-type', text: m.type });

                        item.onclick = () => {
                            const before = val.substring(0, triggerIdx);
                            const after = val.substring(cursor);
                            // If mode is local (starts with # or ^), we might want short link? 
                            // Standardize on full link [[File#Heading]] for stability? Logic above puts full basename.
                            // But if user typed `[[#` (implied local), we should probably insert `[[#Heading]]`.
                            // Let's refine insert logic based on user input.

                            let linkText = `[[${m.insert}]]`;

                            // Check if user started with pure # or ^ (local link)
                            if ((mode === 'heading' || mode === 'block') && (queryRaw.startsWith('#') || queryRaw.startsWith('^'))) {
                                // Strip filename from insert if it matches current file? 
                                // Actually m.insert includes specific syntax.
                                // If m.insert is "File#Heading" and user typed "[[#Head", 
                                // we want "[[#Heading]]".
                                if (targetFile && targetFile.path === this.sourcePath && m.insert.startsWith(targetFile.basename)) {
                                    // Remove basename
                                    linkText = `[[${m.insert.substring(targetFile.basename.length)}]]`;
                                }
                            }

                            textarea.value = before + linkText + after;
                            textarea.focus();
                            textarea.selectionStart = textarea.selectionEnd = triggerIdx + linkText.length;

                            textarea.dispatchEvent(new Event('input'));
                            textarea.dispatchEvent(new Event('change'));

                            cleanup();
                        };
                    });

                    const rect = textarea.getBoundingClientRect();
                    suggestionBox.style.top = `${rect.bottom + window.scrollY}px`;
                    suggestionBox.style.left = `${rect.left + window.scrollX}px`;
                    suggestionBox.style.width = `${rect.width}px`;
                    suggestionBox.style.display = 'block';
                } else {
                    cleanup();
                }
            } else {
                cleanup();
            }
        };

        textarea.addEventListener('input', inputHandler);
        this.cleanupFns.push(() => textarea.removeEventListener('input', inputHandler));

        this.cleanupFns.push(() => suggestionBox.remove());
    }

    onClose() {
        this.contentEl.empty();
        this.cleanupFns.forEach(fn => fn());
        this.cleanupFns = [];
        document.querySelectorAll('.anki-suggestion-container').forEach(el => el.remove());
    }
}
