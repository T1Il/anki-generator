import { ItemView, MarkdownRenderer, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
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
		const inhalt = c.createDiv({ cls: 'anki-lp-inhalt-raum' });
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

	/** Neue PDF-Seiten brauchen etwas. Scheitert der Abruf, zum Beispiel beim Neustart des Servers, versucht es das Plugin erneut. */
	private bild(el: HTMLElement, src: string, alt: string, versuch = 0) {
		const rahmen = versuch ? el : el.createDiv({ cls: 'anki-lp-bild', text: 'Abbildung lädt' });
		const img = document.createElement('img');
		img.alt = alt;
		img.onload = () => { rahmen.empty(); rahmen.removeClass('anki-lp-bild'); rahmen.appendChild(img); };
		img.onerror = () => {
			if (versuch < 3) { window.setTimeout(() => this.bild(rahmen, src, alt, versuch + 1), 8000); return; }
			rahmen.empty();
			const nochmal = rahmen.createEl('button', { cls: 'anki-lp-textknopf', text: 'Abbildung erneut laden' });
			nochmal.onclick = () => { rahmen.setText('Abbildung lädt'); this.bild(rahmen, src, alt, 1); };
		};
		img.src = src;
	}

	private einbettung(el: HTMLElement, e: any) {
		const basis = (this.plugin.settings.fitnessManagerUrl || '').replace(/\/$/, '');
		const karte = (farbe: string, zeichen: string, titel: string, rechts?: string) => {
			const k = el.createDiv({ cls: 'anki-lp-em' });
			k.style.setProperty('--c', farbe);
			const kopf = k.createDiv({ cls: 'anki-lp-ek' });
			kopf.createSpan({ cls: 'anki-lp-ico', text: zeichen });
			kopf.createEl('b', { text: titel });
			if (rechts) kopf.createEl('em', { text: rechts });
			if (['seite', 'bild', 'grafik'].includes(e.art)) {
				k.addClass('is-klappbar');
				kopf.setAttribute('role', 'button');
				kopf.setAttribute('tabindex', '0');
				kopf.setAttribute('aria-expanded', 'true');
				const klappen = () => kopf.setAttribute('aria-expanded', String(!k.classList.toggle('is-zu')));
				kopf.onclick = klappen;
				kopf.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); klappen(); } };
			}
			return k;
		};
		const ROT = 'var(--lp-dosis)', BLAU = 'var(--lp-lern)', GRUEN = 'var(--lp-moos)';
		if (e.art === 'dosis') {
			const k = karte(ROT, '℞', e.suche || 'Dosis');
			for (const a of e.angaben) {
				const z = k.createDiv({ cls: 'anki-lp-dosis' });
				z.createSpan({ text: a.zielgruppe || 'Alle' });
				z.createEl('b', { text: a.text });
				z.createEl('small', { text: [a.beleg || a.quelle, a.seite && `S. ${a.seite}`].filter(Boolean).join(', ') });
			}
			if (e.weitere > 0) k.createDiv({ text: `${e.weitere} weitere Angaben, frag enger nach`, cls: 'anki-lp-fuss' });
		} else if (e.art === 'vorhaltung') {
			const k = karte(BLAU, '▤', 'Auf dem Fahrzeug', 'Vorhaltung');
			for (const z of e.eintraege) k.createDiv({ cls: 'anki-lp-zeile', text: `${z.med_key}: ${z.label || ''}${z.package ? `, ${z.package}` : ''}` });
		} else if (e.art === 'seite') {
			const k = karte(BLAU, '▦', e.titel || 'Abbildung', `S. ${e.seite}`);
			const ziel = e.zotero ? k.createEl('a', { href: e.zotero, cls: 'anki-lp-bildlink' }) : k;
			this.bild(ziel, basis + e.bild, e.titel || '');
			if (e.zotero) k.createEl('a', { cls: 'anki-lp-fuss anki-lp-zotero', href: e.zotero, text: 'In Zotero öffnen' });
		} else if (e.art === 'bild') {
			const k = karte(BLAU, 'N', e.titel || 'Bild', 'Notiz');
			this.bild(k, basis + e.bild, e.titel || '');
		} else if (e.art === 'grafik') {
			const k = karte(GRUEN, '✎', e.titel, 'Eigene Skizze');
			k.createEl('img', { cls: 'anki-lp-grafik', attr: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(e.svg)}`, alt: e.titel } });
		} else if (e.art === 'rechnung') {
			const k = karte(GRUEN, '=', e.ausdruck, 'Rechner');
			k.createDiv({ cls: 'anki-lp-zeile anki-lp-stark', text: e.ergebnis?.text || e.ergebnis?.anzeige || JSON.stringify(e.ergebnis) });
		}
	}

	private async chat(el: HTMLElement) {
		const api = this.plugin.lernplanApi;
		el.addClass('anki-lp-chatflaeche');
		const kopf = el.createDiv({ cls: 'anki-lp-chatkopf' });
		const titel = kopf.createDiv({ cls: 'anki-lp-chattitel', text: 'Lernchat' });
		const verlaufKnopf = kopf.createEl('button', { cls: 'anki-lp-textknopf', text: 'Verlauf' });
		const neuKnopf = kopf.createEl('button', { cls: 'anki-lp-textknopf', text: 'Neu' });
		const verlauf = el.createDiv({ cls: 'anki-lp-chat' });

		const liste = async () => {
			verlauf.empty();
			verlauf.createDiv({ cls: 'anki-lp-fab', text: 'Letzte Chats' });
			const chats = await api.chatListe();
			for (const c of chats) {
				const b = verlauf.createEl('button', { cls: `anki-lp-fzeile${c.id === this.chatId ? ' is-aktiv' : ''}` });
				b.createDiv({ cls: 'anki-lp-ftext', text: c.titel || 'Lernchat' });
				b.onclick = () => { this.chatId = c.id; void this.zeigen(); };
			}
			if (!chats.length) verlauf.createDiv({ cls: 'anki-lp-fleer', text: 'Noch keine Chats' });
		};
		let listeOffen = false;
		verlaufKnopf.onclick = () => { listeOffen = !listeOffen; if (listeOffen) void liste(); else void this.zeigen(); };
		neuKnopf.onclick = () => { this.chatId = null; void this.zeigen(); };

		if (this.chatId) {
			const c = await api.chatLesen(this.chatId);
			titel.setText(c.titel || 'Lernchat');
			for (const m of c.nachrichten) this.nachricht(verlauf, m.rolle, m.content, m.einbettungen);
			for (const p of (c.vorschlaege || []) as LernPunkt[]) if (p.typ in ART) this.punkt(verlauf, p);
			verlauf.scrollTop = verlauf.scrollHeight;
		} else await liste();

		const ein = el.createDiv({ cls: 'anki-lp-ein' });
		const feld = ein.createEl('textarea', { attr: { placeholder: 'Frage', rows: '1' } });
		const senden = ein.createEl('button', { cls: 'anki-lp-senden', attr: { 'aria-label': 'Senden' } });
		setIcon(senden, 'arrow-up');
		feld.oninput = () => { feld.style.height = 'auto'; feld.style.height = `${Math.min(feld.scrollHeight, 160)}px`; };
		const los = async () => {
			const text = feld.value.trim();
			if (!text || senden.disabled) return;
			feld.value = '';
			feld.style.height = 'auto';
			senden.disabled = true;
			if (!this.chatId) verlauf.empty();
			this.nachricht(verlauf, 'user', text, []);
			const warte = verlauf.createDiv({ text: 'Sucht in den Quellen', cls: 'anki-lp-arbeit' });
			const start = Date.now();
			const uhr = window.setInterval(() => {
				const s = Math.round((Date.now() - start) / 1000);
				warte.setText(`Sucht in den Quellen, ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
			}, 1000);
			verlauf.scrollTop = verlauf.scrollHeight;
			try {
				if (!this.chatId) {
					const datei = this.app.workspace.getActiveFile();
					this.chatId = (await api.chatAnlegen({ titel: text.slice(0, 80), pfad: datei?.extension === 'md' ? datei.path : undefined })).id;
					titel.setText(text.slice(0, 80));
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
			} catch (e: any) { warte.remove(); verlauf.createDiv({ text: e?.message || String(e), cls: 'anki-lp-fehler' }); } finally {
				window.clearInterval(uhr);
				senden.disabled = false;
				verlauf.scrollTop = verlauf.scrollHeight;
			}
		};
		senden.onclick = () => void los();
		feld.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void los(); } };
		feld.focus();
	}

	private nachricht(el: HTMLElement, rolle: string, text: string, einbettungen: any[]) {
		if (rolle === 'user') { el.createDiv({ text, cls: 'anki-lp-du' }); return; }
		for (const e of einbettungen || []) this.einbettung(el, e);
		if (text) this.md(el.createDiv({ cls: 'anki-lp-ki' }), text);
	}
}
