/**
 * Alte Anki-Karten aus dem Notiztext entfernen, bevor er an die KI geht.
 *
 * Gemeint ist das Format des frueheren Plugins (obsidian-to-anki): eine Zeile
 * `TARGET DECK` ausserhalb jedes Code-Blocks, darunter `Q:`/`A:`-Paare mit
 * `<!--ID: …-->`. Der neue `anki-cards`-Block ersetzt sie. Sah die KI sie
 * trotzdem, hielt sie die Inhalte fuer schon abgefragt, und sie griff zu deren
 * IDs, um Karten zu „aendern", die es im Block gar nicht gibt (03.10.2026).
 *
 * Nur fuer den KI-Kontext. Die Notiz selbst bleibt unangetastet.
 */
export function ohneAlteKarten(content: string): string {
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let fence: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const t = line.trim();

		// Code-Bloecke (auch ````anki-cards) unveraendert durchreichen.
		const f = t.replace(/^(?:>\s*)*/, '').match(/^(`{3,})/);
		if (fence) {
			if (f && f[1].length >= fence.length && /^(?:>\s*)*`{3,}\s*$/.test(t)) fence = null;
			out.push(line);
			continue;
		}
		if (f) {
			fence = f[1];
			out.push(line);
			continue;
		}

		// Legacy-Block: bis zur naechsten Ueberschrift, Code-Fence oder Dateiende.
		if (/^TARGET DECK\b/.test(t)) {
			let j = i + 1;
			while (j < lines.length && !/^#{1,6}\s/.test(lines[j]) && !/^\s*`{3,}/.test(lines[j])) j++;
			i = j - 1;
			continue;
		}

		// Archivierte Legacy-Bloecke (Befehl „Alte Anki-Blöcke archivieren").
		if (/^>\s*\[!example\]-?\s*Archivierte Anki-Karten/.test(t)) {
			while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) i++;
			continue;
		}

		// Einzelne ID-Kommentare, die ausserhalb eines Blocks stehen.
		if (/^<!--\s*ID:\s*\d+\s*-->$/.test(t)) continue;

		out.push(line);
	}

	// Eine „## Anki"-Ueberschrift, unter der nur der alte Block stand.
	const ohne: string[] = [];
	for (let i = 0; i < out.length; i++) {
		if (/^#{1,6}\s+Anki\s*$/.test(out[i])) {
			let j = i + 1;
			while (j < out.length && out[j].trim() === '') j++;
			if (j >= out.length || /^#{1,6}\s/.test(out[j])) continue;
		}
		ohne.push(out[i]);
	}
	// Leerzeilen bewusst nicht zusammenziehen: FIND-Zitate der KI muessen auf
	// die echte Notiz passen.
	return ohne.join('\n');
}
