/**
 * Recherchierte Quellen aus dem Chat in die Notiz eintragen.
 *
 * Die Notizen fuehren ihre Quellen als APA-Zitate, ein Absatz je Quelle,
 * alphabetisch unter „## Quellen" (vor „## Anki"). Manche haben dort zusaetzlich
 * „**Aus meinen Notizen**" mit einer Wikilink-Liste – die bleibt unberuehrt.
 */

/** Sortierschluessel eines Zitats: ohne Markdown, ohne fuehrende Zeichen. */
function sortierText(t: string): string {
	return t.replace(/[_*[\]()]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').toLocaleLowerCase('de');
}

/**
 * `zitat` alphabetisch in den Quellen-Abschnitt einsortieren. Gibt den neuen
 * Inhalt zurueck, oder null, wenn die Quelle schon drinsteht.
 */
export function fuegeQuelleEin(content: string, zitat: string, url?: string): string | null {
	const text = content.replace(/\r\n/g, '\n');
	zitat = zitat.trim();
	if (!zitat) return null;
	if (text.includes(zitat) || (url && url.length > 12 && text.includes(url))) return null;

	const lines = text.split('\n');
	const kopf = lines.findIndex((l) => /^##\s+Quellen\s*$/i.test(l.trim()));

	if (kopf < 0) {
		// Neuer Abschnitt vor „## Anki", sonst ans Ende.
		const anki = lines.findIndex((l) => /^##\s+Anki\s*$/i.test(l.trim()));
		const abschnitt = ['## Quellen', '', zitat, ''];
		if (anki >= 0) {
			const vor = lines.slice(0, anki);
			while (vor.length && !vor[vor.length - 1].trim()) vor.pop();
			return [...vor, '', ...abschnitt, ...lines.slice(anki)].join('\n');
		}
		return text.replace(/\s*$/, '') + '\n\n' + abschnitt.join('\n');
	}

	let ende = lines.length;
	for (let i = kopf + 1; i < lines.length; i++) {
		if (/^#{1,2}\s/.test(lines[i])) { ende = i; break; }
	}

	// Absaetze des Abschnitts: Zitate sind Absaetze, die nicht mit „-", „**",
	// „>" oder einer Ueberschrift beginnen.
	let ziel = -1;
	let letztesZitatEnde = -1;
	for (let i = kopf + 1; i < ende; i++) {
		const l = lines[i];
		const absatzAnfang = l.trim() && (i === kopf + 1 || !lines[i - 1].trim());
		if (!absatzAnfang) continue;
		if (/^\s*(?:[-*>#]|\*\*|\d+\.)/.test(l)) continue;
		let j = i;
		while (j + 1 < ende && lines[j + 1].trim()) j++;
		if (ziel < 0 && sortierText(l) > sortierText(zitat)) ziel = i;
		letztesZitatEnde = j;
		i = j;
	}

	if (ziel >= 0) {
		return [...lines.slice(0, ziel), zitat, '', ...lines.slice(ziel)].join('\n');
	}
	if (letztesZitatEnde >= 0) {
		return [...lines.slice(0, letztesZitatEnde + 1), '', zitat, ...lines.slice(letztesZitatEnde + 1)].join('\n');
	}
	// Abschnitt ohne Zitate: direkt unter die Ueberschrift.
	const rest = lines.slice(kopf + 1);
	while (rest.length && !rest[0].trim()) rest.shift();
	return [...lines.slice(0, kopf + 1), '', zitat, '', ...rest].join('\n');
}

/** Zotero-Ziel aus dem Ablageort der Notiz: <Elternordner>/<Notizname>. */
export function zoteroZielFuer(pfad: string): string {
	const teile = pfad.replace(/\.md$/i, '').split('/');
	const name = teile.pop() || '';
	const eltern = teile.pop();
	return eltern ? `${eltern}/${name}` : name;
}
