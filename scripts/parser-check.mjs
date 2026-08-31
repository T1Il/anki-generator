/**
 * Fixture-Test für den anki-cards-Parser.
 *
 * Es gibt kein Testframework im Projekt, deshalb ein eigenständiges Skript:
 *   node scripts/parser-check.mjs
 *
 * Es bündelt src/anki/ankiParser.ts mit esbuild (obsidian wird gestubbt, die
 * Imports von dort sind reine Typen) und fährt echte Fixtures dagegen.
 */

import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const outfile = path.join(os.tmpdir(), 'anki-parser-check.cjs');
const stubFile = path.join(os.tmpdir(), 'anki-obsidian-stub.cjs');
fs.writeFileSync(stubFile, 'module.exports = {};\n');

await esbuild.build({
	entryPoints: [path.join(root, 'src/anki/ankiParser.ts')],
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

const P = require(outfile);

let failures = 0;
const check = (name, cond, detail) => {
	if (cond) {
		console.log('  ok   ' + name);
	} else {
		failures++;
		console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
	}
};

const CR = '\r';

console.log('\nBlockerkennung:');

{
	const src = '> ```anki-cards\n> TARGET DECK: A\n>\n> Q: Frage\n> A: Antwort\n> ID: 1\n> ```';
	const blocks = P.getAnkiBlocks(src);
	check('Block im Callout wird gefunden', blocks.length === 1, blocks.length);
	const cards = blocks.length ? P.parseCardsFromBlockSource(blocks[0].innerClean) : [];
	check('Callout-Block liefert 1 Karte', cards.length === 1, cards);
	check('Callout-Karte hat die ID', cards[0] && cards[0].id === 1, cards[0]);
}

{
	const src = '```anki-cards' + CR + '\nQ: Frage' + CR + '\nA: Antwort' + CR + '\nID: 2' + CR + '\n```';
	const blocks = P.getAnkiBlocks(src);
	check('CRLF-Block wird gefunden', blocks.length === 1, blocks.length);
	const cards = blocks.length ? P.parseCardsFromBlockSource(blocks[0].innerClean) : [];
	check('CRLF-Karte korrekt geparst', cards.length === 1 && cards[0].a === 'Antwort', cards);
}

{
	const src = '````anki-cards\nQ: Beispiel\nA: Siehe\n```js\nlet a = 1;\n```\nID: 3\n````';
	const blocks = P.getAnkiBlocks(src);
	check('4-Backtick-Block umschliesst inneren Fence', blocks.length === 1, blocks.length);
	const cards = blocks.length ? P.parseCardsFromBlockSource(blocks[0].innerClean) : [];
	check('Code-Fence bleibt in der Antwort', cards.length === 1 && cards[0].a.includes('let a = 1;'), cards);
	check('ID nach Code-Fence erkannt', cards[0] && cards[0].id === 3, cards[0]);
}

{
	const src = 'Text davor\n\n```anki-cards\nQ: A\nID: 8\n```\n\nText\n\n```anki-cards\nQ: B\nID: 9\n```';
	const blocks = P.getAnkiBlocks(src);
	check('Zwei Bloecke werden getrennt', blocks.length === 2, blocks.length);
	check('Leerzeile ueber dem Block bleibt erhalten',
		src.substring(0, blocks[0].start).endsWith('\n\n'),
		JSON.stringify(src.substring(0, blocks[0].start).slice(-4)));
}

console.log('\nKartenparser:');

{
	const cards = P.parseCardsFromBlockSource('Q: Erste Frage\nA: Prosa-Antwort\n\nQ: 2. Grad Verbrennung beschreiben\nA: Text\nID: 4');
	check('Nummerierte Frage wird NICHT verschluckt', cards.length === 2, cards.map(c => c.q));
}

{
	const cards = P.parseCardsFromBlockSource('Q: Nenne die Medikamente\nA: - Adrenalin\nQ: - Amiodaron\nQ: - Atropin');
	check('Echte Listenfragmente werden zusammengefuehrt', cards.length === 1, cards.map(c => c.q));
	check('Listenfragmente landen in der Antwort',
		cards[0] && cards[0].a.split('\n').length === 3, cards[0] && cards[0].a);
}

{
	const cards = P.parseCardsFromBlockSource('Q: Frage\nA: Antwort\n  ID: 7');
	check('Eingerueckte ID wird erkannt', cards[0] && cards[0].id === 7, cards[0]);
	check('Eingerueckte ID landet nicht im Antworttext',
		cards[0] && !cards[0].a.includes('ID:'), cards[0] && cards[0].a);
}

{
	const cards = P.parseCardsFromBlockSource('Q: Formel\nA: Ein Wert ____ und mehr Text\nID: 5');
	check('____ in der Antwort erzeugt keine Geisterkarte', cards.length === 1, cards.map(c => c.q));
	check('Text nach ____ bleibt erhalten',
		cards[0] && cards[0].a.includes('und mehr Text'), cards[0] && cards[0].a);
}

{
	const cards = P.parseCardsFromBlockSource('Q: Ein ____ Platzhalter\nA: Antwort\nID: 10');
	check('____ allein macht keine Cloze-Karte', cards[0] && cards[0].type === 'Basic', cards[0]);
}

{
	const cards = P.parseCardsFromBlockSource('Q: {{c1::Thalamus}} ist wichtig\nID: 11');
	check('Echte Cloze wird erkannt', cards[0] && cards[0].type === 'Cloze', cards[0]);
}

console.log('\nCloze-Bereinigung:');
check('LaTeX-Cloze klammersicher',
	P.stripClozeSyntax('{{c1::\\frac{a}{b}}} ist ein Bruch') === '\\frac{a}{b} ist ein Bruch',
	P.stripClozeSyntax('{{c1::\\frac{a}{b}}} ist ein Bruch'));
check('Cloze mit Hinweis',
	P.stripClozeSyntax('{{c1::Herz::Organ}}') === 'Herz',
	P.stripClozeSyntax('{{c1::Herz::Organ}}'));

console.log('\nSchreiben:');

{
	const src = 'vor\n\n```anki-cards\nQ: Formel\nA: $$E=mc^2$$\nID: 5\n```\n\nnach';
	const block = P.getAnkiBlocks(src)[0];
	const rebuilt = P.buildFullBlock(block, block.innerClean);
	const out = P.spliceBlock(src, block, rebuilt);
	check('Display-Math ueberlebt den Schreibpfad', out.includes('$$E=mc^2$$'), out);
	check('Round-Trip aendert die Datei nicht', out === src, out);
}

{
	const src = '> ```anki-cards\n> Q: Frage\n> ID: 1\n> ```';
	const block = P.getAnkiBlocks(src)[0];
	const out = P.spliceBlock(src, block, P.buildFullBlock(block, block.innerClean));
	check('Callout-Prefix bleibt beim Schreiben erhalten', out === src, out);
}

{
	const src = '```anki-cards\nQ: A\nID: 8\n```\n\n```anki-cards\nQ: B\nID: 9\n```';
	const blocks = P.getAnkiBlocks(src);
	const out = P.spliceBlock(src, blocks[1], P.buildFullBlock(blocks[1], 'Q: C\nID: 9'));
	check('Nur der Zielblock wird ersetzt',
		out.includes('Q: A') && out.includes('Q: C') && !out.includes('Q: B'), out);
}

{
	const res = P.findSpecificAnkiBlock('```anki-cards\nQ: A\n```', 'Q: NICHT VORHANDEN');
	check('Kein stiller Fallback auf den letzten Block', res.matchIndex === -1, res);
}

console.log('\nBlockkopf (Ueberarbeiten-Pfad):');

{
	const inner = [
		'TARGET DECK: A::B',
		'INSTRUCTION: erste',
		'INSTRUCTION: zweite',
		'# INSTRUCTION: deaktivierte',
		'STATUS: OVERLOADED',
		'',
		'Q: Frage',
		'ID: 1'
	].join('\n');

	const h = P.parseBlockHeader(inner);
	check('Deck erkannt', h.deckName === 'A::B', h.deckName);
	check('Erste Instruction erkannt', h.instruction === 'erste', h.instruction);
	check('Status erkannt', h.status === 'OVERLOADED', h.status);
	check('Weitere + deaktivierte Instructions bleiben erhalten',
		h.extraHeaderLines.length === 2, h.extraHeaderLines);

	const rebuilt = P.formatCardsToString(
		'TARGET DECK: ' + h.deckName,
		P.parseCardsFromBlockSource(inner),
		h.instruction, h.status, h.extraHeaderLines);
	check('Zweite Instruction ueberlebt das Neuschreiben',
		rebuilt.includes('INSTRUCTION: zweite'), rebuilt);
	check('Deaktivierte Instruction ueberlebt das Neuschreiben',
		rebuilt.includes('# INSTRUCTION: deaktivierte'), rebuilt);
}

{
	// So schreibt der Ueberarbeiten-Pfad zurueck: Callout muss Callout bleiben.
	const src = '> ```anki-cards\n> TARGET DECK: A\n>\n> Q: Alt\n> ID: 5\n> ```';
	const block = P.getAnkiBlocks(src)[0];
	const revised = P.buildFullBlock(block, 'TARGET DECK: A\n\nQ: Neu\nID: 5');
	const out = P.spliceBlock(src, block, revised);
	check('Ueberarbeiteter Callout-Block behaelt "> "',
		out.split('\n').every(l => l.startsWith('> ')), out);
	check('Ueberarbeitung hat den Inhalt ersetzt',
		out.includes('Q: Neu') && !out.includes('Q: Alt'), out);
}

console.log('');
if (failures > 0) {
	console.error(failures + ' Pruefung(en) fehlgeschlagen.');
	process.exit(1);
}
console.log('Alle Pruefungen bestanden.');
