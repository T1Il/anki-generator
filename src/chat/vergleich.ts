import { Card } from '../types';
import { Suggestion } from './suggestions';
import { applyFindReplace } from './textLocator';
import { insertAfterAnchor } from './insertText';
import { findeKarte } from './kartenSuche';

/**
 * Vorher/Nachher eines Vorschlags fuer die Vergleichsansicht im Chat-Modal.
 *
 * Text-Vorschlaege werden wirklich auf eine Kopie der Notiz angewendet und der
 * geaenderte Ausschnitt herausgeschnitten – so sieht man genau das, was der
 * Klick auf „Übernehmen" schreiben wuerde, samt Umgebung.
 */
export type Vergleich =
	| {
		art: 'text';
		vorher: string;
		nachher: string;
		/** Zeilenweise fuer die Quelltextansicht. */
		entfernt: string[];
		hinzu: string[];
		hinweis?: string;
	}
	| {
		art: 'karte';
		vorher: { q: string; a: string } | null;
		nachher: { q: string; a: string } | null;
		hinweis?: string;
	};

const KONTEXT = 3;

export function berechneVergleich(
	content: string,
	bloecke: { cards: Card[] }[],
	v: Suggestion
): Vergleich | null {
	content = content.replace(/\r\n/g, '\n');
	if (v.kind === 'invalid') return null;

	if (v.kind === 'card') {
		const neu = v.op === 'delete' ? null : { q: v.q, a: v.a };
		if (v.op === 'add') return { art: 'karte', vorher: null, nachher: neu };
		const suche = findeKarte(content, bloecke, v);
		if (!suche.ok) return { art: 'karte', vorher: null, nachher: neu, hinweis: suche.message };
		const alt = bloecke[suche.treffer.bi].cards[suche.treffer.ci];
		return {
			art: 'karte',
			vorher: { q: alt.q, a: alt.a },
			nachher: neu,
			hinweis: suche.treffer.weg === 'frage'
				? 'Zuordnung über die Ähnlichkeit der Frage – bitte prüfen.'
				: undefined
		};
	}

	const neu = v.kind === 'edit'
		? applyFindReplace(content, v.find, v.replace)
		: insertAfterAnchor(content, v.after, v.text);
	if (neu === null) {
		const text = v.kind === 'edit' ? v.replace : v.text;
		return {
			art: 'text', vorher: '', nachher: text, entfernt: [], hinzu: text.split('\n'),
			hinweis: v.kind === 'edit'
				? 'Textstelle nicht in der Notiz gefunden – nur der neue Text.'
				: 'Ankerzeile (NACH:) nicht gefunden – nur der neue Text.'
		};
	}
	return ausschnitt(content, neu.replace(/\r\n/g, '\n'));
}

/** Den geaenderten Bereich zweier Fassungen samt Umgebung herausschneiden. */
export function ausschnitt(alt: string, neu: string): Vergleich {
	const a = alt.split('\n');
	const b = neu.split('\n');
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let sa = a.length - 1;
	let sb = b.length - 1;
	while (sa >= p && sb >= p && a[sa] === b[sb]) { sa--; sb--; }

	const entfernt = a.slice(p, sa + 1);
	const hinzu = b.slice(p, sb + 1);

	// Umgebung: ein paar Zeilen, und ein angeschnittenes Callout ganz – ohne
	// seine Kopfzeile rendert es nur als Zitat.
	let von = Math.max(0, p - KONTEXT);
	while (von > 0 && /^\s*>/.test(a[von]) && /^\s*>/.test(a[von - 1])) von--;
	let bisA = Math.min(a.length - 1, sa + KONTEXT);
	let bisB = Math.min(b.length - 1, sb + KONTEXT);
	while (bisA < a.length - 1 && /^\s*>/.test(a[bisA]) && /^\s*>/.test(a[bisA + 1])) bisA++;
	while (bisB < b.length - 1 && /^\s*>/.test(b[bisB]) && /^\s*>/.test(b[bisB + 1])) bisB++;

	return {
		art: 'text',
		vorher: a.slice(von, bisA + 1).join('\n'),
		nachher: b.slice(von, bisB + 1).join('\n'),
		entfernt,
		hinzu
	};
}
