import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { GRUENDE, LernPunkt } from '../lernplan/lernplanApi';

export const LERNPLAN_VIEW_TYPE = 'anki-lernplan-view';

const ART: Record<string, [string, string]> = {
	widerspruch: ['Korrektur', 'var(--color-yellow, #d4a72c)'], luecke: ['Ergänzung', 'var(--color-cyan, #3fb5b0)'],
	karte: ['Neue Karte', 'var(--color-green, #4caf50)'], antwort: ['Antwort', 'var(--color-blue, #5b9bd5)'],
};

/** Durchgang und Lernchat in der Seitenleiste, dieselben Daten wie in App und Web. */
export class LernplanView extends ItemView {
	private reiter: 'durchgang' | 'chat' = 'durchgang';
	private chatId: number | null = null;
	constructor(leaf: WorkspaceLeaf, private plugin: AnkiGeneratorPlugin) { super(leaf); }
	getViewType() { return LERNPLAN_VIEW_TYPE; }
	getDisplayText() { return 'Lernplan'; }
	getIcon() { return 'graduation-cap'; }

	async onOpen() { await this.zeigen(); }

	oeffneChat() { this.reiter = 'chat'; void this.zeigen(); }

	async zeigen() {
		const c = this.containerEl.children[1] as HTMLElement;
		c.empty();
		c.addClass('anki-lp');
		const kopf = c.createDiv({ cls: 'anki-lp-reiter' });
		for (const [k, name] of [['durchgang', 'Durchgang'], ['chat', 'Lernchat']] as const) {
			const b = kopf.createEl('button', { text: name, cls: this.reiter === k ? 'mod-cta' : '' });
			b.onclick = () => { this.reiter = k; void this.zeigen(); };
		}
		const inhalt = c.createDiv();
		try {
			if (this.reiter === 'durchgang') await this.durchgang(inhalt); else await this.chat(inhalt);
		} catch (e: any) { inhalt.createDiv({ text: e?.message || String(e), cls: 'anki-lp-fehler' }); }
	}

	private async durchgang(el: HTMLElement) {
		const api = this.plugin.lernplanApi;
		const plan = await api.plan();
		const w = plan.vorarbeit || plan.woche;
		if (!w) { el.createDiv({ text: 'Keine laufende Woche.' }); return; }
		if (w.lernziel) el.createEl('p', { text: w.lernziel, cls: 'anki-lp-ziel' });
		const start = el.createEl('button', { text: 'Aufgaben wählen', cls: 'anki-lp-voll' });
		start.onclick = () => void this.plugin.durchgangWaehlen();
		const d = await api.durchgang(w.kw, w.jahr);
		if (!d) return;
		if (d.status === 'angefragt' || d.status === 'laeuft') el.createDiv({ text: 'Durchgang läuft …', cls: 'anki-lp-status' });
		if (d.kurzbefund) el.createDiv({ text: d.kurzbefund, cls: 'anki-lp-befund' });
		for (const p of (d.punkte || []) as LernPunkt[]) {
			if (p.typ in ART) this.punkt(el, p);
		}
	}

	private punkt(el: HTMLElement, p: LernPunkt) {
		const api = this.plugin.lernplanApi;
		const [art, farbe] = ART[p.typ];
		const box = el.createDiv({ cls: 'anki-lp-vor' });
		box.style.setProperty('--c', farbe);
		const fertig = (text: string, rueck: boolean) => {
			box.empty();
			const z = box.createDiv({ cls: 'anki-lp-zu' });
			z.createSpan({ text });
			if (rueck) {
				const r = z.createEl('a', { text: 'Rückgängig' });
				r.onclick = async () => { await this.tun(() => api.punkt(p.id, 'zuruecknehmen')); void this.zeigen(); };
			}
		};
		if (p.status === 'uebernommen') { fertig('Übernommen', false); return; }
		if (p.status === 'verworfen') { fertig('Verworfen', true); return; }
		const kopf = box.createDiv({ cls: 'anki-lp-vkopf' });
		kopf.createEl('b', { text: art });
		kopf.createSpan({ text: p.ueberschrift || (p.pfad || '').split('/').pop()?.replace(/\.md$/, '') || '' });
		if (p.text) this.md(box.createDiv({ cls: 'anki-lp-warum' }), p.text, p.pfad);
		const ansicht = box.createDiv({ cls: 'anki-lp-inhalt' });
		const form = box.createDiv({ cls: 'anki-lp-inhalt' });
		form.hide();
		const felder: Record<string, HTMLTextAreaElement> = {};
		if (p.typ === 'karte') {
			ansicht.createEl('small', { text: 'FRAGE' });
			this.md(ansicht.createDiv(), p.vorne || '', p.pfad);
			ansicht.createEl('small', { text: 'ANTWORT' });
			this.md(ansicht.createDiv(), p.hinten || '', p.pfad);
			form.createEl('small', { text: 'FRAGE' });
			felder.vorne = form.createEl('textarea', { text: p.vorne || '' });
			form.createEl('small', { text: 'ANTWORT' });
			felder.hinten = form.createEl('textarea', { text: p.hinten || '' });
		} else {
			if (p.alt) ansicht.createDiv({ text: p.alt, cls: 'anki-lp-alt' });
			this.md(ansicht.createDiv({ cls: 'anki-lp-neu' }), p.neu || '', p.pfad);
			felder.neu = form.createEl('textarea', { text: p.neu || '' });
		}
		const beleg = (p.belege || []).map((b) => [b.titel, b.seite && `S. ${b.seite}`].filter(Boolean).join(', ')).join(' · ');
		if (beleg) box.createDiv({ text: beleg, cls: 'anki-lp-beleg' });
		const gruende = box.createDiv({ cls: 'anki-lp-gruende' });
		gruende.hide();
		const verwerfen = async (wert: Record<string, unknown>) => { await this.tun(() => api.punkt(p.id, 'verwerfen', wert)); fertig('Verworfen', true); };
		for (const [k, name] of GRUENDE) {
			const b = gruende.createEl('button', { text: name });
			b.onclick = () => void verwerfen({ grund: k });
		}
		const eigen = gruende.createDiv({ cls: 'anki-lp-eigen' });
		const eingabe = eigen.createEl('input', { attr: { placeholder: 'Eigene Begründung' } });
		const ok = eigen.createEl('button', { text: 'Verwerfen' });
		ok.onclick = () => { if (eingabe.value.trim()) void verwerfen({ grund_text: eingabe.value.trim() }); };
		const leiste = box.createDiv({ cls: 'anki-lp-leiste' });
		const uebern = leiste.createEl('button', { text: p.typ === 'karte' ? 'Hinzufügen' : 'Übernehmen', cls: 'mod-cta' });
		const bearb = leiste.createEl('button', { text: 'Bearbeiten' });
		const frag = leiste.createEl('button', { text: 'Fragen' });
		const weg = leiste.createEl('button', { text: 'Verwerfen' });
		let imEdit = false;
		const editSetzen = (an: boolean) => {
			imEdit = an;
			if (an) { form.show(); ansicht.hide(); } else { form.hide(); ansicht.show(); }
			bearb.setText(an ? 'Abbrechen' : 'Bearbeiten');
		};
		bearb.onclick = () => editSetzen(!imEdit);
		uebern.onclick = async () => {
			const wert: Record<string, string> = {};
			if (imEdit) for (const k in felder) wert[k] = felder[k].value;
			if (await this.tun(() => api.punkt(p.id, 'uebernehmen', wert))) fertig('Übernommen', false);
		};
		weg.onclick = () => { if (gruende.isShown()) gruende.hide(); else gruende.show(); };
		frag.onclick = async () => {
			const c = await api.chatAnlegen({ titel: p.ueberschrift || art, pfad: p.pfad });
			this.chatId = c.id;
			this.oeffneChat();
		};
	}

	private async tun<T>(fn: () => Promise<T>): Promise<T | null> {
		try { return await fn(); } catch (e: any) { new Notice(e?.message || String(e)); return null; }
	}

	private md(el: HTMLElement, text: string, pfad?: string) {
		void MarkdownRenderer.render(this.app, text, el, pfad || '', this);
	}

	private einbettung(el: HTMLElement, e: any) {
		const basis = (this.plugin.settings.fitnessManagerUrl || '').replace(/\/$/, '');
		const karte = (farbe: string, titel: string) => {
			const k = el.createDiv({ cls: 'anki-lp-em' });
			k.style.setProperty('--c', farbe);
			k.createEl('b', { text: titel });
			return k;
		};
		if (e.art === 'dosis') {
			const k = karte('var(--color-red, #e05252)', e.suche || 'Dosis');
			for (const a of e.angaben) {
				const z = k.createDiv({ cls: 'anki-lp-dosis' });
				z.createSpan({ text: a.zielgruppe || 'Alle' });
				z.createEl('b', { text: a.text });
				z.createEl('small', { text: [a.beleg || a.quelle, a.seite && `S. ${a.seite}`].filter(Boolean).join(', ') });
			}
			if (e.weitere > 0) k.createDiv({ text: `${e.weitere} weitere Angaben, frag enger nach`, cls: 'anki-lp-status' });
		} else if (e.art === 'vorhaltung') {
			const k = karte('var(--color-blue, #5b9bd5)', 'Auf dem Fahrzeug');
			for (const z of e.eintraege) k.createDiv({ text: `${z.med_key}: ${z.label || ''}${z.package ? ` · ${z.package}` : ''}` });
		} else if (e.art === 'seite' || e.art === 'bild') {
			const k = karte('var(--color-blue, #5b9bd5)', e.titel || (e.seite ? `S. ${e.seite}` : 'Bild'));
			k.createEl('img', { attr: { src: basis + e.bild, alt: e.titel || '' } });
		} else if (e.art === 'rechnung') {
			const k = karte('var(--color-green, #4caf50)', e.ausdruck);
			k.createDiv({ text: e.ergebnis?.text || e.ergebnis?.anzeige || JSON.stringify(e.ergebnis) });
		}
	}

	private async chat(el: HTMLElement) {
		const api = this.plugin.lernplanApi;
		const verlauf = el.createDiv({ cls: 'anki-lp-chat' });
		if (this.chatId) {
			const c = await api.chatLesen(this.chatId);
			for (const m of c.nachrichten) this.nachricht(verlauf, m.rolle, m.content, m.einbettungen);
			for (const p of (c.vorschlaege || []) as LernPunkt[]) if (p.typ in ART) this.punkt(verlauf, p);
		}
		const ein = el.createDiv({ cls: 'anki-lp-ein' });
		const feld = ein.createEl('textarea', { attr: { placeholder: 'Frage', rows: '2' } });
		const senden = ein.createEl('button', { text: 'Senden', cls: 'mod-cta' });
		const los = async () => {
			const text = feld.value.trim();
			if (!text) return;
			feld.value = '';
			senden.disabled = true;
			this.nachricht(verlauf, 'user', text, []);
			const warte = verlauf.createDiv({ text: 'Denkt nach …', cls: 'anki-lp-status' });
			try {
				if (!this.chatId) {
					const datei = this.app.workspace.getActiveFile();
					this.chatId = (await api.chatAnlegen({ titel: text.slice(0, 80), pfad: datei?.extension === 'md' ? datei.path : undefined })).id;
				}
				const ev = await api.chatFragen(this.chatId as number, text);
				warte.remove();
				const em = ev.filter((x) => x.einbettung).map((x) => x.einbettung);
				const antwort = ev.find((x) => x.type === 'text')?.text || '';
				this.nachricht(verlauf, 'ai', antwort, em);
				for (const x of ev) {
					if (x.type === 'fehler') verlauf.createDiv({ text: x.text, cls: 'anki-lp-fehler' });
					if (x.type === 'vorschlag' && x.punkt && x.punkt.typ in ART) this.punkt(verlauf, x.punkt);
				}
			} catch (e: any) { warte.remove(); verlauf.createDiv({ text: e?.message || String(e), cls: 'anki-lp-fehler' }); } finally { senden.disabled = false; }
		};
		senden.onclick = () => void los();
		feld.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void los(); } };
	}

	private nachricht(el: HTMLElement, rolle: string, text: string, einbettungen: any[]) {
		if (rolle === 'user') { el.createDiv({ text, cls: 'anki-lp-du' }); return; }
		for (const e of einbettungen || []) this.einbettung(el, e);
		if (text) this.md(el.createDiv({ cls: 'anki-lp-ki' }), text);
	}
}
