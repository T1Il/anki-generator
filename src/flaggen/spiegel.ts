import { ChatMessage } from '../types';

/**
 * Die Antwort der Flaggen-Prüfung zwischen Ablage (Vault, synchronisiert) und
 * dem lokalen Chat-Verlauf (Plugin-Ordner, synchronisiert nicht).
 *
 * Rein, ohne Obsidian – geprüft in scripts/flaggen-check.mjs.
 *
 * Bis 1.22.5 stand die Antwort nur in `chat-history.json`: auf einem zweiten
 * Gerät fehlte sie, und nach 30 weiteren Chats fiel sie auch lokal heraus –
 * die Notiz stand dann als „unbearbeitet“ ohne einen einzigen Vorschlag da.
 */

export interface GespiegelteAntwort {
	/** Der Auftrag, wie er im Verlauf steht (eingeklappt). */
	auftrag: string;
	antwort: ChatMessage;
}

/** Die Flaggen-Antwort mit diesem Zeitstempel im Verlauf. */
export function findeFlaggenAntwort(verlauf: ChatMessage[] | undefined, am: string): ChatMessage | undefined {
	if (!verlauf) return undefined;
	for (let i = verlauf.length - 1; i >= 0; i--) {
		const m = verlauf[i];
		if (m.role === 'ai' && m.flaggenAm === am) return m;
	}
	return undefined;
}

/**
 * Die Antwort aus der Ablage in den Verlauf bringen. Fehlt sie, kommen
 * Auftrag und Antwort ans Ende; steht sie schon da, gilt der Zustand der
 * Vorschläge aus der Ablage – dort landet jede Änderung, auch die von einem
 * anderen Gerät. Gibt zurück, ob sich der Verlauf geändert hat.
 */
export function spiegleInVerlauf(verlauf: ChatMessage[], am: string, g: GespiegelteAntwort): boolean {
	const da = findeFlaggenAntwort(verlauf, am);
	if (!da) {
		verlauf.push({ role: 'user', content: g.auftrag }, { ...kopie(g.antwort), flaggenAm: am });
		return true;
	}
	if (gleich(da.vorschlaege, g.antwort.vorschlaege)) return false;
	if (g.antwort.vorschlaege) da.vorschlaege = kopie(g.antwort.vorschlaege);
	else delete da.vorschlaege;
	return true;
}

export type Abgleich = 'gleich' | 'ziehen' | 'schieben';

/**
 * Wer gewinnt, wenn lokaler Verlauf und Ablage beim Zustand der Vorschläge
 * auseinanderliegen? `basis` ist der Stand des letzten Abgleichs.
 *
 * - Lokal seit der Basis geändert → schieben (auch wenn die Ablage sich
 *   ebenfalls geändert hat: wer gerade davorsitzt, gewinnt).
 * - Sonst → ziehen. Ohne Basis (frisch gestartet) gewinnt die Ablage: lokale
 *   Änderungen gehen nach einer Sekunde hinaus, die Ablage ist also selten älter.
 *
 * Vorher wurde bei jedem Speichern einfach geschoben – ein „Verworfen“ vom
 * Laptop wäre beim nächsten Chat am PC wieder verschwunden.
 */
export function abgleich(lokal: unknown, ablage: unknown, basis: string | undefined): Abgleich {
	const l = fingerabdruck(lokal);
	if (l === fingerabdruck(ablage)) return 'gleich';
	return basis !== undefined && l !== basis ? 'schieben' : 'ziehen';
}

/** Lesbarer, stabiler Dateiname je Notiz; der Hash trennt gleichnamige Notizen. */
export function ablageName(pfad: string): string {
	const name = (pfad.split('/').pop() ?? pfad)
		.replace(/\.md$/i, '')
		.replace(/[\\/:*?"<>|#^[\]]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 60) || 'Notiz';
	return `${name} ${fnv1a(pfad)}.json`;
}

function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

function kopie<T>(x: T): T {
	return JSON.parse(JSON.stringify(x));
}

/** Gleich ohne Rücksicht auf die Reihenfolge der Schlüssel. */
export function gleich(a: unknown, b: unknown): boolean {
	return stabil(a) === stabil(b);
}

/** Vergleichbarer Text eines Zustands (Schlüsselreihenfolge egal, leer = nichts). */
export function fingerabdruck(x: unknown): string {
	return stabil(x);
}

function stabil(x: unknown): string {
	if (x === undefined || x === null) return 'null';
	if (Array.isArray(x)) return '[' + x.map(stabil).join(',') + ']';
	if (typeof x === 'object') {
		const o = x as Record<string, unknown>;
		const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
		if (!keys.length) return 'null';
		return '{' + keys.map((k) => JSON.stringify(k) + ':' + stabil(o[k])).join(',') + '}';
	}
	return JSON.stringify(x);
}
