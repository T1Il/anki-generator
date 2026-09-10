import { App, Modal, TFile, Notice } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { getAnkiBlocks, parseBlockHeader, parseCardsFromBlockSource } from '../anki/ankiParser';
import { syncAnkiBlock } from '../anki/syncManager';
import { t } from '../lang/helpers';

/** Ab dieser Kartenzahl verlangt "Alle synchronisieren" einen zweiten Klick. */
const CONFIRM_THRESHOLD = 25;

interface UnsyncedBlock {
    file: TFile;
    /** 1-basiert, wird nur angezeigt wenn eine Datei mehrere Blöcke hat. */
    blockNo: number;
    blockCount: number;
    deckName: string | null;
    /** Normalisierter Blockinhalt — darüber findet syncAnkiBlock den Block wieder. */
    source: string;
    /** Indizes der Karten ohne ID, bezogen auf den geparsten Block. */
    unsyncedIndices: number[];
}

export class SyncReviewModal extends Modal {
    plugin: AnkiGeneratorPlugin;
    /** Blöcke mit TARGET DECK — nur die lassen sich synchronisieren. */
    blocks: UnsyncedBlock[] = [];
    /** Blöcke ohne TARGET DECK. Die liefen früher erst beim Sync in einen Fehler. */
    blocked: UnsyncedBlock[] = [];
    isScanning = true;
    /** Der Bestätigungsklick steht noch aus. */
    armed = false;

    constructor(app: App, plugin: AnkiGeneratorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        this.render();
        await this.scanVault();
    }

    private get totalCards(): number {
        return this.blocks.reduce((n, b) => n + b.unsyncedIndices.length, 0);
    }

    async scanVault() {
        this.blocks = [];
        this.blocked = [];

        for (const file of this.app.vault.getMarkdownFiles()) {
            try {
                // cachedRead: hier wird nur gelesen, geschrieben erst beim Sync.
                const content = await this.app.vault.cachedRead(file);

                // Blocksuche ausschließlich über getAnkiBlocks. Hier stand früher
                // eine eigene Regex, die Callouts, CRLF und verschachtelte Fences
                // übersehen hat — und nur den letzten Block pro Datei ansah.
                const found = getAnkiBlocks(content);

                found.forEach((block, i) => {
                    const cards = parseCardsFromBlockSource(block.innerClean);
                    const unsyncedIndices = cards
                        .map((c, idx) => (!c.id && c.q && c.q.trim() ? idx : -1))
                        .filter(idx => idx >= 0);

                    if (unsyncedIndices.length === 0) return;

                    const entry: UnsyncedBlock = {
                        file,
                        blockNo: i + 1,
                        blockCount: found.length,
                        deckName: parseBlockHeader(block.innerClean).deckName,
                        source: block.innerClean,
                        unsyncedIndices
                    };

                    (entry.deckName ? this.blocks : this.blocked).push(entry);
                });
            } catch (e) {
                console.error(`Fehler beim Scannen von ${file.path}:`, e);
            }
        }

        this.isScanning = false;
        this.render();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: t('syncReview.title') });

        if (this.isScanning) {
            contentEl.createDiv({ text: t('syncReview.scanning'), cls: 'anki-sync-scanning' });
            return;
        }

        if (this.blocks.length === 0 && this.blocked.length === 0) {
            contentEl.createDiv({ text: t('syncReview.allSynced') });
            return;
        }

        const fileCount = new Set(this.blocks.map(b => b.file.path)).size;
        contentEl.createDiv({
            cls: 'anki-sync-summary',
            text: t('syncReview.summary', {
                cards: this.totalCards,
                blocks: this.blocks.length,
                files: fileCount
            })
        });

        this.renderDeckBreakdown(contentEl);
        this.renderList(contentEl, this.blocks);

        if (this.blocked.length > 0) {
            contentEl.createEl('h3', {
                cls: 'anki-sync-blocked-heading',
                text: t('syncReview.noDeck', { count: this.blocked.length })
            });
            this.renderList(contentEl, this.blocked, true);
        }

        this.renderActions(contentEl);
    }

    /** Wohin die Karten gehen — bei einem Vault-weiten Sync die wichtigste Info. */
    private renderDeckBreakdown(parent: HTMLElement) {
        if (this.blocks.length === 0) return;

        const perDeck = new Map<string, number>();
        for (const b of this.blocks) {
            const deck = b.deckName as string;
            perDeck.set(deck, (perDeck.get(deck) || 0) + b.unsyncedIndices.length);
        }

        const list = parent.createDiv({ cls: 'anki-sync-decks' });
        [...perDeck.entries()]
            .sort((a, b) => b[1] - a[1])
            .forEach(([deck, count]) => {
                const row = list.createDiv({ cls: 'anki-sync-deck-row' });
                row.createSpan({ cls: 'anki-sync-deck-count', text: String(count) });
                row.createSpan({ cls: 'anki-sync-deck-name', text: deck });
            });
    }

    private renderList(parent: HTMLElement, items: UnsyncedBlock[], muted = false) {
        const container = parent.createDiv({
            cls: muted ? 'anki-sync-list anki-sync-list-muted' : 'anki-sync-list'
        });

        items.forEach(item => {
            const row = container.createDiv({ cls: 'anki-sync-list-item' });
            row.onclick = async () => {
                await this.app.workspace.getLeaf(false).openFile(item.file);
                this.close();
            };

            const name = row.createSpan({ cls: 'anki-sync-filename', text: item.file.basename });
            if (item.blockCount > 1) {
                name.createSpan({
                    cls: 'anki-sync-blockno',
                    text: ' ' + t('syncReview.blockLabel', { n: item.blockNo, total: item.blockCount })
                });
            }

            row.createSpan({
                cls: 'anki-sync-details',
                text: item.deckName
                    ? t('syncReview.cardsInDeck', { count: item.unsyncedIndices.length, deck: item.deckName })
                    : String(item.unsyncedIndices.length)
            });
        });
    }

    private renderActions(parent: HTMLElement) {
        const total = this.totalCards;
        if (total === 0) return;

        if (this.armed) {
            parent.createDiv({
                cls: 'anki-sync-warning',
                text: t('syncReview.confirmWarn', { count: total })
            });
        }

        const actions = parent.createDiv({ cls: 'anki-sync-actions' });

        if (this.armed) {
            const cancel = actions.createEl('button', { text: t('syncReview.cancel') });
            cancel.onclick = () => {
                this.armed = false;
                this.render();
            };

            const confirm = actions.createEl('button', {
                cls: 'mod-warning',
                text: t('syncReview.confirmBtn', { count: total })
            });
            confirm.onclick = () => this.syncAll();
            return;
        }

        const syncBtn = actions.createEl('button', {
            cls: 'mod-cta',
            text: t('syncReview.syncAll', { count: total })
        });
        syncBtn.onclick = () => {
            // Erst nachfragen, wenn es viele sind: an einer reinen Dateizahl war
            // nicht zu erkennen, dass 12 Dateien 130 Karten bedeuten.
            if (total >= CONFIRM_THRESHOLD) {
                this.armed = true;
                this.render();
                return;
            }
            this.syncAll();
        };
    }

    async syncAll() {
        const items = this.blocks;
        const blockedCount = this.blocked.length;
        this.close();

        const notice = new Notice(t('syncReview.scanning'), 0);

        let processed = 0;
        let failed = 0;
        let skipped = blockedCount;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            notice.setMessage(t('syncReview.progress', {
                file: item.file.basename,
                current: i + 1,
                total: items.length
            }));

            try {
                // Datei frisch lesen und den Block neu lokalisieren: zwischen Scan
                // und Klick kann die Datei sich geändert haben, und die Indizes
                // gelten nur für genau diesen Blockinhalt.
                const content = await this.app.vault.read(item.file);
                const block = getAnkiBlocks(content).find(b => b.innerClean === item.source);

                if (!block) {
                    console.warn(`[SyncReview] Block nicht mehr auffindbar: ${item.file.path}`);
                    new Notice(t('syncReview.blockGone', { file: item.file.basename }));
                    skipped++;
                    continue;
                }

                const cards = parseCardsFromBlockSource(block.innerClean);

                await syncAnkiBlock(
                    this.plugin,
                    block.innerClean,
                    item.deckName,
                    cards,
                    item.file,
                    // Nur die Karten ohne ID anfassen. Vorher lief der ganze Block
                    // durch, also auch hunderte Updates an bereits synchronen Karten.
                    item.unsyncedIndices
                );
                processed += item.unsyncedIndices.length;
            } catch (e) {
                console.error(`Fehler beim Sync von ${item.file.path}:`, e);
                failed++;
            }
        }

        notice.hide();
        new Notice(t('syncReview.done', { created: processed, failed, skipped }), 8000);
    }

    onClose() {
        this.contentEl.empty();
    }
}
