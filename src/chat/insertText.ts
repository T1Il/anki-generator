import { locate } from './textLocator';

const ZITAT = /^[ \t]*>/;
const BLOCK_ID = /^(.*?)[ \t]+(\^[A-Za-z0-9-]+)[ \t]*$/;

/**
 * Fuegt `text` als eigenen Absatz NACH der Zeile ein, in der `anchor` steht.
 *
 * Steht der Anker in einem Callout (Zeilen mit „>"), wird erst hinter dessen
 * letzter Zeile eingefuegt – sonst zerschnitte der neue Absatz das Callout.
 * Ausnahme: der Text selbst besteht aus „>"-Zeilen. Dann gehoert er INS
 * Callout, direkt unter den Anker (Glucose, 13.10.2026: die DBRD-Kinderdosis
 * landete mit Leerzeile als eigenes Zitat hinter dem Dosierungs-Callout).
 * Gibt null zurueck, wenn der Anker nicht zu finden ist.
 */
export function insertAfterAnchor(content: string, anchor: string, text: string): string | null {
	const hit = locate(content, anchor);
	if (!hit) return null;

	let eol = content.indexOf('\n', hit.end);
	if (eol < 0) eol = content.length;

	const lineStart = content.lastIndexOf('\n', hit.start - 1) + 1;
	const ankerZeile = content.slice(lineStart, eol).replace(/\r$/, '');
	if (ZITAT.test(ankerZeile)) {
		const insCallout = insCalloutEinfuegen(content, lineStart, eol, ankerZeile, text);
		if (insCallout !== null) return insCallout;
	}
	if (ZITAT.test(ankerZeile)) {
		while (eol < content.length) {
			const next = content.indexOf('\n', eol + 1);
			const line = content.slice(eol + 1, next < 0 ? content.length : next);
			if (!/^[ \t]*>/.test(line)) break;
			eol = next < 0 ? content.length : next;
		}
	}

	const before = content.slice(0, eol).replace(/\r$/, '');
	let after = content.slice(eol);
	// Genau eine Leerzeile nach dem eingefuegten Absatz.
	after = after.replace(/^(\r?\n)+/, '');
	const block = '\n\n' + text.replace(/\s+$/, '') + '\n';
	return before + block + (after ? '\n' + after : '');
}

/**
 * Zitat-Text direkt unter die Ankerzeile setzen – ohne Leerzeile, sonst
 * endet das Callout dort. null, wenn der Text kein reiner Zitat-Text ist.
 *
 * War die Ankerzeile die letzte des Callouts und trug sie die Block-ID
 * („> … ^dosierung"), wandert die ID ans neue Ende: sie gilt dem ganzen
 * Callout, und Links wie [[#^dosierung]] sollen weiter alles treffen.
 */
function insCalloutEinfuegen(content: string, lineStart: number, eol: number,
	ankerZeile: string, text: string): string | null {
	const zeilen = text.replace(/\r\n/g, '\n').split('\n');
	// Leere Zitatzeilen an den Raendern wuerden nur Luecken ins Callout reissen.
	while (zeilen.length && /^[ \t]*>?[ \t]*$/.test(zeilen[0])) zeilen.shift();
	while (zeilen.length && /^[ \t]*>?[ \t]*$/.test(zeilen[zeilen.length - 1])) zeilen.pop();
	if (!zeilen.length || !zeilen.every((l) => ZITAT.test(l))) return null;

	const nl = content.includes('\r\n') ? '\r\n' : '\n';
	const naechstesEnde = content.indexOf('\n', eol + 1);
	const naechste = eol < content.length
		? content.slice(eol + 1, naechstesEnde < 0 ? content.length : naechstesEnde)
		: '';
	const letzteImCallout = !ZITAT.test(naechste);

	let vorher = content.slice(0, lineStart) + ankerZeile;
	const id = letzteImCallout ? ankerZeile.match(BLOCK_ID) : null;
	if (id) {
		vorher = content.slice(0, lineStart) + id[1];
		zeilen[zeilen.length - 1] += ' ' + id[2];
	}
	const cr = content.slice(lineStart, eol).endsWith('\r') ? '\r' : '';
	return vorher + nl + zeilen.join(nl) + cr + content.slice(eol);
}

/** Neuer Abschnitt „## Anki" mit Kartenblock – mit vier Backticks, wenn der Inhalt ``` enthaelt. */
export function newAnkiSection(inner: string): string {
	let fence = '```';
	while (inner.includes(fence)) fence += '`';
	return `## Anki\n${fence}anki-cards\n${inner}\n${fence}`;
}
