import { locate } from './textLocator';

/**
 * Fuegt `text` als eigenen Absatz NACH der Zeile ein, in der `anchor` steht.
 *
 * Steht der Anker in einem Callout (Zeilen mit „>"), wird erst hinter dessen
 * letzter Zeile eingefuegt – sonst zerschnitte der neue Absatz das Callout.
 * Gibt null zurueck, wenn der Anker nicht zu finden ist.
 */
export function insertAfterAnchor(content: string, anchor: string, text: string): string | null {
	const hit = locate(content, anchor);
	if (!hit) return null;

	let eol = content.indexOf('\n', hit.end);
	if (eol < 0) eol = content.length;

	const lineStart = content.lastIndexOf('\n', hit.start - 1) + 1;
	if (/^[ \t]*>/.test(content.slice(lineStart, eol))) {
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

/** Neuer Abschnitt „## Anki" mit Kartenblock – mit vier Backticks, wenn der Inhalt ``` enthaelt. */
export function newAnkiSection(inner: string): string {
	let fence = '```';
	while (inner.includes(fence)) fence += '`';
	return `## Anki\n${fence}anki-cards\n${inner}\n${fence}`;
}
