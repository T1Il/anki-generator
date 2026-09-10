import { App, Editor, MarkdownView, Notice, TFile, normalizePath } from 'obsidian';
import { farbenFuer } from './farbleiter';
import { Kachel, dateinamenFuer, schreibeKacheln } from './kachelRenderer';
import {
	SchemaTabelle,
	baueNotizGeruest,
	baueTabelle,
	bildLinkKarte,
	bildLinkTabelle,
	ersetzeZeilen,
	escapeZelle,
	findeSchemaTabellen,
	zerlegeTabellenzeile
} from './schemaTabelle';
import { SchemaEingabe, SchemaTabelleModal } from '../ui/SchemaTabelleModal';

/**
 * Die drei Schema-Befehle.
 *
 * Gemeinsamer Kern: aus Buchstaben + Farbleiter werden PNG-Kacheln in den
 * Vault geschrieben, und die Bild-Links wandern in eine Markdown-Tabelle.
 * Was sich unterscheidet, ist nur, was drumherum in die Notiz kommt.
 */

interface PluginMitEinstellungen {
	app: App;
	settings: { mainDeck: string };
}

const STANDARD_KOPF = ['Buchstabe', 'Bedeutung'];
const STANDARD_BREITE = 100;
const BILDER_UNTERORDNER = 'Bilder';

/** Ordner der aktiven Notiz, ohne Dateiname. */
function notizOrdner(file: TFile | null): string {
	if (!file) return '';
	const teile = file.path.split('/');
	teile.pop();
	return teile.join('/');
}

/** Elternordner aller Kachelordner: "<Ordner der Notiz>/Bilder". */
function ordnerBasis(file: TFile | null): string {
	const basis = notizOrdner(file);
	return normalizePath(basis ? `${basis}/${BILDER_UNTERORDNER}` : BILDER_UNTERORDNER);
}

function ordnerVorschlag(file: TFile | null, schemaName: string): string {
	return normalizePath(`${ordnerBasis(file)}/${schemaName || 'Schema'}`);
}

function deckVorschlag(plugin: PluginMitEinstellungen): string {
	const haupt = (plugin.settings.mainDeck || '').trim();
	return haupt ? `${haupt}::Schemata` : 'Schemata';
}

/**
 * Erzeugt die Kacheln und liefert die fertigen Bild-Links je Zeile.
 *
 * Ein Schritt fuer alle Befehle, damit Dateinamen, Farben und Links garantiert
 * zueinander passen.
 */
async function erzeugeKacheln(
	app: App,
	eingabe: SchemaEingabe
): Promise<{ pfade: string[] }> {
	const zeichen = eingabe.zeilen.map(z => z[0]);
	const farben = farbenFuer(zeichen.length, eingabe.leiterId, eingabe.verteilung);
	const namen = dateinamenFuer(zeichen);

	const kacheln: Kachel[] = zeichen.map((z, i) => ({
		zeichen: z,
		farbe: farben[i],
		dateiname: namen[i]
	}));

	const pfade = await schreibeKacheln(app, eingabe.ordner, kacheln);
	return { pfade };
}

/** Die Markdown-Tabelle aus Eingabe + geschriebenen Bildpfaden. */
function tabelleAus(eingabe: SchemaEingabe, pfade: string[]): string {
	const spaltenzahl = Math.max(
		eingabe.kopf.length,
		...eingabe.zeilen.map(z => z.length)
	);
	const kopf: string[] = [];
	for (let s = 0; s < spaltenzahl; s++) {
		kopf.push(eingabe.kopf[s] || (s === 0 ? STANDARD_KOPF[0] : `Spalte ${s + 1}`));
	}

	const zeilen = eingabe.zeilen.map((zelle, i) => {
		const reihe = [bildLinkTabelle(pfade[i], eingabe.breite)];
		for (let s = 1; s < spaltenzahl; s++) {
			reihe.push(escapeZelle(zelle[s] || ''));
		}
		return reihe;
	});

	return baueTabelle(kopf, zeilen);
}

/** Die Aufzaehlung fuer die Anki-Karte: "- ![[…]] Bedeutung". */
function kartenZeilenAus(eingabe: SchemaEingabe, pfade: string[]): string[] {
	return eingabe.zeilen.map((zelle, i) => {
		const bedeutung = (zelle[1] || zelle[0] || '').replace(/\n/g, ' ').trim();
		return `- ${bildLinkKarte(pfade[i], eingabe.breite)} ${bedeutung}`.trimEnd();
	});
}

// --- Befehl 1: Schema-Notiz ------------------------------------------------

/**
 * Callout + Tabelle + anki-cards-Block, in eine Notiz, die nur dieses Schema
 * behandelt. Das Geruest ersetzt nichts, es wird am Cursor eingefuegt.
 */
export function schemaNotizErstellen(
	plugin: PluginMitEinstellungen,
	editor: Editor,
	view: MarkdownView
): void {
	const file = view.file;
	const name = file ? file.basename.replace(/-Schema$/i, '').trim() : '';

	new SchemaTabelleModal(plugin.app, {
		modus: 'notiz',
		schemaName: name,
		kopf: [...STANDARD_KOPF],
		zeilen: [],
		leiterId: 'regenbogen',
		verteilung: 'gespreizt',
		breite: STANDARD_BREITE,
		ordnerBasis: ordnerBasis(file),
		ordner: ordnerVorschlag(file, name),
		hintergrund: '',
		deck: deckVorschlag(plugin)
	}, eingabe => {
		void (async () => {
			try {
				const { pfade } = await erzeugeKacheln(plugin.app, eingabe);
				const geruest = baueNotizGeruest({
					schemaName: eingabe.schemaName || 'Schema',
					hintergrund: eingabe.hintergrund,
					tabelle: tabelleAus(eingabe, pfade),
					kartenZeilen: kartenZeilenAus(eingabe, pfade),
					deck: eingabe.deck || deckVorschlag(plugin)
				});
				editor.replaceSelection(geruest + '\n');
				new Notice(`${pfade.length} Kacheln erzeugt.`);
			} catch (e) {
				fehler(e);
			}
		})();
	}).open();
}

// --- Befehl 2: Tabelle in eine normale Notiz -------------------------------

/** Nur die Tabelle, am Cursor. Fuer Notizen, die nicht nur aus Schemata bestehen. */
export function schemaTabelleEinfuegen(
	plugin: PluginMitEinstellungen,
	editor: Editor,
	view: MarkdownView
): void {
	const file = view.file;

	new SchemaTabelleModal(plugin.app, {
		modus: 'tabelle',
		schemaName: '',
		kopf: [...STANDARD_KOPF],
		zeilen: [],
		leiterId: 'regenbogen',
		verteilung: 'gespreizt',
		breite: STANDARD_BREITE,
		ordnerBasis: ordnerBasis(file),
		ordner: ordnerVorschlag(file, ''),
		hintergrund: '',
		deck: deckVorschlag(plugin)
	}, eingabe => {
		void (async () => {
			try {
				const { pfade } = await erzeugeKacheln(plugin.app, eingabe);
				editor.replaceSelection('\n' + tabelleAus(eingabe, pfade) + '\n');
				new Notice(`${pfade.length} Kacheln erzeugt.`);
			} catch (e) {
				fehler(e);
			}
		})();
	}).open();
}

// --- Befehl 3: vorhandene Tabelle nachziehen -------------------------------

/**
 * Faerbt eine bereits vorhandene Schema-Tabelle neu ein.
 *
 * Die Buchstaben kommen aus den Dateinamen der bisher verlinkten Bilder –
 * im Text der Notiz stehen sie nirgends. Die Bedeutungsspalten bleiben
 * unangetastet; ersetzt wird ausschliesslich die erste Spalte.
 */
export function schemaTabelleAktualisieren(
	plugin: PluginMitEinstellungen,
	editor: Editor,
	view: MarkdownView
): void {
	const file = view.file;
	const inhalt = editor.getValue();
	const tabellen = findeSchemaTabellen(inhalt);

	if (tabellen.length === 0) {
		new Notice('Keine Schema-Tabelle in dieser Notiz gefunden. '
			+ 'Erkannt wird eine Tabelle, deren erste Spalte Bilder enthält.');
		return;
	}

	const cursor = editor.getCursor().line;
	const tabelle = tabelleAmCursor(tabellen, cursor);
	const name = file ? file.basename.replace(/-Schema$/i, '').trim() : 'Schema';

	new SchemaTabelleModal(plugin.app, {
		modus: 'aktualisieren',
		spaltenGesperrt: true,
		schemaName: name,
		kopf: tabelle.kopf,
		zeilen: tabelle.zeilen.map(z => [z.zeichen, ...z.spalten]),
		leiterId: 'regenbogen',
		verteilung: 'gespreizt',
		breite: tabelle.breite,
		ordnerBasis: ordnerBasis(file),
		ordner: ordnerVorschlag(file, name),
		hintergrund: '',
		deck: deckVorschlag(plugin)
	}, eingabe => {
		void (async () => {
			try {
				const { pfade } = await erzeugeKacheln(plugin.app, eingabe);
				// Die Tabelle nach dem Dialog neu suchen: die Notiz kann sich
				// inzwischen geaendert haben.
				const aktuell = editor.getValue();
				const neuGefunden = findeSchemaTabellen(aktuell);
				const ziel = passendeTabelle(neuGefunden, tabelle);
				if (!ziel) {
					new Notice('Die Tabelle ist nicht mehr auffindbar. Die Kacheln wurden trotzdem geschrieben.');
					return;
				}

				// Nur die Datenzeilen der Tabelle anfassen, statt das ganze
				// Dokument neu zu setzen — das wuerde Undo-Verlauf und
				// Scrollposition wegwerfen.
				const neueZeilen = neueErsteSpalte(aktuell, ziel, pfade, eingabe.breite);
				editor.replaceRange(
					neueZeilen.join('\n'),
					{ line: ziel.start + 2, ch: 0 },
					{ line: ziel.ende, ch: editor.getLine(ziel.ende).length }
				);
				new Notice(`${pfade.length} Kacheln neu eingefärbt.`);
			} catch (e) {
				fehler(e);
			}
		})();
	}).open();
}

/** Die Tabelle, in der der Cursor steht – sonst die erste der Notiz. */
function tabelleAmCursor(tabellen: SchemaTabelle[], zeile: number): SchemaTabelle {
	const treffer = tabellen.find(t => zeile >= t.start && zeile <= t.ende);
	return treffer || tabellen[0];
}

/**
 * Findet dieselbe Tabelle nach dem Dialog wieder. Der Zeilenindex kann sich
 * verschoben haben, deshalb wird ueber die Bildpfade der ersten Spalte
 * verglichen; erst danach ueber die Startzeile.
 */
function passendeTabelle(tabellen: SchemaTabelle[], vorher: SchemaTabelle): SchemaTabelle | null {
	const schluessel = vorher.bisherigeBilder.join(' ');
	const ueberBilder = tabellen.find(t => t.bisherigeBilder.join(' ') === schluessel);
	if (ueberBilder) return ueberBilder;
	return tabellen.find(t => t.start === vorher.start) || null;
}

/**
 * Tauscht in den Tabellenzeilen nur die erste Zelle aus.
 *
 * Bewusst zeilen- und indexbasiert und ohne `String.replace`: die
 * Bedeutungsspalten enthalten Mathe, Anfuehrungszeichen und `$`-Zeichen, die
 * ein Ersetzungsstring interpretieren wuerde.
 */
export function neueErsteSpalte(
	inhalt: string,
	tabelle: SchemaTabelle,
	pfade: string[],
	breite: number
): string[] {
	const zeilen = inhalt.split('\n');
	const neu: string[] = [];

	for (let i = 0; i < tabelle.zeilen.length; i++) {
		const dokZeile = tabelle.start + 2 + i;
		const roh = zeilen[dokZeile] || '';
		const prefix = (roh.match(/^[\s>]*/) || [''])[0];
		const zellen = zerlegeTabellenzeile(roh);
		zellen[0] = bildLinkTabelle(pfade[i], breite);
		neu.push(`${prefix}| ${zellen.join(' | ')} |`);
	}

	return neu;
}

/** Dieselbe Ersetzung auf einem reinen String — so pruefen es die Fixture-Tests. */
export function ersetzeErsteSpalte(
	inhalt: string,
	tabelle: SchemaTabelle,
	pfade: string[],
	breite: number
): string {
	const neu = neueErsteSpalte(inhalt, tabelle, pfade, breite);
	return ersetzeZeilen(inhalt, tabelle.start + 2, tabelle.ende, neu.join('\n'));
}

function fehler(e: unknown): void {
	const text = e instanceof Error ? e.message : String(e);
	console.error('[Schema] ', e);
	new Notice(`Schema-Tabelle fehlgeschlagen: ${text}`);
}
