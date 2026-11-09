import { App, Modal } from 'obsidian';
import { deckPfad, deckZeilen, unterdeck } from './syncAuswahl';

/** Deck wählen wie bei „Anki-Karten generieren“: Unterdeck, Baum der vorhandenen Decks, finaler Pfad. */
export class DeckWahlModal extends Modal {
	constructor(app: App, private hauptdeck: string, private deckNamen: string[], private aktuell: string, private fertig: (deck: string) => void) { super(app); }

	onOpen() {
		this.modalEl.addClass('anki-lp-fenster');
		this.titleEl.setText('Deck wählen');
		const { contentEl } = this;
		const feld = contentEl.createEl('input', { cls: 'anki-lp-fsuche', attr: { type: 'search', placeholder: 'Name des Unterdecks, Stufen mit ::' } });
		feld.value = unterdeck(this.hauptdeck, this.aktuell);
		const pfad = contentEl.createDiv({ cls: 'anki-sy-pfad' });
		const baum = contentEl.createDiv({ cls: 'anki-lp-fliste anki-sy-baum' });
		const zeichnen = () => {
			const unter = feld.value.trim().replace(/->/g, '::');
			pfad.setText(deckPfad(this.hauptdeck, unter).split('::').join(' › '));
			baum.empty();
			const zeilen = deckZeilen(this.deckNamen, this.hauptdeck);
			if (!zeilen.length) baum.createDiv({ cls: 'anki-lp-fleer', text: 'Keine Unterdecks gefunden' });
			for (const z of zeilen) {
				const b = baum.createEl('button', { cls: `anki-lp-fzeile anki-sy-ast${unter.toLowerCase() === z.pfad.toLowerCase() ? ' is-aktiv' : ''}`, text: z.name });
				b.style.setProperty('--ebene', String(z.ebene));
				b.onclick = () => { feld.value = z.pfad; zeichnen(); };
			}
		};
		feld.oninput = zeichnen;
		const fuss = contentEl.createDiv({ cls: 'anki-lp-ffuss' });
		const ok = fuss.createEl('button', { cls: 'mod-cta', text: 'Deck übernehmen' });
		ok.onclick = () => { this.close(); this.fertig(deckPfad(this.hauptdeck, feld.value)); };
		zeichnen();
		feld.focus();
	}

	onClose() { this.contentEl.empty(); }
}
