/**
 * Findet einen von der KI zitierten Textabschnitt in der Notiz.
 *
 * Die alte Suche war dreistufig exakt (indexOf, Whitespace-Regex, 50-Zeichen-Stub)
 * und scheiterte an allem, was der Generierungs-Prompt selbst in den Text
 * schreibt: Wikilinks wie [[#^id|Begriff]], **Fettung**, typografische
 * Anführungszeichen. Hier wird stattdessen beides normalisiert und über eine
 * Index-Abbildung auf die Originalposition zurückgerechnet.
 */

export interface LocateResult {
	start: number;
	end: number;
	/** true, wenn nur über die normalisierte Fassung gefunden. */
	fuzzy: boolean;
}

interface Normalized {
	text: string;
	/** map[i] = Index von text[i] im Original. */
	map: number[];
}

const TYPOGRAPHIC: Record<string, string> = {
	'„': '"', '“': '"', '”': '"', '«': '"', '»': '"',
	'‘': "'", '’': "'", '‚': "'",
	'–': '-', '—': '-', '−': '-',
	' ': ' ', ' ': ' ', ' ': ' ',
	'…': '...'
};

/**
 * Baut eine vergleichbare Fassung des Textes und merkt sich für jedes Zeichen,
 * wo es im Original stand.
 */
function normalize(input: string): Normalized {
	const chars: string[] = [];
	const map: number[] = [];
	let i = 0;

	const push = (ch: string, origIndex: number) => {
		chars.push(ch);
		map.push(origIndex);
	};

	while (i < input.length) {
		const rest = input.substring(i);

		// [[ziel|alias]] -> alias
		let m = rest.match(/^\[\[[^\]|]*\|([^\]]*)\]\]/);
		if (m) {
			const aliasStart = i + m[0].indexOf('|') + 1;
			for (let k = 0; k < m[1].length; k++) push(m[1][k], aliasStart + k);
			i += m[0].length;
			continue;
		}

		// [[ziel]] -> ziel
		m = rest.match(/^\[\[([^\]]*)\]\]/);
		if (m) {
			for (let k = 0; k < m[1].length; k++) push(m[1][k], i + 2 + k);
			i += m[0].length;
			continue;
		}

		// [text](url) -> text
		m = rest.match(/^\[([^\]]*)\]\([^)]*\)/);
		if (m) {
			for (let k = 0; k < m[1].length; k++) push(m[1][k], i + 1 + k);
			i += m[0].length;
			continue;
		}

		// Hervorhebungen und Code-Ticks fallen weg
		m = rest.match(/^(\*\*|__|==|~~|`|\*|_)/);
		if (m) {
			i += m[0].length;
			continue;
		}

		// Whitespace-Läufe (inkl. Blockquote-Marker) auf ein Leerzeichen
		m = rest.match(/^[\s>]+/);
		if (m) {
			push(' ', i);
			i += m[0].length;
			continue;
		}

		const ch = input[i];
		const replacement = TYPOGRAPHIC[ch];
		if (replacement !== undefined) {
			for (let k = 0; k < replacement.length; k++) push(replacement[k], i);
			i++;
			continue;
		}

		push(ch, i);
		i++;
	}

	return { text: chars.join(''), map };
}

/** Ende im Original: das Zeichen nach dem letzten getroffenen. */
function originalEnd(norm: Normalized, lastIndex: number, haystackLength: number): number {
	if (lastIndex < 0) return 0;
	if (lastIndex + 1 < norm.map.length) return norm.map[lastIndex + 1];
	return haystackLength;
}

/**
 * Sucht `needle` in `haystack`. Erst exakt, dann normalisiert,
 * dann normalisiert ohne Groß-/Kleinschreibung.
 */
export function locate(haystack: string, needle: string): LocateResult | null {
	const trimmedNeedle = needle.trim();
	if (!trimmedNeedle) return null;

	// 1. Exakt
	const exact = haystack.indexOf(trimmedNeedle);
	if (exact !== -1) {
		return { start: exact, end: exact + trimmedNeedle.length, fuzzy: false };
	}

	// 2. Normalisiert
	const hay = normalize(haystack);
	const nee = normalize(trimmedNeedle);
	const needleText = nee.text.trim();
	if (!needleText) return null;

	let pos = hay.text.indexOf(needleText);

	// 3. Ohne Groß-/Kleinschreibung
	if (pos === -1) {
		pos = hay.text.toLowerCase().indexOf(needleText.toLowerCase());
	}

	if (pos === -1) return null;

	const start = hay.map[pos];
	const end = originalEnd(hay, pos + needleText.length - 1, haystack.length);
	return { start, end, fuzzy: true };
}

/**
 * Wendet eine FIND/REPLACE-Änderung an.
 * Gibt null zurück, wenn die Stelle nicht gefunden wurde - der Aufrufer
 * meldet das dann sichtbar, statt still nichts zu tun.
 */
export function applyFindReplace(content: string, find: string, replace: string): string | null {
	const hit = locate(content, find);
	if (!hit) return null;
	return content.substring(0, hit.start) + replace + content.substring(hit.end);
}
