import { Notice, Platform } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { ankiErreichbar } from '../anki/AnkiConnect';
import { FlaggenEintrag, FlaggenStand, sammleFlaggen, zaehleFlaggen } from './sammeln';
import { schonGeprueft, stapelSchluessel } from './flaggen';
import { StapelDatei, StapelErgebnis, StapelFortschritt, istGeprueft, ladeStapel, pruefeStapel, speichereStapel, waisenGeprueft } from './stapel';

export type NotizStatus = 'bereit' | 'nurUebertragen' | 'fehler' | 'offen';

/**
 * Hält den Stand der geflaggten Karten, startet den Stapel und entscheidet,
 * wann das Fenster von selbst aufgeht.
 *
 * Ein Objekt pro Plugin, damit Fenster und Hintergrundlauf denselben Stand
 * sehen: das Fenster darf während des Laufs zu- und wieder aufgehen.
 */
export class FlaggenDienst {
	stand: FlaggenStand | null = null;
	datei: StapelDatei = { notizen: {} };
	lauf: AbortController | null = null;
	fortschritt: StapelFortschritt | null = null;
	private hoerer = new Set<() => void>();
	/** Öffnet das Fenster – von main.ts gesetzt, damit hier kein UI-Import nötig ist. */
	oeffneFenster: () => void = () => { /* gesetzt in main.ts */ };

	constructor(private plugin: AnkiGeneratorPlugin) {}

	beobachte(f: () => void): () => void {
		this.hoerer.add(f);
		return () => this.hoerer.delete(f);
	}

	private melde() {
		this.hoerer.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
	}

	async aktualisiere(): Promise<void> {
		this.stand = await sammleFlaggen(this.plugin);
		this.datei = await ladeStapel(this.plugin);
		// Notizen ohne Flaggen mehr (abgeschlossen, am Handy entfernt) vergessen.
		const weg = Object.keys(this.datei.notizen).filter((p) => !this.stand?.notizen.has(p));
		if (weg.length && !this.lauf) {
			weg.forEach((p) => delete this.datei.notizen[p]);
			await speichereStapel(this.plugin, this.datei);
		}
		this.melde();
	}

	status(pfad: string, eintraege: FlaggenEintrag[]): NotizStatus {
		const s = this.datei.notizen[pfad];
		if (!s || !schonGeprueft(stapelSchluessel(eintraege), s.schluessel)) return 'offen';
		if (s.fehler) return 'fehler';
		return s.ohneKi ? 'nurUebertragen' : 'bereit';
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
			if (s === 'bereit' || s === 'nurUebertragen') n++;
		}
		if (this.stand.waisen.length && waisenGeprueft(this.datei, this.stand.waisen)) n++;
		return n;
	}

	async starteStapel(): Promise<StapelErgebnis | null> {
		if (this.lauf) return null;
		if (!this.stand) await this.aktualisiere();
		if (!this.stand) return null;

		this.lauf = new AbortController();
		this.fortschritt = { text: '', fertig: 0, gesamt: 0 };
		this.melde();
		try {
			const ergebnis = await pruefeStapel(this.plugin, this.stand, this.lauf.signal, (f) => {
				this.fortschritt = f;
				// Jede fertige Notiz steht schon in der Datei – Status sofort zeigen.
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
		const schwelle = Math.max(1, this.plugin.settings.flaggenSchwelle || 10);
		const offen = this.offeneKarten();

		if (offen >= schwelle) {
			new Notice(`${offen} geflaggte Karten – KI prüft im Hintergrund.`);
			const e = await this.starteStapel();
			if (e && e.geprueft > 0) {
				if (fensterErlaubt) this.oeffneFenster();
				else new Notice(`Geflaggte Karten: ${e.geprueft} Notizen geprüft.`, 8000);
			}
			return;
		}
		if (fensterErlaubt && this.bereiteNotizen() > 0) this.oeffneFenster();
	}
}
