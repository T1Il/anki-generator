/**
 * Prüft die LaTeX-Umwandlung für Tippkarten.
 *
 *   node scripts/latex-check.mjs
 *
 * Hintergrund: Anki zeigt die Antwort einer Tippkarte wörtlich und in
 * Monospace, weil sie zeichenweise mit der Eingabe verglichen wird — MathJax
 * läuft dort nicht. `\(\leq\) 65 mmHg` blieb deshalb als Klartext stehen
 * (10.09.2026, Sepsis.md). Für Tippkarten muss LaTeX also zu Unicode werden.
 *
 * Kein Testframework im Projekt, deshalb dasselbe Muster wie parser-check.mjs.
 */

import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outfile = path.join(os.tmpdir(), 'anki-latex-check.cjs');
const stubFile = path.join(os.tmpdir(), 'anki-obsidian-stub.cjs');
fs.writeFileSync(stubFile, 'module.exports = {};\n');

await esbuild.build({
	entryPoints: [path.join(root, 'src/latexPlain.ts')],
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

const { latexZuKlartext } = require(outfile);

let failures = 0;
const check = (name, cond, detail) => {
	if (cond) {
		console.log('  ok   ' + name);
	} else {
		failures++;
		console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
	}
};

console.log('\nDer Fall, der es ausgeloest hat:');
{
	// Sepsis.md:304 — woertlich aus Tills Vault.
	const r = latexZuKlartext('$\\leq$ 65 mmHg');
	check('\\leq wird zu ≤', r.text === '≤ 65 mmHg', r.text);
	check('nichts bleibt offen', r.ungeloest.length === 0, r.ungeloest);
}

console.log('\nDie beiden anderen Faelle aus dem Vault:');
{
	const r = latexZuKlartext(
		'Bei therapierefraktaeren Anaphylaxien: 0,02 - 0,15 $\\micro g/kgKG/min$');
	check('\\micro wird zu µ', r.text.includes('µ g/kgKG/min'), r.text);
}
{
	const r = latexZuKlartext('Bei Anaphylaxie unter $\\beta$-Blockern');
	check('\\beta wird zu β', r.text === 'Bei Anaphylaxie unter β-Blockern', r.text);
}

console.log('\nWas gaengig vorkommt:');
{
	const faelle = [
		['$\\geq$ 90 %', '≥ 90 %'],
		['$\\pm$ 10', '± 10'],
		['$\\mu$g', 'µg'],
		['Reiz $\\to$ Antwort', 'Reiz → Antwort'],
		['$\\text{mmHg}$', 'mmHg'],
		['$\\alpha$- und $\\beta$-Rezeptoren', 'α- und β-Rezeptoren'],
	];
	for (const [ein, aus] of faelle) {
		const r = latexZuKlartext(ein);
		check(ein + ' -> ' + aus, r.text === aus, r.text);
	}
}

console.log('\nWas unberuehrt bleiben muss:');
{
	const r = latexZuKlartext('Kostet 5 $ und 3 $ extra');
	check('einzelne Dollarzeichen sind kein LaTeX',
		r.text === 'Kostet 5 $ und 3 $ extra', r.text);
}
{
	const r = latexZuKlartext('Ein Satz ohne Mathematik.');
	check('Text ohne LaTeX bleibt gleich',
		r.text === 'Ein Satz ohne Mathematik.', r.text);
}
{
	const r = latexZuKlartext('');
	check('leerer Text', r.text === '' && r.ungeloest.length === 0);
}

console.log('\nWas gemeldet wird, statt still zu scheitern:');
{
	// Ein Bruch laesst sich nicht in EIN Zeichen uebersetzen. Solche Antworten
	// gehoeren als normale Karte geschrieben — und genau das soll die Warnung
	// sichtbar machen, statt „1/2" hinzuschreiben und die Frage zu verdecken.
	const r = latexZuKlartext('$\\frac{1}{2}$ der Dosis');
	check('\\frac wird gemeldet', r.ungeloest.length > 0, r.ungeloest);
}
{
	const r = latexZuKlartext('$\\obskur$');
	check('unbekannter Befehl wird gemeldet',
		r.ungeloest.includes('\\obskur'), r.ungeloest);
	check('und bleibt im Text stehen', r.text.includes('\\obskur'), r.text);
}

console.log('');
if (failures) {
	console.log(failures + ' Pruefung(en) fehlgeschlagen.');
	process.exit(1);
}
console.log('Alle Pruefungen bestanden.');
