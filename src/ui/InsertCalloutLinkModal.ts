import { App, Editor, SuggestModal, Notice, TFile } from 'obsidian';

interface CalloutSuggestion {
    title: string;
    type: string;
    lineIndex: number;
    rawContent: string;
    originalId?: string;
}

export class InsertCalloutLinkModal extends SuggestModal<CalloutSuggestion> {
    editor: Editor; // Target editor (where link is inserted)
    sourceFile: TFile | null = null; // Source file (where callouts are read from)
    sourceContent: string = "";

    constructor(app: App, editor: Editor, sourceFile?: TFile) {
        super(app);
        this.editor = editor;
        this.sourceFile = sourceFile || null;

        const placeholder = this.sourceFile
            ? `Suche Callout in ${this.sourceFile.basename}...`
            : "Suche nach Callout...";
        this.setPlaceholder(placeholder);
    }

    async onOpen() {
        if (this.sourceFile) {
            this.sourceContent = await this.app.vault.read(this.sourceFile);
        } else {
            this.sourceContent = this.editor.getValue();
        }
        super.onOpen();
    }

    getSuggestions(query: string): CalloutSuggestion[] {
        const lines = this.sourceContent.split('\n');
        const suggestions: CalloutSuggestion[] = [];

        // Regex to match callout headers: > [!type] Title
        // Also supports > [!type|Title] or just > [!type]
        const calloutRegex = /^>\s*\[!([\w-]+)(?:\|(.*?))?\]\s*(.*)$/;

        lines.forEach((line, index) => {
            const match = line.match(calloutRegex);
            if (match) {
                const type = match[1];
                let title = match[3] || match[2] || type;
                title = title.trim();

                // Check for existing ID in the block
                // A block ID is usually at the end of the block. 
                // We need to look ahead for the end of the block and check the last line.
                // NOTE: For performance in getSuggestions, we might skip full ID check or do it lazily.
                // However, caching existing ID is helpful. Let's do a quick lookahead.

                // Simple block end finding (same as onChoose)
                let endIndex = index;
                for (let i = index + 1; i < lines.length; i++) {
                    const l = lines[i];
                    if (l.trim() === '' || (l.trim().startsWith('>') && !l.trim().startsWith('> [!'))) {
                        // Continuation of quote block
                        endIndex = i;
                    } else if (l.trim().startsWith('> [!')) {
                        break; // Next callout
                    } else {
                        // End of block logic: empty line ends it. 
                        // If it's text without >, it might be end of block too?
                        // Obsidian callouts usually require > prefix for content.
                        break;
                    }
                }

                // Check if the last line of the block has an ID
                // Wait: lines[endIndex] might not be the last line of content if we break early?
                // Let's rely on standard ID finding in onChoose for robustness, 
                // but let's see if we can catch it here if it's on the header line (rare but possible).
                // Usually ID is ^id at end of block.

                const item: CalloutSuggestion = {
                    title: title,
                    type: type,
                    lineIndex: index,
                    rawContent: line
                };

                if (item.title.toLowerCase().includes(query.toLowerCase()) ||
                    item.type.toLowerCase().includes(query.toLowerCase())) {
                    suggestions.push(item);
                }
            }
        });

        return suggestions;
    }

    renderSuggestion(value: CalloutSuggestion, el: HTMLElement) {
        const div = el.createDiv();
        const typeEl = div.createEl('span', { text: `[${value.type}] ` });
        typeEl.style.color = 'var(--text-muted)';
        typeEl.style.fontSize = '0.8em';

        div.createEl('span', { text: value.title });
    }

    async onChooseSuggestion(item: CalloutSuggestion, evt: MouseEvent | KeyboardEvent) {
        // Need to re-read to ensure we have latest (especially if external file changed?)
        // For now assume sourceContent is fresh enough.

        const lines = this.sourceContent.split('\n');

        // Find end of block logic
        let endIndex = item.lineIndex;
        for (let i = item.lineIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            // Standard callout content line starts with >
            if (line.trim().startsWith('>')) {
                endIndex = i;
            } else if (line.trim() === '') {
                break;
            } else {
                break;
            }
        }

        let targetLine = lines[endIndex];
        let id = "";
        let fileModified = false;

        // Check for existing ID
        const idMatch = targetLine.match(/\^([a-zA-Z0-9-]+)$/);
        if (idMatch) {
            id = idMatch[1];
        } else {
            // Generate new ID
            let baseId = item.title.toLowerCase()
                .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');

            if (!baseId) baseId = item.type; // Fallback

            // Uniqueness check
            id = baseId;
            let counter = 1;
            // Simple check in full content
            while (this.sourceContent.includes(`^${id}`)) {
                id = `${baseId}-${counter}`;
                counter++;
            }

            // Append ID to target line
            const newLine = targetLine + ` ^${id}`;
            lines[endIndex] = newLine;
            fileModified = true;
        }

        // --- Save Changes to Source File ---
        if (fileModified) {
            if (this.sourceFile) {
                // Modify external file
                const newContent = lines.join('\n');
                await this.app.vault.modify(this.sourceFile, newContent);
                new Notice(`Block-ID zu ${this.sourceFile.basename} hinzugefügt.`);
            } else {
                // Modify current editor
                this.editor.setLine(endIndex, lines[endIndex]);
            }
        }

        // --- Insert Link into Target Editor ---
        // Format: [[Path#^id|Title]] or [[#^id|Title]]
        const filePath = this.sourceFile ? this.sourceFile.path : ''; // Or basename if using wiki links with unique names? 
        // Best to use full path if not unique, or let Obsidian handle it.
        // Usually, [[Basename#^id]] works if unique.

        // Let's use file.basename if sourceFile exists
        const fileRef = this.sourceFile ? this.sourceFile.basename : '';

        const cursor = this.editor.getCursor();
        const linkStart = `[[${fileRef}#^${id}|`;
        const linkText = `${linkStart}${item.title}]]`;

        this.editor.replaceSelection(linkText);

        // Select Title part
        const selectionStartCh = cursor.ch + linkStart.length;
        const selectionEndCh = selectionStartCh + item.title.length;

        this.editor.setSelection(
            { line: cursor.line, ch: selectionStartCh },
            { line: cursor.line, ch: selectionEndCh }
        );
    }
}
