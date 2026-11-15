import { App, prepareFuzzySearch, setIcon, TFile } from 'obsidian';
import { LinkFeld } from './linkFeld';

/** Offener `[[…` vor der Schreibmarke: Ziel und, nach `#`, der Anker. Geschlossene Links zählen nicht. */
export function linkAnfrage(text: string, marke: number): { start: number; ziel: string; anker: string | null } | null {
	const vorn = text.slice(0, marke);
	const auf = vorn.lastIndexOf('[[');
	if (auf < 0) return null;
	const rest = vorn.slice(auf + 2);
	if (rest.includes(']]') || rest.includes('\n') || rest.includes('|')) return null;
	const raute = rest.indexOf('#');
	return raute < 0 ? { start: auf, ziel: rest, anker: null } : { start: auf, ziel: rest.slice(0, raute), anker: rest.slice(raute + 1) };
}

/** Alle Wikilinks im Text (ohne Einbettungen), für die Leiste unter dem Feld. */
export function linksIm(text: string): { ziel: string; anker: string | null; anzeige: string | null }[] {
	const raus: { ziel: string; anker: string | null; anzeige: string | null }[] = [];
	for (const m of (text || '').matchAll(/(?<!!)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]*))?\]\]/g)) raus.push({ ziel: m[1].trim(), anker: m[2] || null, anzeige: m[3] || null });
	return raus;
}

/** Erste Textzeile eines Blocks lesbar: Callout als „Typ · Titel“, ohne ^id und Markdown-Zeichen. */
export function blockText(zeilen: string[]): { text: string; art: string | null } {
	const erste = (zeilen.find((z) => z.trim() && !/^\^[\w-]+$/.test(z.trim())) || '').replace(/\s\^[\w-]+\s*$/, '');
	const callout = erste.match(/^\s*>+\s*\[!([^\]]+)\][+-]?\s*(.*)$/);
	if (callout) return { text: callout[2].trim() || callout[1], art: callout[1].toLowerCase() };
	return { text: erste.replace(/^\s*(>+|[-*+]|\d+[.)])\s*/, '').replace(/[*_`]/g, '').trim(), art: null };
}

/** Ordnung der Notizvorschläge: Anfang des Namens vor Wortanfang vor enthalten, zuletzt geöffnete etwas vorn. 0 = nur unscharf. */
export function notizRang(name: string, pfad: string, suche: string, zuletztIndex = -1): number {
	const n = name.toLowerCase(), q = suche.trim().toLowerCase();
	if (!q) return 0;
	const bonus = zuletztIndex >= 0 ? 0.5 - zuletztIndex / 100 : 0;
	if (n === q) return 10 + bonus;
	if (n.startsWith(q)) return 8 + bonus;
	if (new RegExp(`[\\s_\\-(]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) return 6 + bonus;
	if (n.includes(q)) return 4 + bonus;
	if (pfad.toLowerCase().includes(q)) return 2 + bonus;
	return 0;
}

/** Treffer hervorheben (eigene Spans statt renderMatches, das hier leere Zeilen lieferte). */
function markieren(el: HTMLElement, text: string, matches: [number, number][]) {
	let stand = 0;
	for (const [von, bis] of [...matches].sort((a, b) => a[0] - b[0])) {
		if (von < stand || bis > text.length) continue;
		if (von > stand) el.appendText(text.slice(stand, von));
		el.createSpan({ cls: 'suggestion-highlight', text: text.slice(von, bis) });
		stand = bis;
	}
	if (stand < text.length) el.appendText(text.slice(stand));
}

interface Eintrag { icon: string; titel: string; treffer: any; rechts?: string; einsetzen: string; tiefe?: number; art?: string | null }

const LISTE_MAX = 30;

/**
 * Vorschläge beim Tippen von `[[` im Lernchat: Notizen, nach `#` Überschriften und Blöcke (Callouts mit ^id),
 * nach `#^` nur Blöcke. Eingesetzt wird der volle Pfad mit lesbarem Alias, damit das Backend die Stelle findet.
 */
export function linkSucheAnbinden(app: App, f: LinkFeld, rahmen: HTMLElement, quelle: () => string) {
	const feld = f.el;
	const liste = rahmen.createDiv({ cls: 'anki-lp-linkwahl' });
	liste.hide();
	let eintraege: Eintrag[] = [], wahl = 0, anfrage: ReturnType<typeof linkAnfrage> = null, lauf = 0;

	const schliessen = () => { liste.hide(); eintraege = []; anfrage = null; };
	const zeichnen = () => {
		liste.empty();
		if (!eintraege.length) { liste.createDiv({ cls: 'anki-lp-linkleer', text: anfrage?.anker !== null ? 'Keine Überschrift oder Block-ID' : 'Keine Notiz gefunden' }); liste.show(); return; }
		eintraege.forEach((e, i) => {
			const z = liste.createDiv({ cls: `anki-lp-linkzeile${i === wahl ? ' is-wahl' : ''}${e.art ? ' is-callout' : ''}` });
			if (e.tiefe) z.style.setProperty('--tiefe', String(e.tiefe - 1));
			setIcon(z.createSpan({ cls: 'anki-lp-linkzeichen' }), e.icon);
			const t = z.createDiv({ cls: 'anki-lp-linktext' });
			markieren(t, e.titel, e.treffer?.matches || []);
			if (e.rechts) z.createDiv({ cls: 'anki-lp-linkrechts', text: e.rechts });
			z.onmousedown = (ev) => { ev.preventDefault(); einsetzen(e); };
			z.onmouseenter = () => { wahl = i; liste.querySelectorAll('.is-wahl').forEach((x) => x.removeClass('is-wahl')); z.addClass('is-wahl'); };
		});
		liste.show();
		(liste.children[wahl] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
	};
	const einsetzen = (e: Eintrag) => {
		if (!anfrage) return;
		const laenge = f.vorMarke().length - anfrage.start;
		const fertig = e.einsetzen.endsWith(']]');
		schliessen();
		if (fertig) f.ersetzen(laenge, { link: e.einsetzen, anzeige: e.einsetzen.match(/\|([^\]]*)\]\]$/)?.[1] });
		else f.ersetzen(laenge, { text: e.einsetzen });
		feld.focus();
	};
	// Kurzer Linktext wie Obsidian selbst (eindeutiger Name); das Backend löst ihn zum Pfad auf.
	const ohneMd = (f: TFile) => app.metadataCache.fileToLinktext(f, quelle(), true);

	const suchen = async () => {
		const vorn = f.vorMarke();
		anfrage = linkAnfrage(vorn, vorn.length);
		if (!anfrage) { schliessen(); return; }
		const meins = ++lauf;
		const q = anfrage;
		if (q.anker === null) {
			const dateien = app.vault.getMarkdownFiles();
			if (!q.ziel.trim()) {
				const zuletzt = app.workspace.getLastOpenFiles().map((p) => app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile && f.extension === 'md');
				eintraege = zuletzt.slice(0, 10).map((f) => ({ icon: 'clock', titel: f.basename, treffer: null, rechts: f.parent?.path || '', einsetzen: `[[${ohneMd(f)}#` }));
			} else {
				const such = prepareFuzzySearch(q.ziel.trim());
				const zuletzt = app.workspace.getLastOpenFiles();
				eintraege = dateien.map((f) => ({ f, r: such(f.basename), rang: notizRang(f.basename, f.path, q.ziel, zuletzt.indexOf(f.path)) }))
					.filter((x, _, alle) => x.rang > 0 || (x.r && !alle.some((y) => y.rang > 0))).sort((a, b) => (b.rang - a.rang) || ((b.r?.score ?? -99) - (a.r?.score ?? -99)) || (a.f.basename.length - b.f.basename.length)).slice(0, LISTE_MAX)
					.map(({ f, r }) => ({ icon: 'file-text', titel: f.basename, treffer: r, rechts: f.parent?.path || '', einsetzen: `[[${ohneMd(f)}#` }));
			}
			wahl = 0;
			zeichnen();
			return;
		}
		const datei = app.metadataCache.getFirstLinkpathDest(q.ziel.trim(), quelle());
		if (!datei) { eintraege = []; zeichnen(); return; }
		const cache = app.metadataCache.getFileCache(datei);
		const nurBloecke = q.anker.startsWith('^');
		const such = prepareFuzzySearch(q.anker.replace(/^\^/, '').trim() || ' ');
		const leer = !q.anker.replace(/^\^/, '').trim();
		const kandidaten: Eintrag[] = [];
		const zeilen = (await app.vault.cachedRead(datei)).split('\n');
		if (meins !== lauf) return;
		// Überschriften und Blöcke in der Reihenfolge der Notiz, damit die Liste wie ihre Gliederung aussieht.
		const roh: { zeile: number; e: Eintrag }[] = [];
		if (!nurBloecke) for (const h of cache?.headings || []) {
			roh.push({ zeile: h.position.start.line, e: { icon: 'heading', titel: h.heading, treffer: null, rechts: `H${h.level}`, tiefe: h.level, einsetzen: `[[${ohneMd(datei)}#${h.heading}|${datei.basename} › ${h.heading}]]` } });
		}
		for (const [id, b] of Object.entries(cache?.blocks || {})) {
			const von = b.position.start.line, bis = b.position.end.line;
			const { text, art } = blockText(zeilen.slice(von, bis + 1));
			roh.push({ zeile: von, e: { icon: art ? 'quote' : 'pilcrow', titel: text || `^${id}`, treffer: null, rechts: art ? `${art} · ^${id}` : `^${id}`, art, einsetzen: `[[${ohneMd(datei)}#^${id}|${datei.basename} › ${text || id}]]` } });
		}
		roh.sort((a, b) => a.zeile - b.zeile);
		for (const { e } of roh) {
			if (leer) { kandidaten.push(e); continue; }
			const r = such(e.titel) || such(e.rechts || '');
			if (r) kandidaten.push({ ...e, treffer: such(e.titel) });
		}
		eintraege = [{ icon: 'file-text', titel: `Ganze Notiz ${datei.basename}`, treffer: null, rechts: '', einsetzen: `[[${ohneMd(datei)}|${datei.basename}]]` }, ...kandidaten].slice(0, LISTE_MAX + 1);
		if (nurBloecke || !leer) eintraege = kandidaten.slice(0, LISTE_MAX);
		wahl = 0;
		zeichnen();
	};

	feld.addEventListener('input', () => void suchen());
	feld.addEventListener('click', () => void suchen());
	feld.addEventListener('keyup', (ev) => { if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') void suchen(); });
	feld.addEventListener('blur', () => window.setTimeout(schliessen, 150));
	feld.addEventListener('keydown', (ev) => {
		if (!liste.isShown() || !eintraege.length) { if (ev.key === 'Escape' && liste.isShown()) { schliessen(); ev.preventDefault(); } return; }
		if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
			ev.preventDefault();
			wahl = (wahl + (ev.key === 'ArrowDown' ? 1 : -1) + eintraege.length) % eintraege.length;
			zeichnen();
		} else if (ev.key === 'Enter' || ev.key === 'Tab') {
			ev.preventDefault();
			ev.stopImmediatePropagation();
			einsetzen(eintraege[wahl]);
		} else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); schliessen(); }
	}, true);
	return { offen: () => liste.isShown() };
}
