import { Notice, Platform, TAbstractFile } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { ChatMessage } from '../types';
import { ankiErreichbar } from '../anki/AnkiConnect';
import { setHistory } from '../chat/chatHistory';
import { entferneFlaggen, schliesseNotizAb, syncNachAnkiWeb } from './abschluss';
import { FlaggenEintrag, FlaggenStand, dateiFuer, sammleFlaggen, zaehleFlaggen } from './sammeln';
import { AUFTRAG_KOPF, Bearbeitung, NotizStatus, STATUS_RANG, bearbeitungsStand, statusAus } from './bearbeitung';
import { schonGeprueft, stapelSchluessel } from './flaggen';
import { StapelDatei, inAblage, ladeStapel, loescheNotiz, speichereNotiz, standAusAblage, uebernimmAltenStand } from './ablage';
import { abgleich, findeFlaggenAntwort, fingerabdruck, spiegleInVerlauf } from './spiegel';
import { StapelErgebnis, StapelFortschritt, istGeprueft, pruefeStapel, waisenGeprueft } from './stapel';

/** Erst so lange nach dem letzten Abschluss zu AnkiWeb – sonst sperrt jeder Sync den nächsten Abschluss. */
const SYNC_NACH_MS = 20 * 1000;
/** Ablage einer Notiz ohne Flaggen erst nach dieser Zeit löschen (ein anderes Anki kann hinterher sein). */
const VERWAIST_NACH_MS = 3 * 24 * 60 * 60 * 1000;

/** Was beim Durchgehen als Nächstes drankommt. */
const ZUM_DURCHGEHEN = new Set<NotizStatus>(['unbearbeitet', 'teilweise', 'ohneVorschlag']);

/**
 * Hält den Stand der geflaggten Karten, startet den Stapel und entscheidet,
 * wann das Fenster von selbst aufgeht.
 *
 * Ein Objekt pro Plugin, damit Fenster, Chat und Hintergrundlauf denselben
 * Stand sehen: das Fenster darf während des Laufs zu- und wieder aufgehen.
 *
 * Seit 1.23.0 wartet die Oberfläche auf nichts mehr: Abschließen läuft in
 * einer Warteschlange, die Liste wird danach lokal nachgeführt statt aus Anki
 * neu geladen, und zu AnkiWeb geht es einmal, wenn eine Weile Ruhe ist.
 */
export class FlaggenDienst {
	stand: FlaggenStand | null = null;
	datei: StapelDatei = { notizen: {} };
	lauf: AbortController | null = null;
	fortschritt: StapelFortschritt | null = null;
	/** Anki war beim letzten Laden nicht erreichbar – Liste aus der Ablage. */
	ohneAnki = false;
	/** Notizen in der Warteschlange oder gerade im Abschluss. */
	imAbschluss = new Set<string>();
	/** Beim Durchgehen schon gezeigt – „Weiter“ springt nicht zurück. */
	gesehen = new Set<string>();

	private hoerer = new Set<() => void>();
	private schlange: { pfad: string; eintraege: FlaggenEintrag[] }[] = [];
	private schlangeLaeuft = false;
	private summe = { notizen: 0, uebertragen: 0, geloescht: 0, entflaggt: 0 };
	private syncTimer = 0;
	private neuLadenTimer = 0;
	/** Je Notiz der Zustand der Vorschläge beim letzten Abgleich (Fingerabdruck). */
	private basis = new Map<string, string>();
	/** Öffnet das Fenster – von main.ts gesetzt, damit hier kein UI-Import nötig ist. */
	oeffneFenster: () => void = () => { /* gesetzt in main.ts */ };

	constructor(private plugin: AnkiGeneratorPlugin) {}

	/** Ablage laden, alten Stand übernehmen, auf Änderungen von anderen Geräten hören. */
	async starte(): Promise<void> {
		try {
			const n = await uebernimmAltenStand(this.plugin);
			if (n) console.info(`[Flaggen] ${n} Prüfergebnisse in die Ablage übernommen`);
		} catch (e) {
			console.warn('[Flaggen] Alter Stand nicht übernommen', e);
		}
		this.datei = await ladeStapel(this.plugin);
		this.gleicheAlleAb();
		this.melde();

		const beiAenderung = (f: TAbstractFile) => {
			if (!inAblage(this.plugin, f.path)) return;
			window.clearTimeout(this.neuLadenTimer);
			this.neuLadenTimer = window.setTimeout(() => void this.ladeAblage(), 800);
		};
		const vault = this.plugin.app.vault;
		this.plugin.registerEvent(vault.on('create', beiAenderung));
		this.plugin.registerEvent(vault.on('modify', beiAenderung));
		this.plugin.registerEvent(vault.on('delete', beiAenderung));
	}

	beobachte(f: () => void): () => void {
		this.hoerer.add(f);
		return () => this.hoerer.delete(f);
	}

	melde() {
		this.hoerer.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
	}

	private async ladeAblage() {
		this.datei = await ladeStapel(this.plugin);
		this.gleicheAlleAb();
		if (this.ohneAnki) this.stand = standAusAblage(this.datei);
		this.melde();
	}

	/**
	 * Alles neu aus Anki. Ohne Anki (Laptop, Handy, Anki zu) die Liste aus der
	 * Ablage – wirft nur, wenn auch dort nichts liegt.
	 */
	async aktualisiere(): Promise<void> {
		this.datei = await ladeStapel(this.plugin);
		this.gleicheAlleAb();
		try {
			this.stand = await sammleFlaggen(this.plugin);
			this.ohneAnki = false;
		} catch (e) {
			const s = standAusAblage(this.datei);
			if (!s.anzahl) throw e;
			this.stand = s;
			this.ohneAnki = true;
			this.melde();
			return;
		}
		await this.pflegeAblage();
		this.melde();
	}

	/** Karten der Ablage auf den Stand von Anki bringen, Verwaistes nach Tagen löschen. */
	private async pflegeAblage() {
		if (!this.stand || this.lauf) return;
		for (const [pfad, e] of this.stand.notizen) {
			const s = this.datei.notizen[pfad];
			const k = stapelSchluessel(e);
			if (!s || !schonGeprueft(k, s.schluessel) || stapelSchluessel(s.karten ?? []) === k) continue;
			s.karten = e;
			await speichereNotiz(this.plugin, pfad, s).catch((err) => console.warn('[Flaggen] Ablage', err));
		}
		for (const [pfad, s] of Object.entries(this.datei.notizen)) {
			if (this.stand.notizen.has(pfad) || this.imAbschluss.has(pfad)) continue;
			if (Date.now() - Date.parse(s.am) < VERWAIST_NACH_MS) continue;
			await loescheNotiz(this.plugin, pfad);
			delete this.datei.notizen[pfad];
		}
	}

	status(pfad: string, eintraege: FlaggenEintrag[]): NotizStatus {
		const s = this.datei.notizen[pfad];
		if (!s || !schonGeprueft(stapelSchluessel(eintraege), s.schluessel)) return 'offen';
		if (s.fehler) return 'fehler';
		if (s.ohneKi) return 'nurUebertragen';
		return statusAus(this.bearbeitung(pfad));
	}

	/**
	 * Vorschläge der Flaggen-Antwort und wie viele davon erledigt sind. Der
	 * lokale Verlauf zählt, sobald die Antwort dort steht (er ist der frischeste
	 * Stand), sonst die Ablage – so stimmt der Stand auch auf einem Gerät, auf
	 * dem der Chat noch nie offen war.
	 */
	bearbeitung(pfad: string): Bearbeitung {
		const s = this.datei.notizen[pfad];
		const datei = dateiFuer(this.plugin, pfad);
		const lokal = s ? findeFlaggenAntwort(this.plugin.feedbackCache.get(pfad), s.am) : undefined;
		const antwort = lokal ?? s?.antwort;
		const verlauf: ChatMessage[] | undefined = antwort
			? [{ role: 'user', content: AUFTRAG_KOPF }, antwort]
			: this.plugin.feedbackCache.get(pfad);
		return bearbeitungsStand(verlauf, s?.am, datei ? datei.stat.mtime : null);
	}

	/**
	 * Vor dem Öffnen eines Chats: die Antwort aus der Ablage in den Verlauf
	 * der Notiz bringen (fehlt auf einem zweiten Gerät, oder nach 30 anderen
	 * Chats aus dem lokalen Verlauf gefallen) und den Zustand abgleichen.
	 */
	spiegleInChat(pfad: string | undefined): void {
		if (!pfad) return;
		const s = this.datei.notizen[pfad];
		if (!s?.antwort) return;
		const verlauf = this.plugin.feedbackCache.get(pfad) ?? [];
		if (!findeFlaggenAntwort(verlauf, s.am)) {
			spiegleInVerlauf(verlauf, s.am, { auftrag: s.auftrag ?? AUFTRAG_KOPF, antwort: s.antwort });
			this.basis.set(pfad, fingerabdruck(s.antwort.vorschlaege));
			setHistory(this.plugin, pfad, verlauf);
			return;
		}
		this.gleicheAb(pfad);
	}

	/** Nach jedem Speichern des Chat-Verlaufs: Übernommenes/Verworfenes in die Ablage. */
	spiegleZurueck(): void {
		this.gleicheAlleAb();
	}

	private gleicheAlleAb() {
		for (const pfad of Object.keys(this.datei.notizen)) this.gleicheAb(pfad);
	}

	/** Lokalen Verlauf und Ablage einer Notiz abgleichen (siehe `abgleich`). */
	private gleicheAb(pfad: string) {
		const s = this.datei.notizen[pfad];
		if (!s?.antwort) return;
		const lokal = findeFlaggenAntwort(this.plugin.feedbackCache.get(pfad), s.am);
		if (!lokal) return;
		const richtung = abgleich(lokal.vorschlaege, s.antwort.vorschlaege, this.basis.get(pfad));
		if (richtung === 'schieben') {
			if (lokal.vorschlaege) s.antwort.vorschlaege = JSON.parse(JSON.stringify(lokal.vorschlaege));
			else delete s.antwort.vorschlaege;
			void speichereNotiz(this.plugin, pfad, s).catch((e) => console.warn('[Flaggen] Ablage', e));
		} else if (richtung === 'ziehen') {
			if (s.antwort.vorschlaege) lokal.vorschlaege = JSON.parse(JSON.stringify(s.antwort.vorschlaege));
			else delete lokal.vorschlaege;
			const verlauf = this.plugin.feedbackCache.get(pfad) as ChatMessage[];
			setHistory(this.plugin, pfad, verlauf);
			this.plugin.app.workspace.trigger('anki:chat-update', pfad, verlauf);
		}
		this.basis.set(pfad, fingerabdruck(lokal.vorschlaege));
	}

	/** Karten, die noch keine Prüfung gesehen haben. */
	offeneKarten(): number {
		if (!this.stand) return 0;
		let n = 0;
		for (const [pfad, e] of this.stand.notizen) if (!istGeprueft(this.datei, pfad, e)) n += e.length;
		if (this.stand.waisen.length && !waisenGeprueft(this.datei, this.stand.waisen)) n += this.stand.waisen.length;
		return n;
	}

	/** Notizen, deren Prüfung fertig ist und die auf Durchsicht warten. */
	bereiteNotizen(): number {
		if (!this.stand) return 0;
		let n = 0;
		for (const [pfad, e] of this.stand.notizen) {
			const s = this.status(pfad, e);
			if (s !== 'offen' && s !== 'fehler') n++;
		}
		if (this.stand.waisen.length && waisenGeprueft(this.datei, this.stand.waisen)) n++;
		return n;
	}

	/** Notizen in der Reihenfolge der Liste: Unbearbeitetes zuerst. */
	sortierteNotizen(): { pfad: string; e: FlaggenEintrag[]; status: NotizStatus }[] {
		if (!this.stand) return [];
		return Array.from(this.stand.notizen.entries())
			.map(([pfad, e]) => ({ pfad, e, status: this.status(pfad, e) }))
			.sort((a, b) => STATUS_RANG[a.status] - STATUS_RANG[b.status] || a.pfad.localeCompare(b.pfad));
	}

	/** Die nächste Notiz zum Durchgehen – erst Unbearbeitetes, „keine Änderung“ zuletzt. */
	naechste(ausser?: string): string | null {
		const kandidaten = this.sortierteNotizen()
			.filter((n) => n.pfad !== ausser && !this.imAbschluss.has(n.pfad) && ZUM_DURCHGEHEN.has(n.status));
		const neu = kandidaten.find((n) => !this.gesehen.has(n.pfad));
		return (neu ?? kandidaten[0])?.pfad ?? null;
	}

	/** Wie viele Notizen beim Durchgehen noch anstehen (ohne die gerade offene). */
	nochOffen(ausser?: string): number {
		return this.sortierteNotizen()
			.filter((n) => n.pfad !== ausser && !this.imAbschluss.has(n.pfad) && ZUM_DURCHGEHEN.has(n.status)).length;
	}

	async starteStapel(): Promise<StapelErgebnis | null> {
		if (this.lauf || this.ohneAnki) return null;
		if (!this.stand) await this.aktualisiere();
		if (!this.stand) return null;

		this.lauf = new AbortController();
		this.fortschritt = { text: '', fertig: 0, gesamt: 0 };
		this.melde();
		try {
			const ergebnis = await pruefeStapel(this.plugin, this.stand, this.lauf.signal, (f) => {
				this.fortschritt = f;
				// Jede fertige Notiz steht schon in der Ablage – Status sofort zeigen.
				void ladeStapel(this.plugin).then((d) => { this.datei = d; this.melde(); });
			});
			return ergebnis;
		} catch (e: any) {
			new Notice('Prüfung fehlgeschlagen: ' + (e?.message || e), 8000);
			return null;
		} finally {
			this.lauf = null;
			this.fortschritt = null;
			this.datei = await ladeStapel(this.plugin);
			this.melde();
		}
	}

	// --- Abschließen ------------------------------------------------------------

	/**
	 * Eine Notiz zum Abschließen vormerken. Kehrt sofort zurück; die Liste
	 * zeigt „wird abgeschlossen“, bis Anki fertig ist.
	 */
	reiheAbschluss(pfad: string, eintraege?: FlaggenEintrag[]): boolean {
		const e = eintraege ?? this.stand?.notizen.get(pfad);
		if (!e || this.ohneAnki || this.imAbschluss.has(pfad)) return false;
		this.imAbschluss.add(pfad);
		this.schlange.push({ pfad, eintraege: e });
		this.melde();
		void this.arbeiteSchlangeAb();
		return true;
	}

	private async arbeiteSchlangeAb() {
		if (this.schlangeLaeuft) return;
		this.schlangeLaeuft = true;
		window.clearTimeout(this.syncTimer);
		try {
			while (this.schlange.length) {
				const j = this.schlange.shift()!;
				try {
					const r = await schliesseNotizAb(this.plugin, j.pfad, j.eintraege);
					this.summe.notizen++;
					this.summe.uebertragen += r.uebertragen;
					this.summe.geloescht += r.geloescht;
					this.summe.entflaggt += r.entflaggt;
					this.vergiss(j.pfad);
				} catch (e: any) {
					new Notice(`Abschließen fehlgeschlagen (${j.pfad.split('/').pop()?.replace(/\.md$/, '')}): ${e?.message || e}`, 8000);
				} finally {
					this.imAbschluss.delete(j.pfad);
					this.melde();
				}
			}
		} finally {
			this.schlangeLaeuft = false;
		}
		this.planeSync();
	}

	/** Abgeschlossene Notiz aus dem Stand nehmen, ohne Anki zu fragen. */
	private vergiss(pfad: string) {
		const e = this.stand?.notizen.get(pfad);
		if (this.stand && e) {
			this.stand.notizen.delete(pfad);
			this.stand.anzahl = Math.max(0, this.stand.anzahl - e.length);
		}
		delete this.datei.notizen[pfad];
		this.gesehen.delete(pfad);
	}

	/** Flagge einer Karte weg: sofort aus der Liste, Anki im Hintergrund. */
	entferneFlagge(e: FlaggenEintrag): void {
		if (this.ohneAnki || !this.stand) return;
		const liste = e.pfad ? this.stand.notizen.get(e.pfad) : this.stand.waisen;
		if (liste) {
			const i = liste.findIndex((x) => x.cardId === e.cardId);
			if (i >= 0) {
				liste.splice(i, 1);
				this.stand.anzahl = Math.max(0, this.stand.anzahl - 1);
				if (e.pfad && !liste.length) this.stand.notizen.delete(e.pfad);
			}
		}
		this.melde();
		void entferneFlaggen([e.cardId])
			.then(() => this.planeSync())
			.catch((err) => {
				new Notice('Flagge nicht entfernt: ' + (err?.message || err));
				void this.aktualisiere().catch(() => undefined);
			});
	}

	/**
	 * AnkiWeb-Sync, wenn eine Weile nichts abgeschlossen wurde. Während des
	 * Syncs ist Anki gesperrt; danach still neu laden – dabei kommen auch die
	 * Flaggen vom Handy an.
	 */
	planeSync() {
		window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			if (this.schlangeLaeuft) return this.planeSync();
			this.meldeSumme();
			void syncNachAnkiWeb()
				.then(() => this.aktualisiere())
				.catch((e) => console.warn('[Flaggen] Neu laden nach dem Sync', e));
		}, SYNC_NACH_MS);
	}

	private meldeSumme() {
		const s = this.summe;
		if (!s.notizen) return;
		const teile = [`${s.notizen} ${s.notizen === 1 ? 'Notiz' : 'Notizen'} abgeschlossen`, `${s.uebertragen} übertragen`];
		if (s.geloescht) teile.push(`${s.geloescht} gelöscht`);
		teile.push(`${s.entflaggt} Flaggen entfernt`);
		new Notice(teile.join(' · '));
		this.summe = { notizen: 0, uebertragen: 0, geloescht: 0, entflaggt: 0 };
	}

	/**
	 * Fertiges ohne Klick abschließen: Notizen, deren Vorschläge alle übernommen
	 * oder verworfen sind, und reine „neu übertragen“-Fälle. „Keine Änderung
	 * vorgeschlagen“ bleibt stehen – die Karte hat dann noch niemand angesehen.
	 * Gibt die Zahl der vorgemerkten Notizen zurück.
	 */
	schliesseFertigeAb(): number {
		if (!this.plugin.settings.flaggenAutoAbschluss || this.ohneAnki || !this.stand) return 0;
		let n = 0;
		for (const [pfad, e] of this.stand.notizen) {
			const s = this.status(pfad, e);
			if ((s === 'bearbeitet' || s === 'nurUebertragen') && this.reiheAbschluss(pfad, e)) n++;
		}
		return n;
	}

	/** Eine Notiz abschließen, wenn sie fertig ist (nach dem Chat). */
	schliesseAbWennFertig(pfad: string): boolean {
		if (!this.plugin.settings.flaggenAutoAbschluss || !this.stand) return false;
		const e = this.stand.notizen.get(pfad);
		if (!e) return false;
		const s = this.status(pfad, e);
		return (s === 'bearbeitet' || s === 'nurUebertragen') && this.reiheAbschluss(pfad, e);
	}

	brecheAb() {
		this.lauf?.abort();
	}

	/**
	 * Beim Start von Obsidian (und stündlich): sind Vorschläge bereit, geht
	 * das Fenster auf; liegen mindestens X ungeprüfte Flaggen vor, prüft die
	 * KI sie im Hintergrund. Ohne Anki am Desktop passiert nichts.
	 */
	async pruefeBeiBedarf(fensterErlaubt: boolean): Promise<void> {
		if (!Platform.isDesktopApp || this.lauf) return;
		if (!(await ankiErreichbar())) return;
		if ((await zaehleFlaggen()) === 0) return;

		await this.aktualisiere();
		this.schliesseFertigeAb();
		const schwelle = Math.max(1, this.plugin.settings.flaggenSchwelle || 10);
		const offen = this.offeneKarten();

		if (offen >= schwelle) {
			new Notice(`${offen} geflaggte Karten – KI prüft im Hintergrund.`);
			const e = await this.starteStapel();
			this.schliesseFertigeAb();
			if (e && e.geprueft > 0) {
				if (fensterErlaubt) this.oeffneFenster();
				else new Notice(`Geflaggte Karten: ${e.geprueft} Notizen geprüft.`, 8000);
			}
			return;
		}
		if (fensterErlaubt && this.bereiteNotizen() > 0) this.oeffneFenster();
	}
}
