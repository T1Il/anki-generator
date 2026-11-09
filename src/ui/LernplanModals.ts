import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import { aufgabenGliedern, LernAufgabe, LernplanApi } from '../lernplan/lernplanApi';

/** Offene Notiz an Aufgaben hängen: passende oben, darunter je Woche und Kapitel wie auf /lernplan. Bleibt für mehrere offen. */
export class NotizVerknuepfenModal extends Modal {
	private suche = '';
	private zu = new Set<string>();
	constructor(app: App, private api: LernplanApi, private datei: TFile, private aufgaben: LernAufgabe[]) { super(app); }

	onOpen() {
		this.modalEl.addClass('anki-lp-fenster');
		this.titleEl.setText('Mit Aufgabe verknüpfen');
		this.titleEl.createEl('small', { text: this.datei.basename });
		const eingabe = this.contentEl.createEl('input', { cls: 'anki-lp-fsuche', attr: { type: 'search', placeholder: 'Aufgabe oder Kapitel suchen' } });
		const liste = this.contentEl.createDiv({ cls: 'anki-lp-fliste' });
		const fuss = this.contentEl.createDiv({ cls: 'anki-lp-ffuss' });
		const zeichnen = () => {
			liste.empty();
			const { passend, wochen } = aufgabenGliedern(this.aufgaben, this.suche);
			if (passend.length) {
				liste.createDiv({ cls: 'anki-lp-fab', text: 'Passt zu dieser Notiz' });
				passend.forEach((a) => this.zeile(liste, a, a.gruppe || `KW ${a.kw}`, zeichnen, fuss));
			}
			for (const w of wochen) {
				const k = liste.createDiv({ cls: 'anki-lp-fwoche' });
				k.createEl('b', { text: `KW ${w.kw}` });
				if (w.titel) k.createSpan({ text: w.titel });
				for (const g of w.gruppen) {
					if (g.titel) liste.createDiv({ cls: 'anki-lp-fgruppe', text: g.titel });
					g.aufgaben.forEach((a) => this.zeile(liste, a, null, zeichnen, fuss));
				}
			}
			if (!passend.length && !wochen.length) liste.createDiv({ cls: 'anki-lp-fleer', text: 'Keine Aufgabe gefunden' });
		};
		eingabe.oninput = () => { this.suche = eingabe.value; zeichnen(); };
		zeichnen();
		this.fussZeichnen(fuss);
		eingabe.focus();
	}

	private schluessel(a: LernAufgabe) { return `${a.jahr}-${a.kw}-${a.index}`; }

	private fussZeichnen(fuss: HTMLElement) {
		fuss.empty();
		const b = fuss.createEl('button', { text: this.zu.size ? `Fertig · ${this.zu.size} verknüpft` : 'Schließen', cls: this.zu.size ? 'mod-cta' : '' });
		b.onclick = () => this.close();
	}

	private zeile(el: HTMLElement, a: LernAufgabe, unter: string | null, zeichnen: () => void, fuss: HTMLElement) {
		const dran = a.verknuepft || this.zu.has(this.schluessel(a));
		const z = el.createEl('button', { cls: `anki-lp-fzeile${dran ? ' is-dran' : ''}` });
		z.createSpan({ cls: `anki-lp-wahl${dran ? ' is-an' : ''}`, text: dran ? '✓' : '' });
		const t = z.createDiv({ cls: 'anki-lp-ftext' });
		t.createDiv({ text: a.kurz || a.text });
		if (unter) t.createEl('small', { text: unter });
		z.createSpan({ cls: 'anki-lp-frechts', text: dran ? 'verknüpft' : a.seite ? `S. ${a.seite}` : '' });
		z.disabled = !!dran;
		z.onclick = async () => {
			z.disabled = true;
			try {
				await this.api.verknuepfen(a, this.datei.path);
				this.zu.add(this.schluessel(a));
				a.verknuepft = true;
				zeichnen();
				this.fussZeichnen(fuss);
			} catch (e: any) { new Notice(e?.message || String(e)); z.disabled = false; }
		};
	}

	onClose() { this.contentEl.empty(); }
}

const STAND: Record<string, string> = { geprueft: 'geprüft', geaendert: 'geändert', offen: 'offen', keine_notiz: 'keine Notiz' };

/** Aufgaben für einen Durchgang wählen. Geprüftes ist nicht vorgewählt. */
export class DurchgangModal extends Modal {
	private wahl = new Set<number>();
	constructor(app: App, private api: LernplanApi, private woche: any, private stand: Record<string, string>, private nachStart: () => void) { super(app); }
	onOpen() {
		this.titleEl.setText(`Durchgang · KW ${this.woche.kw}`);
		if (this.woche.lernziel) this.contentEl.createEl('p', { text: this.woche.lernziel, cls: 'anki-lp-ziel' });
		for (const a of this.woche.aufgaben || []) {
			const z = new Setting(this.contentEl).setName(a.text).setDesc(STAND[this.stand[a.index]] || '');
			z.addToggle((t) => t.setValue(false).onChange((an) => { if (an) this.wahl.add(a.index); else this.wahl.delete(a.index); }));
		}
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Durchgang starten').setCta().onClick(async () => {
			if (!this.wahl.size) { new Notice('Keine Aufgabe gewählt.'); return; }
			try {
				const d = await this.api.durchgangStarten(this.woche.kw, this.woche.jahr, [...this.wahl].sort((x, y) => x - y));
				new Notice(d?.anderer_umfang ? 'Es läuft schon ein Durchgang.' : 'Durchgang gestartet.');
				this.close();
				this.nachStart();
			} catch (e: any) { new Notice(e?.message || String(e)); }
		}));
	}
	onClose() { this.contentEl.empty(); }
}
