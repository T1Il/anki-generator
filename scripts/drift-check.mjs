/**
 * Fixture-Test für den Abgleich Notiz <-> Anki.
 *   node scripts/drift-check.mjs
 *
 * Wichtigste Eigenschaft: KEINE Falschmeldungen. Formatierung, Bilder,
 * Wikilinks, LaTeX und Mermaid dürfen nicht als inhaltliche Abweichung gelten.
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
fs.writeFileSync(stubFile, 'module.exports = {};\n');

const entry = path.join(os.tmpdir(), 'anki-drift-entry.ts');
fs.writeFileSync(
	entry,
	'export * from ' + JSON.stringify(path.join(root, 'src/anki/driftCheck.ts').replace(/\\/g, '/')) + ';\n'
);

const outfile = path.join(os.tmpdir(), 'anki-drift-check.cjs');

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

const D = require(outfile);

let failures = 0;
const check = (name, cond, detail) => {
	if (cond) {
		console.log('  ok   ' + name);
	} else {
		failures++;
		console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
	}
};

/** So vergleicht der Drift-Check intern. */
const same = (noteMd, ankiHtml) => D.noteToPlain(noteMd) === D.htmlToPlain(ankiHtml);

const F = '```';

console.log('\nKeine Falschmeldungen bei reiner Formatierung:');

check('Fettung vs <b>', same('Die **Dosis** ist wichtig', 'Die <b>Dosis</b> ist wichtig'));
check('Zeilenumbruch vs <br>', same('Zeile eins\nZeile zwei', 'Zeile eins<br>Zeile zwei'));
check('&nbsp; zaehlt als Leerzeichen', same('a b', 'a&nbsp;b'));
check('Mehrfach-Whitespace egal', same('a    b', 'a   b'));
check('Wikilink mit Alias vs Klartext',
	same('Der [[#^thal1|Thalamus]] ist wichtig', 'Der Thalamus ist wichtig'));
check('Wikilink ohne Alias', same('Siehe [[Metoprolol]]', 'Siehe Metoprolol'));
check('Markdown-Link vs Text', same('Siehe [Leitlinie](https://x.y)', 'Siehe Leitlinie'));
check('Bild in Notiz vs <img> in Anki',
	same('Ablauf ![[schema.png]] hier', 'Ablauf <img src="abc123.png"> hier'));
check('Liste vs <li>', same('- A\n- B', '<li>A</li><li>B</li>'));
check('Typografische Anfuehrungszeichen', same('Er sagte „Hallo“', 'Er sagte "Hallo"'));
check('Gedankenstrich vs Bindestrich', same('10 – 15 mg', '10 - 15 mg'));
check('div-Wrapper von Anki', same('Antwort', '<div>Antwort</div>'));

console.log('\nEchte Faelle aus dem Vault:');

{
	// Der Sync macht aus $x$ ein \(x\)
	const notiz = 'Komplette Abwesenheit von $O_2$';
	const anki = 'Komplette Abwesenheit von \\(O_2\\)';
	check('Inline-LaTeX ist kein Unterschied', same(notiz, anki),
		[D.noteToPlain(notiz), D.htmlToPlain(anki)]);
}

{
	const notiz = 'Formel: $$E=mc^2$$';
	const anki = 'Formel: \\[E=mc^2\\]';
	check('Display-LaTeX ist kein Unterschied', same(notiz, anki),
		[D.noteToPlain(notiz), D.htmlToPlain(anki)]);
}

check('Geaenderte Formel wird erkannt', !same('Wert $O_2$', 'Wert \\(O_3\\)'));

{
	// Mermaid wird beim Sync zu einem PNG gerendert
	const notiz = 'Ablauf:\n' + F + 'mermaid\ngraph TD;A-->B;\n' + F;
	const anki = 'Ablauf: <img src="abc.png">';
	check('Mermaid-Diagramm ist kein Unterschied', same(notiz, anki),
		[D.noteToPlain(notiz), D.htmlToPlain(anki)]);
}

{
	// Hybrid-Link wird beim Sync auf den Wikilink reduziert
	const notiz = 'Siehe [[Ertrinken]](obsidian://open?vault=NFS-Ausbildung%28Till%29&file=x)';
	const anki = 'Siehe <a href="obsidian://open?vault=x">Ertrinken</a>';
	check('Hybrid-Link ist kein Unterschied', same(notiz, anki),
		[D.noteToPlain(notiz), D.htmlToPlain(anki)]);
}

{
	// Der Fall aus dem Screenshot: nur die Anzahlangabe unterscheidet sich
	const ohne = 'Nenne die [[#^fakten|Fakten zu Ertrinkungsunfaellen]].';
	const mit = 'Nenne die [[#^fakten|Fakten zu Ertrinkungsunfaellen]]. (7)';
	const anki = 'Nenne die <a href="obsidian://open?vault=x">Fakten zu Ertrinkungsunfaellen</a>.';

	check('Wikilink allein loest nichts aus', same(ohne, anki),
		[D.noteToPlain(ohne), D.htmlToPlain(anki)]);
	check('Anzahlangabe wird erkannt', !same(mit, anki));
}

console.log('\nEchte Abweichungen werden erkannt:');

check('Geaenderte Zahl', !same('Maximaldosis 10 mg', 'Maximaldosis 15 mg'));
check('Angehaengte Anzahl', !same('Nenne die Symptome. (5)', 'Nenne die Symptome.'));
check('Anderer Text', !same('Frage A', 'Frage B'));
check('Leer vs gefuellt', !same('', 'Etwas'));
check('Zusaetzlicher Satz', !same('Satz eins. Satz zwei.', 'Satz eins.'));

console.log('\nBegruendungen:');

{
	const r = D.describeChange('Nenne die Symptome.', 'Nenne die Symptome. (5)');
	check('Anzahlangabe wird benannt', r.label === 'Anzahlangabe ergänzt', r);
}
{
	const r = D.describeChange('Maximaldosis 10 mg', 'Maximaldosis 15 mg');
	check('Zahlaenderung wird benannt', r.label === 'Zahl geändert', r);
}
{
	const r = D.describeChange('Ein Satz.', 'Ein Satz. Noch einer.');
	check('Ergaenzung wird benannt', r.label === 'Text ergänzt', r);
}
{
	const r = D.describeChange('Ein Satz. Noch einer.', 'Ein Satz.');
	check('Entfernung wird benannt', r.label === 'Text entfernt', r);
}
{
	const r = D.describeChange('Der Thalamus ist wichtig.', 'Der Hypothalamus steuert das.');
	check('Umformulierung wird benannt', r.label === 'Umformuliert', r);
}
{
	const r = D.describeChange('', 'Etwas');
	check('Leeres Anki-Feld wird benannt', r.label === 'In Anki leer', r);
}
{
	const r = D.describeChange('Das Herz', 'das herz');
	check('Nur Gross-/Kleinschreibung wird benannt', r.label === 'Nur Groß-/Kleinschreibung', r);
}

console.log('\nCloze-Text wie beim Sync:');

check('Frage mit echter Luecke bleibt unveraendert',
	D.expectedClozeText({ q: 'Das Herz ist ein {{c1::Hohlmuskel}}', a: '', type: 'Cloze', id: 1 })
		=== 'Das Herz ist ein {{c1::Hohlmuskel}}');

check('Altformat ____ wird zur Luecke',
	D.expectedClozeText({ q: 'Das Herz ist ein ____', a: 'Hohlmuskel', type: 'Cloze', id: 1 })
		=== 'Das Herz ist ein {{c1::Hohlmuskel}}');

check('Ohne Luecke wird die Antwort angehaengt',
	D.expectedClozeText({ q: 'Das Herz', a: 'Hohlmuskel', type: 'Cloze', id: 1 })
		=== 'Das Herz {{c1::Hohlmuskel}}');

check('Kein leeres {{c1::}} ohne Antwort',
	!D.expectedClozeText({ q: 'Das Herz', a: '', type: 'Cloze', id: 1 }).includes('{{c1::}}'));

console.log('');
if (failures > 0) {
	console.error(failures + ' Pruefung(en) fehlgeschlagen.');
	process.exit(1);
}
console.log('Alle Pruefungen bestanden.');
