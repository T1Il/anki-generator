/**
 * Diff auf Wortebene fuer die Vorschlagsboxen im Chat.
 *
 * Vorher stand jede geaenderte Zeile zweimal da, einmal rot, einmal gruen –
 * bei einer langen Antwortzeile, in der sich zwei Woerter aendern, musste man
 * den Unterschied selbst suchen.
 */

export type DiffTeil = { art: 'gleich' | 'weg' | 'neu'; text: string };

/**
 * Woerter, Leerraum und Satzzeichen getrennt; ein Wikilink, eine Lueckenmarke
 * oder ein Fettdruck-Stern bleibt ein Stueck, damit der Diff ihn nicht zerlegt.
 */
export function zerlege(text: string): string[] {
	return text.match(/\[\[[^\]]*\]\]|\{\{c\d+::|\}\}|\*\*|\s+|[\p{L}\p{N}]+|./gu) || [];
}

/** Obergrenze fuer die LCS-Tabelle (Teile alt × Teile neu). */
const MAX_ZELLEN = 400_000;

export function wortDiff(alt: string, neu: string): DiffTeil[] {
	if (alt === neu) return alt ? [{ art: 'gleich', text: alt }] : [];
	const a = zerlege(alt);
	const b = zerlege(neu);

	// Gemeinsamen Anfang und gemeinsames Ende abschneiden – meist bleibt nur
	// ein kleines Mittelstueck fuer die Tabelle.
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let ea = a.length;
	let eb = b.length;
	while (ea > p && eb > p && a[ea - 1] === b[eb - 1]) { ea--; eb--; }

	const teile: DiffTeil[] = [];
	const push = (art: DiffTeil['art'], text: string) => {
		if (!text) return;
		const last = teile[teile.length - 1];
		if (last && last.art === art) last.text += text;
		else teile.push({ art, text });
	};

	push('gleich', a.slice(0, p).join(''));
	const ma = a.slice(p, ea);
	const mb = b.slice(p, eb);

	if (ma.length * mb.length > MAX_ZELLEN) {
		push('weg', ma.join(''));
		push('neu', mb.join(''));
	} else {
		// LCS rueckwaerts, damit die Ausgabe vorwaerts laufen kann.
		const n = ma.length;
		const m = mb.length;
		const t: Uint32Array[] = [];
		for (let i = 0; i <= n; i++) t.push(new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				t[i][j] = ma[i] === mb[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (ma[i] === mb[j]) { push('gleich', ma[i]); i++; j++; }
			else if (t[i + 1][j] >= t[i][j + 1]) { push('weg', ma[i]); i++; }
			else { push('neu', mb[j]); j++; }
		}
		while (i < n) push('weg', ma[i++]);
		while (j < m) push('neu', mb[j++]);
	}

	push('gleich', a.slice(ea).join(''));
	return glaette(teile);
}

/**
 * Einzelne gleiche Leerzeichen zwischen zwei Aenderungen in die Aenderung
 * ziehen – sonst zerfaellt ein umgeschriebener Halbsatz in Wortschnipsel.
 * Aufeinanderfolgende Aenderungen werden zu „weg, dann neu" zusammengefasst.
 */
function glaette(teile: DiffTeil[]): DiffTeil[] {
	const out: DiffTeil[] = [];
	let weg = '';
	let neu = '';
	const flush = () => {
		// Nur Leerraum auf einer Seite ist kein Unterschied, den man sehen muss.
		if (weg && (weg.trim() || !neu.trim())) out.push({ art: 'weg', text: weg });
		if (neu && (neu.trim() || !weg.trim())) out.push({ art: 'neu', text: neu });
		weg = ''; neu = '';
	};
	teile.forEach((t, k) => {
		const zwischen = t.art === 'gleich' && /^[ \t]+$/.test(t.text)
			&& k > 0 && teile[k - 1].art !== 'gleich'
			&& k + 1 < teile.length && teile[k + 1].art !== 'gleich';
		if (zwischen) { weg += t.text; neu += t.text; return; }
		if (t.art === 'weg') { weg += t.text; return; }
		if (t.art === 'neu') { neu += t.text; return; }
		flush();
		out.push({ ...t });
	});
	flush();
	return out;
}

/** Wikilink fuer die Anzeige: [[ziel|Begriff]] → Begriff, [[ziel]] → ziel. */
export function linkText(stueck: string): string | null {
	const m = stueck.match(/^\[\[([^\]|]*)(?:\|([^\]]*))?\]\]$/);
	if (!m) return null;
	return (m[2] ?? m[1].replace(/^#\^?/, '')).trim();
}
