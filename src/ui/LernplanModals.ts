import { App, Modal, Notice, Setting, SuggestModal, TFile } from 'obsidian';
import { LernAufgabe, LernplanApi } from '../lernplan/lernplanApi';

/** Offene Notiz an eine Lernplan-Aufgabe hängen. Passende Aufgaben stehen oben. */
export class NotizVerknuepfenModal extends SuggestModal<LernAufgabe> {
	constructor(app: App, private api: LernplanApi, private datei: TFile, private aufgaben: LernAufgabe[]) {
		super(app);
		this.setPlaceholder(`${datei.basename} verknüpfen mit …`);
	}
	getSuggestions(q: string) {
		const s = q.toLowerCase();
		return this.aufgaben.filter((a) => a.text.toLowerCase().includes(s));
	}
	renderSuggestion(a: LernAufgabe, el: HTMLElement) {
		el.addClass('anki-lp-wahl');
		el.createDiv({ text: a.text, cls: 'anki-lp-wahl-text' });
		el.createDiv({ text: `KW ${a.kw}${a.verknuepft ? ' · verknüpft' : a.passt ? ' · passt' : ''}`, cls: 'anki-lp-wahl-rechts' });
	}
	async onChooseSuggestion(a: LernAufgabe) {
		try {
			await this.api.verknuepfen(a, this.datei.path);
			new Notice(`Verknüpft mit ${a.text}`);
		} catch (e: any) { new Notice(e?.message || String(e)); }
	}
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
