/**
 * ```mermaid-Bloecke in einem Text finden und ersetzen – auch in Callouts
 * (`> ```mermaid`) und unverschlossen am Ende einer Kartenantwort.
 */

export interface MermaidBlock {
	/** Zeile der oeffnenden Fence (0-basiert). */
	open: number;
	/** Zeile der schliessenden Fence; `lines.length`, wenn sie fehlt. */
	close: number;
	/** Zitat-Praefix der oeffnenden Zeile, z. B. "> " – leer ausserhalb von Callouts. */
	quote: string;
	code: string;
}

// Auch direkt hinter "A:" einer Karte im anki-cards-Block.
const OPEN = /^((?:[ \t]*>)*)[ \t]*(?:(?:Q|A(?: \(type\))?):[ \t]*)?`{3,}mermaid[ \t]*$/i;

function ohneQuote(line: string, quote: string): string {
	if (!quote) return line;
	const q = line.match(/^((?:[ \t]*>)*)[ \t]?/);
	return line.slice(q ? q[0].length : 0);
}

export function findeMermaidBloecke(text: string): MermaidBlock[] {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const out: MermaidBlock[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(OPEN);
		if (!m) continue;
		const quote = m[1];
		const code: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const l = ohneQuote(lines[j], quote);
			if (/^[ \t]*`{3,}[ \t]*$/.test(l)) break;
			code.push(l);
		}
		out.push({ open: i, close: j, quote, code: code.join('\n') });
		i = j;
	}
	return out;
}

/** Den Code eines Blocks ersetzen; Zeilenenden und Zitat-Praefix bleiben. */
export function ersetzeMermaidCode(text: string, block: MermaidBlock, neu: string): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const praefix = block.quote ? block.quote.replace(/[ \t]+$/, '') + ' ' : '';
	const neueZeilen = neu.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
		.map((l) => (praefix && !l.trim() ? praefix.trimEnd() : praefix + l));
	lines.splice(block.open + 1, block.close - block.open - 1, ...neueZeilen);
	return lines.join(eol);
}

/**
 * Jeden Block, dessen Code (nach `vergleichbar`) gleich `alt` ist, durch
 * `neu` ersetzen. Fuer Vorschlaege: dasselbe Diagramm steht im Callout der
 * Notiz und in der Karte, die es abfragt – beide sollen die Aenderung bekommen.
 */
export function ersetzeGleicheMermaid(
	text: string, alt: string, neu: string, vergleichbar: (c: string) => string = (c) => c
): string {
	const ziel = vergleichbar(alt).trim();
	const treffer = findeMermaidBloecke(text).filter((b) => vergleichbar(b.code).trim() === ziel);
	// Von hinten, damit die Zeilennummern davor gueltig bleiben.
	return treffer.reverse().reduce((t, b) => ersetzeMermaidCode(t, b, neu), text);
}

/** Jeden Mermaid-Block eines Textes umformen. */
export function mapMermaid(text: string, f: (code: string) => string): string {
	return findeMermaidBloecke(text).reverse().reduce((t, b) => {
		const neu = f(b.code);
		return neu === b.code ? t : ersetzeMermaidCode(t, b, neu);
	}, text);
}

/** Den k-ten Mermaid-Block eines Textes ersetzen. Unveraendert, wenn es ihn nicht gibt. */
export function ersetzeKtenMermaid(text: string, k: number, neu: string): string {
	const b = findeMermaidBloecke(text)[k];
	return b ? ersetzeMermaidCode(text, b, neu) : text;
}
