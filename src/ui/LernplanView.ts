import { ItemView, Keymap, MarkdownRenderer, Menu, Notice, PaneType, setIcon, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { chatGruppen, chatZeit, DENKTIEFEN, GRUENDE, LernChatKopf, LernPunkt, MODELLE } from '../lernplan/lernplanApi';
import { bildAlsPng, bildBedienbar, kopierenMitRueckmeldung, svgAdresse, svgAlsPng } from './lernBild';
import { NameModal } from './LernplanModals';
import { linkSucheAnbinden } from './linkSuche';
import { LinkFeld } from './linkFeld';


export const LERNPLAN_VIEW_TYPE = 'anki-lernplan-view';

const ART: Record<string, [string, string]> = {
	widerspruch: ['Korrektur', 'var(--color-yellow, #d4a72c)'], luecke: ['Ergänzung', 'var(--color-cyan, #3fb5b0)'],
	karte: ['Neue Karte', 'var(--color-green, #4caf50)'], antwort: ['Antwort', 'var(--color-blue, #5b9bd5)'],
};

/** Durchgang und Lernchat in der Seitenleiste, dieselben Daten wie in App und Web. */
export class LernplanView extends ItemView {
	private reiter: 'durchgang' | 'chat' = 'durchgang';
	private chatId: number | null = null;
	private chatPfad: string | null = null;
	private archiv = false;
	private suche = '';
	private notizChip: (() => void) | null = null;
	private vorlage: string | null = null;
	constructor(leaf: WorkspaceLeaf, private plugin: AnkiGeneratorPlugin) { super(leaf); }

	getState() { return { reiter: this.reiter, chatId: this.chatId }; }
	async setState(state: any, result: ViewStateResult) {
		if (state?.reiter === 'chat' || state?.reiter === 'durchgang') this.reiter = state.reiter;
		if (typeof state?.chatId === 'number' || state?.chatId === null) this.chatId = state.chatId;
		await super.setState(state, result);
		await this.zeigen();
	}

	/** Liegt die Ansicht im Hauptbereich statt in einer Seitenleiste? */
	private istGross() { return this.leaf.getRoot() === this.app.workspace.rootSplit; }
	getViewType() { return LERNPLAN_VIEW_TYPE; }
	getDisplayText() { return 'Lernplan'; }
	getIcon() { return 'graduation-cap'; }

	async onOpen() {
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.notizChip?.()));
		await this.zeigen();
	}

	oeffneChat() { this.reiter = 'chat'; void this.zeigen(); }

	/** Markierten Text als Zitat in einen neuen Chat; die Notiz der Markierung wird der Bezug. */
	fragenMitAuswahl(text: string) {
		this.chatId = null;
		this.vorlage = `${text.trim().split('\n').map((z) => `> ${z.replace(/^(\s*>)+\s?/, '')}`).join('\n')}\n\n`;
		this.oeffneChat();
	}

	private offeneNotiz(): TFile | null {
		const f = this.app.workspace.getActiveFile();
		return f && f.extension === 'md' ? f : null;
	}

	/** Geblätterte Woche im Reiter Durchgang; null = die laufende. */
	private gewaehlt: { kw: number; jahr: number } | null = null;

	async zeigen() {
		const c = this.containerEl.children[1] as HTMLElement;
		c.empty();
		c.addClass('anki-lp');
		c.toggleClass('is-gross', this.istGross());
		this.notizChip = null;
		const kopf = c.createDiv({ cls: 'anki-lp-reiter' });
		for (const [k, name] of [['durchgang', 'Durchgang'], ['chat', 'Lernchat']] as const) {
			const b = kopf.createEl('button', { text: name, cls: this.reiter === k ? 'mod-cta' : '' });
			b.onclick = () => { this.reiter = k; void this.zeigen(); };
		}
		if (!this.istGross()) {
			const gross = kopf.createEl('button', { cls: 'anki-lp-ikon anki-lp-gross', attr: { 'aria-label': 'Groß öffnen', title: 'Groß öffnen' } });
			setIcon(gross, 'maximize-2');
			gross.onclick = () => void this.plugin.lernplanGross(this.reiter, this.chatId);
		}
		const inhalt = c.createDiv({ cls: 'anki-lp-inhalt-raum' });
		try {
			if (this.reiter === 'durchgang') await this.durchgang(inhalt); else await this.chat(inhalt);
		} catch (e: any) { inhalt.createDiv({ text: e?.message || String(e), cls: 'anki-lp-fehler' }); }
	}

	private async durchgang(el: HTMLElement) {
		const api = this.plugin.lernplanApi;
		const plan = await api.plan();
		el.addClass('anki-lp-dg');
		const basis = plan.woche || plan.vorarbeit;
		if (!basis) { el.createDiv({ text: 'Keine laufende Woche.', cls: 'anki-lp-leer' }); return; }
		const fremd = this.gewaehlt && !(this.gewaehlt.kw === basis.kw && this.gewaehlt.jahr === basis.jahr) ? this.gewaehlt : null;
		// Von der laufenden Woche aus mit `auch_spaeter`: so bleibt ihr Durchgang mit offenen Punkten sichtbar,
		// auch wenn schon die Vorarbeit für die nächste Woche läuft; ein neuerer Lauf der Vorarbeit gewinnt.
		// Geblättert (z. B. Vorwoche): genau deren Durchgang.
		const d = fremd ? await api.durchgang(fremd.kw, fremd.jahr, false) : await api.durchgang(basis.kw, basis.jahr);
		const w = fremd ? await api.woche(fremd.kw, fremd.jahr)
			: (d?.kw && [plan.woche, plan.vorarbeit].find((x: any) => x?.kw === d.kw)) || plan.vorarbeit || plan.woche;
		if (w.lernziel) {
			const ziel = el.createDiv({ text: w.lernziel, cls: 'anki-lp-ziel', attr: { title: 'Lernziel' } });
			ziel.onclick = () => ziel.toggleClass('is-offen', !ziel.hasClass('is-offen'));
		}
		const punkte = ((d?.punkte || []) as LernPunkt[]).filter((p) => p.typ in ART);
		const offen = punkte.filter((p) => p.status === 'offen');
		const erledigt = punkte.filter((p) => p.status !== 'offen');
		const laeuft = d && (d.status === 'angefragt' || d.status === 'laeuft');
		const weg = d && !laeuft && !offen.length && this.plugin.settings.lernplanAusgeblendet === d.id;

		const zeile = el.createDiv({ cls: 'anki-lp-dzeile' });
		const links = zeile.createDiv();
		const blaettern = (tage: number) => {
			const ziel = isoWoche(w.von, tage);
			if (!ziel) return;
			this.gewaehlt = ziel.kw === basis.kw && ziel.jahr === basis.jahr ? null : ziel;
			void this.zeigen();
		};
		const zurueck = links.createEl('button', { cls: 'anki-lp-ikon anki-lp-blatt', attr: { 'aria-label': 'Vorherige Woche', title: 'Vorherige Woche' } });
		setIcon(zurueck, 'chevron-left');
		zurueck.onclick = () => blaettern(-7);
		links.createEl('b', { text: `KW ${w.kw}` });
		const vor = links.createEl('button', { cls: 'anki-lp-ikon anki-lp-blatt', attr: { 'aria-label': 'Nächste Woche', title: 'Nächste Woche' } });
		setIcon(vor, 'chevron-right');
		vor.onclick = () => blaettern(7);
		if (fremd) {
			const heute = links.createEl('button', { text: 'Diese Woche', cls: 'anki-lp-textknopf anki-lp-leise' });
			heute.onclick = () => { this.gewaehlt = null; void this.zeigen(); };
		}
		const stand = !d || weg ? 'kein offener Durchgang'
			: laeuft ? 'Durchgang läuft'
			: d.status === 'fehlgeschlagen' ? 'Durchgang fehlgeschlagen'
			: offen.length ? `${offen.length} offen · ${punkte.length} Punkte` : `${punkte.length} Punkte, alles entschieden`;
		links.createSpan({ text: stand, cls: laeuft ? 'is-laeuft' : '' });
		const start = zeile.createEl('button', { text: 'Neuer Durchgang', cls: 'anki-lp-textknopf' });
		start.onclick = () => void this.plugin.durchgangWaehlen(fremd ? { kw: w.kw, jahr: w.jahr } : undefined);
		if (!d) return;
		if (weg) {
			const z = el.createEl('button', { text: 'Letzten Durchgang zeigen', cls: 'anki-lp-textknopf anki-lp-leise' });
			z.onclick = async () => { this.plugin.settings.lernplanAusgeblendet = undefined; await this.plugin.saveSettings(); void this.zeigen(); };
			return;
		}
		if (d.status === 'fehlgeschlagen' && d.fehler) el.createDiv({ text: d.fehler, cls: 'anki-lp-fehler' });
		if (d.kurzbefund) {
			const befund = el.createEl('details', { cls: 'anki-lp-befund' });
			if (offen.length) befund.open = true;
			befund.createEl('summary', { text: 'Befund' });
			this.md(befund.createDiv({ cls: 'anki-lp-befundtext' }), d.kurzbefund);
		}
		const offenBox = el.createDiv({ cls: 'anki-lp-offen' });
		const zaehlen = () => {
			const n = offenBox.querySelectorAll(':scope > .anki-lp-vor:not(.is-zu)').length;
			links.querySelector('span')?.setText(n ? `${n} offen · ${punkte.length} Punkte` : `${punkte.length} Punkte, alles entschieden`);
		};
		for (const p of offen) this.punkt(offenBox, p, zaehlen);
		if (erledigt.length) {
			const liste = el.createEl('details', { cls: 'anki-lp-erledigt' });
			const zahl = (s: string) => erledigt.filter((p) => p.status === s).length;
			liste.createEl('summary', { text: [`${zahl('uebernommen')} übernommen`, zahl('verworfen') && `${zahl('verworfen')} verworfen`].filter(Boolean).join(' · ') });
			for (const p of erledigt) this.punkt(liste, p, zaehlen);
		}
		if (!offen.length && !laeuft) {
			const fuss = el.createDiv({ cls: 'anki-lp-dfuss' });
			const aus = fuss.createEl('button', { text: 'Ausblenden', cls: 'anki-lp-textknopf anki-lp-leise' });
			aus.onclick = async () => { this.plugin.settings.lernplanAusgeblendet = d.id; await this.plugin.saveSettings(); void this.zeigen(); };
		}
	}

	/** Ein Vorschlag. Entschiedene erscheinen knapp mit Titel, Inhalt zum Aufklappen und Rückgängig; `nachher` zeichnet etwa den Durchgang neu. */
	private punkt(el: HTMLElement, p: LernPunkt, nachher?: () => void) {
		this.punktZeichnen(el.createDiv(), p, nachher);
	}

	private punktZeichnen(box: HTMLElement, p: LernPunkt, nachher?: () => void) {
		const api = this.plugin.lernplanApi;
		const [art, farbe] = ART[p.typ];
		box.empty();
		box.className = 'anki-lp-vor';
		box.style.setProperty('--c', farbe);
		const neu = (r: LernPunkt | null) => {
			if (!r) return;
			// Nur dieser Vorschlag wechselt sein Aussehen; die Ansicht bleibt stehen. `nachher` zählt danach nach.
			this.punktZeichnen(box, { ...p, ...r }, nachher);
			nachher?.();
		};
		const titelText = p.ueberschrift || (p.pfad || '').split('/').pop()?.replace(/\.md$/, '') || art;
		const inhalt = (ziel: HTMLElement) => {
			if (p.typ === 'karte') {
				ziel.createEl('small', { text: 'FRAGE' });
				this.md(ziel.createDiv(), p.vorne || '', p.pfad);
				ziel.createEl('small', { text: 'ANTWORT' });
				this.md(ziel.createDiv(), p.hinten || '', p.pfad);
			} else {
				if (p.alt) ziel.createDiv({ text: p.alt, cls: 'anki-lp-alt' });
				this.md(ziel.createDiv({ cls: 'anki-lp-neu' }), p.neu || '', p.pfad);
			}
		};

		if (p.status === 'uebernommen' || p.status === 'verworfen' || p.status === 'gesehen') {
			box.addClass('is-zu');
			const zeile = box.createDiv({ cls: 'anki-lp-zu' });
			const status = p.status === 'verworfen' ? 'Verworfen' : p.typ === 'karte' ? 'Karte hinzugefügt' : 'Übernommen';
			setIcon(zeile.createSpan({ cls: 'anki-lp-zu-zeichen' }), p.status === 'verworfen' ? 'x' : 'check');
			const t = zeile.createDiv({ cls: 'anki-lp-zu-text' });
			t.createSpan({ text: titelText });
			const notiz = p.pfad ? p.pfad.split('/').pop()?.replace(/\.md$/, '') : '';
			t.createEl('small', { text: [status, art !== status ? art : '', notiz].filter(Boolean).join(' · ') });
			const knoepfe = zeile.createDiv({ cls: 'anki-lp-zu-knoepfe' });
			const ansehen = knoepfe.createEl('button', { cls: 'anki-lp-ikon', attr: { 'aria-label': 'Ansehen', title: 'Ansehen' } });
			setIcon(ansehen, 'chevron-down');
			if (p.status === 'verworfen' || p.rueckbar) {
				const r = knoepfe.createEl('button', { cls: 'anki-lp-ikon', attr: { 'aria-label': 'Rückgängig', title: p.status === 'verworfen' ? 'Wieder öffnen' : 'Rückgängig: Notiz auf den Stand davor' } });
				setIcon(r, 'undo-2');
				r.onclick = async () => neu(await this.tun(() => this.imVault(p, 'zuruecknehmen')));
			}
			const koerper = box.createDiv({ cls: 'anki-lp-inhalt anki-lp-zu-inhalt' });
			koerper.hide();
			let gefuellt = false;
			ansehen.onclick = () => {
				if (!gefuellt) {
					gefuellt = true;
					inhalt(koerper);
					if (p.grund || p.grund_text) koerper.createDiv({ cls: 'anki-lp-beleg', text: `Grund: ${p.grund_text || GRUENDE.find(([k]) => k === p.grund)?.[1] || p.grund}` });
					if (p.pfad) {
						const a = koerper.createEl('a', { cls: 'anki-lp-zu-link', text: `In ${notiz || 'Notiz'} ansehen` });
						a.onclick = (ev) => void this.zurStelle(p, Keymap.isModEvent(ev));
					}
				}
				const offen = !koerper.isShown();
				koerper.toggle(offen);
				ansehen.toggleClass('is-an', offen);
			};
			return;
		}

		const kopf = box.createDiv({ cls: 'anki-lp-vkopf' });
		kopf.createEl('b', { text: art });
		if (p.pfad) {
			const zu = kopf.createEl('a', { cls: 'anki-lp-zurstelle', text: titelText, attr: { title: `Zur Stelle in ${p.pfad.split('/').pop()?.replace(/\.md$/, '')}` } });
			setIcon(zu.createSpan(), 'arrow-up-right');
			zu.onclick = (ev) => void this.zurStelle(p, Keymap.isModEvent(ev));
		} else kopf.createSpan({ text: titelText });
		if (p.status === 'konflikt') box.createDiv({ cls: 'anki-lp-fehler anki-lp-warum', text: 'Die Stelle steht so nicht mehr in der Notiz. Bearbeiten oder verwerfen.' });
		if (p.text) this.md(box.createDiv({ cls: 'anki-lp-warum' }), p.text, p.pfad);
		const ansicht = box.createDiv({ cls: 'anki-lp-inhalt' });
		const form = box.createDiv({ cls: 'anki-lp-inhalt' });
		form.hide();
		const felder: Record<string, HTMLTextAreaElement> = {};
		inhalt(ansicht);
		if (p.typ === 'karte') {
			form.createEl('small', { text: 'FRAGE' });
			felder.vorne = form.createEl('textarea', { text: p.vorne || '' });
			form.createEl('small', { text: 'ANTWORT' });
			felder.hinten = form.createEl('textarea', { text: p.hinten || '' });
		} else felder.neu = form.createEl('textarea', { text: p.neu || '' });
		const beleg = (p.belege || []).map((b) => [b.titel, b.seite && `S. ${b.seite}`].filter(Boolean).join(', ')).join(' · ');
		if (beleg) box.createDiv({ text: beleg, cls: 'anki-lp-beleg' });
		const gruende = box.createDiv({ cls: 'anki-lp-gruende' });
		gruende.hide();
		const verwerfen = async (wert: Record<string, unknown>) => neu(await this.tun(() => api.punkt(p.id, 'verwerfen', wert)));
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
		if (p.typ === 'karte') {
			// Neu generieren: eigene Zeile über der Leiste, damit die vier Knöpfe in der Seitenleiste lesbar bleiben.
			const neuZeile = createDiv({ cls: 'anki-lp-neuzeile' });
			leiste.before(neuZeile);
			const hinweis = neuZeile.createEl('input', { attr: { type: 'text', placeholder: 'Hinweis (optional)' } });
			const los = neuZeile.createEl('button', { cls: 'anki-lp-neuknopf', attr: { title: 'Karte neu generieren' } });
			setIcon(los.createSpan(), 'refresh-cw');
			los.createSpan({ text: 'Neu generieren' });
			const starten = async () => {
				los.disabled = true; hinweis.disabled = true;
				los.addClass('is-laeuft');
				const s = this.plugin.settings;
				const r = await this.tun(() => api.karteNeu(p.id, hinweis.value, { modell: s.lernchatModell || undefined, denken: s.lernchatDenken || undefined }));
				if (r) this.punktZeichnen(box, { ...p, ...r }, nachher);
				else { los.disabled = false; hinweis.disabled = false; los.removeClass('is-laeuft'); }
			};
			los.onclick = () => void starten();
			hinweis.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void starten(); } };
		}
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
			uebern.disabled = true;
			const r = await this.tun(() => this.imVault(p, 'uebernehmen', wert));
			uebern.disabled = false;
			if (r?.status === 'konflikt') new Notice('Die Stelle steht so nicht mehr in der Notiz.');
			neu(r);
		};
		weg.onclick = () => { if (gruende.isShown()) gruende.hide(); else gruende.show(); };
		frag.onclick = async () => {
			const c = await api.chatAnlegen({ titel: p.ueberschrift || art, pfad: p.pfad });
			this.chatId = c.id;
			this.oeffneChat();
		};
	}

	/**
	 * Zur Stelle eines Vorschlags: Anker vom Server (`stelle`: #^block oder #Überschrift) öffnen, dann den
	 * betroffenen Text markieren. Gesucht wird, was jetzt dasteht: alt (Korrektur offen), neu (übernommen),
	 * die Zeile davor (Ergänzung), die Frage (Karte).
	 */
	private async zurStelle(p: LernPunkt, neuerTab: PaneType | boolean) {
		if (!p.pfad) return;
		let ziel = p.pfad.replace(/\.md$/, '');
		const datei = p.stelle?.match(/[?&]file=([^&]+)/)?.[1];
		if (datei) { try { ziel = decodeURIComponent(datei); } catch { /* Pfad bleibt */ } }
		await this.app.workspace.openLinkText(ziel, '', neuerTab || (this.istGross() ? 'tab' : false));
		const ed = this.app.workspace.activeEditor?.editor;
		if (!ed) return;
		const inhalt = ed.getValue();
		const kandidaten: (string | null | undefined)[] = [...(p.status === 'uebernommen' ? [p.neu, p.alt] : [p.alt, p.neu]), p.nach, p.zeile, p.vorne ? `Q: ${p.vorne}` : null];
		for (const k of kandidaten) {
			const zeile = (k || '').split('\n').map((z) => z.trim().replace(/^[-*>]+\s*/, '')).find((z) => z.length > 6);
			if (!zeile) continue;
			const stelle = inhalt.indexOf(zeile.slice(0, 80));
			if (stelle < 0) continue;
			const von = ed.offsetToPos(stelle), bis = ed.offsetToPos(stelle + Math.min(zeile.length, 80));
			ed.setSelection(von, bis);
			ed.scrollIntoView({ from: von, to: bis }, true);
			return;
		}
	}

	/**
	 * Übernehmen/Zurücknehmen im eigenen Vault (24.11.2026): die betroffenen Notizen gehen mit, der Server
	 * rechnet darauf und schreibt nichts — das Server-Obsidian steht z. B. bei jedem APK-Bau still. Geschrieben
	 * wird hier, und nur, wenn die Notiz seit dem Absenden unverändert ist.
	 */
	private async imVault(p: LernPunkt, aktion: string, wert: Record<string, unknown> = {}): Promise<LernPunkt> {
		const lokal: Record<string, string> = {};
		for (const pfad of [p.pfad, p.lernplan_notiz]) {
			const f = pfad ? this.app.vault.getAbstractFileByPath(pfad) : null;
			if (pfad && f instanceof TFile) lokal[pfad] = await this.app.vault.read(f);
		}
		const r = await this.plugin.lernplanApi.punktLokal(p.id, aktion, wert, lokal);
		const fehler: string[] = [];
		for (const s of r.schreiben) {
			const f = this.app.vault.getAbstractFileByPath(s.pfad);
			try {
				if (f instanceof TFile) {
					await this.app.vault.process(f, (jetzt) => {
						if (s.pfad in lokal && jetzt !== lokal[s.pfad]) throw new Error('inzwischen geändert');
						return s.text;
					});
				} else await this.app.vault.create(s.pfad, s.text);
			} catch (e: any) { fehler.push(`${s.pfad.split('/').pop()?.replace(/\.md$/, '')}: ${e?.message || e}`); }
		}
		if (fehler.length) new Notice(`Nicht geschrieben — ${fehler.join('; ')}. Rückgängig und nochmal übernehmen.`, 10000);
		return r.punkt;
	}

	private async tun<T>(fn: () => Promise<T>): Promise<T | null> {
		try { return await fn(); } catch (e: any) { new Notice(e?.message || String(e)); return null; }
	}

	/** Markdown wie in Obsidian, Wikilinks auf Notizen, Überschriften und Blöcke anklickbar und mit Vorschau. */
	private md(el: HTMLElement, text: string, pfad?: string) {
		const quelle = pfad || this.chatPfad || '';
		void MarkdownRenderer.render(this.app, text, el, quelle, this);
		el.addEventListener('click', (ev) => {
			const a = (ev.target as HTMLElement).closest('a.internal-link') as HTMLAnchorElement | null;
			if (!a) return;
			ev.preventDefault();
			const ziel = a.getAttribute('data-href') || a.getAttribute('href');
			if (ziel) void this.app.workspace.openLinkText(ziel, quelle, Keymap.isModEvent(ev) || (this.istGross() ? false : 'tab'));
		});
		el.addEventListener('mouseover', (ev) => {
			const a = (ev.target as HTMLElement).closest('a.internal-link') as HTMLAnchorElement | null;
			const ziel = a?.getAttribute('data-href');
			if (a && ziel) this.app.workspace.trigger('hover-link', { event: ev, source: LERNPLAN_VIEW_TYPE, hoverParent: this, targetEl: a, linktext: ziel, sourcePath: quelle });
		});
		el.querySelectorAll('img').forEach((img) => bildBedienbar(this.app, img as HTMLImageElement, (img as HTMLImageElement).alt, () => bildAlsPng((img as HTMLImageElement).src)));
	}

	/** Neue PDF-Seiten brauchen etwas. Scheitert der Abruf, zum Beispiel beim Neustart des Servers, versucht es das Plugin erneut. */
	private bild(el: HTMLElement, src: string, alt: string, versuch = 0, extern?: string) {
		const rahmen = versuch ? el : el.createDiv({ cls: 'anki-lp-bild', text: 'Abbildung lädt' });
		const img = document.createElement('img');
		img.alt = alt;
		img.onload = () => {
			rahmen.empty(); rahmen.removeClass('anki-lp-bild'); rahmen.appendChild(img);
			bildBedienbar(this.app, img, alt, () => bildAlsPng(src), extern, () => void this.bildInNotiz(() => bildAlsPng(src), alt));
		};
		img.onerror = () => {
			if (versuch < 3) { window.setTimeout(() => this.bild(rahmen, src, alt, versuch + 1, extern), 8000); return; }
			rahmen.empty();
			const nochmal = rahmen.createEl('button', { cls: 'anki-lp-textknopf', text: 'Abbildung erneut laden' });
			nochmal.onclick = () => { rahmen.setText('Abbildung lädt'); this.bild(rahmen, src, alt, 1, extern); };
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
				const z = k.createDiv({ cls: 'anki-lp-dosis' + ((a.text || '').length > 40 ? ' lang' : '') });
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
			this.bild(k, basis + e.bild, e.titel || '', 0, e.zotero);
			this.bildFuss(k, () => bildAlsPng(basis + e.bild), e.titel || `Seite ${e.seite}`, e.zotero);
		} else if (e.art === 'bild') {
			const k = karte(BLAU, 'N', e.titel || 'Bild', 'Notiz');
			this.bild(k, basis + e.bild, e.titel || '');
			this.bildFuss(k, () => bildAlsPng(basis + e.bild), e.titel || 'Abbildung');
		} else if (e.art === 'grafik') {
			const k = karte(GRUEN, '✎', e.titel, 'Eigene Skizze');
			const img = k.createEl('img', { cls: 'anki-lp-grafik', attr: { src: svgAdresse(e.svg), alt: e.titel } });
			bildBedienbar(this.app, img, e.titel, () => svgAlsPng(e.svg), undefined, () => void this.bildInNotiz(() => svgAlsPng(e.svg), e.titel));
			this.bildFuss(k, () => svgAlsPng(e.svg), e.titel || 'Skizze');
		} else if (e.art === 'quelle') {
			const k = karte(BLAU, '⊕', e.titel, [e.herausgeber, e.jahr].filter(Boolean).join(' · ') || undefined);
			const fuss = k.createDiv({ cls: 'anki-lp-fuss anki-lp-grafikfuss' });
			fuss.createEl('a', { cls: 'anki-lp-zotero', href: e.url, text: 'Quelle öffnen' });
			const knopf = fuss.createEl('button', { cls: 'anki-lp-textknopf', text: 'In Zotero ablegen' });
			knopf.onclick = async () => {
				knopf.disabled = true;
				knopf.setText('Lege ab …');
				try {
					const r = await this.plugin.lernplanApi.quelleAblegen(e);
					knopf.setText(r.status === 'war schon drin' ? 'War schon drin' : r.seiten ? `Abgelegt · ${r.seiten} Seiten` : 'Abgelegt · ohne PDF');
				} catch (err: any) {
					knopf.disabled = false;
					knopf.setText(`Nicht abgelegt: ${err?.message || err}`);
				}
			};
		} else if (e.art === 'rechnung') {
			const k = karte(GRUEN, '=', e.ausdruck, 'Rechner');
			k.createDiv({ cls: 'anki-lp-zeile anki-lp-stark', text: e.ergebnis?.text || e.ergebnis?.anzeige || JSON.stringify(e.ergebnis) });
		}
	}

	/** Bild als PNG neben die Notiz (Anhangsordner aus den Obsidian-Einstellungen) und an der Schreibmarke einbetten. */
	private async bildInNotiz(png: () => Promise<Blob>, titel: string) {
		const pfad = this.chatPfad || this.offeneNotiz()?.path;
		const ziel = pfad ? this.app.vault.getAbstractFileByPath(pfad) : null;
		if (!(ziel instanceof TFile)) { new Notice('Keine Notiz offen.'); return; }
		try {
			const name = (titel || 'Lernchat-Abbildung').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Lernchat-Abbildung';
			const ablage = await this.app.fileManager.getAvailablePathForAttachment(`${name}.png`, ziel.path);
			const datei = await this.app.vault.createBinary(ablage, await (await png()).arrayBuffer());
			const link = `${this.app.fileManager.generateMarkdownLink(datei, ziel.path)}\n`;
			const ansicht = this.app.workspace.getLeavesOfType('markdown').map((l) => l.view as any).find((v) => v?.file?.path === ziel.path);
			if (ansicht?.editor) {
				ansicht.editor.replaceSelection(link);
				new Notice(`Bild in „${ziel.basename}“ eingefügt`);
			} else {
				await navigator.clipboard.writeText(link.trim());
				new Notice(`Bild gespeichert (${datei.name}), Link kopiert`);
			}
		} catch (e: any) { new Notice(`Bild nicht gespeichert: ${e?.message || e}`); }
	}

	private bildFuss(k: HTMLElement, png: () => Promise<Blob>, titel: string, zotero?: string) {
		const fuss = k.createDiv({ cls: 'anki-lp-fuss anki-lp-grafikfuss' });
		if (zotero) fuss.createEl('a', { cls: 'anki-lp-zotero', href: zotero, text: 'In Zotero öffnen' });
		const kopieren = fuss.createEl('button', { cls: 'anki-lp-textknopf', text: 'Kopieren' });
		kopieren.onclick = () => kopierenMitRueckmeldung(kopieren, png);
		const notiz = fuss.createEl('button', { cls: 'anki-lp-textknopf', text: 'In Notiz' });
		notiz.onclick = () => void this.bildInNotiz(png, titel);
		const gross = fuss.createEl('button', { cls: 'anki-lp-textknopf', text: 'Vergrößern' });
		gross.onclick = () => (k.querySelector('img') as HTMLImageElement | null)?.click();
	}

	private async chat(el: HTMLElement) {
		const api = this.plugin.lernplanApi;
		el.addClass('anki-lp-chatflaeche');
		const kopf = el.createDiv({ cls: 'anki-lp-chatkopf' });
		const kopfText = kopf.createDiv({ cls: 'anki-lp-chatkopftext' });
		const titel = kopfText.createDiv({ cls: 'anki-lp-chattitel', text: 'Lernchat', attr: { title: 'Doppelklick zum Umbenennen' } });
		titel.ondblclick = () => { if (this.chatId && chat) new NameModal(this.app, 'Chat umbenennen', chat.titel || '', async (w) => {
			const r = await this.tun(() => api.chatAendern(this.chatId as number, { titel: w }));
			if (r) { chat = r; titel.setText(r.titel || w); }
		}).open(); };
		const notiz = kopfText.createDiv({ cls: 'anki-lp-notiz' });
		const ikon = (icon: string, name: string) => {
			const b = kopf.createEl('button', { cls: 'anki-lp-ikon', attr: { 'aria-label': name, title: name } });
			setIcon(b, icon);
			return b;
		};
		const verlaufKnopf = ikon('history', 'Verlauf');
		const neuKnopf = ikon('plus', 'Neuer Chat');
		const mehr = ikon('more-horizontal', 'Mehr');
		const verlauf = el.createDiv({ cls: 'anki-lp-chat' });
		let chat: LernChatKopf | null = null;

		// Notiz, auf die sich der Chat bezieht. Ein neuer Chat nimmt die offene, ein laufender bleibt bei seiner.
		this.chatPfad = null;
		let ohneNotiz = false;
		const notizZeigen = () => {
			notiz.empty();
			const pfad = this.chatId ? chat?.pfad || null : (ohneNotiz ? null : this.offeneNotiz()?.path || null);
			this.chatPfad = pfad;
			if (!pfad) { notiz.setText('Ohne Notiz'); notiz.addClass('is-leer'); return; }
			notiz.removeClass('is-leer');
			const name = pfad.split('/').pop()?.replace(/\.md$/, '') || pfad;
			const a = notiz.createEl('a', { text: name, attr: { title: pfad } });
			setIcon(notiz.createSpan({ cls: 'anki-lp-notizzeichen' }), 'file-text');
			notiz.prepend(notiz.lastChild as Node);
			a.onclick = (ev) => void this.app.workspace.openLinkText(pfad, '', Keymap.isModEvent(ev));
			const offen = this.offeneNotiz();
			if (this.chatId && offen && offen.path !== pfad) {
				const tausch = notiz.createEl('button', { cls: 'anki-lp-textknopf anki-lp-leise', text: `→ ${offen.basename}`, attr: { title: 'Chat an die offene Notiz hängen' } });
				tausch.onclick = async () => { chat = await api.chatAendern(this.chatId as number, { pfad: offen.path }); notizZeigen(); };
			}
			if (!this.chatId) {
				const x = notiz.createEl('button', { cls: 'anki-lp-textknopf anki-lp-leise anki-lp-notizweg', attr: { 'aria-label': 'Ohne Notiz', title: 'Neuen Chat ohne Notiz beginnen' } });
				setIcon(x, 'x');
				x.onclick = () => { ohneNotiz = true; notizZeigen(); };
			}
		};
		this.notizChip = notizZeigen;

		const liste = async () => {
			verlauf.empty();
			verlauf.addClass('is-liste');
			const suche = verlauf.createEl('input', { cls: 'anki-lp-fsuche anki-lp-vsuche', attr: { type: 'search', placeholder: this.archiv ? 'Archiv durchsuchen' : 'Chats durchsuchen' } });
			suche.value = this.suche;
			const raum = verlauf.createDiv();
			const chats = await api.chatListe(this.archiv);
			const zeichnen = () => {
				raum.empty();
				const q = this.suche.trim().toLowerCase();
				const treffer = chats.filter((c) => !q || `${c.titel || ''} ${c.pfad || ''}`.toLowerCase().includes(q));
				for (const g of chatGruppen(treffer)) {
					raum.createDiv({ cls: 'anki-lp-vgruppe', text: g.titel });
					for (const c of g.chats) this.verlaufZeile(raum, c, () => { chats.splice(chats.indexOf(c), 1); zeichnen(); });
				}
				if (!treffer.length) raum.createDiv({ cls: 'anki-lp-fleer', text: q ? 'Nichts gefunden' : this.archiv ? 'Archiv ist leer' : 'Noch keine Chats' });
			};
			suche.oninput = () => { this.suche = suche.value; zeichnen(); };
			zeichnen();
			const fuss = verlauf.createDiv({ cls: 'anki-lp-vfuss' });
			const wechsel = fuss.createEl('button', { cls: 'anki-lp-textknopf anki-lp-leise' });
			setIcon(wechsel.createSpan(), this.archiv ? 'arrow-left' : 'archive');
			wechsel.createSpan({ text: this.archiv ? 'Zurück zum Verlauf' : 'Archiv' });
			wechsel.onclick = () => { this.archiv = !this.archiv; void liste(); };
		};
		let listeOffen = false;
		verlaufKnopf.onclick = () => { listeOffen = !listeOffen; verlaufKnopf.toggleClass('is-an', listeOffen); if (listeOffen) void liste(); else void this.zeigen(); };
		neuKnopf.onclick = () => { this.chatId = null; this.archiv = false; void this.zeigen(); };
		mehr.onclick = (ev) => {
			const m = new Menu();
			if (this.chatId && chat) {
				const c = chat;
				m.addItem((i) => i.setTitle('Umbenennen').setIcon('pencil').onClick(() => new NameModal(this.app, 'Chat umbenennen', c.titel || '', async (w) => {
					const r = await this.tun(() => api.chatAendern(c.id, { titel: w }));
					if (r) { chat = r; titel.setText(r.titel || w); }
				}).open()));
				m.addItem((i) => i.setTitle(c.archiviert ? 'Aus dem Archiv holen' : 'Archivieren').setIcon(c.archiviert ? 'archive-restore' : 'archive').onClick(async () => {
					await this.tun(() => api.chatAendern(c.id, { archiviert: !c.archiviert }));
					if (!c.archiviert) this.chatId = null;
					void this.zeigen();
				}));
				const offen = this.offeneNotiz();
				if (offen && offen.path !== c.pfad) m.addItem((i) => i.setTitle(`An „${offen.basename}“ hängen`).setIcon('file-plus').onClick(async () => { chat = await api.chatAendern(c.id, { pfad: offen.path }); notizZeigen(); }));
				if (c.pfad) m.addItem((i) => i.setTitle('Von der Notiz lösen').setIcon('file-x').onClick(async () => { chat = await api.chatAendern(c.id, { pfad: '' }); notizZeigen(); }));
			}
			if (!this.istGross()) m.addItem((i) => i.setTitle('Groß öffnen').setIcon('maximize-2').onClick(() => void this.plugin.lernplanGross('chat', this.chatId)));
			m.showAtMouseEvent(ev);
		};

		if (this.chatId) {
			const c = await api.chatLesen(this.chatId);
			chat = c;
			titel.setText(c.titel || 'Lernchat');
			notizZeigen();
			for (const m of c.nachrichten) this.nachricht(verlauf, m.rolle, m.content, m.einbettungen);
			for (const p of (c.vorschlaege || []) as LernPunkt[]) if (p.typ in ART) this.punkt(verlauf, p);
			verlauf.scrollTop = verlauf.scrollHeight;
		} else { notizZeigen(); verlauf.createDiv({ cls: 'anki-lp-fleer', text: 'Lädt …' }); void liste().catch((e) => { verlauf.empty(); verlauf.createDiv({ cls: 'anki-lp-fehler', text: e?.message || String(e) }); }); }

		const ein = el.createDiv({ cls: 'anki-lp-ein' });
		const feld = new LinkFeld(ein.createDiv(), 'Frage, [[ für Notizen und Stellen');
		feld.el.addEventListener('click', (ev) => {
			const p = (ev.target as HTMLElement).closest('.anki-lp-pille') as HTMLElement | null;
			const ziel = p?.dataset.link?.slice(2, -2).split('|')[0];
			if (ziel && (ev.ctrlKey || ev.metaKey)) void this.app.workspace.openLinkText(ziel, this.chatPfad || '', 'tab');
		});
		feld.el.addEventListener('mouseover', (ev) => {
			const p = (ev.target as HTMLElement).closest('.anki-lp-pille') as HTMLElement | null;
			const ziel = p?.dataset.link?.slice(2, -2).split('|')[0];
			if (p && ziel) this.app.workspace.trigger('hover-link', { event: ev, source: LERNPLAN_VIEW_TYPE, hoverParent: this, targetEl: p, linktext: ziel, sourcePath: this.chatPfad || '' });
		});
		linkSucheAnbinden(this.app, feld, ein, () => this.chatPfad || '');
		const senden = ein.createEl('button', { cls: 'anki-lp-senden', attr: { 'aria-label': 'Senden' } });
		setIcon(senden, 'arrow-up');
		const wahlZeile = createDiv({ cls: 'anki-lp-einfuss' });
		el.insertBefore(wahlZeile, ein);
		const wahl = wahlZeile.createEl('button', { cls: 'anki-lp-modellwahl', attr: { title: 'Modell und Denktiefe' } });
		const wahlText = () => {
			const s = this.plugin.settings;
			const m = MODELLE.find(([k]) => k === (s.lernchatModell || 'sonnet'))?.[1] || 'Sonnet';
			const d = DENKTIEFEN.find(([k]) => k === (s.lernchatDenken || ''))?.[1] || 'Standard';
			wahl.setText(d === 'Standard' ? m : `${m} · ${d}`);
		};
		wahlText();
		wahl.onclick = (ev) => {
			const s = this.plugin.settings;
			const m = new Menu();
			for (const [k, name] of MODELLE) m.addItem((i) => i.setSection('modell').setTitle(name).setChecked((s.lernchatModell || 'sonnet') === k)
				.onClick(async () => { s.lernchatModell = k; await this.plugin.saveSettings(); wahlText(); }));
			for (const [k, name] of DENKTIEFEN) m.addItem((i) => i.setSection('denken').setTitle(`Denken: ${name}`).setChecked((s.lernchatDenken || '') === k)
				.onClick(async () => { s.lernchatDenken = k || undefined; await this.plugin.saveSettings(); wahlText(); }));
			m.showAtMouseEvent(ev);
		};
		const los = async () => {
			const text = feld.wert().trim();
			if (!text || senden.disabled) return;
			feld.leeren();
			senden.disabled = true;
			if (!this.chatId) { verlauf.empty(); verlauf.removeClass('is-liste'); }
			this.nachricht(verlauf, 'user', text, []);
			const live = verlauf.createDiv({ cls: 'anki-lp-live' });
			const schritte = live.createDiv({ cls: 'anki-lp-schritte' });
			const karten = live.createDiv();
			const entwurf = live.createDiv({ cls: 'anki-lp-ki' });
			entwurf.hide();
			const warte = live.createDiv({ text: 'Denkt nach', cls: 'anki-lp-arbeit' });
			const start = Date.now();
			let schritt = 'Denkt nach', gezeigt = 0, geschrieben = '', frage = false, anzahl = 0;
			const uhr = window.setInterval(() => {
				const s = Math.round((Date.now() - start) / 1000);
				warte.setText(`${schritt}, ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
				if (frage || !this.chatId) return;
				frage = true;
				api.chatLive(this.chatId).then((z) => {
					const unten = verlauf.scrollHeight - verlauf.scrollTop - verlauf.clientHeight < 80;
					if (z.schritte.length > anzahl) {
						schritte.empty();
						z.schritte.slice(0, -1).slice(-4).forEach((t) => schritte.createDiv({ text: t }));
						schritt = z.schritte[z.schritte.length - 1];
						anzahl = z.schritte.length;
					}
					for (; gezeigt < z.einbettungen.length; gezeigt++) this.einbettung(karten, z.einbettungen[gezeigt]);
					if (z.text !== geschrieben) {
						geschrieben = z.text;
						entwurf.empty();
						if (z.text.trim()) { entwurf.show(); this.md(entwurf.createDiv(), z.text); schritt = 'Schreibt die Antwort'; } else entwurf.hide();
					}
					if (unten) verlauf.scrollTop = verlauf.scrollHeight;
				}).catch(() => undefined).finally(() => { frage = false; });
			}, 1000);
			verlauf.scrollTop = verlauf.scrollHeight;
			try {
				if (!this.chatId) {
					chat = await api.chatAnlegen({ titel: text.slice(0, 80), pfad: this.chatPfad || undefined });
					this.chatId = (chat as LernChatKopf).id;
					titel.setText(text.slice(0, 80));
					notizZeigen();
				}
				const s = this.plugin.settings;
				const ev = await api.chatFragen(this.chatId as number, text, { modell: s.lernchatModell || undefined, denken: s.lernchatDenken || undefined });
				live.remove();
				const em = ev.filter((x) => x.einbettung).map((x) => x.einbettung);
				const antwort = ev.find((x) => x.type === 'text')?.text || '';
				this.nachricht(verlauf, 'ai', antwort, em);
				for (const x of ev) {
					if (x.type === 'fehler') verlauf.createDiv({ text: x.text, cls: 'anki-lp-fehler' });
					if (x.type === 'vorschlag' && x.punkt && x.punkt.typ in ART) this.punkt(verlauf, x.punkt);
					if (x.type === 'titel' && x.text) { titel.setText(x.text); if (chat) chat.titel = x.text; }
				}
			} catch (e: any) { live.remove(); verlauf.createDiv({ text: e?.message || String(e), cls: 'anki-lp-fehler' }); } finally {
				window.clearInterval(uhr);
				senden.disabled = false;
				verlauf.scrollTop = verlauf.scrollHeight;
			}
		};
		senden.onclick = () => void los();
		feld.el.addEventListener('keydown', (e) => {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			if (e.shiftKey) feld.textEinfuegen('\n'); else void los();
		});
		if (this.vorlage) {
			feld.setzen(this.vorlage);
			this.vorlage = null;
		}
		feld.fokus();
	}

	private verlaufZeile(el: HTMLElement, c: LernChatKopf, weg: () => void) {
		const z = el.createDiv({ cls: `anki-lp-vzeile${c.id === this.chatId ? ' is-aktiv' : ''}`, attr: { role: 'button', tabindex: '0' } });
		const text = z.createDiv({ cls: 'anki-lp-vtext' });
		text.createDiv({ cls: 'anki-lp-vtitel', text: c.titel || 'Lernchat' });
		const notiz = c.pfad ? c.pfad.split('/').pop()?.replace(/\.md$/, '') : '';
		const meta = [notiz, c.fragen ? `${c.fragen} ${c.fragen === 1 ? 'Frage' : 'Fragen'}` : ''].filter(Boolean).join(' · ');
		if (meta) text.createDiv({ cls: 'anki-lp-vmeta', text: meta });
		z.createDiv({ cls: 'anki-lp-vzeit', text: chatZeit(c.letzte) });
		const ab = z.createEl('button', { cls: 'anki-lp-ikon anki-lp-varchiv', attr: { 'aria-label': c.archiviert ? 'Zurückholen' : 'Archivieren', title: c.archiviert ? 'Zurückholen' : 'Archivieren' } });
		setIcon(ab, c.archiviert ? 'archive-restore' : 'archive');
		ab.onclick = async (ev) => {
			ev.stopPropagation();
			if (await this.tun(() => this.plugin.lernplanApi.chatAendern(c.id, { archiviert: !c.archiviert }))) {
				if (c.id === this.chatId) this.chatId = null;
				weg();
			}
		};
		const oeffnen = () => { this.chatId = c.id; this.archiv = false; void this.zeigen(); };
		z.onclick = oeffnen;
		z.onkeydown = (ev) => { if (ev.key === 'Enter') oeffnen(); };
	}

	private nachricht(el: HTMLElement, rolle: string, text: string, einbettungen: any[]) {
		if (rolle === 'user') { this.md(el.createDiv({ cls: 'anki-lp-du' }), text); return; }
		for (const e of einbettungen || []) this.einbettung(el, e);
		if (!text) return;
		const box = el.createDiv({ cls: 'anki-lp-ki' });
		this.md(box.createDiv(), text);
		const kopieren = box.createEl('button', { cls: 'anki-lp-textknopf anki-lp-kopieren', text: 'Kopieren' });
		kopieren.onclick = () => {
			navigator.clipboard.writeText(text).then(() => {
				kopieren.setText('Kopiert');
				window.setTimeout(() => kopieren.setText('Kopieren'), 1500);
			}).catch(() => new Notice('Kopieren ging nicht. Markiere den Text von Hand.'));
		};
	}
}


/** ISO-Woche von `von` (JJJJ-MM-TT) um `tage` verschoben. */
function isoWoche(von: string | undefined, tage: number): { kw: number; jahr: number } | null {
	if (!von) return null;
	const d = new Date(`${von}T12:00:00Z`);
	if (Number.isNaN(d.getTime())) return null;
	d.setUTCDate(d.getUTCDate() + tage + 3 - ((d.getUTCDay() + 6) % 7));   // Donnerstag derselben Woche
	const jahr = d.getUTCFullYear();
	const erster = new Date(Date.UTC(jahr, 0, 4));
	const kw = 1 + Math.round(((d.getTime() - erster.getTime()) / 86400000 - 3 + ((erster.getUTCDay() + 6) % 7)) / 7);
	return { kw, jahr };
}
