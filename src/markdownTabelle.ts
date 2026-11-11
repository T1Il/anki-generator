/**
 * Markdown-Tabellen → HTML für Anki.
 *
 * `basicMarkdownToHtml` kannte bis 11.11.2026 nur Links, fett und kursiv; eine Tabelle
 * kam als `| | Frequenz | QRS |` mit `<br>` je Zeile in Anki an (Breitkomplextachykardien,
 * „Vergleiche Kammertachykardie, …“). Der Kartenprompt verlangt für Vergleiche aber
 * ausdrücklich eine Tabelle — und die Flaggen-Durchsicht schlug dieselbe Tabelle noch
 * einmal vor, weil das Problem nicht im Text lag.
 *
 * Erkannt wird ein Block aus mindestens zwei Zeilen, die mit `|` beginnen, dessen zweite
 * Zeile die Trennzeile `|---|:---:|` ist. Die Tabelle darf direkt hinter `A: ` stehen
 * (so schreiben es die Karten im Vault). Das Ergebnis enthält keine Zeilenumbrüche, damit
 * die spätere `\n → <br>`-Ersetzung sie nicht zerreißt.
 */

const TRENN = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function zellen(zeile: string): string[] {
    let z = zeile.trim();
    if (z.startsWith('|')) z = z.slice(1);
    if (z.endsWith('|') && !z.endsWith('\\|')) z = z.slice(0, -1);
    // `\|` ist ein Strich im Zelltext, kein Trenner.
    return z.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function ausrichtung(trenn: string): string[] {
    return zellen(trenn).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
}

function tabelle(kopf: string, trenn: string, rumpf: string[]): string {
    const ausr = ausrichtung(trenn);
    // Inline-Stil: die Kartenvorlagen in Anki bringen kein Tabellen-CSS mit.
    const rand = 'border:1px solid #888;padding:3px 8px;';
    const stil = (i: number) => ` style="${rand}${ausr[i] ? `text-align:${ausr[i]};` : ''}"`;
    const th = zellen(kopf).map((c, i) => `<th${stil(i)}>${c}</th>`).join('');
    const tr = rumpf.map((z) => '<tr>' + zellen(z).map((c, i) => `<td${stil(i)}>${c}</td>`).join('') + '</tr>').join('');
    return `<table style="border-collapse:collapse;margin:6px auto"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

export function markdownTabellenZuHtml(text: string): string {
    if (!text || !text.includes('|')) return text;
    const zeilen = text.split('\n');
    const raus: string[] = [];
    let i = 0;
    while (i < zeilen.length) {
        const zeile = zeilen[i];
        const trenn = zeilen[i + 1];
        // Kopfzeile darf mit Text davor beginnen („A: | | Frequenz |“) — der Text bleibt davor stehen.
        const start = zeile.indexOf('|');
        if (start >= 0 && trenn !== undefined && trenn.includes('|') && TRENN.test(trenn)) {
            const vorne = zeile.slice(0, start);
            const kopf = zeile.slice(start);
            const rumpf: string[] = [];
            let j = i + 2;
            while (j < zeilen.length && zeilen[j].trim().startsWith('|')) {
                rumpf.push(zeilen[j]);
                j++;
            }
            const html = tabelle(kopf, trenn, rumpf);
            raus.push(vorne.trim() ? `${vorne.trimEnd()}${html}` : html);
            i = j;
            continue;
        }
        raus.push(zeile);
        i++;
    }
    return raus.join('\n');
}
