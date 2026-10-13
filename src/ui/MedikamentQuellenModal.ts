import { App, ButtonComponent, Modal, Notice, requestUrl, setIcon, TFile } from 'obsidian';
import type AnkiGeneratorPlugin from '../main';
import { ZoteroClient, ZoteroSource } from '../zotero/zoteroClient';
import {
	buildNachsuchePrompt, buildQuellenPrompt, parseQuellenPlan, QuellenAuftrag, QuellenPlan, QuellenVorschlag,
	STANDARDWERK_SUCHE, ThiemeKapitel, thiemeKapitelNr
} from '../agent/quellenPrompt';
import {
	AgentEvent, AgentResult, runClaudeAgent, runMitSitzung, defaultCliPath, defaultZoteroDataDir
} from '../agent/claudeAgent';

/** Eine Quelle wiedererkennen – ueber Nachsuchen und Neuzeichnen hinweg. */
const ident = (q: QuellenVorschlag) => q.key || q.url || q.titel;
import type { QuellenSitzung } from '../settings';

/**
 * Quellen fuer ein Medikament zusammenstellen und in Zotero ablegen.
 *
 * 1. Bibliothek lesen (lokale Zotero-API): was liegt schon im Ordner, welche
 *    Standardwerke gibt es, was findet die Suche nach dem Wirkstoff.
 * 2. Claude-Agent sucht die fehlenden Quellen (Web) und prueft SAA/DBRD im Volltext.
 * 3. Till hakt ab.
 * 4. Das Fitness-Manager-Backend legt Medikamente/<Wirkstoff> an, sortiert
 *    Vorhandenes ein und haengt PDFs/Seitenkopien ueber WebDAV an.
 */
export class MedikamentQuellenModal extends Modal {
	private controller = new AbortController();
	private body!: HTMLElement;
	private fertig = false;

	/**
	 * @param notizPfad unter diesem Pfad merkt sich das Plugin die Sitzung der
	 *   Suche – der spaetere Zotero-Abgleich dieser Notiz knuepft daran an.
	 */
	constructor(app: App, private plugin: AnkiGeneratorPlugin, private wirkstoff: string,
		private notizPfad?: string) {
		super(app);
	}

	private async merkeSitzung(aenderung: Partial<QuellenSitzung> & { id?: string }) {
		if (!this.notizPfad) return;
		const s = this.plugin.settings;
		const alt = s.quellenSitzungen?.[this.notizPfad];
		if (!aenderung.id && !alt) return;
		// Neues Objekt statt Mutation: DEFAULT_SETTINGS teilt sonst dieselbe Referenz.
		s.quellenSitzungen = {
			...(s.quellenSitzungen || {}),
			[this.notizPfad]: { ...(alt || { datum: '', wirkstoff: this.wirkstoff }), ...aenderung } as QuellenSitzung
		};
		await this.plugin.saveSettings();
	}

	/** Sitzung der Suche – „Nachsuchen" knuepft daran an. */
	private sitzungId: string | null = null;
	/** Fuer einen frischen Lauf, falls die Sitzung weg ist. */
	private auftrag: QuellenAuftrag | null = null;
	private plan: QuellenPlan = { quellen: [], hinweise: [] };
	/** Abgewaehlte Quellen, ueber ident() – ueberlebt Nachsuchen und Neuzeichnen. */
	private abgewaehlt = new Set<string>();
	/** Selbst eingetragene Quellen: gehen nie verloren, auch wenn der Agent sie weglaesst. */
	private eigene: QuellenVorschlag[] = [];
	private kostenGesamt = 0;

	onOpen() {
		this.modalEl.addClass('anki-zotero-modal', 'anki-quellen-modal');
		this.titleEl.setText(`Zotero-Quellen: ${this.wirkstoff}`);
		this.body = this.contentEl.createDiv();
		this.start();
	}

	/** Vor dem Lauf: Tipps fuer die Suche, alles optional. */
	private start() {
		this.body.empty();
		this.body.createEl('p', {
			cls: 'anki-zotero-hint',
			text: 'Claude sucht Fachinformation, Gelbe Liste, Thieme-Kapitel, SAA/BPR, DBRD, ERC, Karow, Embryotox und weitere Quellen. ' +
				'Tipps sind optional – z. B. welches Präparat auf eurem RTW liegt oder eine Quelle, die unbedingt dabei sein soll.'
		});
		const feld = this.body.createEl('textarea', {
			cls: 'anki-quellen-eingabe',
			attr: { rows: '4', placeholder: 'Tipps für die Suche (optional), z. B. „Bei uns: Urbason solubile forte 250 mg"' }
		});
		const footer = this.body.createDiv({ cls: 'anki-zotero-footer' });
		footer.createSpan({ cls: 'anki-zotero-count', text: 'Die Suche dauert ein paar Minuten.' });
		new ButtonComponent(footer).setButtonText('Suche starten').setCta()
			.onClick(() => void this.suchen(feld.value));
		window.setTimeout(() => feld.focus(), 0);
	}

	onClose() {
		if (!this.fertig) this.controller.abort();
		this.contentEl.empty();
	}

	private backend(): string {
		return (this.plugin.settings.fitnessManagerUrl || '').replace(/\/$/, '');
	}

	// --- 1 + 2: suchen ------------------------------------------------------

	private async suchen(tipps: string) {
		this.body.empty();
		const status = this.body.createDiv({ cls: 'anki-agent-progress' });
		const kopf = status.createDiv({ cls: 'anki-agent-progress-head', text: 'Prüfe den Server…' });
		const zeilen = status.createDiv({ cls: 'anki-agent-progress-lines' });
		const zeile = (t: string) => {
			zeilen.createDiv({ cls: 'anki-agent-progress-line', text: t });
			while (zeilen.childElementCount > 10) zeilen.firstElementChild?.remove();
		};
		const footer = this.body.createDiv({ cls: 'anki-zotero-footer' });
		footer.createSpan({ cls: 'anki-zotero-count', text: 'Das dauert ein paar Minuten.' });
		new ButtonComponent(footer).setButtonText('Abbrechen').onClick(() => this.close());

		const start = Date.now();
		let schritte = 0;
		const ticker = window.setInterval(() => {
			const s = Math.round((Date.now() - start) / 1000);
			if (schritte) kopf.setText(`Claude sucht Quellen … ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${schritte} Schritte`);
		}, 1000);

		try {
			// Erst pruefen, ob am Ende ueberhaupt angelegt werden kann – sonst
			// waere der Agentenlauf umsonst.
			const st = await requestUrl({ url: `${this.backend()}/api/zotero/medikamente/status`, throw: false });
			if (st.status !== 200) throw new Error(`Fitness-Manager nicht erreichbar (${this.backend()}, HTTP ${st.status}).`);
			if (!st.json?.zugang) throw new Error('Auf dem Server fehlt der Zotero-Zugang (ZOTERO_API_KEY).');

			kopf.setText('Lese die Zotero-Bibliothek…');
			const dataDir = this.plugin.settings.zoteroDataDir || defaultZoteroDataDir();
			const client = new ZoteroClient(this.plugin.settings.zoteroApiUrl || 'http://localhost:23119/api', dataDir);
			const kontext = await this.bibliothek(client);
			zeile(`${kontext.schonImOrdner.length} schon im Ordner · ${kontext.standardwerke.length} Standardwerke · ${kontext.treffer.length} Treffer` +
				` · ${kontext.thiemeKapitel.length} Thieme-Kapitel bekannt`);

			kopf.setText('Claude sucht Quellen…');
			this.auftrag = { wirkstoff: this.wirkstoff, ...kontext, notizAuszug: await this.notizAuszug(), tipps };
			const ergebnis = await runClaudeAgent({
				...this.agentOptionen(dataDir, (n) => { schritte = n; }, zeile),
				prompt: buildQuellenPrompt(this.auftrag)
			});
			window.clearInterval(ticker);
			await this.uebernimmErgebnis(ergebnis);
			if (!this.plan.quellen.length) throw new Error('Der Agent hat keine Quellen gefunden.');
			this.pruefen();
		} catch (e: any) {
			window.clearInterval(ticker);
			if (e?.name === 'AbortError') return;
			this.body.empty();
			this.body.createDiv({ cls: 'anki-zotero-list is-error', text: e?.message || String(e) });
		}
	}

	private async bibliothek(client: ZoteroClient) {
		const alle = await client.collections();
		const ober = alle.find((c) => !c.parentKey && c.name === 'Medikamente');
		const ordner = ober && alle.find((c) => c.parentKey === ober.key
			&& c.name.toLowerCase() === this.wirkstoff.toLowerCase());
		const schonImOrdner = ordner ? await client.sources([ordner.key], alle, false) : [];

		const gesehen = new Set(schonImOrdner.map((s) => s.key));
		const sammle = (xs: ZoteroSource[]) => xs.filter((s) => !gesehen.has(s.key) && gesehen.add(s.key));
		const standardwerke: ZoteroSource[] = [];
		for (const q of STANDARDWERK_SUCHE) standardwerke.push(...sammle(await client.search(q, 6)));
		const treffer = sammle(await client.search(this.wirkstoff, 25));

		// Thieme-Kapitel mit Nummer: das Buch ist alphabetisch nummeriert, die
		// bekannten Nummern grenzen die gesuchte ein (das Inhaltsverzeichnis
		// sperrt Thieme fuer Skripte).
		const thiemeKapitel: ThiemeKapitel[] = [];
		const nrGesehen = new Set<number>();
		for (const s of await client.search('Wanka', 100)) {
			const nr = thiemeKapitelNr(s.url);
			if (nr !== null && !nrGesehen.has(nr)) { nrGesehen.add(nr); thiemeKapitel.push({ nr, titel: s.title }); }
		}
		return { schonImOrdner, standardwerke, treffer, thiemeKapitel };
	}

	/** Uebersicht der Notiz (Handelsname, Darreichung) – sagt, welches Praeparat gemeint ist. */
	private async notizAuszug(): Promise<string> {
		if (!this.notizPfad) return '';
		const f = this.app.vault.getAbstractFileByPath(this.notizPfad);
		if (!(f instanceof TFile)) return '';
		const text = await this.app.vault.cachedRead(f);
		const kopf = text.search(/^>\s*\[![^\]]+\][-+]?\s*(Übersicht|Steckbrief)/im);
		if (kopf < 0) return '';
		const zeilen: string[] = [];
		for (const z of text.slice(kopf).split('\n')) {
			if (!/^\s*>/.test(z)) break;
			zeilen.push(z.replace(/^\s*>\s?/, '').replace(/\s\^[A-Za-z0-9-]+\s*$/, ''));
		}
		// Ohne ausgefuellte Felder (frische Vorlage) hilft der Auszug nicht.
		const inhalt = zeilen.slice(1).filter((z) => /:\s*\S/.test(z) || /^\s*-\s*\S/.test(z));
		return inhalt.length ? zeilen.join('\n').slice(0, 1200) : '';
	}

	private agentOptionen(dataDir: string, schritt: (n: number) => void, zeile: (t: string) => void) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const storage = require('path').join(dataDir, 'storage');
		let n = 0;
		return {
			cliPath: this.plugin.settings.claudeCliPath || defaultCliPath(),
			cwd: dataDir,
			addDirs: [storage],
			research: true,
			model: this.plugin.settings.claudeAgentModel,
			signal: this.controller.signal,
			onEvent: (ev: AgentEvent) => {
				if (ev.kind !== 'tool') return;
				schritt(++n);
				const icon = ev.name.startsWith('Web') ? '🌐' : ev.name === 'Grep' ? '🔍' : '📖';
				zeile(`${icon} ${ev.name}: ${ev.detail.split(/[\\/]/).slice(-2).join('/')}`);
			}
		};
	}

	/** Ergebnis eines Laufs: Sitzung merken, Plan uebernehmen, eigene Quellen sichern. */
	private async uebernimmErgebnis(ergebnis: AgentResult) {
		if (ergebnis.costUsd !== null) this.kostenGesamt += ergebnis.costUsd;
		if (ergebnis.sessionId) {
			this.sitzungId = ergebnis.sessionId;
			await this.merkeSitzung({
				id: ergebnis.sessionId, datum: new Date().toISOString(), wirkstoff: this.wirkstoff, abgelegt: undefined
			});
		}
		const plan = parseQuellenPlan(ergebnis.text);
		const da = new Set(plan.quellen.map(ident));
		for (const q of this.eigene) if (!da.has(ident(q))) plan.quellen.push(q);
		this.plan = plan;
	}

	// --- 3: pruefen ---------------------------------------------------------

	private pruefen() {
		this.body.empty();
		const plan = this.plan;
		const gewaehlt = () => plan.quellen.filter((q) => !this.abgewaehlt.has(ident(q)));

		this.body.createEl('p', {
			cls: 'anki-zotero-hint',
			text: `Vorschläge für Medikamente/${this.wirkstoff}. „Vorhanden" wird nur einsortiert, „Neu" wird angelegt` +
				' – mit PDF oder Seitenkopie, wo möglich.' +
				(this.kostenGesamt ? ` (Suche bisher: ${this.kostenGesamt.toFixed(2).replace('.', ',')} $)` : '')
		});

		const liste = this.body.createDiv({ cls: 'anki-zotero-list anki-quellen-liste' });
		const gruppen = new Map<string, QuellenVorschlag[]>();
		plan.quellen.forEach((q) => {
			if (!gruppen.has(q.kategorie)) gruppen.set(q.kategorie, []);
			gruppen.get(q.kategorie)!.push(q);
		});
		for (const [kategorie, qs] of gruppen) {
			liste.createDiv({ cls: 'anki-quellen-gruppe', text: kategorie });
			for (const q of qs) this.zeile(liste, q);
		}

		if (plan.hinweise.length) {
			const h = this.body.createDiv({ cls: 'anki-quellen-hinweise' });
			h.createEl('strong', { text: 'Hinweise des Agenten' });
			const ul = h.createEl('ul');
			plan.hinweise.forEach((t) => ul.createEl('li', { text: t }));
		}

		this.eigeneQuelleFormular();
		this.nachsuchenFormular();

		const footer = this.body.createDiv({ cls: 'anki-zotero-footer' });
		const zaehler = footer.createSpan({ cls: 'anki-zotero-count' });
		const knopf = new ButtonComponent(footer).setCta();
		const aktualisieren = () => {
			const n = gewaehlt().length;
			zaehler.setText(`${n} von ${plan.quellen.length} ausgewählt`);
			knopf.setButtonText(`In Zotero anlegen (${n})`).setDisabled(n === 0);
		};
		liste.addEventListener('change', aktualisieren);
		aktualisieren();
		knopf.onClick(() => void this.anlegen(gewaehlt()));
	}

	/** Eine Quelle selbst eintragen – der Agent hat sie nicht gefunden oder nicht vorgeschlagen. */
	private eigeneQuelleFormular() {
		const box = this.body.createEl('details', { cls: 'anki-quellen-zusatz' });
		box.createEl('summary', { text: 'Quelle selbst hinzufügen' });
		const url = box.createEl('input', { type: 'url', attr: { placeholder: 'https://… (Webseite oder PDF)' } });
		const titel = box.createEl('input', { type: 'text', attr: { placeholder: 'Titel' } });
		const kategorie = box.createEl('input', { type: 'text', attr: { placeholder: 'Kategorie, z. B. ERC oder Leitlinie' } });
		const grund = box.createEl('input', { type: 'text', attr: { placeholder: 'Warum sie dazugehört (optional)' } });
		const fehler = box.createDiv({ cls: 'anki-quellen-fehler' });
		new ButtonComponent(box.createDiv({ cls: 'anki-quellen-zusatz-knopf' })).setButtonText('Hinzufügen').onClick(() => {
			const u = url.value.trim();
			if (!/^https?:\/\//i.test(u)) { fehler.setText('Bitte eine vollständige URL (https://…) eintragen.'); return; }
			const istPdf = /\.pdf(\?|#|$)/i.test(u);
			const q: QuellenVorschlag = {
				kategorie: kategorie.value.trim() || 'Eigene',
				art: 'neu',
				typ: istPdf ? 'document' : 'webpage',
				titel: titel.value.trim() || u.replace(/^https?:\/\//, '').replace(/\/$/, ''),
				url: u,
				pdf_url: istPdf ? u : undefined,
				grund: grund.value.trim() || 'Selbst hinzugefügt.'
			};
			if (this.plan.quellen.some((x) => ident(x) === ident(q))) { fehler.setText('Diese URL steht schon in der Liste.'); return; }
			this.eigene.push(q);
			this.plan.quellen.push(q);
			this.pruefen();
		});
	}

	/** Tipp oder Ergaenzung an den Agenten – er arbeitet in derselben Sitzung weiter. */
	private nachsuchenFormular() {
		const box = this.body.createEl('details', { cls: 'anki-quellen-zusatz' });
		box.createEl('summary', { text: 'Claude nachsuchen lassen' });
		const feld = box.createEl('textarea', {
			cls: 'anki-quellen-eingabe',
			attr: { rows: '3', placeholder: 'z. B. „Nimm die ERC-Leitlinie Anaphylaxie dazu" oder „Präparat ist Urbason solubile forte 250 mg"' }
		});
		new ButtonComponent(box.createDiv({ cls: 'anki-quellen-zusatz-knopf' })).setButtonText('Nachsuchen').setCta()
			.onClick(() => { if (feld.value.trim()) void this.nachsuchen(feld.value); });
	}

	private async nachsuchen(wunsch: string) {
		if (!this.auftrag) return;
		this.body.empty();
		const status = this.body.createDiv({ cls: 'anki-agent-progress' });
		const kopf = status.createDiv({ cls: 'anki-agent-progress-head', text: 'Claude sucht nach …' });
		const zeilen = status.createDiv({ cls: 'anki-agent-progress-lines' });
		const zeile = (t: string) => {
			zeilen.createDiv({ cls: 'anki-agent-progress-line', text: t });
			while (zeilen.childElementCount > 10) zeilen.firstElementChild?.remove();
		};
		const footer = this.body.createDiv({ cls: 'anki-zotero-footer' });
		footer.createSpan();
		new ButtonComponent(footer).setButtonText('Abbrechen').onClick(() => this.close());

		const vorher = this.plan;
		const nachsuche = buildNachsuchePrompt(wunsch, vorher.quellen);
		const auftrag = this.auftrag;
		try {
			const dataDir = this.plugin.settings.zoteroDataDir || defaultZoteroDataDir();
			const ergebnis = await runMitSitzung({
				...this.agentOptionen(dataDir, (n) => kopf.setText(`Claude sucht nach … ${n} Schritte`), zeile),
				prompt: nachsuche,
				fortsetzen: this.sitzungId ?? undefined,
				// Sitzung weg: alles neu, mit dem Wunsch als Tipp und der bisherigen Liste.
				frisch: () => buildQuellenPrompt(auftrag) + '\n\n' + nachsuche
			});
			if (!ergebnis.fortgesetzt && this.sitzungId) zeile('Alte Sitzung nicht mehr da – neu gesucht.');
			await this.uebernimmErgebnis(ergebnis);
			if (!this.plan.quellen.length) this.plan = vorher;
			this.pruefen();
		} catch (e: any) {
			if (e?.name === 'AbortError') return;
			this.plan = vorher;
			this.pruefen();
			this.body.prepend(createDiv({ cls: 'anki-zotero-list is-error', text: 'Nachsuchen fehlgeschlagen: ' + (e?.message || e) }));
		}
	}

	private zeile(into: HTMLElement, q: QuellenVorschlag) {
		const row = into.createEl('label', { cls: 'anki-zotero-row anki-quellen-row' });
		const box = row.createEl('input', { type: 'checkbox' });
		box.checked = !this.abgewaehlt.has(ident(q));
		box.addEventListener('change', () => {
			if (box.checked) this.abgewaehlt.delete(ident(q)); else this.abgewaehlt.add(ident(q));
		});

		const text = row.createDiv({ cls: 'anki-quellen-text' });
		const titel = text.createDiv({ cls: 'anki-quellen-titel' });
		titel.createSpan({ cls: `anki-quellen-art is-${q.art}`, text: q.art === 'vorhanden' ? 'vorhanden' : 'neu' });
		if (q.url) {
			const a = titel.createEl('a', { text: q.titel, href: q.url });
			a.setAttr('target', '_blank');
			a.addEventListener('click', (e) => e.stopPropagation());
		} else {
			titel.createSpan({ text: q.titel });
		}

		const meta: string[] = [];
		if (q.typ) meta.push(q.typ);
		if (q.herausgeber) meta.push(q.herausgeber);
		if (q.jahr) meta.push(q.jahr);
		if (q.art === 'neu') {
			// Thieme beantwortet Skripte mit einer Bot-Abfrage: das Kapitel-PDF
			// kommt nur ueber den Browser (Zotero Connector) in die Bibliothek.
			meta.push(q.typ === 'bookSection' ? '📕 Kapitel-PDF selbst ergänzen (Thieme sperrt Downloads)'
				: q.pdf_url ? '📄 PDF' : q.seitenkopie === false ? 'ohne Datei' : '🌐 Seitenkopie');
		}
		if (meta.length) text.createDiv({ cls: 'anki-zotero-meta', text: meta.join(' · ') });
		if (q.grund) text.createDiv({ cls: 'anki-quellen-grund', text: q.grund });
	}

	// --- 4: anlegen ---------------------------------------------------------

	private async anlegen(quellen: QuellenVorschlag[]) {
		this.body.empty();
		const status = this.body.createDiv({ cls: 'anki-agent-progress' });
		status.createDiv({
			cls: 'anki-agent-progress-head',
			text: `Lege ${quellen.length} Quellen in Zotero an (Dateien über WebDAV)…`
		});
		const typing = this.body.createDiv({ cls: 'anki-chat-typing' });
		typing.createSpan(); typing.createSpan(); typing.createSpan();

		try {
			const res = await requestUrl({
				url: `${this.backend()}/api/zotero/medikamente/anlegen`,
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify({ wirkstoff: this.wirkstoff, quellen }),
				throw: false
			});
			if (res.status !== 200) throw new Error(res.json?.detail || `HTTP ${res.status}`);
			this.fertig = true;
			// Der Abgleich soll wissen, was davon wirklich in Zotero liegt.
			const ok = (res.json?.ergebnisse || []).filter((e: any) => e.status !== 'fehler').map((e: any) => String(e.titel));
			await this.merkeSitzung({ abgelegt: ok });
			this.ergebnis(res.json);
		} catch (e: any) {
			this.body.empty();
			this.body.createDiv({ cls: 'anki-zotero-list is-error', text: 'Anlegen fehlgeschlagen: ' + (e?.message || e) });
		}
	}

	private ergebnis(r: { ergebnisse: { titel: string; status: string; anhang?: string | null; grund?: string }[] }) {
		this.body.empty();
		const fehler = r.ergebnisse.filter((e) => e.status === 'fehler').length;
		this.body.createEl('p', {
			cls: 'anki-zotero-hint',
			text: `Fertig${fehler ? ` – ${fehler} mit Fehler` : ''}. Zotero zeigt Medikamente/${this.wirkstoff} nach dem nächsten Sync.`
		});
		const liste = this.body.createDiv({ cls: 'anki-zotero-list' });
		for (const e of r.ergebnisse) {
			const row = liste.createDiv({ cls: 'anki-zotero-row' });
			const icon = row.createSpan({ cls: 'anki-zotero-icon' });
			setIcon(icon, e.status === 'fehler' ? 'x-circle' : e.status === 'angelegt' ? 'plus-circle' : 'folder-input');
			row.createSpan({ cls: 'anki-zotero-name', text: e.titel });
			const teile = [e.status];
			if (e.anhang) teile.push(e.anhang);
			if (e.grund) teile.push(e.grund);
			row.createSpan({ cls: 'anki-zotero-meta', text: teile.join(' · ') });
		}
		const footer = this.body.createDiv({ cls: 'anki-zotero-footer' });
		footer.createSpan();
		new ButtonComponent(footer).setButtonText('Schließen').setCta().onClick(() => this.close());
		new Notice(`Zotero: ${r.ergebnisse.length - fehler} Quellen für ${this.wirkstoff} abgelegt.`);
	}
}
