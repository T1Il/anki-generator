/**
 * Haeufige Mermaid-Syntaxfehler der KI still reparieren.
 *
 * Die Modelle halten sich bei Knoten meist an `["…"]`, bei Subgraph-Titeln
 * aber nicht: `subgraph Anlegen (Donning)` ist ein Parse-Fehler, weil Mermaid
 * die Klammer als Knotenform liest. Eine Prompt-Regel allein hat das nicht
 * verhindert (03.10.2026, Notiz „Persönliche Schutzausrüstung") – deshalb
 * wird der Code vor Vorschau, Übernahme und Sync hier geradegezogen.
 *
 * Repariert wird nur, was eindeutig ist:
 * - Subgraph-Titel, die kein reiner Bezeichner sind → `subgraph sgN["Titel"]`
 * - Knotenbeschriftungen in `[…]` oder `{…}` ohne Anführungszeichen, die
 *   Klammern enthalten → `["…"]` bzw. `{"…"}`
 */

const IDENT = /^[A-Za-z0-9_-]+$/;
/** `id["Titel"]`, `id[Titel]` oder `"Titel"` – alles, was Mermaid schon versteht. */
const SUBGRAPH_OK = /^(?:[A-Za-z0-9_-]+\s*\[.*\]|"[^"]*")$/;

export function repariereMermaid(code: string): string {
	let n = 0;
	const belegt = new Set<string>();
	code.replace(/\b(sg\d+)\b/g, (m) => { belegt.add(m); return m; });
	const neueId = () => {
		let id: string;
		do { id = `sg${++n}`; } while (belegt.has(id));
		return id;
	};

	return code.split('\n').map((zeile) => {
		const sg = zeile.match(/^(\s*)subgraph\s+(.+?)\s*$/);
		if (sg) {
			const titel = sg[2];
			if (IDENT.test(titel) || SUBGRAPH_OK.test(titel)) return zeile;
			const sauber = titel.replace(/^"|"$/g, '').replace(/"/g, "'");
			return `${sg[1]}subgraph ${neueId()}["${sauber}"]`;
		}
		return repariereKnoten(zeile);
	}).join('\n');
}

/**
 * `A[Text (x)]` → `A["Text (x)"]`, `B{Frage (x)?}` → `B{"Frage (x)?"}`.
 * Sonderformen wie `[(Datenbank)]`, `[/schraeg/]` oder `{{Sechseck}}` bleiben
 * unangetastet: dort gehoert das Zeichen nach der Klammer zur Form.
 */
function repariereKnoten(zeile: string): string {
	if (/^\s*(%%|classDef|class |style |linkStyle|click )/.test(zeile)) return zeile;
	return zeile
		.replace(/(\b[A-Za-z0-9_]+)\[(?![\[(/\\"])([^\]"]*[()][^\]"]*)\]/g, (_m, id, text) => `${id}["${text}"]`)
		.replace(/(\b[A-Za-z0-9_]+)\{(?![{"])([^}"]*[()][^}"]*)\}/g, (_m, id, text) => `${id}{"${text}"}`);
}

/**
 * Alle ```mermaid-Bloecke in einem Text reparieren – auch in Callouts, deren
 * Zeilen mit `> ` beginnen. Der Rest des Textes bleibt Zeichen fuer Zeichen.
 */
export function repariereMermaidImText(text: string): string {
	if (!/`{3,}mermaid/i.test(text)) return text;
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^((?:[ \t]*>)*[ \t]?)[ \t]*`{3,}mermaid[ \t]*\r?$/i);
		if (!m) continue;
		const quote = /\>/.test(m[1]);
		let j = i + 1;
		const prefixe: string[] = [];
		const code: string[] = [];
		for (; j < lines.length; j++) {
			let l = lines[j];
			let p = '';
			if (quote) {
				const q = l.match(/^((?:[ \t]*>)*)[ \t]?/);
				p = q ? q[0] : '';
				l = l.slice(p.length);
			}
			if (/^[ \t]*`{3,}[ \t]*\r?$/.test(l)) break;
			prefixe.push(p);
			code.push(l);
		}
		const repariert = repariereMermaid(code.join('\n')).split('\n');
		for (let k = 0; k < repariert.length; k++) lines[i + 1 + k] = prefixe[k] + repariert[k];
		i = j;
	}
	return lines.join('\n');
}

/**
 * Ein schließender Code-Zaun, direkt gefolgt von einem zweiten nackten Zaun
 * mit demselben Zitat-Präfix: der zweite ist zu viel. Er öffnete einen neuen,
 * nie geschlossenen Code-Block – in der Notiz verschluckte er den Rest des
 * Callouts, auf der Karte stand ``` unter dem Bild (Sepsis, 21.10.2026, in
 * Notiz UND Kartenantwort). Die Modelle schließen gern einmal für den
 * Mermaid-Block und noch einmal „für den Vorschlag".
 */
export function ohneDoppeltenZaun(text: string): string {
	if (!/`{3}/.test(text)) return text;
	const lines = text.split('\n');
	const out: string[] = [];
	let offen: { praefix: string; laenge: number } | null = null;
	let geradeGeschlossen = '';
	let geschlossenBei = -2;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		const m = l.match(/^((?:[ \t]*>)*[ \t]*)(?:(?:Q|A(?: \(type\))?):[ \t]*)?(`{3,})([^`]*?)[ \t]*\r?$/);
		if (!m) { out.push(l); continue; }
		const praefix = m[1].replace(/[ \t]+/g, '');
		const zaun = m[2];
		const info = m[3].trim();
		if (offen) {
			if (!info && praefix === offen.praefix && zaun.length >= offen.laenge) {
				offen = null;
				geradeGeschlossen = praefix;
				geschlossenBei = out.length;
			}
			out.push(l);
			continue;
		}
		if (!info && geschlossenBei === out.length - 1 && praefix === geradeGeschlossen) continue;
		offen = { praefix, laenge: zaun.length };
		out.push(l);
	}
	return out.join('\n');
}
