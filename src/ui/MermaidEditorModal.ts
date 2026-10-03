import { App, Modal, loadMermaid } from 'obsidian';
import { repariereMermaid } from '../chat/mermaidRepair';
import {
	Abstand, Kurve, MermaidEinstellungen, Richtung, leseEinstellungen, setzeEinstellungen
} from '../mermaid/mermaidEinstellungen';

/**
 * Kleiner Mermaid-Editor: Grundeinstellungen per Knopf (Richtung, Kanten,
 * Abstaende), darunter der Quelltext, rechts die Vorschau live.
 *
 * Gespeichert wird nur ueber `onSave` – wohin (Notiz, Vorschlag, Karte),
 * entscheidet der Aufrufer.
 */
export class MermaidEditorModal extends Modal {
	private code: string;
	private onSave: (code: string) => void | Promise<void>;
	private feld!: HTMLTextAreaElement;
	private vorschau!: HTMLElement;
	private fehler!: HTMLElement;
	private knoepfe: { gruppe: keyof MermaidEinstellungen; wert: string; el: HTMLElement }[] = [];
	private timer = 0;
	private lauf = 0;

	constructor(app: App, code: string, onSave: (code: string) => void | Promise<void>) {
		super(app);
		this.code = code;
		this.onSave = onSave;
	}

	onOpen() {
		this.modalEl.addClass('anki-mermaid-editor');
		this.titleEl.setText('Mermaid-Diagramm bearbeiten');

		const raster = this.contentEl.createDiv({ cls: 'anki-mermaid-editor-grid' });
		const links = raster.createDiv({ cls: 'anki-mermaid-editor-links' });
		const rechts = raster.createDiv({ cls: 'anki-mermaid-editor-rechts' });

		this.reihe(links, 'Richtung', 'richtung', [
			['TD', '↓ Senkrecht'], ['LR', '→ Waagerecht'], ['BT', '↑ Von unten'], ['RL', '← Von rechts']
		]);
		this.reihe(links, 'Kanten', 'kurve', [['step', 'Stufig'], ['basis', 'Rund'], ['linear', 'Gerade']]);
		this.reihe(links, 'Abstand', 'abstand', [['kompakt', 'Kompakt'], ['normal', 'Normal'], ['weit', 'Weit']]);

		this.feld = links.createEl('textarea', { cls: 'anki-mermaid-editor-code' });
		this.feld.value = this.code;
		this.feld.spellcheck = false;
		this.feld.addEventListener('input', () => {
			this.code = this.feld.value;
			this.aktualisiere();
		});

		this.fehler = rechts.createDiv({ cls: 'anki-mermaid-editor-fehler' });
		this.vorschau = rechts.createDiv({ cls: 'anki-mermaid-editor-vorschau' });

		const leiste = this.contentEl.createDiv({ cls: 'anki-mermaid-editor-leiste' });
		const abbrechen = leiste.createEl('button', { text: 'Abbrechen' });
		abbrechen.addEventListener('click', () => this.close());
		const speichern = leiste.createEl('button', { cls: 'mod-cta', text: 'Speichern' });
		speichern.addEventListener('click', async () => {
			speichern.disabled = true;
			try {
				await this.onSave(this.code);
				this.close();
			} finally {
				speichern.disabled = false;
			}
		});

		this.aktualisiere(0);
	}

	onClose() {
		window.clearTimeout(this.timer);
		this.contentEl.empty();
	}

	private reihe(ziel: HTMLElement, titel: string, gruppe: keyof MermaidEinstellungen, werte: [string, string][]) {
		const r = ziel.createDiv({ cls: 'anki-mermaid-editor-reihe' });
		r.createSpan({ cls: 'anki-mermaid-editor-label', text: titel });
		const g = r.createDiv({ cls: 'anki-mermaid-editor-segment' });
		werte.forEach(([wert, text]) => {
			const el = g.createEl('button', { text });
			el.addEventListener('click', () => {
				const e: Partial<MermaidEinstellungen> = {};
				if (gruppe === 'richtung') e.richtung = wert as Richtung;
				if (gruppe === 'kurve') e.kurve = wert as Kurve;
				if (gruppe === 'abstand') e.abstand = wert as Abstand;
				this.code = setzeEinstellungen(this.code, e);
				this.feld.value = this.code;
				this.aktualisiere(0);
			});
			this.knoepfe.push({ gruppe, wert, el });
		});
	}

	private aktualisiere(verzoegerung = 300) {
		const e = leseEinstellungen(this.code);
		this.knoepfe.forEach((k) => {
			k.el.toggleClass('is-active', e[k.gruppe] === k.wert);
			// Ohne Kopfzeile "flowchart" gibt es keine Richtung.
			(k.el as HTMLButtonElement).disabled = k.gruppe === 'richtung' && e.richtung === null;
		});
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.zeichne(), verzoegerung);
	}

	private async zeichne() {
		const lauf = ++this.lauf;
		let mermaid: any;
		try { mermaid = await loadMermaid(); } catch { mermaid = (window as any).mermaid; }
		if (!mermaid?.render) {
			this.fehler.setText('Vorschau nicht verfügbar.');
			return;
		}
		const id = `anki-mermaid-editor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			const code = repariereMermaid(this.code);
			if (typeof mermaid.parse === 'function') await mermaid.parse(code);
			const r = await mermaid.render(id, code);
			if (lauf !== this.lauf) return; // spaeterer Lauf ist schneller fertig
			const svg = typeof r === 'string' ? r : r?.svg;
			this.vorschau.empty();
			this.vorschau.createDiv({ cls: 'mermaid' }).innerHTML = svg ?? '';
			this.fehler.setText('');
		} catch (e: any) {
			document.getElementById(id)?.remove();
			document.getElementById('d' + id)?.remove();
			if (lauf !== this.lauf) return;
			// Letzte gueltige Vorschau stehen lassen, Fehler darueber zeigen.
			this.fehler.setText('Syntaxfehler: ' + String(e?.message || e).split('\n').slice(0, 3).join(' '));
		}
	}
}
