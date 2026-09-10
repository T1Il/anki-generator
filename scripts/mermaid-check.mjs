/**
 * Ueberlebt ein Schaubild den Weg von der Karte in die Notiz und zurueck?
 *
 *   node scripts/mermaid-check.mjs
 *
 * Der Grund: eine ```mermaid-Fence in einer Antwort steht INNERHALB des
 * anki-cards-Blocks, und ihre schliessende ``` haette den aeusseren Block
 * beendet — mitten in der Karte. Seit buildFullBlock() die aeussere Fence
 * verlaengert, schliesst die innere nur noch sich selbst. Dieses Skript
 * haelt genau das fest; kein Testframework im Projekt, deshalb dasselbe
 * Muster wie parser-check.mjs.
 */

import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outfile = path.join(os.tmpdir(), 'anki-mermaid-check.cjs');
const stubFile = path.join(os.tmpdir(), 'anki-obsidian-stub.cjs');
fs.writeFileSync(stubFile, 'module.exports = {};\n');

await esbuild.build({
	entryPoints: [path.join(root, 'src/anki/ankiParser.ts')],
	bundle: true, format: 'cjs', platform: 'node', target: 'es2018',
	external: ['obsidian'], outfile, logLevel: 'silent'
});

const require = createRequire(import.meta.url);
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'obsidian') return stubFile;
	return originalResolve.call(this, request, ...args);
};

const P = require(outfile);

let failures = 0;
const check = (name, cond, detail) => {
	if (cond) console.log('  ok   ' + name);
	else {
		failures++;
		console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
	}
};

const SCHAUBILD = [
	'```mermaid',
	'flowchart TD',
	'  A["Rhythmus pruefen"] --> B{"Defibrillierbar?"}',
	'  B -->|Ja| C["Einmal defibrillieren"]',
	'  B -->|Nein| D["2 Minuten Thoraxkompression"]',
	'  C --> D',
	'  D --> A',
	'```'
].join('\n');

/** Karte -> Blocktext -> Datei -> geparste Karte. Der ganze Weg. */
function hinUndZurueck(karten) {
	const inner = P.formatCardsToString('DECK: Medizin', karten);
	const block = { start: 0, end: 0, prefix: '', fence: '```', inner: '', innerClean: '' };
	const datei = 'Text davor.\n\n' + P.buildFullBlock(block, inner) + '\n\nText danach.\n';
	const bloecke = P.getAnkiBlocks(datei);
	return { datei, bloecke, karten: bloecke.length ? P.parseCardsFromBlockSource(bloecke[0].innerClean) : [] };
}

console.log('\nDas Schaubild in einer Antwort:');
{
	const r = hinUndZurueck([{ q: 'Wie laeuft ein Zyklus der Reanimation ab?', a: SCHAUBILD, id: null, typeIn: false }]);
	check('der aeussere Block wird noch gefunden', r.bloecke.length === 1, r.bloecke.length);
	check('die aeussere Fence ist vier Backticks lang',
		r.bloecke[0] && r.bloecke[0].fence === '````', r.bloecke[0] && r.bloecke[0].fence);
	check('genau eine Karte kommt zurueck', r.karten.length === 1, r.karten.map(k => k.q));
	check('die Antwort ist Zeichen fuer Zeichen dieselbe',
		r.karten[0] && r.karten[0].a.trim() === SCHAUBILD, r.karten[0] && r.karten[0].a);
	check('der Text nach dem Block bleibt stehen',
		r.datei.trimEnd().endsWith('Text danach.'), r.datei.slice(-40));
}

console.log('\nSchaubild neben gewoehnlichen Karten:');
{
	const r = hinUndZurueck([
		{ q: 'Normalwert Herzfrequenz Erwachsene?', a: '60-100 bpm', id: 1, typeIn: true },
		{ q: 'Wie laeuft ein Zyklus der Reanimation ab?', a: SCHAUBILD, id: null, typeIn: false },
		{ q: 'Was bedeutet ROSC?', a: 'Return of Spontaneous Circulation', id: 2, typeIn: false }
	]);
	check('alle drei Karten kommen zurueck', r.karten.length === 3, r.karten.map(k => k.q));
	check('die Tippkarte bleibt eine Tippkarte', r.karten[0] && r.karten[0].typeIn === true);
	check('die Anki-IDs bleiben erhalten',
		r.karten[0].id === 1 && r.karten[2].id === 2, r.karten.map(k => k.id));
	check('das Schaubild steht unveraendert in der mittleren Karte',
		r.karten[1] && r.karten[1].a.trim() === SCHAUBILD, r.karten[1] && r.karten[1].a);
	check('die Karte danach faengt sauber an',
		r.karten[2] && r.karten[2].a.trim() === 'Return of Spontaneous Circulation', r.karten[2] && r.karten[2].a);
}

console.log('\nWas sich nicht aendern darf:');
{
	const r = hinUndZurueck([{ q: 'Was ist Sepsis?', a: 'Eine dysregulierte Wirtsantwort auf eine Infektion.', id: 5, typeIn: false }]);
	check('ohne Schaubild bleiben es drei Backticks',
		r.bloecke[0] && r.bloecke[0].fence === '```', r.bloecke[0] && r.bloecke[0].fence);
}
{
	// Ein Codebeispiel in einer Antwort ist derselbe Fall — die Regel ist nicht
	// auf Mermaid gemuenzt, sondern auf jede Fence im Inhalt.
	const code = '```python\nprint("hallo")\n```';
	const r = hinUndZurueck([{ q: 'Wie gibt man in Python etwas aus?', a: code, id: null, typeIn: false }]);
	check('ein Codeblock in der Antwort ueberlebt genauso',
		r.karten.length === 1 && r.karten[0].a.trim() === code, r.karten[0] && r.karten[0].a);
}

console.log('');
if (failures) {
	console.log(failures + ' Pruefung(en) fehlgeschlagen.');
	process.exit(1);
}
console.log('Alle Pruefungen bestanden.');
