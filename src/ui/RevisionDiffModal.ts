import { Modal, App, ButtonComponent, MarkdownRenderer, Component } from 'obsidian';
import { Card } from '../types';

interface DiffItem {
    type: 'unchanged' | 'modified' | 'added' | 'deleted';
    oldCard?: Card;
    newCard?: Card;
    selected: 'old' | 'new' | 'none'; 
}

export class RevisionDiffModal extends Modal {
    oldCards: Card[];
    newCards: Card[];
    onSubmit: (finalCards: Card[]) => void;
    diffItems: DiffItem[] = [];
    sourcePath: string;
    component: Component;

    constructor(app: App, oldCards: Card[], newCards: Card[], sourcePath: string, onSubmit: (finalCards: Card[]) => void) {
        super(app);
        this.oldCards = oldCards;
        this.newCards = newCards;
        this.sourcePath = sourcePath;
        this.onSubmit = onSubmit;
        this.component = new Component();
        this.calculateDiff();
    }

    calculateDiff() {
        this.diffItems = [];
        const newCardsMap = new Map<number, Card>(); 
        const oldCardsMap = new Map<number, Card>(); 
        
        this.newCards.forEach(c => { if (c.id) newCardsMap.set(c.id, c); });
        this.oldCards.forEach(c => { if (c.id) oldCardsMap.set(c.id, c); });

        const processedNewIndices = new Set<number>();
        const processedOldIndices = new Set<number>();

        // 1. Match by ID
        this.oldCards.forEach((oldCard, oldIndex) => {
            if (oldCard.id && newCardsMap.has(oldCard.id)) {
                const newCard = newCardsMap.get(oldCard.id)!;
                const newIndex = this.newCards.indexOf(newCard);
                
                if (this.areCardsEqual(oldCard, newCard)) {
                    this.diffItems.push({ type: 'unchanged', oldCard, newCard, selected: 'new' });
                } else {
                    this.diffItems.push({ type: 'modified', oldCard, newCard, selected: 'new' });
                }
                processedOldIndices.add(oldIndex);
                processedNewIndices.add(newIndex);
            }
        });

        // 2. Match by Question
        this.oldCards.forEach((oldCard, oldIndex) => {
            if (processedOldIndices.has(oldIndex)) return;

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
                // User requested: Missing cards should NOT be deleted, but preserved as unchanged.
                this.diffItems.push({ type: 'unchanged', oldCard, selected: 'old' });
                processedOldIndices.add(oldIndex);
            }
        });

        // 3. Remaining New Cards
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
        
        this.modalEl.style.width = '90vw';
        this.modalEl.style.maxWidth = '1200px';

        contentEl.createEl('h2', { text: 'Karten-Revision prüfen' });
        contentEl.createEl('p', { text: 'Bitte wähle aus, welche Änderungen übernommen werden sollen.' });

        const container = contentEl.createDiv({ cls: 'anki-diff-container' });
        container.style.maxHeight = '70vh';
        container.style.overflowY = 'auto';
        container.style.padding = '10px';
        container.style.border = '1px solid var(--background-modifier-border)';

        this.diffItems.forEach((item, index) => {
            if (item.type === 'unchanged') return; 

            const itemDiv = container.createDiv({ cls: 'anki-diff-item' });
            itemDiv.style.marginBottom = '20px';
            itemDiv.style.borderBottom = '1px solid var(--background-modifier-border)';
            itemDiv.style.paddingBottom = '15px';

            const header = itemDiv.createDiv({ cls: 'anki-diff-header' });
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.marginBottom = '10px';
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
            contentDiv.style.gap = '20px';

            let oldDiv: HTMLElement | null = null;
            let newDiv: HTMLElement | null = null;
            let delDiv: HTMLElement | null = null;

            // OLD CONTENT 
            if (item.oldCard) {
                oldDiv = contentDiv.createDiv({ cls: 'anki-diff-old' });
                oldDiv.style.flex = '1';
                oldDiv.style.width = '0'; // Allow shrinking for flex
                oldDiv.style.padding = '10px';
                oldDiv.style.borderRadius = '5px';
                
                oldDiv.createEl('div', { text: 'Original', cls: 'anki-diff-label' }).style.fontWeight = 'bold';
                
                this.renderCardContent(oldDiv, item.oldCard);

                oldDiv.onclick = () => {
                    item.selected = 'old';
                    updateVisuals();
                };
                oldDiv.style.cursor = 'pointer';
            } else {
                 contentDiv.createDiv().style.flex = '1'; 
            }

            // NEW CONTENT 
            if (item.newCard) {
                newDiv = contentDiv.createDiv({ cls: 'anki-diff-new' });
                newDiv.style.flex = '1';
                newDiv.style.width = '0'; // Allow shrinking
                newDiv.style.padding = '10px';
                newDiv.style.borderRadius = '5px';
                
                newDiv.createEl('div', { text: 'Überarbeitung', cls: 'anki-diff-label' }).style.fontWeight = 'bold';
                
                this.renderCardContent(newDiv, item.newCard);

                newDiv.onclick = () => {
                    item.selected = 'new';
                    updateVisuals();
                };
                newDiv.style.cursor = 'pointer';
            } else if (item.type === 'deleted') {
                delDiv = contentDiv.createDiv({ cls: 'anki-diff-del' });
                delDiv.style.flex = '1';
                delDiv.style.width = '0';
                delDiv.style.padding = '10px';
                delDiv.style.borderRadius = '5px';
                
                delDiv.createEl('div', { text: 'Löschen', cls: 'anki-diff-label' }).style.fontWeight = 'bold';
                delDiv.createDiv({ text: '(Karte wird entfernt)' }).style.fontStyle = 'italic';

                delDiv.onclick = () => {
                    item.selected = 'new';
                    updateVisuals();
                };
                delDiv.style.cursor = 'pointer';
            }

            // Function to update interaction styles without re-rendering
            const updateVisuals = () => {
                if (oldDiv) {
                    const isSelected = item.selected === 'old';
                    oldDiv.style.opacity = isSelected ? '1' : '0.5';
                    oldDiv.style.backgroundColor = isSelected ? 'var(--background-primary-alt)' : 'transparent';
                    oldDiv.style.border = isSelected ? '2px solid var(--text-normal)' : '1px dashed var(--text-muted)';
                }
                if (newDiv) {
                    const isSelected = item.selected === 'new';
                    newDiv.style.opacity = isSelected ? '1' : '0.5';
                    newDiv.style.backgroundColor = isSelected ? 'var(--background-primary-alt)' : 'transparent';
                    newDiv.style.border = isSelected ? '2px solid var(--text-success)' : '1px dashed var(--text-muted)';
                }
                if (delDiv) {
                     const isSelected = item.selected === 'new';
                     delDiv.style.opacity = isSelected ? '1' : '0.5';
                     delDiv.style.border = isSelected ? '2px solid var(--text-error)' : '1px dashed var(--text-muted)';
                }
            };

            // Initial call
            updateVisuals();
        });
        
        const unchangedCount = this.diffItems.filter(i => i.type === 'unchanged').length;
        if (unchangedCount > 0) {
            container.createDiv({ text: `${unchangedCount} Karten unverändert (ausgeblendet)` }).style.cssText = 'color: var(--text-muted); font-style: italic; margin-top: 10px;';
        }

        const footer = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(footer).setButtonText('Abbrechen').onClick(() => this.close());
        new ButtonComponent(footer).setButtonText('Übernehmen').setCta().onClick(() => {
            this.finalize();
            this.close();
        });
    }

    async renderCardContent(container: HTMLElement, card: Card) {
        // Wrapper for overflow handling
        const wrapper = container.createDiv();
        wrapper.style.overflowWrap = 'anywhere';
        wrapper.style.wordBreak = 'break-word';

        // TYPE BADGE
        let typeLabel: string = card.type || 'Standard';
        let badgeColor = 'var(--text-muted)';
        
        switch (card.type?.toLowerCase()) {
            case 'basic': typeLabel = 'Standard'; badgeColor = 'var(--color-blue)'; break;
            case 'cloze': typeLabel = 'Lückentext'; badgeColor = 'var(--color-purple)'; break;
            case 'input': typeLabel = 'Eingabe'; badgeColor = 'var(--color-orange)'; break;
            case 'generated implicit': typeLabel = 'Automatisch'; badgeColor = 'var(--text-muted)'; break; 
        }

        const badge = wrapper.createDiv({ text: typeLabel, cls: 'anki-card-type-badge' });
        badge.style.cssText = `
            display: inline-block;
            font-size: 0.7em;
            padding: 2px 6px;
            border-radius: 4px;
            background-color: ${badgeColor};
            color: var(--text-on-accent);
            margin-bottom: 8px;
            font-weight: bold;
            opacity: 0.8;
        `;

        // Question
        wrapper.createDiv({ text: 'Frage:', cls: 'anki-card-label' }).style.cssText = 'font-size: 0.8em; color: var(--text-muted); margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.05em;';
        const qDiv = wrapper.createDiv({ cls: 'anki-card-q' });
        await MarkdownRenderer.render(this.app, card.q, qDiv, this.sourcePath, this.component);

        // Spacer
        wrapper.createDiv().style.height = '10px';

        // Answer
        wrapper.createDiv({ text: 'Antwort:', cls: 'anki-card-label' }).style.cssText = 'font-size: 0.8em; color: var(--text-muted); margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.05em;';
        const aDiv = wrapper.createDiv({ cls: 'anki-card-a' });
        await MarkdownRenderer.render(this.app, card.a, aDiv, this.sourcePath, this.component);
    }

    finalize() {
        const finalCards: Card[] = [];
        this.diffItems.forEach(item => {
            if (item.type === 'unchanged') {
                if (item.oldCard) finalCards.push(item.oldCard);
            }
            else if (item.type === 'modified') {
                if (item.selected === 'new' && item.newCard) finalCards.push(item.newCard);
                else if (item.selected === 'old' && item.oldCard) finalCards.push(item.oldCard);
            }
            else if (item.type === 'added') {
                if (item.selected === 'new' && item.newCard) finalCards.push(item.newCard);
            }
            else if (item.type === 'deleted') {
                if (item.selected === 'old' && item.oldCard) finalCards.push(item.oldCard);
            }
        });
        this.onSubmit(finalCards);
    }

    onClose() {
        this.component.unload();
        this.contentEl.empty();
    }
}
