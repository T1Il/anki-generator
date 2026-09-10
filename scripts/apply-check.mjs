/**
 * Fixture-Test für das Anwenden von Karten-Vorschlägen.
 *   node scripts/apply-check.mjs
 *
 * Schwerpunkt: Karten OHNE Anki-ID. Frisch generierte Blöcke haben keine `ID:`,
 * und genau dann will man mit der KI iterieren. Der Handle ist dort die
 * CARD-Nummer aus der Prompt-Kartenliste.
 */

import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const slash = (p) => p.split(path.sep).join('/');

// applySuggestion braucht echte Klassen: es prüft `instanceof TFile`.
const stubFile = path.join(os.tmpdir(), 'anki-obsidian-apply-stub.cjs');
fs.writeFileSync(stubFile, [
	'class TFile {}',
	'class Notice { constructor(message) { this.message = message; } }',
	'module.exports = { TFile, Notice, normalizePath: (p) => p };'
].join('\n'));

const entry = path.join(os.tmpdir(), 'anki-apply-entry.ts');
fs.writeFileSync(entry, [
	'export * from ' + JSON.stringify(slash(path.join(root, 'src/chat/applySuggestion.ts'))) + ';',
	'export * from ' + JSON.stringify(slash(path.join(root, 'src/chat/suggestions.ts'))) + ';'
].join('\n'));

const outfile = path.join(os.tmpdir(), 'anki-apply-check.cjs');

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

const A = require(outfile);
const { TFile } = require(stubFile);

let failures = 0;
const check = (name, cond, detail) => {
	if (cond) {
		console.log('  ok   ' + name);
	} else {
		failures++;
		console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
	}
};

/** Notiz mit drei Karten, keine davon synchronisiert. */
const NOTE = [
	'# Anki',
	'',
	'```anki-cards',
	'TARGET DECK: NFS-AI::Test',
	'',
	'Q: Frage eins',
	'A: Antwort eins',
	'',
	'Q: Frage zwei',
	'A: Antwort zwei',
	'',
	'Q: Frage drei',
	'A: Antwort drei',
	'```'
].join('\n');

/** Minimale App-Attrappe: nur was applyCardSuggestion anfasst. */
function makeApp(initial) {
	const state = { content: initial };
	const file = Object.create(TFile.prototype);
	const app = {
		vault: {
			getAbstractFileByPath: () => file,
			process: async (_f, fn) => { state.content = fn(state.content); }
		}
	};
	return [app, state];
}

const block = (...lines) => A.parseSuggestions(['```anki-card', ...lines, '```'].join('\n'))[0];

console.log('\nKarten ohne Anki-ID ueber CARD: ansprechen:');

{
	const [app, st] = makeApp(NOTE);
	const r = await A.applyCardSuggestion(app, 'x.md',
		block('OP: update', 'CARD: 2', 'Q: Frage zwei neu', 'A: Antwort zwei neu'));
	check('update per CARD: 2 gelingt', r.ok, r);
	check('Karte 2 wurde geaendert', st.content.includes('Q: Frage zwei neu'));
	check('Karte 1 blieb unangetastet', st.content.includes('Q: Frage eins'));
	check('Karte 3 blieb unangetastet', st.content.includes('Q: Frage drei'));
}

{
	const [app, st] = makeApp(NOTE);
	const r = await A.applyCardSuggestion(app, 'x.md', block('OP: delete', 'CARD: 1'));
	check('delete per CARD: 1 gelingt', r.ok, r);
	check('Karte 1 ist weg', !st.content.includes('Q: Frage eins'));
	check('Karte 2 und 3 sind noch da',
		st.content.includes('Q: Frage zwei') && st.content.includes('Q: Frage drei'));
}

{
	const [app, st] = makeApp(NOTE);
	const r = await A.applyCardSuggestion(app, 'x.md', block('OP: update', 'CARD: 9', 'Q: X'));
	check('CARD: 9 wird abgelehnt statt falsch angewandt', !r.ok, r);
	check('Fehlermeldung nennt die Kartenzahl', /3 Karten/.test(r.message), r.message);
	check('Datei bleibt unveraendert', st.content === NOTE);
}

{
	const [app, st] = makeApp(NOTE);
	const r = await A.applyCardSuggestion(app, 'x.md',
		block('OP: add', 'Q: Frage vier', 'A: Antwort vier'));
	check('add haengt hinten an', r.ok && st.content.includes('Q: Frage vier'), r);
	check('TARGET DECK bleibt erhalten', st.content.includes('TARGET DECK: NFS-AI::Test'));
}

console.log('\nID bleibt der bevorzugte Handle:');

{
	// Karte 2 hat eine ID. Ein widerspruechliches CARD: darf sie nicht schlagen.
	const withId = NOTE.replace('A: Antwort zwei', 'A: Antwort zwei\nID: 555');
	const [app, st] = makeApp(withId);
	const r = await A.applyCardSuggestion(app, 'x.md',
		block('OP: update', 'CARD: 1', 'ID: 555', 'Q: Ueber die ID getroffen'));
	check('ID gewinnt gegen abweichendes CARD:', r.ok, r);
	check('Karte mit ID 555 wurde geaendert', st.content.includes('Q: Ueber die ID getroffen'));
	check('Karte 1 blieb unangetastet', st.content.includes('Q: Frage eins'));
	check('ID ueberlebt das Neuschreiben', st.content.includes('ID: 555'));
}

console.log('\nMehrere Bloecke - CARD zaehlt durch:');

{
	const two = [
		'```anki-cards',
		'TARGET DECK: NFS-AI::A',
		'',
		'Q: A1',
		'A: x',
		'```',
		'',
		'```anki-cards',
		'TARGET DECK: NFS-AI::B',
		'',
		'Q: B1',
		'A: y',
		'```'
	].join('\n');
	const [app, st] = makeApp(two);
	const r = await A.applyCardSuggestion(app, 'x.md', block('OP: update', 'CARD: 2', 'Q: B1 neu', 'A: y'));
	check('CARD: 2 trifft die Karte im zweiten Block', r.ok && st.content.includes('Q: B1 neu'), r);
	check('erster Block unveraendert', st.content.includes('Q: A1'));
	check('beide TARGET DECK bleiben', st.content.includes('NFS-AI::A') && st.content.includes('NFS-AI::B'));
}

console.log(failures === 0 ? '\nAlle Pruefungen bestanden.' : '\n' + failures + ' Pruefung(en) fehlgeschlagen.');
process.exit(failures === 0 ? 0 : 1);
