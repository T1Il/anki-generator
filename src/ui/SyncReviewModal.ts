import { App, Modal, Setting, TFile, Notice } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { parseAnkiSection } from '../anki/ankiParser';
import { syncAnkiBlock } from '../anki/syncManager';
import { parseCardsFromBlockSource } from '../anki/ankiParser';

interface UnsyncedFile {
    file: TFile;
    deckName: string;
    unsyncedCount: number;
    blockSource: string;
}

export class SyncReviewModal extends Modal {
    plugin: AnkiGeneratorPlugin;
    unsyncedFiles: UnsyncedFile[] = [];
    isScanning: boolean = true;

    constructor(app: App, plugin: AnkiGeneratorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        this.render();
        await this.scanVault();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Nicht synchronisierte Anki-Karten" });

        if (this.isScanning) {
            contentEl.createDiv({ text: "Scanne Vault...", cls: "anki-sync-scanning" });
            return;
        }

        if (this.unsyncedFiles.length === 0) {
            contentEl.createDiv({ text: "Alle Anki-Karten sind synchronisiert! 🎉" });
            return;
        }

        contentEl.createDiv({ text: `Gefunden: ${this.unsyncedFiles.length} Dateien mit unsynchronisierten Karten.` });

        const listContainer = contentEl.createDiv({ cls: 'anki-sync-list-container' });
        listContainer.style.maxHeight = '300px';
        listContainer.style.overflowY = 'auto';
        listContainer.style.margin = '20px 0';
        listContainer.style.border = '1px solid var(--background-modifier-border)';
        listContainer.style.padding = '10px';

        this.unsyncedFiles.forEach(item => {
            const row = listContainer.createDiv({ cls: 'anki-sync-list-item' });
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.padding = '5px 0';
            row.style.borderBottom = '1px solid var(--background-modifier-border-hover)';
            row.style.cursor = 'pointer'; // Make it look clickable

            // Hover effect
            row.addEventListener('mouseenter', () => {
                row.style.backgroundColor = 'var(--background-modifier-hover)';
            });
            row.addEventListener('mouseleave', () => {
                row.style.backgroundColor = 'transparent';
            });

            // Click handler to open file
            row.onclick = async () => {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(item.file);
                this.close(); // Optional: close modal after clicking? User might want to keep it open. Let's keep it open for now or close? 
                // User request: "bei der Übersicht der nicht-synchronisierten Karten die Aufschriebe anklickbar machen"
                // Usually navigation closes modals, but let's see. 
                // If I open in background, modal stays. If I open in active leaf, modal might obscure it.
                // Let's close it to be safe and standard behavior.
                this.close();
            };

            row.createSpan({ text: item.file.basename, cls: 'anki-sync-filename' });
            row.createSpan({ text: `${item.unsyncedCount} Karten (${item.deckName})`, cls: 'anki-sync-details' });
        });

        const btnContainer = contentEl.createDiv({ cls: 'anki-sync-actions' });
        btnContainer.style.display = 'flex';
        btnContainer.style.justifyContent = 'flex-end';
        btnContainer.style.marginTop = '20px';

        const syncAllBtn = btnContainer.createEl('button', { text: '🔄 Alle synchronisieren', cls: 'mod-cta' });
        syncAllBtn.onclick = async () => {
            await this.syncAll();
        };
    }

    async scanVault() {
        this.unsyncedFiles = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                // Wir nutzen hier eine vereinfachte Suche, da parseAnkiSection nur den letzten Block findet.
                // Für Global Sync sollten wir idealerweise alle Blöcke finden, aber vorerst bleiben wir beim letzten Block Logik oder erweitern es.
                // Um konsistent mit dem Rest zu bleiben, nutzen wir parseAnkiSection, was derzeit nur EINEN Block pro Datei unterstützt.

                // Wir müssen den Editor nicht haben, also simulieren wir oder nutzen direkt Regex auf Content.
                // Da parseAnkiSection Editor braucht, nutzen wir hier eigene Logik basierend auf ankiParser helpers.

                const ankiBlockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
                const matches = [...content.matchAll(ankiBlockRegex)];

                if (matches.length > 0) {
                    // Nimm den letzten Block wie im Rest des Plugins
                    const lastMatch = matches[matches.length - 1];
                    const blockSource = lastMatch[1];
                    const cards = parseCardsFromBlockSource(blockSource);

                    const unsyncedCards = cards.filter(c => !c.id);

                    if (unsyncedCards.length > 0) {
                        const deckLine = blockSource.split('\n').find(l => l.trim().startsWith('TARGET DECK:'));
                        const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : "Unbekannt";

                        this.unsyncedFiles.push({
                            file,
                            deckName,
                            unsyncedCount: unsyncedCards.length,
                            blockSource: lastMatch[0] // Der ganze Block inkl. Backticks für syncAnkiBlock
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

    async syncAll() {
        this.close(); // Modal schließen
        const notice = new Notice(`Starte Synchronisation von ${this.unsyncedFiles.length} Dateien...`, 0);

        let successCount = 0;
        let failCount = 0;

        for (const item of this.unsyncedFiles) {
            try {
                notice.setMessage(`Synchronisiere ${item.file.basename}...`);
                // Lese Datei neu, falls sich was geändert hat (unwahrscheinlich in der kurzen Zeit, aber sicher ist sicher)
                const content = await this.app.vault.read(item.file);

                // Extrahiere Karten erneut
                // Wir müssen vorsichtig sein: syncAnkiBlock erwartet den "originalSourceContent" des BLOCKS (mit Backticks? Nein, processAnkiCardsBlock übergibt 'source' was der INHALT ist, aber syncAnkiBlock nutzt findSpecificAnkiBlock welches Backticks erwartet... 
                // Moment, schauen wir syncManager.ts an.
                // findSpecificAnkiBlock sucht nach ANKI_BLOCK_REGEX.
                // processAnkiCardsBlock übergibt 'source' was der Inhalt des Codeblocks ist (ohne Backticks).
                // ABER syncAnkiBlock ruft findSpecificAnkiBlock auf.
                // findSpecificAnkiBlock normalisiert newlines von originalSourceContent.
                // Wenn originalSourceContent NUR der Inhalt ist, matcht es nicht auf den vollen Block mit Backticks im File.

                // KORREKTUR: processAnkiCardsBlock übergibt 'source' = Inhalt.
                // findSpecificAnkiBlock: const matches = [...fullContent.matchAll(ANKI_BLOCK_REGEX)];
                // match[1] ist der Inhalt.
                // Es vergleicht normalizeNewlines(match[1]) === normalizedSource.
                // Also ja, wir müssen den INHALT übergeben.

                const blockContentOnly = item.blockSource.replace(/^```anki-cards\s*\n/, '').replace(/\n^```$/gm, ''); // Grob entfernen, besser regex match nutzen

                // Sauberer Weg:
                const ankiBlockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
                const matches = [...item.blockSource.matchAll(ankiBlockRegex)];
                let sourceContent = "";
                if (matches.length > 0 && matches[0][1]) {
                    sourceContent = matches[0][1];
                } else {
                    // Fallback
                    sourceContent = item.blockSource.replace('```anki-cards', '').replace('```', '').trim();
                }

                const cards = parseCardsFromBlockSource(sourceContent);

                // Deckname extrahieren
                const deckLine = sourceContent.split('\n').find(l => l.trim().startsWith('TARGET DECK:'));
                const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;

                await syncAnkiBlock(this.plugin, sourceContent, deckName, cards, item.file);
                successCount++;
            } catch (e) {
                console.error(`Fehler beim Sync von ${item.file.path}:`, e);
                failCount++;
            }
        }

        notice.hide();
        new Notice(`Sync abgeschlossen. Erfolgreich: ${successCount}, Fehler: ${failCount}`, 5000);
    }

    onClose() {
        this.contentEl.empty();
    }
}
