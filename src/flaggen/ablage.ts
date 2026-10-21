import { normalizePath } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { ChatMessage } from '../types';
import { scheduleSave } from '../chat/chatHistory';
import { AUFTRAG_KOPF } from './bearbeitung';
import { FlaggenEintrag, FlaggenStand } from './sammeln';
import { ablageName } from './spiegel';

/**
 * Was geprüft ist und was die KI geantwortet hat – je Notiz eine JSON-Datei
 * in einem Vault-Ordner (Einstellung `flaggenOrdner`).
 *
 * Im Vault, nicht im Plugin-Ordner: Obsidian Sync trägt aus dem Plugin-Ordner
 * nur main.js, manifest.json, styles.css und data.json. Bis 1.22.5 lag hier
 * `flaggen-stand.json` neben dem Plugin – ein zweites Gerät prüfte alles
 * noch einmal und bezahlte es noch einmal.
 *
 * Eine Datei je Notiz, damit zwei Geräte sich nicht gegenseitig überschreiben
 * (Sync löst JSON-Konflikte, indem der letzte Schreiber gewinnt).
 */

const ART = 'anki-flaggen';
const WAISEN_DATEI = 'Ohne Notiz.json';

export interface NotizStand {
	/** stapelSchluessel der geprüften Flaggen. */
	schluessel: string;
	/** ISO-Zeitpunkt. */
	am: string;
	modell: string;
	/** Nur Befunde, die erneutes Übertragen behebt – die KI wurde nicht gefragt. */
	ohneKi?: boolean;
	fehler?: string;
	/** Auftrag, wie er im Chat steht. */
	auftrag?: string;
	/** Antwort der KI samt Zustand der Vorschläge. */
	antwort?: ChatMessage;
	/** Die Karten beim letzten Blick in Anki – für die Liste ohne Anki. */
	karten?: FlaggenEintrag[];
}

export interface WaisenStand {
	schluessel: string;
	am: string;
	modell: string;
	antwort: string;
	/** Je Anki-Notiz-ID: schon in Anki übernommen? */
	erledigt: Record<string, 'uebernommen' | 'verworfen'>;
	fehler?: string;
	karten?: FlaggenEintrag[];
}

export interface StapelDatei {
	notizen: Record<string, NotizStand>;
	waisen?: WaisenStand;
}

export function ablageOrdner(plugin: AnkiGeneratorPlugin): string {
	return normalizePath(plugin.settings.flaggenOrdner || 'Lernen/Anki-Flaggen');
}

function notizDatei(plugin: AnkiGeneratorPlugin, pfad: string): string {
	return `${ablageOrdner(plugin)}/${ablageName(pfad)}`;
}

/** Liegt die Datei in der Ablage? Für die Vault-Ereignisse. */
export function inAblage(plugin: AnkiGeneratorPlugin, pfad: string): boolean {
	return pfad.startsWith(ablageOrdner(plugin) + '/') && pfad.endsWith('.json');
}

export async function ladeStapel(plugin: AnkiGeneratorPlugin): Promise<StapelDatei> {
	const d: StapelDatei = { notizen: {} };
	const ad = plugin.app.vault.adapter;
	const ordner = ablageOrdner(plugin);
	try {
		if (!(await ad.exists(ordner))) return d;
		const { files } = await ad.list(ordner);
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			try {
				const j = JSON.parse(await ad.read(f));
				if (j?.art !== ART) continue;
				if (j.waisen) d.waisen = j.waisen;
				else if (j.pfad && j.stand) {
					const alt = d.notizen[j.pfad];
					if (!alt || alt.am < j.stand.am) d.notizen[j.pfad] = j.stand;
				}
			} catch (e) {
				console.warn('[Flaggen] Ablage nicht lesbar', f, e);
			}
		}
	} catch (e) {
		console.warn('[Flaggen] Ablage nicht lesbar', e);
	}
	return d;
}

/** Eine Notiz frisch von der Platte – vor einer Prüfung, falls ein anderes Gerät schneller war. */
export async function ladeNotiz(plugin: AnkiGeneratorPlugin, pfad: string): Promise<NotizStand | null> {
	try {
		const j = JSON.parse(await plugin.app.vault.adapter.read(notizDatei(plugin, pfad)));
		return j?.art === ART && j.pfad === pfad ? j.stand : null;
	} catch {
		return null;
	}
}

async function schreibe(plugin: AnkiGeneratorPlugin, datei: string, inhalt: object) {
	const ad = plugin.app.vault.adapter;
	const ordner = ablageOrdner(plugin);
	if (!(await ad.exists(ordner))) {
		let teil = '';
		for (const s of ordner.split('/')) {
			teil = teil ? `${teil}/${s}` : s;
			if (!(await ad.exists(teil))) await ad.mkdir(teil);
		}
	}
	const text = JSON.stringify({ art: ART, version: 1, geaendert: new Date().toISOString(), ...inhalt }, null, '\t');
	await ad.write(datei, text);
}

export async function speichereNotiz(plugin: AnkiGeneratorPlugin, pfad: string, stand: NotizStand): Promise<void> {
	await schreibe(plugin, notizDatei(plugin, pfad), { pfad, stand });
}

export async function loescheNotiz(plugin: AnkiGeneratorPlugin, pfad: string): Promise<void> {
	const ad = plugin.app.vault.adapter;
	const datei = notizDatei(plugin, pfad);
	try {
		if (await ad.exists(datei)) await ad.remove(datei);
	} catch (e) {
		console.warn('[Flaggen] Ablage nicht gelöscht', datei, e);
	}
}

export async function speichereWaisen(plugin: AnkiGeneratorPlugin, waisen: WaisenStand): Promise<void> {
	await schreibe(plugin, `${ablageOrdner(plugin)}/${WAISEN_DATEI}`, { waisen });
}

/**
 * Die Liste ohne Anki: aus den Karten, die bei der letzten Prüfung dabei
 * waren. Ansehen und Übernehmen gehen, Abschließen braucht Anki.
 */
export function standAusAblage(d: StapelDatei): FlaggenStand {
	const notizen = new Map<string, FlaggenEintrag[]>();
	let anzahl = 0;
	for (const [pfad, s] of Object.entries(d.notizen)) {
		if (!s.karten?.length) continue;
		notizen.set(pfad, s.karten);
		anzahl += s.karten.length;
	}
	const waisen = d.waisen?.karten ?? [];
	return { notizen, waisen, anzahl: anzahl + waisen.length };
}

/**
 * Einmalig: den alten Stand aus dem Plugin-Ordner samt der Antworten aus dem
 * lokalen Chat in die Ablage holen. Die alte Datei bleibt umbenannt liegen.
 */
export async function uebernimmAltenStand(plugin: AnkiGeneratorPlugin): Promise<number> {
	const ad = plugin.app.vault.adapter;
	const dir = plugin.manifest.dir || `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
	const alt = `${dir}/flaggen-stand.json`;
	if (!(await ad.exists(alt))) return 0;

	let roh: any;
	try {
		roh = JSON.parse(await ad.read(alt));
	} catch {
		return 0;
	}
	const vorhanden = await ladeStapel(plugin);
	let n = 0;
	for (const [pfad, s] of Object.entries((roh?.notizen ?? {}) as Record<string, NotizStand>)) {
		if (vorhanden.notizen[pfad]) continue;
		const stand: NotizStand = { ...s };
		const verlauf = plugin.feedbackCache.get(pfad);
		const i = verlauf ? letzteFlaggenAntwort(verlauf) : -1;
		if (verlauf && i > 0) {
			verlauf[i].flaggenAm = s.am;
			stand.auftrag = verlauf[i - 1].content;
			stand.antwort = { ...verlauf[i] };
		}
		await speichereNotiz(plugin, pfad, stand);
		n++;
	}
	if (roh?.waisen && !vorhanden.waisen) await speichereWaisen(plugin, roh.waisen);
	// flaggenAm im lokalen Verlauf festhalten – sonst hängte der nächste Start die Antwort ein zweites Mal an.
	scheduleSave(plugin);
	await ad.rename(alt, `${dir}/flaggen-stand.uebernommen.json`);
	return n;
}

function letzteFlaggenAntwort(verlauf: ChatMessage[]): number {
	for (let i = verlauf.length - 1; i > 0; i--) {
		if (verlauf[i].role === 'ai' && verlauf[i - 1].role === 'user' && verlauf[i - 1].content.startsWith(AUFTRAG_KOPF)) return i;
	}
	return -1;
}
