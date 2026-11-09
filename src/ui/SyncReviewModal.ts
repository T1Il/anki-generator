import { App, Modal, TFile, Notice } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { getAnkiBlocks, parseBlockHeader, parseCardsFromBlockSource, stripClozeSyntax } from '../anki/ankiParser';
import { syncAnkiBlock } from '../anki/syncManager';
import { getDeckNames } from '../anki/AnkiConnect';
import { DeckWahlModal } from './DeckWahlModal';
import { t } from '../lang/helpers';
import { auftraege, deckVorschlag, gewaehltZahl, neueGruppe, passt, SyncGruppe } from './syncAuswahl';

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
    auswahl: SyncGruppe;
}

export class SyncReviewModal extends Modal {
    plugin: AnkiGeneratorPlugin;
    blocks: UnsyncedBlock[] = [];
    deckNamen: string[] = [];
    /** Deck für alle Notizen ohne eigenes. */
    fuerAlle = '';
    /** Ohne laufendes Anki kann nichts synchronisiert werden. */
    ankiDa = true;
    isScanning = true;
    /** Der Bestätigungsklick steht noch aus. */
    armed = false;

    constructor(app: App, plugin: AnkiGeneratorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        this.modalEl.addClass('anki-lp-fenster');
        this.render();
        try { this.deckNamen = await getDeckNames(); } catch { this.deckNamen = []; this.ankiDa = false; }
        await this.scanVault();
    }

    private get gruppen(): SyncGruppe[] {
        return this.blocks.map((b) => b.auswahl);
    }

    async scanVault() {
        this.blocks = [];
        const deckeJeOrdner: Record<string, Record<string, number>> = {};

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
                    const blockDeck = parseBlockHeader(block.innerClean).deckName;
                    if (blockDeck) {
                        const ordner = (deckeJeOrdner[file.parent?.path || ''] ||= {});
                        ordner[blockDeck] = (ordner[blockDeck] || 0) + 1;
                    }
                    const unsyncedIndices = cards
                        .map((c, idx) => (!c.id && c.q && c.q.trim() ? idx : -1))
                        .filter(idx => idx >= 0);

                    if (unsyncedIndices.length === 0) return;

                    const deckName = parseBlockHeader(block.innerClean).deckName;
                    this.blocks.push({
                        file,
                        blockNo: i + 1,
                        blockCount: found.length,
                        deckName,
                        source: block.innerClean,
                        unsyncedIndices,
                        auswahl: neueGruppe(deckName, unsyncedIndices.map((index) => ({ index, frage: stripClozeSyntax(cards[index].q), antwort: (cards[index].a || '').trim() })))
                    });
                });
            } catch (e) {
                console.error(`Fehler beim Scannen von ${file.path}:`, e);
            }
        }

        // Vorschlag aus dem Ordner, sichtbar und änderbar. Die aktuelle Notiz steht oben, danach was noch ein Deck braucht.
        const aktiv = this.app.workspace?.getActiveFile?.()?.path;
        for (const b of this.blocks) if (!b.deckName) b.auswahl.neuesDeck = deckVorschlag(b.file.path, deckeJeOrdner);
        const rang = (b: UnsyncedBlock) => (b.file.path === aktiv ? 0 : b.deckName ? 2 : 1);
        this.blocks.sort((a, b) => rang(a) - rang(b) || a.file.basename.localeCompare(b.file.basename, 'de'));

        this.isScanning = false;
        this.render();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();
        this.titleEl.setText('Karten synchronisieren');

        if (this.isScanning) {
            contentEl.createDiv({ text: t('syncReview.scanning'), cls: 'anki-lp-fleer' });
            return;
        }
        if (this.blocks.length === 0) {
            contentEl.createDiv({ text: t('syncReview.allSynced'), cls: 'anki-lp-fleer' });
            return;
        }

        const kopf = contentEl.createDiv({ cls: 'anki-sy-kopf' });
        const alle = kopf.createEl('label', { cls: 'anki-sy-alle' });
        const alleBox = alle.createEl('input', { attr: { type: 'checkbox' } });
        alle.createSpan({ text: 'Alle' });
        const zahl = kopf.createSpan({ cls: 'anki-sy-zahl' });
        if (this.blocks.some((b) => !b.deckName)) {
            const fuerAlle = contentEl.createEl('button', { cls: 'anki-sy-deckwahl anki-sy-fueralle' });
            const beschriften = () => fuerAlle.setText(this.fuerAlle ? `Deck für alle ohne Deck: ${this.fuerAlle}` : 'Deck für alle Notizen ohne Deck wählen');
            beschriften();
            fuerAlle.onclick = () => this.deckWaehlen(this.fuerAlle, (d) => { this.fuerAlle = d; beschriften(); aktualisieren(); });
        }

        const suche = contentEl.createEl('input', { cls: 'anki-lp-fsuche anki-sy-suche', attr: { type: 'search', placeholder: 'Notiz oder Karte suchen' } });
        const liste = contentEl.createDiv({ cls: 'anki-lp-fliste' });
        const fuss = contentEl.createDiv({ cls: 'anki-lp-ffuss anki-sy-fuss' });
        const hinweis = fuss.createSpan({ cls: 'anki-sy-hinweis' });
        const start = fuss.createEl('button', { cls: 'mod-cta' });

        const aktualisieren = () => {
            const n = gewaehltZahl(this.gruppen);
            const gesamt = this.gruppen.reduce((x, g) => x + g.karten.length, 0);
            const a = auftraege(this.gruppen, this.fuerAlle);
            zahl.setText(`${n} von ${gesamt} Karten`);
            alleBox.checked = n === gesamt;
            alleBox.indeterminate = n > 0 && n < gesamt;
            hinweis.setText(!this.ankiDa ? 'Anki ist nicht erreichbar. Starte Anki und öffne das Fenster neu.' : a.ohneDeck.length ? `${a.ohneDeck.length} ${a.ohneDeck.length === 1 ? 'Notiz braucht' : 'Notizen brauchen'} noch ein Deck` : '');
            start.setText(this.armed ? `Ja, ${n} Karten synchronisieren` : `${n} Karten synchronisieren`);
            start.disabled = !this.ankiDa || n === 0 || a.ohneDeck.length > 0;
        };

        const zeilen = this.blocks.map((item) => ({ item, ...this.notizZeile(liste, item, aktualisieren) }));
        // „Alle“ gilt für das, was die Suche gerade zeigt.
        alleBox.onchange = () => {
            for (const z of zeilen) {
                if (passt(z.item.file.basename, z.item.auswahl.karten, suche.value)) z.item.auswahl.gewaehlt = new Set(alleBox.checked ? z.item.auswahl.karten.map((k) => k.index) : []);
                z.setzen();
            }
            aktualisieren();
        };
        suche.oninput = () => zeilen.forEach((z) => z.zeigen(passt(z.item.file.basename, z.item.auswahl.karten, suche.value)));
        start.onclick = () => {
            if (gewaehltZahl(this.gruppen) >= CONFIRM_THRESHOLD && !this.armed) {
                this.armed = true;
                aktualisieren();
                return;
            }
            void this.syncAll();
        };
        aktualisieren();
    }

    private deckWaehlen(aktuell: string, fertig: (deck: string) => void) {
        new DeckWahlModal(this.app, this.plugin.settings.mainDeck, this.deckNamen, aktuell, fertig).open();
    }

    /** Eine Notiz: Haken, Deck, aufklappbar bis zur einzelnen Karte. Gibt zurück, wie sich die Haken neu setzen. */
    private notizZeile(parent: HTMLElement, item: UnsyncedBlock, aktualisieren: () => void): { setzen: () => void; zeigen: (an: boolean) => void } {
        const g = item.auswahl;
        const auf = parent.createEl('details', { cls: 'anki-sy-notiz' });
        const kopf = auf.createEl('summary');
        const box = kopf.createEl('input', { attr: { type: 'checkbox', 'aria-label': `${item.file.basename} wählen` } });
        box.onclick = (e) => e.stopPropagation();
        const text = kopf.createDiv({ cls: 'anki-lp-ftext' });
        text.createDiv({ text: item.file.basename + (item.blockCount > 1 ? ` · ${t('syncReview.blockLabel', { n: item.blockNo, total: item.blockCount })}` : '') });
        if (item.deckName) text.createEl('small', { text: item.deckName });
        const zahl = kopf.createSpan({ cls: 'anki-lp-frechts' });

        const deck = item.deckName ? null : parent.createEl('button', { cls: 'anki-sy-deckwahl anki-sy-deck' });
        if (deck) {
            const beschriften = () => deck.setText(g.neuesDeck ? `Deck: ${g.neuesDeck}` : 'Deck wählen');
            beschriften();
            deck.onclick = () => this.deckWaehlen(g.neuesDeck, (d) => { g.neuesDeck = d; beschriften(); aktualisieren(); });
        }

        const karten = g.karten.map((k) => {
            const zeile = auf.createEl('label', { cls: 'anki-sy-karte' });
            const b = zeile.createEl('input', { attr: { type: 'checkbox' } });
            const inhalt = zeile.createDiv();
            inhalt.createDiv({ text: k.frage });
            if (k.antwort && k.antwort !== '—') inhalt.createEl('small', { text: k.antwort });
            b.onchange = () => {
                if (b.checked) g.gewaehlt.add(k.index); else g.gewaehlt.delete(k.index);
                setzen();
                aktualisieren();
            };
            return { index: k.index, b };
        });
        const setzen = () => {
            box.checked = g.gewaehlt.size === g.karten.length;
            box.indeterminate = g.gewaehlt.size > 0 && !box.checked;
            zahl.setText(`${g.gewaehlt.size}/${g.karten.length}`);
            karten.forEach(({ index, b }) => { b.checked = g.gewaehlt.has(index); });
        };
        box.onchange = () => {
            g.gewaehlt = new Set(box.checked ? g.karten.map((k) => k.index) : []);
            setzen();
            aktualisieren();
        };
        const oeffnen = auf.createEl('button', { cls: 'anki-lp-textknopf anki-sy-oeffnen', text: 'Notiz öffnen' });
        oeffnen.onclick = async () => {
            await this.app.workspace.getLeaf(false).openFile(item.file);
            this.close();
        };
        setzen();
        const zeigen = (an: boolean) => { auf.style.display = an ? '' : 'none'; if (deck) deck.style.display = an ? '' : 'none'; };
        return { setzen, zeigen };
    }

    async syncAll() {
        const { fertig } = auftraege(this.gruppen, this.fuerAlle);
        const items = fertig.map((f) => ({ item: this.blocks.find((b) => b.auswahl === f.gruppe) as UnsyncedBlock, deck: f.deck, indizes: f.indizes }));
        this.close();

        const notice = new Notice(t('syncReview.scanning'), 0);

        let processed = 0;
        let failed = 0;
        let skipped = 0;

        for (let i = 0; i < items.length; i++) {
            const { item, deck, indizes } = items[i];
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
                    deck,
                    cards,
                    item.file,
                    // Nur die gewählten Karten ohne ID anfassen. Vorher lief der ganze Block
                    // durch, also auch hunderte Updates an bereits synchronen Karten.
                    indizes
                );
                processed += indizes.length;
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
