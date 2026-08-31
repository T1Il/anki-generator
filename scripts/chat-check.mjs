/**
 * Fixture-Test für Vorschlags-Parser und Textsuche des AI-Chats.
 *   node scripts/chat-check.mjs
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

const entry = path.join(os.tmpdir(), 'anki-chat-entry.ts');
fs.writeFileSync(entry, [
	"export * from " + JSON.stringify(path.join(root, 'src/chat/suggestions.ts').replace(/\\/g, '/')) + ";",
	"export * from " + JSON.stringify(path.join(root, 'src/chat/textLocator.ts').replace(/\\/g, '/')) + ";"
].join('\n'));

const outfile = path.join(os.tmpdir(), 'anki-chat-check.cjs');

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

const C = require(outfile);

let failures = 0;
const check = (name, cond, detail) => {
	if (cond) {
		console.log('  ok   ' + name);
	} else {
		failures++;
		console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
	}
};

const F = '```';

console.log('\nVorschlags-Parser:');

{
	const md = [
		'Die Dosierung ist ungenau.',
		'',
		F + 'anki-edit',
		'FIND:',
		'Adrenalin 1mg i.v.',
		'REPLACE:',
		'Adrenalin 1 mg i.v. alle 3-5 min',
		F
	].join('\n');

	const list = C.parseSuggestions(md);
	check('anki-edit wird erkannt', list.length === 1 && list[0].kind === 'edit', list);
	check('FIND korrekt', list[0] && list[0].find === 'Adrenalin 1mg i.v.', list[0]);
	check('REPLACE korrekt', list[0] && list[0].replace === 'Adrenalin 1 mg i.v. alle 3-5 min', list[0]);
	check('Prosa bleibt ohne Block uebrig',
		C.stripSuggestionBlocks(md) === 'Die Dosierung ist ungenau.', C.stripSuggestionBlocks(md));
}

{
	const md = [F + 'anki-card', 'OP: update', 'ID: 12345', 'Q: Neue Frage', 'A: Neue Antwort', F].join('\n');
	const list = C.parseSuggestions(md);
	check('anki-card update wird erkannt', list.length === 1 && list[0].kind === 'card', list);
	check('OP/ID/Q/A korrekt',
		list[0] && list[0].op === 'update' && list[0].id === 12345
		&& list[0].q === 'Neue Frage' && list[0].a === 'Neue Antwort', list[0]);
}

{
	const md = [F + 'anki-card', 'OP: delete', 'ID: 77', F].join('\n');
	const list = C.parseSuggestions(md);
	check('anki-card delete braucht kein Q', list.length === 1 && list[0].op === 'delete', list);
}

{
	const md = [F + 'anki-card', 'OP: update', 'Q: Ohne ID', F].join('\n');
	check('update ohne ID wird verworfen', C.parseSuggestions(md).length === 0);
}

{
	const md = [F + 'anki-card', 'OP: add', 'Q: Frage', 'A (type): Getippt', F].join('\n');
	const list = C.parseSuggestions(md);
	check('Type-In wird erkannt', list[0] && list[0].typeIn === true && list[0].a === 'Getippt', list[0]);
}

{
	const md = [
		F + 'anki-edit', 'FIND:', 'Zeile eins', 'Zeile zwei', 'REPLACE:', 'Neu eins', 'Neu zwei', F
	].join('\n');
	const list = C.parseSuggestions(md);
	check('Mehrzeiliges FIND/REPLACE',
		list[0] && list[0].find === 'Zeile eins\nZeile zwei' && list[0].replace === 'Neu eins\nNeu zwei', list[0]);
}

{
	const md = [
		'Text A', '', F + 'anki-edit', 'FIND: a', 'REPLACE: b', F, '', 'Text B', '',
		F + 'anki-card', 'OP: add', 'Q: X', F
	].join('\n');
	const list = C.parseSuggestions(md);
	check('Mehrere Bloecke in einer Antwort', list.length === 2, list.map(x => x.kind));
	check('Einzeilige Kurzform funktioniert', list[0].find === 'a' && list[0].replace === 'b', list[0]);
}

console.log('\nTextsuche (die alte Fehlerquelle):');

const NOTE = [
	'# Notfallmedizin',
	'',
	'Der [[#^thal1|Thalamus]] ist wichtig fuer die Weiterleitung.',
	'Die Gabe von **Adrenalin** erfolgt 1mg i.v.',
	'Ein Satz mit „typografischen“ Anfuehrungszeichen und einem – Gedankenstrich.',
	''
].join('\n');

{
	const hit = C.locate(NOTE, 'Der Thalamus ist wichtig fuer die Weiterleitung.');
	check('Wikilink im Text wird uebersprungen', hit !== null, hit);
	check('Trefferbereich zeigt auf das Original',
		hit && NOTE.substring(hit.start, hit.end).includes('[[#^thal1|Thalamus]]'),
		hit && NOTE.substring(hit.start, hit.end));
}

{
	const hit = C.locate(NOTE, 'Die Gabe von Adrenalin erfolgt 1mg i.v.');
	check('Fettung wird ignoriert', hit !== null, hit);
	check('Ersetzen trifft die Fettung mit',
		C.applyFindReplace(NOTE, 'Die Gabe von Adrenalin erfolgt 1mg i.v.', 'ERSETZT').includes('ERSETZT'));
}

{
	const hit = C.locate(NOTE, 'Ein Satz mit "typografischen" Anfuehrungszeichen und einem - Gedankenstrich.');
	check('Typografische Zeichen werden normalisiert', hit !== null, hit);
}

{
	const hit = C.locate(NOTE, 'Der   Thalamus   ist wichtig');
	check('Abweichender Whitespace stoert nicht', hit !== null, hit);
}

{
	check('Nicht vorhandener Text liefert null', C.locate(NOTE, 'Kommt so nicht vor') === null);
	check('applyFindReplace meldet Fehlschlag',
		C.applyFindReplace(NOTE, 'Kommt so nicht vor', 'X') === null);
}

{
	const exact = C.locate(NOTE, '# Notfallmedizin');
	check('Exakter Treffer ist nicht fuzzy', exact && exact.fuzzy === false, exact);
}

console.log('');
if (failures > 0) {
	console.error(failures + ' Pruefung(en) fehlgeschlagen.');
	process.exit(1);
}
console.log('Alle Pruefungen bestanden.');
