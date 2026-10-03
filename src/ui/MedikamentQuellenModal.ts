import { App, ButtonComponent, Modal, Notice, requestUrl, setIcon } from 'obsidian';
import type AnkiGeneratorPlugin from '../main';
import { ZoteroClient, ZoteroSource } from '../zotero/zoteroClient';
import { buildQuellenPrompt, parseQuellenPlan, QuellenPlan, QuellenVorschlag, STANDARDWERK_SUCHE } from '../agent/quellenPrompt';
import { runClaudeAgent, defaultCliPath, defaultZoteroDataDir } from '../agent/claudeAgent';

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

	constructor(app: App, private plugin: AnkiGeneratorPlugin, private wirkstoff: string) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('anki-zotero-modal', 'anki-quellen-modal');
		this.titleEl.setText(`Zotero-Quellen: ${this.wirkstoff}`);
		this.body = this.contentEl.createDiv();
		void this.suchen();
	}

	onClose() {
		if (!this.fertig) this.controller.abort();
		this.contentEl.empty();
	}

	private backend(): string {
		return (this.plugin.settings.fitnessManagerUrl || '').replace(/\/$/, '');
	}

	// --- 1 + 2: suchen ------------------------------------------------------

	private async suchen() {
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
			zeile(`${kontext.schonImOrdner.length} schon im Ordner · ${kontext.standardwerke.length} Standardwerke · ${kontext.treffer.length} Treffer`);

			kopf.setText('Claude sucht Quellen…');
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const storage = require('path').join(dataDir, 'storage');
			const ergebnis = await runClaudeAgent({
				cliPath: this.plugin.settings.claudeCliPath || defaultCliPath(),
				prompt: buildQuellenPrompt({ wirkstoff: this.wirkstoff, ...kontext }),
				cwd: dataDir,
				addDirs: [storage],
				research: true,
				model: this.plugin.settings.claudeAgentModel,
				signal: this.controller.signal,
				onEvent: (ev) => {
					if (ev.kind !== 'tool') return;
					schritte++;
					const icon = ev.name.startsWith('Web') ? '🌐' : ev.name === 'Grep' ? '🔍' : '📖';
					zeile(`${icon} ${ev.name}: ${ev.detail.split(/[\\/]/).slice(-2).join('/')}`);
				}
			});
			window.clearInterval(ticker);
			const plan = parseQuellenPlan(ergebnis.text);
			if (!plan.quellen.length) throw new Error('Der Agent hat keine Quellen gefunden.');
			this.pruefen(plan, ergebnis.costUsd);
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
		return { schonImOrdner, standardwerke, treffer };
	}

	// --- 3: pruefen ---------------------------------------------------------

	private pruefen(plan: QuellenPlan, kosten: number | null) {
		this.body.empty();
		const gewaehlt = new Set(plan.quellen.map((_, i) => i));

		this.body.createEl('p', {
			cls: 'anki-zotero-hint',
			text: `Vorschläge für Medikamente/${this.wirkstoff}. „Vorhanden" wird nur einsortiert, „Neu" wird angelegt` +
				' – mit PDF oder Seitenkopie, wo möglich.' + (kosten !== null ? ` (Suche: ${kosten.toFixed(2)} $)` : '')
		});

		const liste = this.body.createDiv({ cls: 'anki-zotero-list anki-quellen-liste' });
		const gruppen = new Map<string, number[]>();
		plan.quellen.forEach((q, i) => {
			if (!gruppen.has(q.kategorie)) gruppen.set(q.kategorie, []);
			gruppen.get(q.kategorie)!.push(i);
		});

		for (const [kategorie, idx] of gruppen) {
			liste.createDiv({ cls: 'anki-quellen-gruppe', text: kategorie });
			for (const i of idx) this.zeile(liste, plan.quellen[i], i, gewaehlt);
		}

		if (plan.hinweise.length) {
			const h = this.body.createDiv({ cls: 'anki-quellen-hinweise' });
			h.createEl('strong', { text: 'Hinweise des Agenten' });
			const ul = h.createEl('ul');
			plan.hinweise.forEach((t) => ul.createEl('li', { text: t }));
		}

		const footer = this.body.createDiv({ cls: 'anki-zotero-footer' });
		const zaehler = footer.createSpan({ cls: 'anki-zotero-count' });
		const knopf = new ButtonComponent(footer).setCta();
		const aktualisieren = () => {
			zaehler.setText(`${gewaehlt.size} von ${plan.quellen.length} ausgewählt`);
			knopf.setButtonText(`In Zotero anlegen (${gewaehlt.size})`).setDisabled(gewaehlt.size === 0);
		};
		this.body.addEventListener('change', aktualisieren);
		aktualisieren();
		knopf.onClick(() => void this.anlegen(plan.quellen.filter((_, i) => gewaehlt.has(i))));
	}

	private zeile(into: HTMLElement, q: QuellenVorschlag, i: number, gewaehlt: Set<number>) {
		const row = into.createEl('label', { cls: 'anki-zotero-row anki-quellen-row' });
		const box = row.createEl('input', { type: 'checkbox' });
		box.checked = true;
		box.addEventListener('change', () => { box.checked ? gewaehlt.add(i) : gewaehlt.delete(i); });

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
