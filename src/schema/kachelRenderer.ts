import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { Kachelfarbe } from './farbleiter';

/**
 * Zeichnet die Buchstaben-Kacheln der Schemata als PNG.
 *
 * Warum Bilder und kein HTML: die Kacheln landen ueber den anki-cards-Block
 * auch in Anki, und dort gibt es auf AnkiDroid und iOS keine Bahnschrift. Im
 * Bild ist die Schrift eingebrannt und sieht ueberall gleich aus – so wie
 * die handgemachten Kacheln, die es im Vault schon gibt.
 */

/** Kantenlaenge der erzeugten PNGs. Die alten Kacheln sind 100 und 1000 gross. */
export const KACHEL_GROESSE = 512;

/**
 * Bahnschrift SemiBold, mit Rueckfallkette. Bahnschrift ist eine Variable
 * Font; Windows meldet die Schnitte als eigene Familien an, deshalb steht der
 * Schnittname direkt in der Familie. Wo es sie nicht gibt (Linux, macOS),
 * greift die Kette auf eine schmale Grotesk zurueck.
 */
const SCHRIFT_KETTE = '"Bahnschrift SemiBold", "Bahnschrift", "DIN Alternate", ' +
	'"Roboto Condensed", "Arial Narrow", sans-serif';

/**
 * Wie viel der Kachel der Buchstabe hoechstens fuellen darf. Die vorhandenen
 * Kacheln lassen ringsum etwas Luft; 0.72 trifft das gut.
 */
const FUELLGRAD = 0.72;

/**
 * Wie viel der Kachel ein Buchstabe in der Hoehe aeusserstenfalls einnehmen
 * darf, Umlautpunkte und Unterlaengen eingerechnet. Der Rest ist Rand, damit
 * nichts an der Kante klebt oder abgeschnitten wird.
 */
const HOECHSTER_ANTEIL = 0.94;

export interface Kachel {
	/** Der Buchstabe, meist ein Zeichen, aber "Ö" oder "10" sind erlaubt. */
	zeichen: string;
	farbe: Kachelfarbe;
	/** Dateiname ohne Ordner, z.B. "S.png" oder "S2.png". */
	dateiname: string;
}

/** Meldet, ob Bahnschrift auf diesem Geraet wirklich vorhanden ist. */
export function bahnschriftVerfuegbar(): boolean {
	try {
		const fonts = (document as unknown as { fonts?: { check(f: string): boolean } }).fonts;
		if (!fonts || typeof fonts.check !== 'function') return true; // nicht pruefbar, nicht warnen
		return fonts.check('64px "Bahnschrift SemiBold"') || fonts.check('64px "Bahnschrift"');
	} catch {
		return true;
	}
}

/**
 * ALLE KACHELN EINES SCHEMAS TEILEN SICH EINE SCHRIFTGROESSE.
 *
 * Nachgemessen an den vorhandenen Bildern: dort ist die Tintenhoehe fuer A,
 * B, E, F, L, M, P, R, T, X und Z durchweg 711 von 1000 Pixeln – also eine
 * feste Schriftgroesse, keine pro Buchstabe angepasste. Nur die runden S, C
 * und O ragen mit 724..726 leicht darueber hinaus, und genau so soll es sein:
 * Rundungen bekommen typografisch einen Ueberschuss.
 *
 * Wuerde man jeden Buchstaben einzeln auf dieselbe Kastenhoehe ziehen,
 * schrumpfte ausgerechnet das S – und ein Q mit Unterlaenge noch viel mehr.
 * In einer Tabelle untereinander faellt das sofort auf.
 *
 * Den Ausschlag gibt die Versalhoehe, gemessen am "H" – nicht der hoechste
 * Buchstabe des Schemas. Sonst wuerde ein einziges "Ö" mit seinen Punkten
 * alle anderen Buchstaben um ein Fuenftel schrumpfen lassen. Die Punkte
 * duerfen stattdessen in den Rand hineinragen; nur ganz abgeschnitten werden
 * darf nichts, dafuer sorgt die Sicherheitsgrenze.
 */
export function gemeinsameSchriftgroesse(
	zeichen: string[],
	groesse = KACHEL_GROESSE
): number {
	const platz = groesse * FUELLGRAD;
	const flaeche = arbeitsflaeche(groesse);
	if (!flaeche) return platz;

	// Einmal bei einer Referenzgroesse messen; die Tintenbox skaliert linear
	// mit der Schriftgroesse, ein zweiter Durchlauf ist deshalb unnoetig.
	const referenz = platz;
	let faktor = Infinity;

	const versal = zeichneUndMesse(flaeche, 'H', referenz);
	if (versal && versal.hoehe > 0) faktor = platz / versal.hoehe;

	for (const z of zeichen) {
		const box = zeichneUndMesse(flaeche, text(z), referenz);
		if (!box || box.breite <= 0 || box.hoehe <= 0) continue;
		// In der Breite gilt der Kasten: etwas ungewoehnlich Breites wie "10"
		// soll lieber kleiner werden, als an den Rand zu stossen.
		faktor = Math.min(faktor, platz / box.breite);
		// In der Hoehe nur die Sicherheitsgrenze, damit Umlautpunkte und
		// Unterlaengen den Rand nutzen duerfen, aber nie abgeschnitten werden.
		faktor = Math.min(faktor, (groesse * HOECHSTER_ANTEIL) / box.hoehe);
		// Kein Versalbuchstabe messbar? Dann greift ersatzweise der Kasten.
		if (!versal) faktor = Math.min(faktor, platz / box.hoehe);
	}

	return isFinite(faktor) ? referenz * faktor : platz;
}

/**
 * Zeichnet eine Kachel.
 *
 * Zentriert wird ueber die tatsaechlich gesetzten Pixel, nicht ueber die
 * Schriftlinie und nicht ueber `measureText`: der Buchstabe wird auf eine
 * durchsichtige Arbeitsflaeche gezeichnet, seine Tintenflaeche dort
 * ausgemessen und genau mittig auf die Kachel kopiert. Damit stimmt die Mitte
 * unabhaengig davon, wie die jeweilige Schrift ihre Metriken meldet.
 *
 * `schriftgroesse` sollte von `gemeinsameSchriftgroesse()` fuer das ganze
 * Schema kommen. Ohne Angabe passt sich die Groesse nur an diesen einen
 * Buchstaben an – das ist fuer eine einzelne Kachel richtig, fuer eine
 * Reihe nicht.
 */
export function zeichneKachel(
	zeichen: string,
	farbe: Kachelfarbe,
	groesse = KACHEL_GROESSE,
	schriftgroesse?: number
): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = groesse;
	canvas.height = groesse;
	const ctx = canvas.getContext('2d');
	if (!ctx) return canvas;

	ctx.fillStyle = farbe.hintergrund;
	ctx.fillRect(0, 0, groesse, groesse);

	const inhalt = text(zeichen);
	const gewaehlt = schriftgroesse !== undefined
		? schriftgroesse
		: gemeinsameSchriftgroesse([inhalt], groesse);

	const flaeche = arbeitsflaeche(groesse);
	if (!flaeche) {
		// Ohne zweite Zeichenflaeche bleibt nur die Naeherung ueber die
		// Schriftmetrik. Sichtbar schlechter, aber besser als nichts.
		zeichneUeberMetrik(ctx, inhalt, farbe.schrift, gewaehlt, groesse);
		return canvas;
	}

	const box = zeichneUndMesse(flaeche, inhalt, gewaehlt, farbe.schrift);
	if (!box) {
		zeichneUeberMetrik(ctx, inhalt, farbe.schrift, gewaehlt, groesse);
		return canvas;
	}

	// Auf ganze Pixel runden: ein halber Pixel Versatz waere sonst eine
	// Neuabtastung und damit ein weichgezeichneter Buchstabe.
	const zielX = Math.round((groesse - box.breite) / 2);
	const zielY = Math.round((groesse - box.hoehe) / 2);
	ctx.drawImage(
		flaeche.canvas,
		box.x, box.y, box.breite, box.hoehe,
		zielX, zielY, box.breite, box.hoehe
	);

	return canvas;
}

function text(zeichen: string): string {
	return zeichen.trim() || '?';
}

function schriftFuer(groesse: number): string {
	// 600 ist SemiBold. Gibt es den echten SemiBold-Schnitt, waehlt ihn schon
	// der Familienname; sonst gewichtet der Browser selbst.
	return `600 ${Math.max(1, Math.round(groesse))}px ${SCHRIFT_KETTE}`;
}

interface Arbeitsflaeche {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	kante: number;
}

/**
 * Durchsichtige Flaeche zum Ausmessen. Sie ist doppelt so gross wie die
 * Kachel, damit auch ein zu gross geratener erster Versuch nicht am Rand
 * abgeschnitten wird – eine abgeschnittene Tintenbox waere zu klein
 * gemessen und der Buchstabe danach falsch platziert.
 */
function arbeitsflaeche(groesse: number): Arbeitsflaeche | null {
	const kante = Math.max(8, Math.round(groesse * 2));
	const canvas = document.createElement('canvas');
	canvas.width = kante;
	canvas.height = kante;
	const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
	return ctx ? { canvas, ctx, kante } : null;
}

interface Tinte { x: number; y: number; breite: number; hoehe: number; }

/** Zeichnet mittig auf die Arbeitsflaeche und misst die gesetzten Pixel aus. */
function zeichneUndMesse(
	flaeche: Arbeitsflaeche,
	inhalt: string,
	schriftgroesse: number,
	farbe = '#000000'
): Tinte | null {
	const { ctx, kante } = flaeche;
	ctx.clearRect(0, 0, kante, kante);
	ctx.font = schriftFuer(schriftgroesse);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = farbe;
	ctx.fillText(inhalt, kante / 2, kante / 2);

	let daten: ImageData;
	try {
		daten = ctx.getImageData(0, 0, kante, kante);
	} catch {
		return null;
	}

	// Schwelle statt "> 0": die aeussersten Kantenglaettungspixel sind fast
	// durchsichtig und wuerden die Box je nach Schrift unterschiedlich weit
	// aufblaehen.
	const SCHWELLE = 8;
	const px = daten.data;
	let links = kante, rechts = -1, oben = kante, unten = -1;
	for (let y = 0; y < kante; y++) {
		const zeilenstart = y * kante * 4;
		for (let x = 0; x < kante; x++) {
			if (px[zeilenstart + x * 4 + 3] < SCHWELLE) continue;
			if (x < links) links = x;
			if (x > rechts) rechts = x;
			if (y < oben) oben = y;
			if (y > unten) unten = y;
		}
	}
	if (rechts < 0) return null;

	return { x: links, y: oben, breite: rechts - links + 1, hoehe: unten - oben + 1 };
}

/** Rueckfall ohne Pixelmessung: zentriert ueber die gemeldete Schriftmetrik. */
function zeichneUeberMetrik(
	ctx: CanvasRenderingContext2D,
	inhalt: string,
	farbe: string,
	schriftgroesse: number,
	groesse: number
): void {
	ctx.font = schriftFuer(schriftgroesse);
	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = farbe;

	const m = ctx.measureText(inhalt);
	const links = typeof m.actualBoundingBoxLeft === 'number' ? -m.actualBoundingBoxLeft : 0;
	const rechts = typeof m.actualBoundingBoxRight === 'number' ? m.actualBoundingBoxRight : m.width;
	const oben = typeof m.actualBoundingBoxAscent === 'number' ? -m.actualBoundingBoxAscent : -schriftgroesse * 0.7;
	const unten = typeof m.actualBoundingBoxDescent === 'number' ? m.actualBoundingBoxDescent : 0;
	const breite = rechts - links;
	const hoehe = unten - oben;

	ctx.fillText(inhalt, groesse / 2 - links - breite / 2, groesse / 2 - oben - hoehe / 2);
}

/** PNG-Bytes einer Kachel. */
export async function kachelAlsPng(
	zeichen: string,
	farbe: Kachelfarbe,
	groesse = KACHEL_GROESSE,
	schriftgroesse?: number
): Promise<ArrayBuffer> {
	const canvas = zeichneKachel(zeichen, farbe, groesse, schriftgroesse);
	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
	if (!blob) throw new Error('Kachel konnte nicht als PNG kodiert werden.');
	return await blob.arrayBuffer();
}

/**
 * Vergibt Dateinamen fuer eine Buchstabenfolge. Wiederholte Buchstaben
 * bekommen eine Nummer angehaengt – 6F wird also F, F2, F3 ... genau wie
 * die vorhandenen S1..S4 im 4S-Ordner.
 */
export function dateinamenFuer(zeichen: string[]): string[] {
	const zaehler = new Map<string, number>();
	return zeichen.map(z => {
		const basis = dateiBasis(z);
		const bisher = (zaehler.get(basis) || 0) + 1;
		zaehler.set(basis, bisher);
		return bisher === 1 ? `${basis}.png` : `${basis}${bisher}.png`;
	});
}

/** Macht aus einem Zeichen einen dateisystemtauglichen Namen. */
function dateiBasis(zeichen: string): string {
	const sauber = zeichen.trim().replace(/[\\/:*?"<>|#^[\]]/g, '');
	return sauber.length > 0 ? sauber : 'X';
}

/**
 * Schreibt die Kacheln in den Vault und gibt die Vault-Pfade zurueck.
 *
 * Vorhandene Dateien werden ueberschrieben, nicht daneben gelegt: der Befehl
 * soll ein Schema auch nachtraeglich umfaerben koennen, ohne S 1.png,
 * S 2.png ... zu hinterlassen.
 */
export async function schreibeKacheln(
	app: App,
	ordner: string,
	kacheln: Kachel[],
	groesse = KACHEL_GROESSE
): Promise<string[]> {
	const ziel = normalizePath(ordner);
	await stelleOrdnerSicher(app, ziel);

	// Eine Schriftgroesse fuer das ganze Schema, damit die Buchstaben in der
	// Tabelle untereinander gleich gross wirken.
	const schriftgroesse = gemeinsameSchriftgroesse(kacheln.map(k => k.zeichen), groesse);

	const pfade: string[] = [];
	for (const kachel of kacheln) {
		const pfad = normalizePath(`${ziel}/${kachel.dateiname}`);
		const daten = await kachelAlsPng(kachel.zeichen, kachel.farbe, groesse, schriftgroesse);
		const vorhanden = app.vault.getAbstractFileByPath(pfad);
		if (vorhanden instanceof TFile) {
			await app.vault.modifyBinary(vorhanden, daten);
		} else {
			await app.vault.createBinary(pfad, daten);
		}
		pfade.push(pfad);
	}
	return pfade;
}

/** Legt den Ordner samt fehlender Elternordner an. */
export async function stelleOrdnerSicher(app: App, pfad: string): Promise<void> {
	const teile = normalizePath(pfad).split('/').filter(t => t.length > 0);
	let bisher = '';
	for (const teil of teile) {
		bisher = bisher ? `${bisher}/${teil}` : teil;
		const vorhanden = app.vault.getAbstractFileByPath(bisher);
		if (vorhanden instanceof TFolder) continue;
		if (vorhanden) throw new Error(`"${bisher}" ist bereits eine Datei, kein Ordner.`);
		await app.vault.createFolder(bisher);
	}
}
