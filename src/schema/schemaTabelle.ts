/**
 * Markdown-Seite der Schema-Tabellen: erkennen, zerlegen, neu aufbauen.
 *
 * Bewusst zeilenbasiert und ohne Regex ueber den ganzen Dateitext – die
 * Tabellen stehen in Notizen, die daneben anki-cards-Bloecke, Callouts und
 * Mathe enthalten. Ein gieriges Muster ueber alles hinweg wuerde davon frueher
 * oder spaeter etwas mitnehmen.
 */

/** Eine Zeile der Tabelle: Buchstabe plus die restlichen Spalten. */
export interface SchemaZeile {
	/** Der Buchstabe der Kachel, z.B. "S". */
	zeichen: string;
	/** Inhalt der uebrigen Spalten, in Reihenfolge. */
	spalten: string[];
}

export interface SchemaTabelle {
	/** Ueberschriften aller Spalten, inklusive der Buchstabenspalte. */
	kopf: string[];
	zeilen: SchemaZeile[];
	/** Zeilenindex der Kopfzeile im Dokument. */
	start: number;
	/** Zeilenindex der letzten Tabellenzeile im Dokument (einschliesslich). */
	ende: number;
	/** Bildbreite, die in den vorhandenen Links steht (z.B. 100). */
	breite: number;
	/** Vault-Pfade der bisher verlinkten Bilder, je Zeile. */
	bisherigeBilder: string[];
}

/** Erkennt `![[pfad/S.png|100]]`, auch mit escaptem Pipe (`\|`) wie in Tabellen. */
const BILD_MUSTER = /!\[\[([^\]|\\]+?\.(?:png|jpe?g|webp|svg))(?:\s*(?:\\)?\|\s*(\d+))?\s*\]\]/i;

const TRENNZEILE = /^[\s>]*\|?[\s]*:?-{2,}:?[\s]*(\|[\s]*:?-{2,}:?[\s]*)*\|?[\s]*$/;

/**
 * Zerlegt eine Tabellenzeile in ihre Zellen.
 *
 * Escapte Pipes (`\|`) gehoeren zur Zelle und trennen nicht – genau die
 * stecken in jedem `![[A.png\|50]]`.
 */
export function zerlegeTabellenzeile(zeile: string): string[] {
	const ohnePrefix = zeile.replace(/^[\s>]*/, '');
	const zellen: string[] = [];
	let aktuell = '';
	for (let i = 0; i < ohnePrefix.length; i++) {
		const zeichen = ohnePrefix[i];
		if (zeichen === '\\' && ohnePrefix[i + 1] === '|') {
			aktuell += '\\|';
			i++;
			continue;
		}
		if (zeichen === '|') {
			zellen.push(aktuell);
			aktuell = '';
			continue;
		}
		aktuell += zeichen;
	}
	zellen.push(aktuell);

	// Fuehrende und schliessende Pipe erzeugen je eine leere Randzelle.
	if (zellen.length && zellen[0].trim() === '') zellen.shift();
	if (zellen.length && zellen[zellen.length - 1].trim() === '') zellen.pop();
	return zellen.map(z => z.trim());
}

function istTabellenzeile(zeile: string): boolean {
	const t = zeile.replace(/^[\s>]*/, '');
	return t.indexOf('|') !== -1 && t.trim().length > 0;
}

/**
 * Sucht alle Tabellen, deren erste Spalte aus Bild-Einbettungen besteht –
 * also die Schema-Tabellen. Andere Tabellen in der Notiz bleiben unberuehrt.
 */
export function findeSchemaTabellen(inhalt: string): SchemaTabelle[] {
	const zeilen = inhalt.split('\n');
	const gefunden: SchemaTabelle[] = [];

	let i = 0;
	while (i < zeilen.length) {
		if (!istTabellenzeile(zeilen[i]) || i + 1 >= zeilen.length || !TRENNZEILE.test(zeilen[i + 1])) {
			i++;
			continue;
		}

		const kopf = zerlegeTabellenzeile(zeilen[i]);
		const start = i;
		let ende = i + 1;
		const datenzeilen: string[][] = [];
		let j = i + 2;
		while (j < zeilen.length && istTabellenzeile(zeilen[j])) {
			datenzeilen.push(zerlegeTabellenzeile(zeilen[j]));
			ende = j;
			j++;
		}
		i = j;

		const tabelle = alsSchemaTabelle(kopf, datenzeilen, start, ende);
		if (tabelle) gefunden.push(tabelle);
	}

	return gefunden;
}

function alsSchemaTabelle(
	kopf: string[],
	datenzeilen: string[][],
	start: number,
	ende: number
): SchemaTabelle | null {
	if (datenzeilen.length === 0) return null;

	const zeilen: SchemaZeile[] = [];
	const bilder: string[] = [];
	let breite = 0;

	for (const zellen of datenzeilen) {
		const treffer = (zellen[0] || '').match(BILD_MUSTER);
		if (!treffer) return null; // Erste Spalte ohne Bild -> keine Schema-Tabelle.
		bilder.push(treffer[1].trim());
		if (!breite && treffer[2]) breite = parseInt(treffer[2], 10);
		zeilen.push({
			zeichen: zeichenAusPfad(treffer[1]),
			spalten: zellen.slice(1)
		});
	}

	return {
		kopf,
		zeilen,
		start,
		ende,
		breite: breite || 100,
		bisherigeBilder: bilder
	};
}

/**
 * Holt den Buchstaben aus einem Bildpfad: "…/SAMPLERS/S2.png" -> "S".
 *
 * Die Zaehlziffer der Wiederholungen (S2, S3) gehoert nicht zum Buchstaben,
 * eine Kachel "10" dagegen schon. Deshalb wird nur eine angehaengte Ziffer
 * abgeschnitten, wenn davor noch etwas Nichtnumerisches steht.
 */
export function zeichenAusPfad(pfad: string): string {
	const datei = pfad.split(/[\\/]/).pop() || pfad;
	const basis = datei.replace(/\.(png|jpe?g|webp|svg)$/i, '').trim();
	const ohneZaehler = basis.replace(/^(\D.*?)\d+$/, '$1');
	return (ohneZaehler || basis).toUpperCase();
}

/** Escapt eine Zelle so, dass sie eine Markdown-Tabelle nicht sprengt. */
export function escapeZelle(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/\|/g, '\\|')
		.replace(/\n/g, '<br>')
		.trim();
}

/** Der Tabellen-Link auf eine Kachel. In Tabellen muss das Pipe escapt sein. */
export function bildLinkTabelle(pfad: string, breite: number): string {
	return `![[${pfad}\\|${breite}]]`;
}

/** Derselbe Link fuer den anki-cards-Block – dort wird nicht escapt. */
export function bildLinkKarte(pfad: string, breite: number): string {
	return `![[${pfad}|${breite}]]`;
}

/**
 * Baut die Markdown-Tabelle. Die Spalten werden auf gleiche Breite gepolstert,
 * weil die vorhandenen Notizen das auch sind und Obsidian es beim Formatieren
 * ohnehin so hinterlaesst.
 */
export function baueTabelle(
	kopf: string[],
	zeilen: string[][]
): string {
	const alle = [kopf, ...zeilen];
	const spaltenzahl = kopf.length;
	const breiten: number[] = [];
	for (let s = 0; s < spaltenzahl; s++) {
		let max = 3;
		for (const zeile of alle) {
			const laenge = (zeile[s] || '').length;
			if (laenge > max) max = laenge;
		}
		breiten.push(max);
	}

	const zeileAlsText = (zeile: string[]) => '| ' + breiten
		.map((b, s) => fuelleAuf(zeile[s] || '', b))
		.join(' | ') + ' |';

	const trenner = '| ' + breiten.map(b => '-'.repeat(b)).join(' | ') + ' |';

	return [zeileAlsText(kopf), trenner, ...zeilen.map(zeileAlsText)].join('\n');
}

function fuelleAuf(text: string, breite: number): string {
	if (text.length >= breite) return text;
	return text + ' '.repeat(breite - text.length);
}

/**
 * Ersetzt die Zeilen `start`..`ende` im Dokument durch neuen Text.
 *
 * Indexbasiert und ohne `String.replace`, damit `$&` und Co. in Kartentexten
 * nichts zerstoeren – dieselbe Falle, die es bei den anki-cards-Bloecken
 * schon gab.
 */
export function ersetzeZeilen(
	inhalt: string,
	start: number,
	ende: number,
	neu: string
): string {
	const zeilen = inhalt.split('\n');
	const vorher = zeilen.slice(0, start);
	const nachher = zeilen.slice(ende + 1);
	return [...vorher, ...neu.split('\n'), ...nachher].join('\n');
}

/** Block-ID des Hintergrund-Callouts, z.B. "hintergrund-atmist". */
export function hintergrundId(schemaName: string): string {
	const sauber = schemaName
		.toLowerCase()
		.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return `hintergrund-${sauber || 'schema'}`;
}

export interface NotizGeruestOptionen {
	schemaName: string;
	hintergrund: string;
	tabelle: string;
	/** Zeilen fuer die Aufzaehlungskarte: schon fertig formatierte Strings. */
	kartenZeilen: string[];
	deck: string;
}

/**
 * Callout + Tabelle + anki-cards-Block, im Aufbau von ATMIST.md.
 *
 * Der Fence wird hier direkt geschrieben, weil der Block neu entsteht. Fuer
 * das Umschreiben eines *vorhandenen* Blocks gilt weiter buildFullBlock().
 */
export function baueNotizGeruest(o: NotizGeruestOptionen): string {
	const id = hintergrundId(o.schemaName);
	const hintergrund = o.hintergrund.trim() || `Merkhilfe für ${o.schemaName}`;
	const verweis = `[[#^${id}|${o.schemaName}]]`;

	const teile: string[] = [];
	teile.push(`>[!definition] Hintergrund *${o.schemaName}*`);
	teile.push(`>${hintergrund} ^${id}`);
	teile.push('');
	teile.push(o.tabelle);
	teile.push('');
	teile.push('');
	teile.push('## Anki');
	teile.push('```anki-cards');
	teile.push(`TARGET DECK: ${o.deck}`);
	teile.push('');
	teile.push(`Q: Das ${verweis}-Schema dient als {{c1::${hintergrund.replace(/\.$/, '')}}}.`);
	teile.push('');
	teile.push(`Q: Nenne die einzelnen Bestandteile und ihre Bedeutungen im ${verweis}-Schema. (${o.kartenZeilen.length})`);
	teile.push(`A: ${o.kartenZeilen.join('\n')}`);
	teile.push('```');

	return teile.join('\n');
}
