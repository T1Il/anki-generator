import { Modal, App, ButtonComponent, Setting } from 'obsidian';
import { Card } from '../types';

interface DiffItem {
    type: 'unchanged' | 'modified' | 'added' | 'deleted';
    oldCard?: Card;
    newCard?: Card;
    selected: 'old' | 'new' | 'none'; // 'none' for deleted if we accept deletion? Or just 'new' means accept the state of new set (which is "no card" for deleted). 
    // Let's refine:
    // For Modified: 'old' = keep original, 'new' = take revision.
    // For Added: 'new' = add it. 'none' = don't add. (Default 'new')
    // For Deleted: 'old' = keep original (don't delete). 'none' = accept deletion. (Default 'none')
    // So 'old' always means "Keep what was there". 'new' means "Accept the change/addition".
    // Wait, for Deleted, 'accept change' means 'delete it'. So 'new state' is 'deleted'.
    // Let's us 'keep' and 'reject' terminology?
    // 'keep' = keep the OLD state.
    // 'apply' = apply the NEW state.
}

export class RevisionDiffModal extends Modal {
    oldCards: Card[];
    newCards: Card[];
    onSubmit: (finalCards: Card[]) => void;
    diffItems: DiffItem[] = [];

    constructor(app: App, oldCards: Card[], newCards: Card[], onSubmit: (finalCards: Card[]) => void) {
        super(app);
        this.oldCards = oldCards;
        this.newCards = newCards;
        this.onSubmit = onSubmit;
        this.calculateDiff();
    }

    calculateDiff() {
        this.diffItems = [];
        const newCardsMap = new Map<number, Card>(); // Map ID -> NewCard
        const oldCardsMap = new Map<number, Card>(); // Map ID -> OldCard
        
        // Index by ID
        this.newCards.forEach(c => { if (c.id) newCardsMap.set(c.id, c); });
        this.oldCards.forEach(c => { if (c.id) oldCardsMap.set(c.id, c); });

        // Helper to find match by question if ID missing
        const findMatchByQ = (q: string, list: Card[]) => list.find(c => c.q === q);

        const processedNewIndices = new Set<number>();
        const processedOldIndices = new Set<number>();

        // 1. Match by ID
        this.oldCards.forEach((oldCard, oldIndex) => {
            if (oldCard.id && newCardsMap.has(oldCard.id)) {
                const newCard = newCardsMap.get(oldCard.id)!;
                // Find index in newCards for processed tracking
                const newIndex = this.newCards.indexOf(newCard); // simplistic
                
                if (this.areCardsEqual(oldCard, newCard)) {
                    this.diffItems.push({ type: 'unchanged', oldCard, newCard, selected: 'new' });
                } else {
                    this.diffItems.push({ type: 'modified', oldCard, newCard, selected: 'new' });
                }
                processedOldIndices.add(oldIndex);
                processedNewIndices.add(newIndex);
            }
        });

        // 2. Match by Question (for cards without ID or ID mismatch but same Q)
        this.oldCards.forEach((oldCard, oldIndex) => {
            if (processedOldIndices.has(oldIndex)) return;

            // Try to find in newCards that are not yet processed
            const matchIndex = this.newCards.findIndex((nc, idx) => !processedNewIndices.has(idx) && nc.q === oldCard.q);
            
            if (matchIndex !== -1) {
                const newCard = this.newCards[matchIndex];
                if (this.areCardsEqual(oldCard, newCard)) {
                    this.diffItems.push({ type: 'unchanged', oldCard, newCard, selected: 'new' });
                } else {
                    this.diffItems.push({ type: 'modified', oldCard, newCard, selected: 'new' });
                }
                processedOldIndices.add(oldIndex);
                processedNewIndices.add(matchIndex);
            } else {
                // Not found in new cards -> DELETED
                this.diffItems.push({ type: 'deleted', oldCard, selected: 'new' }); // default 'new' means accept deletion
                processedOldIndices.add(oldIndex);
            }
        });

        // 3. Remaining New Cards -> ADDED
        this.newCards.forEach((newCard, newIndex) => {
            if (!processedNewIndices.has(newIndex)) {
                this.diffItems.push({ type: 'added', newCard, selected: 'new' });
                processedNewIndices.add(newIndex);
            }
        });
    }

    areCardsEqual(c1: Card, c2: Card): boolean {
        return c1.q === c2.q && c1.a === c2.a && c1.type === c2.type;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Karten-Revision prüfen' });
        contentEl.createEl('p', { text: 'Bitte wähle aus, welche Änderungen übernommen werden sollen.' });

        const container = contentEl.createDiv({ cls: 'anki-diff-container' });
        container.style.maxHeight = '60vh';
        container.style.overflowY = 'auto';
        container.style.padding = '10px';
        container.style.border = '1px solid var(--background-modifier-border)';

        // Render Items
        this.diffItems.forEach((item, index) => {
            if (item.type === 'unchanged') return; // Skip unchanged by default to reduce noise? Or show collapsed?

            const itemDiv = container.createDiv({ cls: 'anki-diff-item' });
            itemDiv.style.marginBottom = '15px';
            itemDiv.style.borderBottom = '1px solid var(--background-modifier-border)';
            itemDiv.style.paddingBottom = '10px';

            const header = itemDiv.createDiv({ cls: 'anki-diff-header' });
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.marginBottom = '5px';
            header.style.fontWeight = 'bold';

            if (item.type === 'modified') {
                const span = header.createSpan({ text: '✏️ Geändert' });
                span.style.color = 'var(--text-warning)';
            } else if (item.type === 'added') {
                const span = header.createSpan({ text: '➕ Neu' });
                span.style.color = 'var(--text-success)';
            } else if (item.type === 'deleted') {
                const span = header.createSpan({ text: '❌ Gelöscht' });
                span.style.color = 'var(--text-error)';
            }

            const contentDiv = itemDiv.createDiv({ cls: 'anki-diff-content' });
            contentDiv.style.display = 'flex';
            contentDiv.style.gap = '10px';

            // OLD CONTENT (Left)
            if (item.oldCard) {
                const oldDiv = contentDiv.createDiv({ cls: 'anki-diff-old' });
                oldDiv.style.flex = '1';
                oldDiv.style.opacity = item.selected === 'old' ? '1' : '0.6';
                oldDiv.style.padding = '5px';
                oldDiv.style.border = item.selected === 'old' ? '2px solid var(--text-normal)' : '1px dashed var(--text-muted)';
                oldDiv.createEl('strong', { text: 'Alt:' });
                oldDiv.createEl('div', { text: `Q: ${item.oldCard.q}` }).style.cssText = 'white-space: pre-wrap; font-size: 0.9em;';
                oldDiv.createEl('div', { text: `A: ${item.oldCard.a}` }).style.cssText = 'white-space: pre-wrap; font-size: 0.9em; margin-top: 5px;';
                
                // Click to select
                oldDiv.onclick = () => {
                    item.selected = 'old';
                    this.refreshUI(container);
                };
                oldDiv.style.cursor = 'pointer';
            } else {
                contentDiv.createDiv().style.flex = '1'; // Spacer
            }

            // NEW CONTENT (Right)
            if (item.newCard) { // Could be missing if Deleted
                const newDiv = contentDiv.createDiv({ cls: 'anki-diff-new' });
                newDiv.style.flex = '1';
                newDiv.style.opacity = item.selected === 'new' ? '1' : '0.6';
                newDiv.style.padding = '5px';
                newDiv.style.border = item.selected === 'new' ? '2px solid var(--text-success)' : '1px dashed var(--text-muted)';
                newDiv.createEl('strong', { text: 'Neu:' });
                newDiv.createEl('div', { text: `Q: ${item.newCard.q}` }).style.cssText = 'white-space: pre-wrap; font-size: 0.9em;';
                newDiv.createEl('div', { text: `A: ${item.newCard.a}` }).style.cssText = 'white-space: pre-wrap; font-size: 0.9em; margin-top: 5px;';

                // Click to select
                newDiv.onclick = () => {
                    item.selected = 'new';
                    this.refreshUI(container);
                };
                newDiv.style.cursor = 'pointer';
            } else if (item.type === 'deleted') {
                // For deleted, "New" state is essentially "Nothing".
                // We show a placeholder for "Delete this card".
                const delDiv = contentDiv.createDiv({ cls: 'anki-diff-del' });
                delDiv.style.flex = '1';
                delDiv.style.opacity = item.selected === 'new' ? '1' : '0.6';
                delDiv.style.padding = '5px';
                delDiv.style.border = item.selected === 'new' ? '2px solid var(--text-error)' : '1px dashed var(--text-muted)';
                delDiv.createEl('strong', { text: 'Löschen' });
                 delDiv.createEl('div', { text: '(Karte wird entfernt)' }).style.cssText = 'font-style: italic; color: var(--text-muted);';

                delDiv.onclick = () => {
                    item.selected = 'new';
                    this.refreshUI(container);
                };
                delDiv.style.cursor = 'pointer';
            }
        });
        
        // Show count of unchanged
        const unchangedCount = this.diffItems.filter(i => i.type === 'unchanged').length;
        if (unchangedCount > 0) {
            container.createDiv({ text: `${unchangedCount} Karten unverändert (ausgeblendet)` }).style.cssText = 'color: var(--text-muted); font-style: italic; margin-top: 10px;';
        }


        // Footer Buttons
        const footer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        new ButtonComponent(footer)
            .setButtonText('Abbrechen')
            .onClick(() => this.close());

        new ButtonComponent(footer)
            .setButtonText('Übernehmen')
            .setCta()
            .onClick(() => {
                this.finalize();
                this.close();
            });
    }

    refreshUI(container: HTMLElement) {
        // Simple re-render logic: clear and redraw inside container?
        // Actually, re-rendering the whole modal content logic inside onOpen is easier if we separate render logic.
        // But for efficiently, we just update classes/styles.
        // For now, let's just clear and call onOpen() logic part again? No, recursion.
        // Let's just create a render function.
        // Quick hack: just re-run onOpen logic by clearing contentEl. Not efficient but works for low complexity.
        this.onOpen();
    }

    finalize() {
        const finalCards: Card[] = [];

        this.diffItems.forEach(item => {
            if (item.type === 'unchanged') {
                // Keep the card (prefer newCard reference if it has updates fields, but for unchanged it's same content)
                // Use newCard to have latest "version" if meaningful, or oldCard to keep ID safely.
                // oldCard has ID. newCard might not have ID if AI dropped it (though we matched by ID?).
                // Let's use oldCard to preserve ID.
                if (item.oldCard) finalCards.push(item.oldCard);
            }
            else if (item.type === 'modified') {
                if (item.selected === 'new' && item.newCard) {
                    finalCards.push(item.newCard);
                } else if (item.selected === 'old' && item.oldCard) {
                    finalCards.push(item.oldCard);
                }
            }
            else if (item.type === 'added') {
                if (item.selected === 'new' && item.newCard) {
                    finalCards.push(item.newCard);
                }
                // if selected 'old' (checking off 'new'?), we don't add it.
                // Wait, logic above was: Added -> selected 'new' by default. If 'old' (none), don't push.
            }
            else if (item.type === 'deleted') {
                if (item.selected === 'old' && item.oldCard) {
                    // "Keep Old" -> Don't delete
                    finalCards.push(item.oldCard);
                }
                // if selected 'new', we accept deletion -> don't push.
            }
        });

        this.onSubmit(finalCards);
    }

    onClose() {
        this.contentEl.empty();
    }
}
