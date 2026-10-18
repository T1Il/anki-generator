/**
 * Geflaggte Karten: Befunde ohne KI, Auftrag, Schluessel, Abschlussplan.
 *   node scripts/flaggen-check.mjs
 *
 * Nur ausgedachte Karten – das Repo ist oeffentlich. Die Faelle bilden die
 * Fehlerarten nach, die am 16.10.2026 im echten Bestand geflaggt waren.
 */

import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const stubFile = path.join(os.tmpdir(), 'anki-obsidian-stub.cjs');
// requestUrl wird von AnkiConnect.ts importiert; die geprueften Funktionen
// rufen es nicht auf, der Import muss aber aufloesen.
fs.writeFileSync(stubFile, 'module.exports = { requestUrl: async () => ({ json: {} }) };\n');

const entry = path.join(os.tmpdir(), 'anki-flaggen-entry.ts');
fs.writeFileSync(
	entry,
	'export * from ' + JSON.stringify(path.join(root, 'src/flaggen/flaggen.ts').replace(/\\/g, '/')) + ';\n' +
	'export * from ' + JSON.stringify(path.join(root, 'src/flaggen/bearbeitung.ts').replace(/\\/g, '/')) + ';\n'
);

const outfile = path.join(os.tmpdir(), 'anki-flaggen-check.cjs');

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'es2018',
	external: ['obsidian'],
	outfile,
	logLevel: 'silent'
});

const require = createRequire(import.meta.url);
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'obsidian') return stubFile;
	return originalResolve.call(this, request, ...args);
};

const F = require(outfile);

let failures = 0;
const check = (name, cond, detail) => {
	if (cond) {
		console.log('  ok   ' + name);
	} else {
		failures++;
		console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
	}
};


const basic = (q, a, id = 1, extra = {}) => ({ type: 'Basic', q, a, id, ...extra });
const cloze = (q, a = '', id = 1) => ({ type: 'Cloze', q, a, id });
const arten = (b) => b.map((x) => x.art);

console.log('\nFlaggen:');
check('pink = Darstellung kaputt / hinzufügen', F.flaggenArt(5).bedeutung === 'Darstellung kaputt / hinzufügen' && F.flaggenArt(5).auftrag.includes('Mermaid') && F.flaggenArt(5).auftrag.includes('erneutes Übertragen'));
check('türkis = Antwort unpräzise', F.flaggenArt(6).bedeutung === 'Antwort unpräzise');
check('blau = Überflüssig, Auftrag loeschen', F.flaggenArt(4).bedeutung === 'Überflüssig' && F.flaggenArt(4).auftrag.includes('OP: delete'));
check('unbekannte Nummer faellt auf rot', F.flaggenArt(9).nummer === 1);

console.log('\nBefunde ohne KI:');
{
	const b = F.befundeFuerKarte(
		{ felder: ['Zeige den Ablauf.', '[Mermaid-Diagramm konnte nicht gerendert werden]'], modell: 'Basic' },
		basic('Zeige den Ablauf.', '```mermaid\nflowchart TD\nA-->B\n```'));
	check('Mermaid-Fehlertext + Diagramm im Vault = veraltet, neu uebertragen',
		b.length === 1 && b[0].art === 'veraltet' && b[0].neuUebertragen, b);
	check('... und damit allein durch Uebertragen reparierbar', F.nurNeuUebertragen(b));
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Zeige die EKG-Bilder.', '<img src="ekg-beispiel.pdf">'], modell: 'Basic' },
		basic('Zeige die EKG-Bilder.', '![[ekg-beispiel.pdf]]'));
	check('PDF als Bild erkannt', arten(b).includes('anhang') && b[0].text.includes('PDF') && b[0].neuUebertragen, b);
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Zeige die Übersicht.', '<img src="Uebersicht.excalidraw.md">'], modell: 'Basic' },
		basic('Zeige die Übersicht.', '![[Uebersicht.excalidraw]]'));
	check('Excalidraw als Bild erkannt', b.length === 1 && b[0].text.includes('Excalidraw'), b);
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Zeige die Störung.', '<img src="St%C3%B6rung.png">'], modell: 'Basic',
			medien: [{ name: 'Störung.png', vorhanden: true, breite: 1600, hoehe: 500 }] },
		basic('Zeige die Störung.', '![[Störung.png]]'));
	check('Querformat erkannt (Name URL-dekodiert)', arten(b).join() === 'querformat', b);
	check('Querformat ist nicht durch Uebertragen reparierbar', !F.nurNeuUebertragen(b));
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Frage', '<img src="fehlt.png">'], modell: 'Basic', medien: [{ name: 'fehlt.png', vorhanden: false }] },
		basic('Frage', '![[fehlt.png]]'));
	check('fehlende Mediendatei', b.length === 1 && b[0].art === 'anhang' && b[0].neuUebertragen, b);
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Hochformat', '<img src="hoch.png">'], modell: 'Basic', medien: [{ name: 'hoch.png', vorhanden: true, breite: 800, hoehe: 1200 }] },
		basic('Hochformat', '![[hoch.png]]'));
	check('Bild im Hochformat ist kein Befund', b.length === 0, b);
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Ab welchem Wert?', '\\(\\leq\\) 65 mmHg'], modell: 'Einfach (Eintippen der Antwort)' },
		basic('Ab welchem Wert?', '$\\leq$ 65 mmHg', 1, { typeIn: true }));
	check('LaTeX auf Tippkarte = veraltet', b.length === 1 && b[0].art === 'veraltet', b);
	const normal = F.befundeFuerKarte(
		{ felder: ['Formel?', '\\(a^2\\)'], modell: 'Basic' }, basic('Formel?', '$a^2$'));
	check('LaTeX auf normaler Karte ist kein Befund', normal.length === 0, normal);
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Wie lautet die Hotline?', '** 0800 123'], modell: 'Basic' }, basic('Wie lautet die Hotline?', '** 0800 123'));
	check('Sternchen-Rest', arten(b).join() === 'rest', b);
	const fett = F.befundeFuerKarte(
		{ felder: ['Was ist <b>wichtig</b>?', 'Das'], modell: 'Basic' }, basic('Was ist **wichtig**?', 'Das'));
	check('richtig uebertragene Fettung ist kein Rest', fett.length === 0, fett);
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Häufigste Zelle ist der {{c1::Granulozyt}}. ^haeufigste-zelle'], modell: 'Lückentext' },
		cloze('Häufigste Zelle ist der {{c1::Granulozyt}}. ^haeufigste-zelle'));
	check('Block-ID im Lueckentext', arten(b).join() === 'rest' && b[0].text.includes('^haeufigste-zelle'), b);
	check('... und die ID macht ihn nicht zur Frage', !arten(b).includes('lueckentext'));
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['{{c1::ABC}} ist die Abkürzung für...'], modell: 'Lückentext' },
		cloze('{{c1::ABC}} ist die Abkürzung für...', 'Alpha Beta Gamma'));
	check('Lueckentext verliert Antwortzeile', b.some((x) => x.text.includes('Antwortzeile')), b);
	check('Lueckentext als Frage formuliert', b.some((x) => x.text.includes('Frage')), b);
}
{
	const b = F.befundeFuerKarte(
		{ felder: ['Nasenbluten heißt {{c1::Epistaxis}}. (Epistaxis)'], modell: 'Lückentext' },
		cloze('Nasenbluten heißt {{c1::Epistaxis}}. (Epistaxis)'));
	check('Loesung steht zusaetzlich im Text', b.some((x) => x.text.includes('Lösung „Epistaxis“')), b);
	const ok = F.befundeFuerKarte(
		{ felder: ['Nasenbluten heißt {{c1::Epistaxis}}.'], modell: 'Lückentext' }, cloze('Nasenbluten heißt {{c1::Epistaxis}}.'));
	check('sauberer Lueckentext ohne Befund', ok.length === 0, ok);
}
{
	const b = F.befundeFuerKarte({ felder: ['A', 'B'], modell: 'Basic', weichtAb: true }, basic('A', 'C'));
	check('allgemeine Abweichung = veraltet', b.length === 1 && b[0].art === 'veraltet', b);
	const doppelt = F.befundeFuerKarte(
		{ felder: ['Z', '[Mermaid-Diagramm konnte nicht gerendert werden]'], modell: 'Basic', weichtAb: true },
		basic('Z', '```mermaid\nA-->B\n```'));
	check('Abweichung nicht doppelt gemeldet', doppelt.length === 1, doppelt);
}
{
	const b = F.befundeFuerKarte({ felder: ['Was ist X?', 'Y'], modell: 'Basic' }, basic('Was ist X?', 'Y'));
	check('fachlicher Fall: keine Befunde, nicht nur Uebertragen', b.length === 0 && !F.nurNeuUebertragen(b));
}

console.log('\nAuftrag:');
{
	const t = F.pruefAuftrag([
		{ cardId: 11, noteId: 101, flagge: 6, kartenNummer: 3, anki: { felder: ['Frage <b>X</b>', 'Antwort'], modell: 'Basic' }, befunde: [] },
		{ cardId: 12, noteId: 102, flagge: 1, kartenNummer: 5, anki: { felder: ['Q', '<img src="a.pdf">'], modell: 'Basic' },
			befunde: [{ art: 'anhang', text: 'PDF', neuUebertragen: true }] }
	], true);
	check('CARD-Nummern im Auftrag', t.includes('### CARD: 3') && t.includes('### CARD: 5'));
	check('Flaggenbedeutung im Auftrag', t.includes('Antwort unpräzise') && t.includes('Fehler (unbestimmt)'));
	check('HTML wird zu Klartext', t.includes('Vorderseite: Frage X'), t);
	check('Befund mit Hinweis auf Neu-Uebertragen', t.includes('PDF (wird beim Abschließen neu übertragen)'));
	check('Quellen: Zotero und Vault', t.includes('Zotero') && t.includes('Vault'));
	const ohne = F.pruefAuftrag([], false);
	check('ohne Quellen kein Zotero-Hinweis', !ohne.includes('Zotero'));
	const w = F.waisenAuftrag([{ cardId: 1, noteId: 555, flagge: 4, kartenNummer: null, anki: { felder: ['a', 'b'], modell: 'Basic' }, befunde: [] }], false);
	check('Waisen werden ueber ID angesprochen', w.includes('### ID: 555') && w.includes('Überflüssig') && w.includes('OP: delete'));
}

console.log('\nSchluessel:');
check('Reihenfolge egal', F.stapelSchluessel([{ cardId: 2, flagge: 1 }, { cardId: 1, flagge: 4 }]) ===
	F.stapelSchluessel([{ cardId: 1, flagge: 4 }, { cardId: 2, flagge: 1 }]));
check('andere Flagge = anderer Schluessel', F.stapelSchluessel([{ cardId: 1, flagge: 1 }]) !==
	F.stapelSchluessel([{ cardId: 1, flagge: 6 }]));

check('weggefallene Flagge: Rest bleibt geprueft', F.schonGeprueft('1:1', '1:1,2:4'));
check('neue Flagge: neu pruefen', !F.schonGeprueft('1:1,3:1', '1:1,2:4'));
check('geaenderte Farbe: neu pruefen', !F.schonGeprueft('1:6', '1:1'));
check('nie geprueft', !F.schonGeprueft('1:1', undefined));

console.log('\nAbschlussplan:');
{
	const bloecke = [[basic('a', 'a', 100), basic('b', 'b', 200), basic('neu', 'n', null)], [basic('c', 'c', 300)]];
	const p = F.abschlussPlan([{ cardId: 1, noteId: 200 }, { cardId: 2, noteId: 300 }], bloecke);
	check('geflaggte Karte + neue Karte im selben Block', JSON.stringify(p.uebertragen.get(0)) === '[1,2]', [...p.uebertragen]);
	check('zweiter Block nur seine Karte', JSON.stringify(p.uebertragen.get(1)) === '[0]');
	check('beide entflaggt', p.entflaggen.join() === '1,2');
	check('nichts geloescht', p.loeschen.length === 0);
}
{
	const bloecke = [[basic('a', 'a', 100), basic('teil 1', 'x', null), basic('teil 2', 'y', null)]];
	const p = F.abschlussPlan([{ cardId: 9, noteId: 999 }], bloecke);
	check('im Vault geloeschte Karte wird in Anki geloescht', p.loeschen.join() === '999');
	check('... nicht entflaggt', p.entflaggen.length === 0);
	check('... und die neuen Teilkarten gehen mit', JSON.stringify(p.uebertragen.get(0)) === '[1,2]', [...p.uebertragen]);
}
{
	const bloecke = [[basic('a', 'a', 100), basic('b', 'b', 200)]];
	const p = F.abschlussPlan([{ cardId: 1, noteId: 100 }], bloecke);
	check('unbeteiligte Karten werden nicht uebertragen', JSON.stringify(p.uebertragen.get(0)) === '[0]');
}

console.log('\nAnzeige:');
{
	const e = F.eingeklappt('**Kopf**\n\nZeile 1\nZeile 2', 2);
	check('Kopfzeile sichtbar, Rest im eingeklappten Callout',
		e.startsWith('**Kopf** (2 Karten)') && e.includes('> [!abstract]- Auftrag') && e.includes('> Zeile 2'), e);
	const antwort = '### ID: 5 — rot\nIn Ordnung, weil X.\n\n### ID: 6 — blau\nWeg damit.\n```anki-card\nOP: delete\nID: 6\n```\n';
	check('Begruendung je Waise', F.waisenBegruendung(antwort, 5) === 'In Ordnung, weil X.', F.waisenBegruendung(antwort, 5));
	check('Begruendung ohne Vorschlagsblock', F.waisenBegruendung(antwort, 6) === 'Weg damit.', F.waisenBegruendung(antwort, 6));
	check('unbekannte ID = leer', F.waisenBegruendung(antwort, 7) === '');
}

console.log('\nBearbeitet?');
{
	const S = (v) => JSON.stringify(['card', 'update', null, v.ref, v.q, v.a, false]);
	const antwort = '### CARD: 1\n```anki-card\nOP: update\nCARD: 1\nQ: Neu 1\nA: a\n```\n### CARD: 2\n```anki-card\nOP: update\nCARD: 2\nQ: Neu 2\nA: b\n```\n';
	const verlauf = (vorschlaege) => [
		{ role: 'user', content: F.AUFTRAG_KOPF + ' (2 Karten)\n\n> [!abstract]- Auftrag' },
		{ role: 'ai', content: antwort, vorschlaege }
	];
	const am = '2026-10-16T10:00:00.000Z';
	const vor = Date.parse(am) - 1000;
	const b0 = F.bearbeitungsStand(verlauf({}), am, vor);
	check('zwei Vorschlaege, keiner erledigt', b0.vorschlaege === 2 && b0.erledigt === 0, b0);
	check('... = unbearbeitet', F.statusAus(b0) === 'unbearbeitet');
	const k1 = S({ ref: 1, q: 'Neu 1', a: 'a' });
	const b1 = F.bearbeitungsStand(verlauf({ [k1]: { status: 'applied' } }), am, vor);
	check('einer uebernommen = teilweise', b1.erledigt === 1 && F.statusAus(b1) === 'teilweise', b1);
	const k2 = S({ ref: 2, q: 'Neu 2', a: 'b' });
	const b2 = F.bearbeitungsStand(verlauf({ [k1]: { status: 'applied' }, [k2]: { status: 'dismissed' } }), am, vor);
	check('uebernommen + verworfen = bearbeitet', F.statusAus(b2) === 'bearbeitet', b2);
	const bh = F.bearbeitungsStand(verlauf({}), am, Date.parse(am) + 60000);
	check('Notiz von Hand geaendert = teilweise', F.statusAus(bh) === 'teilweise', bh);
	const bo = F.bearbeitungsStand([{ role: 'user', content: F.AUFTRAG_KOPF }, { role: 'ai', content: 'In Ordnung.' }], am, vor);
	check('Antwort ohne Vorschlag', F.statusAus(bo) === 'ohneVorschlag', bo);
	check('ohne Verlauf = unbearbeitet', F.statusAus(F.bearbeitungsStand(undefined, am, vor)) === 'unbearbeitet');
	check('Rang: unbearbeitet vor bearbeitet', F.STATUS_RANG.unbearbeitet < F.STATUS_RANG.bearbeitet && F.STATUS_RANG.teilweise < F.STATUS_RANG.nurUebertragen);
}

console.log('');
if (failures > 0) {
	console.error(failures + ' Pruefung(en) fehlgeschlagen.');
	process.exit(1);
}
console.log('Alle Pruefungen bestanden.');
