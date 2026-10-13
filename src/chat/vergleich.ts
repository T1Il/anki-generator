import { Card } from '../types';
import { Suggestion } from './suggestions';
import { applyFindReplace } from './textLocator';
import { insertAfterAnchor } from './insertText';
import { findeKarte } from './kartenSuche';
import { fuegeQuelleEin } from './quellen';

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
		/** Zeilennummern in `vorher`/`nachher`, die sich geaendert haben – fuer die Markierung. */
		geaendertVorher: number[];
		geaendertNachher: number[];
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

	if (v.kind === 'quelle') {
		const mit = fuegeQuelleEin(content, v.zitat, v.url);
		if (mit === null) {
			return {
				art: 'text', vorher: '', nachher: v.zitat, entfernt: [], hinzu: [v.zitat],
				geaendertVorher: [], geaendertNachher: [], hinweis: 'Die Quelle steht schon in der Notiz.'
			};
		}
		return ausschnitt(content, mit);
	}

	const neu = v.kind === 'edit'
		? applyFindReplace(content, v.find, v.replace)
		: insertAfterAnchor(content, v.after, v.text);
	if (neu === null) {
		const text = v.kind === 'edit' ? v.replace : v.text;
		const zeilen = text.split('\n');
		return {
			art: 'text', vorher: '', nachher: text, entfernt: [], hinzu: zeilen,
			geaendertVorher: [], geaendertNachher: zeilen.map((_, i) => i),
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

	// Innerhalb des geaenderten Bereichs nur die Zeilen markieren, die es auf
	// der anderen Seite nicht gibt – eine eingeschobene Zeile soll nicht den
	// ganzen Rest des Callouts einfaerben.
	const [wegIdx, neuIdx] = zeilenDiff(entfernt, hinzu);
	return {
		art: 'text',
		vorher: a.slice(von, bisA + 1).join('\n'),
		nachher: b.slice(von, bisB + 1).join('\n'),
		entfernt,
		hinzu,
		geaendertVorher: wegIdx.map((i) => i + p - von),
		geaendertNachher: neuIdx.map((i) => i + p - von)
	};
}

/** Indizes der Zeilen, die nicht im laengsten gemeinsamen Teil liegen. */
function zeilenDiff(a: string[], b: string[]): [number[], number[]] {
	if (a.length * b.length > 250_000) return [a.map((_, i) => i), b.map((_, i) => i)];
	const t: Uint32Array[] = [];
	for (let i = 0; i <= a.length; i++) t.push(new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
		}
	}
	const weg: number[] = [];
	const neu: number[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) { i++; j++; }
		else if (t[i + 1][j] >= t[i][j + 1]) weg.push(i++);
		else neu.push(j++);
	}
	while (i < a.length) weg.push(i++);
	while (j < b.length) neu.push(j++);
	return [weg, neu];
}

/**
 * Geaenderte Zeilen fuer die gerenderte Vorschau einfaerben: der Inhalt der
 * Zeile kommt in ein <span class="anki-diff-mark …">, Zitat-, Listen- und
 * Ueberschriftenmarker bleiben davor – sonst zerbricht die Struktur.
 *
 * Nicht angefasst werden Zeilen in Codebloecken (Mermaid), Tabellenzeilen,
 * Einbettungen und Formelbloecke: ein <span> dort wuerde sie zerstoeren.
 * Eine Block-ID am Zeilenende bleibt ausserhalb des <span>.
 */
export function markiereZeilen(text: string, zeilen: number[], cls: 'is-add' | 'is-remove'): string {
	if (!zeilen.length) return text;
	const set = new Set(zeilen);
	let imCode = false;
	return text.split('\n').map((zeile, i) => {
		const ohneZitat = zeile.replace(/^(?:[ \t]*>)+[ \t]?/, '');
		if (/^[ \t]*(`{3,}|~{3,})/.test(ohneZitat)) { imCode = !imCode; return zeile; }
		if (imCode || !set.has(i)) return zeile;

		const m = zeile.match(
			/^((?:[ \t]*>)*[ \t]*(?:\[![^\]]+\][-+]?[ \t]*)?(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[.\][ \t]+)?|\d+[.)][ \t]+)?)(.*)$/
		);
		if (!m) return zeile;
		let [, vor, inhalt] = m;
		let id = '';
		const idTreffer = inhalt.match(/^(.*?)([ \t]+\^[A-Za-z0-9-]+[ \t]*)$/);
		if (idTreffer) { inhalt = idTreffer[1]; id = idTreffer[2]; }
		if (!inhalt.trim() || /^\s*(\||!\[\[|\$\$|\^[A-Za-z0-9-]+\s*$)/.test(inhalt)) return zeile;
		return `${vor}<span class="anki-diff-mark ${cls}">${inhalt}</span>${id}`;
	}).join('\n');
}
