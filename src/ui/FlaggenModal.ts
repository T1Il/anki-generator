import { ButtonComponent, Modal, Notice, TFile } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { ChatModal } from './chat/ChatModal';
import { FlaggenEintrag } from '../flaggen/sammeln';
import { flaggenArt, waisenBegruendung } from '../flaggen/flaggen';
import { htmlToPlain } from '../anki/driftCheck';
import { zeigeInAnki } from '../anki/AnkiConnect';
import { entferneFlaggen, schliesseNotizAb, syncNachAnkiWeb, uebernimmWaise, waisenVorschlaege } from '../flaggen/abschluss';
import { ladeStapel, speichereStapel } from '../flaggen/stapel';
import { NotizStatus } from '../flaggen/dienst';

const STATUS_TEXT: Record<NotizStatus, string> = {
	bereit: 'Vorschläge bereit',
	nurUebertragen: 'neu übertragen',
	fehler: 'Fehler',
	offen: 'ungeprüft'
};

const STATUS_RANG: Record<NotizStatus, number> = { bereit: 0, nurUebertragen: 1, fehler: 2, offen: 3 };

/**
 * Geflaggte Karten durchsehen und abschließen.
 *
 * Je Notiz: Karten mit Flagge und Befund, „Ansehen“ öffnet den großen Chat mit
 * den Vorschlägen der KI, „Abschließen“ bringt den Vault-Stand nach Anki und
 * nimmt die Flaggen weg. Karten ohne Notiz werden direkt in Anki korrigiert.
 */
export class FlaggenModal extends Modal {
	private liste!: HTMLElement;
	private kopf!: HTMLElement;
	private abmelden: (() => void) | null = null;
	private beschaeftigt = new Set<string>();

	constructor(private plugin: AnkiGeneratorPlugin) {
		super(plugin.app);
	}

	async onOpen() {
		this.modalEl.addClass('anki-flaggen-modal');
		this.titleEl.setText('Geflaggte Karten');
		this.kopf = this.contentEl.createDiv({ cls: 'anki-flaggen-kopf' });
		this.liste = this.contentEl.createDiv({ cls: 'anki-flaggen-liste' });

		const dienst = this.plugin.flaggen;
		this.abmelden = dienst.beobachte(() => this.zeichne());

		if (!dienst.stand) {
			this.liste.createDiv({ cls: 'anki-flaggen-leer', text: 'Lade aus Anki …' });
			try {
				await dienst.aktualisiere();
			} catch (e: any) {
				this.liste.empty();
				this.liste.createDiv({ cls: 'anki-flaggen-leer', text: 'Anki nicht erreichbar: ' + (e?.message || e) });
				return;
			}
		}
		this.zeichne();
	}

	onClose() {
		this.abmelden?.();
		this.contentEl.empty();
	}

	private zeichne() {
		const dienst = this.plugin.flaggen;
		const stand = dienst.stand;
		this.kopf.empty();
		this.liste.empty();
		if (!stand) return;

		// --- Kopf: Zahlen, Lauf, Knöpfe -----------------------------------
		const zahlen = this.kopf.createDiv({ cls: 'anki-flaggen-zahlen' });
		zahlen.createSpan({ cls: 'anki-flaggen-zahl', text: String(stand.anzahl) });
		zahlen.createSpan({ text: stand.anzahl === 1 ? ' Karte' : ' Karten' });
		const offen = dienst.offeneKarten();
		if (offen) zahlen.createSpan({ cls: 'anki-flaggen-offen', text: ` · ${offen} ungeprüft` });

		const knoepfe = this.kopf.createDiv({ cls: 'anki-flaggen-knoepfe' });
		if (dienst.lauf) {
			const f = dienst.fortschritt;
			const lauf = this.kopf.createDiv({ cls: 'anki-flaggen-lauf' });
			lauf.createSpan({ text: f && f.gesamt ? `Prüfe ${f.fertig + 1}/${f.gesamt}: ${f.text}` : 'Prüfe …' });
			new ButtonComponent(knoepfe).setButtonText('Abbrechen').onClick(() => dienst.brecheAb());
		} else {
			const alle = new ButtonComponent(knoepfe).setButtonText('Alle prüfen lassen').setDisabled(offen === 0);
			if (offen) alle.setCta();
			alle.onClick(() => void dienst.starteStapel());
		}
		new ButtonComponent(knoepfe).setIcon('refresh-cw').setTooltip('Neu aus Anki laden').onClick(async () => {
			try { await dienst.aktualisiere(); } catch (e: any) { new Notice('Anki nicht erreichbar: ' + (e?.message || e)); }
		});

		if (stand.anzahl === 0) {
			this.liste.createDiv({ cls: 'anki-flaggen-leer', text: 'Keine geflaggten Karten.' });
			return;
		}

		// --- Notizen ----------------------------------------------------------
		const notizen = Array.from(stand.notizen.entries())
			.map(([pfad, e]) => ({ pfad, e, status: dienst.status(pfad, e) }))
			.sort((a, b) => STATUS_RANG[a.status] - STATUS_RANG[b.status] || a.pfad.localeCompare(b.pfad));

		for (const n of notizen) this.zeichneNotiz(n.pfad, n.e, n.status);
		if (stand.waisen.length) this.zeichneWaisen(stand.waisen);
	}

	private zeichneNotiz(pfad: string, eintraege: FlaggenEintrag[], status: NotizStatus) {
		const gruppe = this.liste.createDiv({ cls: 'anki-flaggen-gruppe' });
		const kopf = gruppe.createDiv({ cls: 'anki-flaggen-gruppe-kopf' });
		const name = pfad.split('/').pop()?.replace(/\.md$/, '') ?? pfad;
		const link = kopf.createEl('a', { cls: 'anki-flaggen-notiz', text: name, attr: { title: pfad } });
		link.onclick = () => {
			const f = this.app.vault.getAbstractFileByPath(pfad);
			if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
		};
		kopf.createSpan({ cls: `anki-flaggen-status is-${status}`, text: STATUS_TEXT[status] });
		const fehler = this.plugin.flaggen.datei.notizen[pfad]?.fehler;
		if (status === 'fehler' && fehler) kopf.createSpan({ cls: 'anki-flaggen-fehler', text: fehler });

		const k = kopf.createDiv({ cls: 'anki-flaggen-gruppe-knoepfe' });
		if (status === 'bereit' || status === 'fehler' || status === 'offen') {
			new ButtonComponent(k).setButtonText('Ansehen').onClick(() => this.oeffneChat(pfad));
		}
		const ab = new ButtonComponent(k).setButtonText('Abschließen');
		if (status === 'nurUebertragen') ab.setCta();
		ab.setDisabled(this.beschaeftigt.has(pfad));
		ab.onClick(() => void this.schliesseAb(pfad, eintraege));

		for (const e of eintraege) this.zeichneKarte(gruppe, e);
	}

	private zeichneKarte(parent: HTMLElement, e: FlaggenEintrag, extra?: (zeile: HTMLElement) => void) {
		const art = flaggenArt(e.flagge);
		const zeile = parent.createDiv({ cls: 'anki-flaggen-karte' });
		const flagge = zeile.createSpan({ cls: 'anki-flaggen-flagge', attr: { title: `${art.farbe}: ${art.bedeutung}` } });
		flagge.style.backgroundColor = art.css;

		const text = zeile.createDiv({ cls: 'anki-flaggen-karte-text' });
		const titel = text.createDiv({ cls: 'anki-flaggen-frage' });
		if (e.kartenNummer) titel.createSpan({ cls: 'anki-flaggen-nummer', text: `${e.kartenNummer}` });
		titel.createSpan({ text: kurz(htmlToPlain(e.anki.felder[0] ?? '')) || '(leer)' });
		text.createDiv({ cls: 'anki-flaggen-bedeutung', text: art.bedeutung });
		if (e.befunde.length) {
			const ul = text.createEl('ul', { cls: 'anki-flaggen-befunde' });
			e.befunde.forEach((b) => ul.createEl('li', { cls: `is-${b.art}`, text: b.text }));
		}
		extra?.(text);

		const knoepfe = zeile.createDiv({ cls: 'anki-flaggen-karte-knoepfe' });
		new ButtonComponent(knoepfe).setIcon('flag-off').setTooltip('Flagge entfernen').onClick(async () => {
			try {
				await entferneFlaggen([e.cardId]);
				await this.plugin.flaggen.aktualisiere();
				void syncNachAnkiWeb();
			} catch (err: any) {
				new Notice('Flagge nicht entfernt: ' + (err?.message || err));
			}
		});
	}

	private zeichneWaisen(waisen: FlaggenEintrag[]) {
		const dienst = this.plugin.flaggen;
		const gruppe = this.liste.createDiv({ cls: 'anki-flaggen-gruppe' });
		const kopf = gruppe.createDiv({ cls: 'anki-flaggen-gruppe-kopf' });
		kopf.createSpan({ cls: 'anki-flaggen-notiz', text: 'Ohne Notiz' });
		const w = dienst.datei.waisen;
		if (w?.fehler) {
			kopf.createSpan({ cls: 'anki-flaggen-status is-fehler', text: 'Fehler' });
			kopf.createSpan({ cls: 'anki-flaggen-fehler', text: w.fehler });
		}

		for (const e of waisen) {
			this.zeichneKarte(gruppe, e, (text) => {
				const zustand = w?.erledigt?.[String(e.noteId)];
				const vorschlaege = w?.antwort ? waisenVorschlaege(w.antwort, e.noteId) : [];
				const reihe = text.createDiv({ cls: 'anki-flaggen-waise' });
				const warum = w?.antwort ? waisenBegruendung(w.antwort, e.noteId) : '';
				if (!zustand && warum) reihe.createDiv({ cls: 'anki-flaggen-begruendung', text: warum });
				if (zustand) {
					reihe.createSpan({ cls: 'anki-flaggen-status is-bereit', text: zustand === 'uebernommen' ? 'übernommen' : 'verworfen' });
				}
				for (const v of zustand ? [] : vorschlaege) {
					const box = reihe.createDiv({ cls: 'anki-flaggen-vorschlag' });
					if (v.op === 'delete') {
						box.createDiv({ cls: 'anki-flaggen-vorschlag-art', text: 'Löschen' });
					} else {
						box.createDiv({ cls: 'anki-flaggen-vorschlag-feld', text: 'Vorderseite: ' + v.q });
						if (v.a) box.createDiv({ cls: 'anki-flaggen-vorschlag-feld', text: 'Rückseite: ' + v.a });
					}
					const kn = box.createDiv({ cls: 'anki-flaggen-gruppe-knoepfe' });
					const ja = new ButtonComponent(kn).setButtonText(v.op === 'delete' ? 'In Anki löschen' : 'In Anki übernehmen');
					if (v.op === 'delete') ja.setWarning(); else ja.setCta();
					ja.onClick(async () => {
						try {
							await uebernimmWaise(e, v);
							await this.merkeWaise(e.noteId, 'uebernommen');
							void syncNachAnkiWeb();
							await dienst.aktualisiere();
						} catch (err: any) {
							new Notice('Nicht übernommen: ' + (err?.message || err));
						}
					});
					new ButtonComponent(kn).setButtonText('Verwerfen').onClick(async () => {
						await this.merkeWaise(e.noteId, 'verworfen');
						dienst.datei = await ladeStapel(this.plugin);
						this.zeichne();
					});
				}

				const anki = reihe.createEl('a', { cls: 'anki-flaggen-link', text: 'In Anki zeigen' });
				anki.onclick = () => void zeigeInAnki(`nid:${e.noteId}`).catch((err) => new Notice(String(err?.message || err)));
			});
		}
	}

	private async merkeWaise(noteId: number, z: 'uebernommen' | 'verworfen') {
		const d = await ladeStapel(this.plugin);
		if (!d.waisen) return;
		d.waisen.erledigt[String(noteId)] = z;
		await speichereStapel(this.plugin, d);
	}

	/** Großer Chat; danach kommt dieses Fenster mit frischem Stand zurück. */
	private oeffneChat(pfad: string) {
		this.close();
		const chat = new ChatModal(this.plugin, pfad);
		const zu = chat.onClose.bind(chat);
		chat.onClose = () => {
			zu();
			new FlaggenModal(this.plugin).open();
		};
		chat.open();
	}

	private async schliesseAb(pfad: string, eintraege: FlaggenEintrag[]) {
		this.beschaeftigt.add(pfad);
		this.zeichne();
		try {
			const r = await schliesseNotizAb(this.plugin, pfad, eintraege);
			const teile = [`${r.uebertragen} übertragen`];
			if (r.geloescht) teile.push(`${r.geloescht} gelöscht`);
			teile.push(`${r.entflaggt} Flaggen entfernt`);
			new Notice(teile.join(', '));
			void syncNachAnkiWeb();
			await this.plugin.flaggen.aktualisiere();
		} catch (e: any) {
			new Notice('Abschließen fehlgeschlagen: ' + (e?.message || e), 8000);
		} finally {
			this.beschaeftigt.delete(pfad);
			this.zeichne();
		}
	}
}

function kurz(t: string, max = 140): string {
	const e = t.replace(/\s+/g, ' ').trim();
	return e.length > max ? e.slice(0, max - 1) + '…' : e;
}
