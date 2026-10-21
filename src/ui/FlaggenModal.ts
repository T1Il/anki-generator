import { ButtonComponent, Modal, Notice, TFile, setIcon } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { ChatModal } from './chat/ChatModal';
import { FlaggenEintrag } from '../flaggen/sammeln';
import { flaggenArt, waisenBegruendung } from '../flaggen/flaggen';
import { htmlToPlain } from '../anki/driftCheck';
import { zeigeInAnki } from '../anki/AnkiConnect';
import { uebernimmWaise, waisenVorschlaege } from '../flaggen/abschluss';
import { ladeStapel, speichereWaisen } from '../flaggen/ablage';
import { NotizStatus } from '../flaggen/bearbeitung';

const STATUS_TEXT: Record<NotizStatus, string> = {
	unbearbeitet: 'unbearbeitet',
	teilweise: 'teilweise bearbeitet',
	offen: 'ungeprüft',
	fehler: 'Fehler',
	bearbeitet: 'bearbeitet',
	ohneVorschlag: 'keine Änderung vorgeschlagen',
	nurUebertragen: 'neu übertragen'
};

/** Nur noch abschließen – Knopf hervorheben, Gruppe zurücknehmen. */
const NUR_ABSCHLUSS = new Set<NotizStatus>(['bearbeitet', 'ohneVorschlag', 'nurUebertragen']);

/**
 * Geflaggte Karten durchsehen und abschließen.
 *
 * Je Notiz: Karten mit Flagge und Befund, „Ansehen“ öffnet den großen Chat mit
 * den Vorschlägen der KI, „Abschließen“ bringt den Vault-Stand nach Anki und
 * nimmt die Flaggen weg. Karten ohne Notiz werden direkt in Anki korrigiert.
 *
 * „Durchgehen“ öffnet eine Notiz nach der anderen im großen Chat, mit einer
 * Leiste oben (Flaggen, Stand, „Abschließen & weiter“) – ohne Umweg über
 * diese Liste. Abschließen wartet nie: es läuft im Dienst in einer
 * Warteschlange (bis 1.22.5 kam die Liste erst nach Übertragen, Neuladen
 * aus Anki und Sync wieder).
 */
export class FlaggenModal extends Modal {
	private liste!: HTMLElement;
	private kopf!: HTMLElement;
	private abmelden: (() => void) | null = null;

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
		} else if (dienst.ohneAnki) {
			// Vielleicht ist Anki inzwischen da – im Hintergrund nachsehen.
			void dienst.aktualisiere().catch(() => undefined);
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
		const zuTun = dienst.nochOffen();
		if (zuTun) zahlen.createSpan({ text: ` · ${zuTun} ${zuTun === 1 ? 'Notiz' : 'Notizen'} offen` });
		if (dienst.imAbschluss.size) zahlen.createSpan({ text: ` · ${dienst.imAbschluss.size} im Abschluss` });
		if (dienst.ohneAnki) zahlen.createSpan({ cls: 'anki-flaggen-ohne-anki', text: 'Anki offline' });

		const knoepfe = this.kopf.createDiv({ cls: 'anki-flaggen-knoepfe' });
		const naechste = dienst.naechste();
		const durch = new ButtonComponent(knoepfe).setButtonText('Durchgehen').setDisabled(!naechste);
		if (naechste) durch.setCta();
		durch.onClick(() => {
			dienst.gesehen.clear();
			const n = dienst.naechste();
			if (!n) return;
			this.close();
			oeffneFlaggenChat(this.plugin, n);
		});
		if (dienst.lauf) {
			const f = dienst.fortschritt;
			const lauf = this.kopf.createDiv({ cls: 'anki-flaggen-lauf' });
			lauf.createSpan({ text: f && f.gesamt ? `Prüfe ${f.fertig + 1}/${f.gesamt}: ${f.text}` : 'Prüfe …' });
			new ButtonComponent(knoepfe).setButtonText('Abbrechen').onClick(() => dienst.brecheAb());
		} else if (!dienst.ohneAnki) {
			const alle = new ButtonComponent(knoepfe).setButtonText('Alle prüfen lassen').setDisabled(offen === 0);
			if (offen && !naechste) alle.setCta();
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
		for (const n of dienst.sortierteNotizen()) this.zeichneNotiz(n.pfad, n.e, n.status);
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
		const dienst = this.plugin.flaggen;
		const laeuft = dienst.imAbschluss.has(pfad);
		let text = laeuft ? 'wird abgeschlossen' : STATUS_TEXT[status];
		if (!laeuft && status === 'teilweise') {
			const b = dienst.bearbeitung(pfad);
			if (b.vorschlaege) text += ` (${b.erledigt}/${b.vorschlaege})`;
		}
		if (laeuft || NUR_ABSCHLUSS.has(status)) gruppe.addClass('is-erledigt');
		kopf.createSpan({ cls: `anki-flaggen-status is-${laeuft ? 'laeuft' : status}`, text });
		const fehler = dienst.datei.notizen[pfad]?.fehler;
		if (status === 'fehler' && fehler) kopf.createSpan({ cls: 'anki-flaggen-fehler', text: fehler });

		const k = kopf.createDiv({ cls: 'anki-flaggen-gruppe-knoepfe' });
		if (status !== 'nurUebertragen') {
			new ButtonComponent(k).setButtonText('Ansehen').onClick(() => {
				this.close();
				oeffneFlaggenChat(this.plugin, pfad);
			});
		}
		const ab = new ButtonComponent(k).setButtonText('Abschließen');
		if (NUR_ABSCHLUSS.has(status)) ab.setCta();
		ab.setDisabled(laeuft || dienst.ohneAnki);
		ab.onClick(() => dienst.reiheAbschluss(pfad, eintraege));

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
		new ButtonComponent(knoepfe).setIcon('flag-off').setTooltip('Flagge entfernen')
			.setDisabled(this.plugin.flaggen.ohneAnki)
			.onClick(() => this.plugin.flaggen.entferneFlagge(e));
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
					ja.setDisabled(dienst.ohneAnki);
					ja.onClick(async () => {
						try {
							await uebernimmWaise(e, v);
							await this.merkeWaise(e.noteId, 'uebernommen');
							dienst.planeSync();
							this.zeichne();
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
		await speichereWaisen(this.plugin, d.waisen);
		this.plugin.flaggen.datei = d;
	}
}

/**
 * Eine Notiz im großen Chat, mit Leiste zum Durchgehen. Schließen führt
 * sofort zurück in die Liste; ist die Notiz fertig, schließt der Dienst sie
 * im Hintergrund ab.
 */
export function oeffneFlaggenChat(plugin: AnkiGeneratorPlugin, pfad: string) {
	const dienst = plugin.flaggen;
	dienst.gesehen.add(pfad);
	let weiter: string | null = null;

	const chat = new ChatModal(plugin, pfad, (el, m) => zeichneLeiste(plugin, el, m, (abschliessen) => {
		if (abschliessen) dienst.reiheAbschluss(pfad);
		weiter = dienst.naechste(pfad);
		m.close();
	}));
	chat.scope.register(['Alt'], 'ArrowRight', () => {
		dienst.reiheAbschluss(pfad);
		weiter = dienst.naechste(pfad);
		chat.close();
		return false;
	});
	const abmelden = dienst.beobachte(() => chat.zeichneLeiste());
	const zu = chat.onClose.bind(chat);
	chat.onClose = () => {
		zu();
		abmelden();
		dienst.schliesseAbWennFertig(pfad);
		if (weiter) oeffneFlaggenChat(plugin, weiter);
		else new FlaggenModal(plugin).open();
	};
	chat.open();
}

/** Leiste über dem Chat: Flaggen der Notiz, Stand, Weiter. */
function zeichneLeiste(
	plugin: AnkiGeneratorPlugin,
	el: HTMLElement,
	m: ChatModal,
	weiter: (abschliessen: boolean) => void
) {
	const dienst = plugin.flaggen;
	const pfad = m.pfad;
	const eintraege = dienst.stand?.notizen.get(pfad) ?? [];

	const flaggen = el.createDiv({ cls: 'anki-chat-leiste-flaggen' });
	for (const e of eintraege) {
		const art = flaggenArt(e.flagge);
		const chip = flaggen.createSpan({ cls: 'anki-chat-leiste-flagge', attr: { title: kurz(htmlToPlain(e.anki.felder[0] ?? '')) } });
		chip.createSpan({ cls: 'anki-flaggen-flagge' }).style.backgroundColor = art.css;
		if (e.kartenNummer) chip.createSpan({ cls: 'anki-flaggen-nummer', text: String(e.kartenNummer) });
		chip.createSpan({ text: art.bedeutung });
	}

	const rechts = el.createDiv({ cls: 'anki-chat-leiste-rechts' });
	const laeuft = dienst.imAbschluss.has(pfad);
	const status = eintraege.length ? dienst.status(pfad, eintraege) : null;
	let text = laeuft ? 'wird abgeschlossen' : !eintraege.length ? 'abgeschlossen' : status ? STATUS_TEXT[status] : '';
	if (!laeuft && status && status !== 'ohneVorschlag') {
		const b = dienst.bearbeitung(pfad);
		if (b.vorschlaege) text = `${b.erledigt}/${b.vorschlaege} Vorschläge`;
	}
	rechts.createSpan({ cls: `anki-flaggen-status is-${laeuft ? 'laeuft' : status ?? 'bearbeitet'}`, text });

	const rest = dienst.nochOffen(pfad);
	if (rest > 0) rechts.createSpan({ cls: 'anki-chat-leiste-rest', text: `noch ${rest}` });

	const liste = rechts.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Liste' } });
	setIcon(liste, 'list');
	liste.addEventListener('click', () => m.close());

	const hatNaechste = dienst.naechste(pfad) !== null;
	if (hatNaechste) {
		new ButtonComponent(rechts).setButtonText('Überspringen').onClick(() => weiter(false));
	}
	const fertig = status === 'bearbeitet' || status === 'ohneVorschlag' || status === 'nurUebertragen';
	const kannAbschliessen = !dienst.ohneAnki && !laeuft && eintraege.length > 0;
	const haupt = new ButtonComponent(rechts)
		.setButtonText(kannAbschliessen ? (hatNaechste ? 'Abschließen & weiter' : 'Abschließen') : (hatNaechste ? 'Weiter' : 'Fertig'))
		.setTooltip(kannAbschliessen ? 'Alt+→' : '');
	if (fertig || !kannAbschliessen) haupt.setCta();
	haupt.onClick(() => weiter(kannAbschliessen));
}

function kurz(t: string, max = 140): string {
	const e = t.replace(/\s+/g, ' ').trim();
	return e.length > max ? e.slice(0, max - 1) + '…' : e;
}
