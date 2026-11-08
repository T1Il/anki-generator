import { requestUrl } from 'obsidian';

/**
 * Lernplan auf dem Server (08.11.2026). Das Plugin schreibt nie selbst in die Lernplan-Notiz:
 * Verknüpfen, Durchgang und Chat laufen über dieselben Endpunkte wie App und Web.
 */
export interface LernAufgabe { kw: number; jahr: number; index: number; text: string; passt?: boolean; verknuepft?: boolean; }
export interface LernPunkt { id: number; typ: string; status: string; ueberschrift?: string; pfad?: string; alt?: string; neu?: string; text?: string; vorne?: string; hinten?: string; belege?: { titel?: string; seite?: number }[]; }
export interface ChatEreignis { type: string; text?: string; name?: string; einbettung?: any; punkt?: LernPunkt; }

export const GRUENDE: [string, string][] = [['falsch', 'Falsch'], ['unwichtig', 'Unwichtig'], ['zu_lang', 'Zu lang'], ['doppelt', 'Doppelt'], ['schon_klar', 'Schon klar']];

/** NDJSON-Antwort des Chats in Ereignisse. Kaputte Zeilen fallen weg. */
export function chatEreignisse(text: string): ChatEreignis[] {
	const raus: ChatEreignis[] = [];
	for (const z of (text || '').split('\n')) {
		if (!z.trim()) continue;
		try { raus.push(JSON.parse(z)); } catch { /* unvollständige Zeile */ }
	}
	return raus;
}

/** Kartenvorschlag des Chats in die gemeinsame Rückmeldung. */
export function rueckmeldungAus(v: { kind: string; q?: string; a?: string; replace?: string; text?: string }, status: 'uebernommen' | 'verworfen', grund?: string, grundText?: string) {
	const karte = v.kind === 'card';
	return { typ: karte ? 'karte' : 'luecke', status, vorne: karte ? v.q : undefined, hinten: karte ? v.a : undefined,
		neu: karte ? undefined : (v.replace ?? v.text), grund, grund_text: grundText, herkunft: 'plugin' };
}

export class LernplanApi {
	constructor(private basis: () => string) {}

	private async ruf(pfad: string, methode = 'GET', koerper?: unknown) {
		const b = (this.basis() || '').replace(/\/$/, '');
		if (!b) throw new Error('Keine Fitness-Manager-Adresse in den Einstellungen.');
		const r = await requestUrl({ url: b + pfad, method: methode, throw: false,
			...(koerper !== undefined ? { contentType: 'application/json', body: JSON.stringify(koerper) } : {}) });
		if (r.status === 409) throw new Error('Inzwischen geändert. Bitte neu laden.');
		if (r.status >= 400) throw new Error(r.json?.detail || `Server antwortet mit ${r.status}`);
		return r;
	}

	async plan() { return (await this.ruf('/api/lernplan')).json; }
	async aufgabenFuerNotiz(pfad: string): Promise<LernAufgabe[]> { return (await this.ruf(`/api/lernplan/notiz/aufgaben?pfad=${encodeURIComponent(pfad)}`)).json.aufgaben || []; }
	async verknuepfen(a: LernAufgabe, pfad: string) { return (await this.ruf('/api/lernplan/aufgabe/notiz', 'POST', { kw: a.kw, jahr: a.jahr, index: a.index, pfad, text: a.text })).json; }
	async loesen(a: LernAufgabe, pfad: string) { return (await this.ruf('/api/lernplan/aufgabe/notiz/loesen', 'POST', { kw: a.kw, jahr: a.jahr, index: a.index, pfad, text: a.text })).json; }
	async pruefstand(kw: number, jahr: number): Promise<Record<string, string>> { return (await this.ruf(`/api/lernplan/durchgang/pruefstand?kw=${kw}&jahr=${jahr}`)).json.aufgaben || {}; }
	async durchgangStarten(kw: number, jahr: number, aufgaben: number[]) { return (await this.ruf('/api/lernplan/durchgang', 'POST', { kw, jahr, aufgaben })).json.durchgang; }
	async durchgang(kw: number, jahr: number) { return (await this.ruf(`/api/lernplan/durchgang?kw=${kw}&jahr=${jahr}&auch_spaeter=true`)).json.durchgang; }
	async punkt(id: number, aktion: string, wert: Record<string, unknown> = {}): Promise<LernPunkt> { return (await this.ruf(`/api/lernplan/durchgang/punkt/${id}`, 'POST', { aktion, ...wert })).json.punkt; }
	async rueckmeldung(eintrag: Record<string, unknown>) { await this.ruf('/api/lernplan/rueckmeldung', 'POST', eintrag); }
	async chatAnlegen(felder: Record<string, unknown>) { return (await this.ruf('/api/lernchat', 'POST', felder)).json; }
	async chatLesen(id: number) { return (await this.ruf(`/api/lernchat/${id}`)).json; }
	async chatFragen(id: number, text: string): Promise<ChatEreignis[]> { return chatEreignisse((await this.ruf(`/api/lernchat/${id}/stream`, 'POST', { text })).text); }
}
