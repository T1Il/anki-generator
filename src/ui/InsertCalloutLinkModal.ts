import { App, Editor, SuggestModal, Notice } from 'obsidian';

interface CalloutSuggestion {
    title: string;
    type: string;
    lineIndex: number;
    rawContent: string;
}

export class InsertCalloutLinkModal extends SuggestModal<CalloutSuggestion> {
    editor: Editor;
    
    constructor(app: App, editor: Editor) {
        super(app);
        this.editor = editor;
        this.setPlaceholder("Suche nach Callout...");
    }

    getSuggestions(query: string): CalloutSuggestion[] {
        const lines = this.editor.getValue().split('\n');
        const suggestions: CalloutSuggestion[] = [];
        
        // Regex to match callout headers: > [!type] Title
        // Also supports > [!type|Title] or just > [!type]
        const calloutRegex = /^>\s*\[!([\w-]+)(?:\|(.*?))?\]\s*(.*)$/;

        lines.forEach((line, index) => {
            const match = line.match(calloutRegex);
            if (match) {
                const type = match[1];
                let title = match[3] || match[2] || type; 
                // match[2] handles pipe syntax if present, match[3] handles space syntax, fallback to type
                
                title = title.trim();

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

    onChooseSuggestion(item: CalloutSuggestion, evt: MouseEvent | KeyboardEvent) {
        // Find if block ID exists for this callout
        const doc = this.editor.getValue();
        const lines = doc.split('\n');
        
        // We need to find where the block ends to check/insert ID.
        // Or simpler: Check the callout block logic.
        // Block ID usually resides at the end of the last line of the block.
        // Or for the callout specifically, it can be at the end of the header? No, Obsidian standard is end of block.
        
        // Let's reuse logic: Find the end of this callout block.
        let endIndex = item.lineIndex;
        // Search forward until we hit a line that is NOT a quote or empty
        for (let i = item.lineIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '' || line.trim().startsWith('>')) {
                 endIndex = i;
            } else {
                break; // End of block
            }
        }
        
        let targetLine = lines[endIndex];
        let id = "";

        // Check for existing ID
        const idMatch = targetLine.match(/\^([a-zA-Z0-9-]+)$/);
        if (idMatch) {
            id = idMatch[1];
        } else {
            // Generate new ID
            // Sanitize title
            let baseId = item.title.toLowerCase()
                .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            
            if (!baseId) baseId = item.type; // Fallback
            
            // Uniqueness check (simple append number)
            id = baseId;
            let counter = 1;
            while (doc.includes(`^${id}`)) {
                 id = `${baseId}-${counter}`;
                 counter++;
            }

            // Insert ID
            // We need to modify the file
            // Use setLine to avoid full replace flicker?
            // Wait, if it's the last line, we append ` ^id`.
            const newLine = targetLine + ` ^${id}`;
            this.editor.setLine(endIndex, newLine);
        }

        // Insert Link and select the alias part for easy editing
        const cursor = this.editor.getCursor();
        const linkStart = `[[#^${id}|`;
        const linkText = `${linkStart}${item.title}]]`;
        
        this.editor.replaceSelection(linkText);
        
        // Calculate positions to select "Title"
        // Cursor matches the START of the selection replacment
        const selectionStartCh = cursor.ch + linkStart.length;
        const selectionEndCh = selectionStartCh + item.title.length;
        
        this.editor.setSelection(
            { line: cursor.line, ch: selectionStartCh },
            { line: cursor.line, ch: selectionEndCh }
        );
    }
}
