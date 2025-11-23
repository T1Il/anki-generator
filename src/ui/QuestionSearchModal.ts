import { App, Modal, TFile, MarkdownView } from 'obsidian';
import { parseCardsFromBlockSource, ANKI_BLOCK_REGEX } from '../anki/ankiParser';
import { Card } from '../types';

interface NoteWithCards {
    file: TFile;
    cardCount: number;
    cards: Card[];
}

export class QuestionSearchModal extends Modal {
    notes: NoteWithCards[] = [];
    isScanning: boolean = true;
    currentView: 'list' | 'details' = 'list';
    selectedNote: NoteWithCards | null = null;

    constructor(app: App) {
        super(app);
    }

    async onOpen() {
        this.render();
        await this.scanVault();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();

        if (this.isScanning) {
            contentEl.createEl("h2", { text: "Suche Anki-Karten..." });
            contentEl.createDiv({ text: "Scanne Vault...", cls: "anki-sync-scanning" });
            return;
        }

        if (this.currentView === 'list') {
            this.renderList(contentEl);
        } else {
            this.renderDetails(contentEl);
        }
    }

    renderList(container: HTMLElement) {
        container.createEl("h2", { text: "Notizen mit Anki-Karten" });

        if (this.notes.length === 0) {
            container.createDiv({ text: "Keine Anki-Karten gefunden." });
            return;
        }

        const listContainer = container.createDiv({ cls: 'anki-search-list' });
        listContainer.style.maxHeight = '400px';
        listContainer.style.overflowY = 'auto';

        this.notes.forEach(note => {
            const row = listContainer.createDiv({ cls: 'anki-search-item' });
            row.style.padding = '10px';
            row.style.borderBottom = '1px solid var(--background-modifier-border)';
            row.style.cursor = 'pointer';
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';

            const nameSpan = row.createSpan({ text: note.file.basename });
            nameSpan.style.fontWeight = 'bold';

            const countSpan = row.createSpan({ text: `${note.cardCount} Fragen` });
            countSpan.style.color = 'var(--text-muted)';

            row.addEventListener('click', () => {
                this.selectedNote = note;
                this.currentView = 'details';
                this.render();
            });

            row.addEventListener('mouseenter', () => {
                row.style.backgroundColor = 'var(--background-modifier-hover)';
            });
            row.addEventListener('mouseleave', () => {
                row.style.backgroundColor = 'transparent';
            });
        });
    }

    renderDetails(container: HTMLElement) {
        if (!this.selectedNote) return;

        const header = container.createDiv({ cls: 'anki-search-header' });
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.marginBottom = '15px';

        const backBtn = header.createEl('button', { text: '⬅ Zurück' });
        backBtn.onclick = () => {
            this.currentView = 'list';
            this.selectedNote = null;
            this.render();
        };

        const title = header.createEl("h2", { text: this.selectedNote.file.basename });
        title.style.margin = '0 0 0 15px';

        const listContainer = container.createDiv({ cls: 'anki-question-list' });
        listContainer.style.maxHeight = '400px';
        listContainer.style.overflowY = 'auto';

        this.selectedNote.cards.forEach(card => {
            const cardEl = listContainer.createDiv({ cls: 'anki-question-item' });
            cardEl.style.padding = '10px';
            cardEl.style.borderBottom = '1px solid var(--background-modifier-border)';
            cardEl.style.cursor = 'pointer';

            const qText = cardEl.createDiv({ cls: 'anki-question-q', text: card.q });
            qText.style.fontWeight = '500';

            cardEl.addEventListener('click', async () => {
                this.close();
                if (this.selectedNote) {
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(this.selectedNote.file);
                }
            });

            cardEl.addEventListener('mouseenter', () => {
                cardEl.style.backgroundColor = 'var(--background-modifier-hover)';
            });
            cardEl.addEventListener('mouseleave', () => {
                cardEl.style.backgroundColor = 'transparent';
            });
        });
    }

    async scanVault() {
        this.notes = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const matches = [...content.matchAll(ANKI_BLOCK_REGEX)];

                if (matches.length > 0) {
                    // Collect cards from ALL blocks in the file
                    let allCards: Card[] = [];
                    for (const match of matches) {
                        const blockSource = match[1];
                        const cards = parseCardsFromBlockSource(blockSource);
                        allCards = allCards.concat(cards);
                    }

                    if (allCards.length > 0) {
                        this.notes.push({
                            file,
                            cardCount: allCards.length,
                            cards: allCards
                        });
                    }
                }
            } catch (e) {
                console.error(`Fehler beim Scannen von ${file.path}:`, e);
            }
        }

        this.isScanning = false;
        this.render();
    }

    onClose() {
        this.contentEl.empty();
    }
}
