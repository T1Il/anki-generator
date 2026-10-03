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
	"export * from " + JSON.stringify(path.join(root, 'src/chat/textLocator.ts').replace(/\\/g, '/')) + ";",
	"export * from " + JSON.stringify(path.join(root, 'src/chat/insertText.ts').replace(/\\/g, '/')) + ";",
	"export * from " + JSON.stringify(path.join(root, 'src/chat/mermaidRepair.ts').replace(/\\/g, '/')) + ";",
	"export * from " + JSON.stringify(path.join(root, 'src/chat/kartenSuche.ts').replace(/\\/g, '/')) + ";",
	"export * from " + JSON.stringify(path.join(root, 'src/chat/vergleich.ts').replace(/\\/g, '/')) + ";",
	"export * from " + JSON.stringify(path.join(root, 'src/anki/legacyStrip.ts').replace(/\\/g, '/')) + ";",
	"export * from " + JSON.stringify(path.join(root, 'src/mermaid/mermaidBloecke.ts').replace(/\\/g, '/')) + ";",
	"export * from " + JSON.stringify(path.join(root, 'src/mermaid/mermaidEinstellungen.ts').replace(/\\/g, '/')) + ";"
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
	// Frisch generierte Karten haben keine ID - CARD: ist dann der Handle.
	const md = [F + 'anki-card', 'OP: update', 'CARD: 3', 'Q: Neue Frage', F].join('\n');
	const list = C.parseSuggestions(md);
	check('update ueber CARD: ohne ID wird erkannt',
		list.length === 1 && list[0].kind === 'card' && list[0].ref === 3 && list[0].id === null, list[0]);
}

{
	const md = [F + 'anki-card', 'OP: delete', 'CARD: 2', F].join('\n');
	const list = C.parseSuggestions(md);
	check('delete ueber CARD: ohne ID wird erkannt',
		list.length === 1 && list[0].op === 'delete' && list[0].ref === 2, list[0]);
}

{
	const md = [F + 'anki-card', 'OP: update', 'KARTE: 4', 'Q: X', F].join('\n');
	check('deutsche Schreibweise KARTE: zaehlt auch',
		C.parseSuggestions(md)[0]?.ref === 4);
}

{
	// Weder CARD: noch ID: - der Block darf NICHT stillschweigend verschwinden.
	const md = [F + 'anki-card', 'OP: update', 'Q: Ohne Handle', F].join('\n');
	const list = C.parseSuggestions(md);
	check('update ohne Handle wird als invalid gemeldet',
		list.length === 1 && list[0].kind === 'invalid', list);
	check('invalid nennt einen Grund', !!(list[0] && list[0].reason), list[0]);
	check('invalid behaelt den Rohinhalt',
		!!(list[0] && list[0].raw.includes('Q: Ohne Handle')), list[0]);
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

// --- Kein Plugin-Fence darf in den Chat-Renderer ---------------------------
// Regression vom 10.09.2026: eine KI-Antwort schrieb ```anki-cards (Plural),
// wo FENCE ```anki-card erwartet. Der Block galt deshalb nicht als Vorschlag,
// blieb beim Strippen stehen und landete in MarkdownRenderer.render() - das
// rief den anki-cards-Prozessor des Plugins auf, mitten in der Chat-Blase.
// Obsidian fror schon beim Aktivieren ein, weil die Chat-Ansicht ihren
// gespeicherten Verlauf wiederherstellt.
{
	const antwort = [
		'Hier mein Feedback.',
		'',
		'```anki-edit',
		'FIND: alt',
		'REPLACE: neu',
		'```',
		'',
		'Und die Karten dazu:',
		'',
		'```anki-cards',
		'Q: Frage',
		'A: Antwort',
		'```'
	].join('\n');

	const gestrippt = C.stripSuggestionBlocks(antwort);
	check('anki-cards ueberlebt das Strippen (die Ausgangslage)',
		gestrippt.split('\n').some((l) => /^\s*```anki-cards\s*$/.test(l)), gestrippt);

	const prose = C.entschaerfePluginFences(gestrippt);
	const fences = prose.split('\n').filter((l) => /^\s*```/.test(l));

	check('nach dem Entschaerfen keine Plugin-Sprachmarke mehr',
		fences.every((l) => !/anki-(cards?|edit)/.test(l)), fences);
	check('der Block bleibt als Code-Block sichtbar',
		fences.filter((l) => /```text/.test(l)).length === 1, fences);
	check('der Fliesstext bleibt erhalten',
		prose.includes('Hier mein Feedback.') && prose.includes('Und die Karten dazu:'), prose);

	check('anki-card in der Einzahl wird auch entschaerft',
		!/anki-card/.test(C.entschaerfePluginFences('```anki-card\nx\n```')));
	check('vier Backticks werden erwischt',
		!/anki-cards/.test(C.entschaerfePluginFences('````anki-cards\nx\n````')));
	check('fremde Sprachmarken bleiben unangetastet',
		C.entschaerfePluginFences('```mermaid\nflowchart TD\n```') === '```mermaid\nflowchart TD\n```');
}

// --- Schluessel fuer uebernommene Vorschlaege -------------------------------
// Seitenleiste und Tab zeigen denselben Chat. Wird ein Vorschlag drueben
// uebernommen, muss hier dieselbe Box gefunden werden - ueber den Inhalt, nicht
// ueber die Position, denn die Nachricht kann unterschiedlich weit oben stehen.
{
	const ausText = (md) => C.parseSuggestions(md)[0];

	const a = ausText('```anki-edit\nFIND: alt\nREPLACE: neu\n```');
	const b = ausText('```anki-edit\nFIND: alt\nREPLACE: neu\n```');
	const c = ausText('```anki-edit\nFIND: alt\nREPLACE: anders\n```');

	check('gleicher Inhalt gibt gleichen Schluessel',
		C.schluesselFuer(a) === C.schluesselFuer(b), [a, b]);
	check('anderes REPLACE gibt anderen Schluessel',
		C.schluesselFuer(a) !== C.schluesselFuer(c), [a, c]);

	const karte = ausText('```anki-card\nOP: add\nQ: Frage\nA: Antwort\n```');
	check('Kartenvorschlag hat einen eigenen Schluessel',
		typeof C.schluesselFuer(karte) === 'string' && C.schluesselFuer(karte) !== C.schluesselFuer(a), karte);

	// Der Schluessel landet als data-Attribut im DOM: keine Zeilenumbrueche,
	// nichts, was HTML zerlegt.
	const mehrzeilig = ausText('```anki-edit\nFIND:\nZeile 1\nZeile 2\nREPLACE:\nneu\n```');
	const s = C.schluesselFuer(mehrzeilig);
	check('mehrzeiliger Vorschlag ergibt einen einzeiligen Schluessel',
		!s.includes('\n') && !s.includes('\r'), s);
}

console.log('\nEinfuegen, verschachtelte Fences, Diagramme:');

{
	const md = [
		'Hier ein Diagramm.',
		'````anki-insert',
		'NACH:',
		'#### Wirkmechanismus',
		'TEXT:',
		'> [!info]- 🧬 Wirkmechanismus',
		'> ```mermaid',
		'> flowchart TD',
		'>     A["Wirkstoff"] --> B["Effekt"]',
		'> ```',
		'````',
		'',
		'````anki-card',
		'OP: add',
		'Q: Zeige das Schema.',
		'A: ```mermaid',
		'flowchart TD',
		'    A["Wirkstoff"] --> B["Effekt"]',
		'```',
		'````',
		'Schluss.'
	].join('\n');
	const list = C.parseSuggestions(md);
	check('insert und Karte erkannt', list.length === 2 && list[0].kind === 'insert' && list[1].kind === 'card',
		list.map(x => x.kind));
	check('NACH korrekt', list[0].after === '#### Wirkmechanismus', list[0]);
	check('TEXT behaelt Callout-Praefix', list[0].text.startsWith('> [!info]-') && list[0].text.endsWith('> ```'), list[0].text);
	check('Karte endet nicht am inneren ```', list[1].a.includes('A["Wirkstoff"]') && list[1].a.trim().endsWith('```'), list[1].a);
	check('Prosa ohne Bloecke', C.stripSuggestionBlocks(md) === 'Hier ein Diagramm.\n\nSchluss.', C.stripSuggestionBlocks(md));

	const ausInsert = C.mermaidAusVorschlag(list[0]);
	check('Mermaid aus Callout ohne "> "', ausInsert.length === 1 && ausInsert[0].startsWith('flowchart TD') && !ausInsert[0].includes('>  '),
		ausInsert);
	const ausKarte = C.mermaidAusVorschlag(list[1]);
	check('Mermaid aus Kartenantwort', ausKarte.length === 1 && ausKarte[0].includes('--> B'), ausKarte);
	check('kein Mermaid bei normaler Karte',
		C.mermaidAusVorschlag({ kind: 'card', op: 'add', id: null, ref: null, q: 'x', a: 'y', typeIn: false }).length === 0);

	const kaputt = C.parseSuggestions(F + 'anki-insert\nTEXT:\nnur Text\n' + F);
	check('insert ohne NACH ist invalid', kaputt[0] && kaputt[0].kind === 'invalid', kaputt);
}

{
	const note = [
		'#### Wirkmechanismus',
		'',
		'>[!algorithm] Wirkmechanismus',
		'>- Antagonismus (Frage: auch Übelkeit?)',
		'>- Area postrema',
		'',
		'### Dosierung'
	].join('\n');

	const a = C.insertAfterAnchor(note, '#### Wirkmechanismus', 'NEU');
	check('nach Ueberschrift eingefuegt', a === '#### Wirkmechanismus\n\nNEU\n\n>[!algorithm] Wirkmechanismus\n>- Antagonismus (Frage: auch Übelkeit?)\n>- Area postrema\n\n### Dosierung', a);

	const b = C.insertAfterAnchor(note, '>- Antagonismus (Frage: auch Übelkeit?)', 'NEU');
	check('Anker im Callout: erst nach dem Callout', b.includes('>- Area postrema\n\nNEU\n\n### Dosierung'), b);

	const c = C.insertAfterAnchor(note, '### Dosierung', 'NEU');
	check('am Dateiende', c.endsWith('### Dosierung\n\nNEU\n'), c);

	check('fehlender Anker ergibt null', C.insertAfterAnchor(note, 'gibt es nicht', 'x') === null);

	const sec = C.newAnkiSection('TARGET DECK: X\n\nQ: a\nA: ```mermaid\nflowchart TD\n```');
	check('neuer Block mit vier Backticks bei innerem ```', sec.startsWith('## Anki\n````anki-cards') && sec.endsWith('\n````'), sec);
	check('neuer Block ohne Code mit drei', C.newAnkiSection('Q: a').includes('```anki-cards') && !C.newAnkiSection('Q: a').includes('````'));
}

{
	const instr = C.SUGGESTION_FORMAT_INSTRUCTIONS;
	check('Anweisungen nennen Fragen', instr.includes('(Frage: …)'));
	check('Anweisungen nennen Diagramme', instr.includes('flowchart TD') && instr.includes("curve': 'step'"));
	check('Anweisungen nennen anki-insert', instr.includes('anki-insert'));
	check('Beispiele im Prompt sind selbst parsebar',
		C.parseSuggestions(instr).filter(v => v.kind === 'invalid').length === 0,
		C.parseSuggestions(instr).filter(v => v.kind === 'invalid'));
}

// --- Mermaid-Reparatur (03.10.2026: subgraph Anlegen (Donning)) ---
{
	const code = [
		'flowchart TD',
		'    subgraph Anlegen (Donning)',
		'        HD1["1. Händedesinfektion"] --> K[Kittel (lang)]',
		'        K --> E{Kontamination (sichtbar)?}',
		'        D[(Datenbank)] --> F{{Sechseck}}',
		'    end',
		'    subgraph Ablegen',
		'    end',
		'    subgraph ok["Schon (richtig)"]',
		'    end'
	].join('\n');
	const r = C.repariereMermaid(code);
	check('subgraph mit Klammern bekommt ID und Anführungszeichen', r.includes('subgraph sg1["Anlegen (Donning)"]'), r);
	check('einfacher subgraph-Titel bleibt', r.includes('    subgraph Ablegen\n'), r);
	check('korrekter subgraph bleibt', r.includes('subgraph ok["Schon (richtig)"]'), r);
	check('Knoten mit Klammern wird gequotet', r.includes('K["Kittel (lang)"]'), r);
	check('Raute mit Klammern wird gequotet', r.includes('E{"Kontamination (sichtbar)?"}'), r);
	check('Sonderformen bleiben', r.includes('D[(Datenbank)]') && r.includes('F{{Sechseck}}'), r);
	check('gequoteter Knoten bleibt', r.includes('HD1["1. Händedesinfektion"]'), r);

	const callout = [
		'> [!info]- 🔄 PSA',
		'> ```mermaid',
		'> flowchart TD',
		'>     subgraph Anlegen (Donning)',
		'>         A["x"]',
		'>     end',
		'> ```',
		'danach (bleibt)'
	].join('\n');
	const rc = C.repariereMermaidImText(callout);
	check('Reparatur im Callout behält "> "', rc.includes('>     subgraph sg1["Anlegen (Donning)"]'), rc);
	check('Text außerhalb bleibt', rc.endsWith('danach (bleibt)'), rc);
}

// --- Vorschläge: Reparatur, mehrere Karten, keine ID bei add ---
{
	const antwort = [
		'````anki-insert',
		'NACH:',
		'### Ablauf',
		'TEXT:',
		'> [!info]- Bild',
		'> ```mermaid',
		'> flowchart TD',
		'>     subgraph Anlegen (Donning)',
		'>     end',
		'> ```',
		'````',
		'',
		'````anki-card',
		'OP: add',
		'ID: 1749890860503',
		'Q: Erste Frage?',
		'A: 1. eins',
		'2. zwei',
		'',
		'Q: Zweite Frage?',
		'A: zwei',
		'',
		'Q: Schema?',
		'A: ```mermaid',
		'flowchart TD',
		'    subgraph Ablegen (Doffing)',
		'    Q: kein neuer Anfang',
		'    end',
		'```',
		'````'
	].join('\n');
	const v = C.parseSuggestions(antwort);
	check('Insert-Mermaid repariert', v[0].kind === 'insert' && v[0].text.includes('subgraph sg1["Anlegen (Donning)"]'), v[0]);
	const karten = v.filter((x) => x.kind === 'card');
	check('drei Karten aus einem add-Block', karten.length === 3, karten.map((k) => k.q));
	check('add verwirft erfundene ID', karten.every((k) => k.id === null), karten.map((k) => k.id));
	check('Antwort der ersten Karte mehrzeilig', karten[0] && karten[0].a === '1. eins\n2. zwei', karten[0]);
	check('Q: im Mermaid-Code startet keine Karte', karten[2] && karten[2].a.includes('Q: kein neuer Anfang'), karten[2]);
	check('Karten-Mermaid repariert', karten[2] && karten[2].a.includes('subgraph sg1["Ablegen (Doffing)"]'), karten[2]);
}

// --- Kartensuche: alte <!--ID-->, Ähnlichkeit ---
{
	const content = 'Q: Alt?\nA: x\n<!--ID: 1749890860503-->\n';
	const bloecke = [{ cards: [
		{ type: 'Basic', q: 'Was versteht man unter [[#^a|Arbeitskleidung]]?', a: 'x', id: null },
		{ type: 'Basic', q: 'Nenne die Teile der [[#^t|hygienischen persönlichen Schutzausrüstung]].', a: 'y', id: null }
	] }];
	const upd = (id, q, ref = null) => ({ kind: 'card', op: 'update', id, ref, q, a: 'neu', typeIn: false });

	const r1 = C.findeKarte(content, bloecke, upd(1749890860503, 'Welche Gegenstände gehören zur Küche?'));
	check('alte <!--ID--> wird erkannt', !r1.ok && r1.alteKarte === true, r1);

	const r2 = C.findeKarte(content, bloecke, upd(999, 'Nenne die Teile der hygienischen persönlichen Schutzausrüstung.'));
	check('erfundene ID → Zuordnung über Frage', r2.ok && r2.treffer.ci === 1 && r2.treffer.weg === 'frage', r2);

	const r3 = C.findeKarte(content, bloecke, upd(null, '', 2));
	check('CARD: 2 trifft', r3.ok && r3.treffer.ci === 1 && r3.treffer.weg === 'card', r3);

	const r4 = C.findeKarte(content, bloecke, upd(12345, 'Ganz andere Frage'));
	check('erfundene ID ohne Treffer meldet sich', !r4.ok && !r4.alteKarte && /erfunden/.test(r4.message), r4);
}

// --- Vergleich ---
{
	const note = ['# T', '', 'a', 'b', 'c', '', '> [!info] Kopf', '> eins', '> zwei', '', 'Ende'].join('\n');
	const v = C.berechneVergleich(note, [], { kind: 'edit', find: '> zwei', replace: '> ZWEI' });
	check('Vergleich: Callout samt Kopf im Ausschnitt', v.art === 'text' && v.vorher.includes('> [!info] Kopf') && v.nachher.includes('> ZWEI'), v);
	check('Vergleich: Zeilen-Diff', v.entfernt.join() === '> zwei' && v.hinzu.join() === '> ZWEI', v);

	const k = C.berechneVergleich(note, [{ cards: [{ type: 'Basic', q: 'Alt?', a: 'alt', id: 5 }] }],
		{ kind: 'card', op: 'update', id: 5, ref: null, q: 'Neu?', a: 'neu', typeIn: false });
	check('Vergleich: Karte vorher/nachher', k.art === 'karte' && k.vorher.q === 'Alt?' && k.nachher.q === 'Neu?', k);
}

{
	const instr = C.SUGGESTION_FORMAT_INSTRUCTIONS;
	check('Anweisungen verbieten ID:', instr.includes('NIEMALS eine `ID:`'));
	check('Anweisungen nennen subgraph-Form', instr.includes('subgraph an["Anlegen (Donning)"]'));
}

// --- Legacy-Karten nicht an die KI ---
{
	const note = [
		'# PSA', '', 'Text bleibt.', '## Anki', '', 'TARGET DECK', 'NFS-Ausbildung::Hygiene', '',
		'Q: Alt?', 'A: alt', '<!--ID: 1749890860503-->', '', '',
		'## Anki', '', '```anki-cards', 'TARGET DECK: NFS-AI::Hygiene', '', 'Q: Neu?', 'A: neu', 'ID: 42', '```',
		'', '> [!example]- Archivierte Anki-Karten', '> TARGET DECK', '> Q: Archiv?', '', 'Schluss.'
	].join('\n');
	const r = C.ohneAlteKarten(note);
	check('Legacy-Karten entfernt', !r.includes('Alt?') && !r.includes('<!--ID') && !r.includes('Archiv?'), r);
	check('anki-cards-Block bleibt', r.includes('```anki-cards\nTARGET DECK: NFS-AI::Hygiene') && r.includes('Q: Neu?'), r);
	check('leere ## Anki fällt weg, die mit Block bleibt', (r.match(/## Anki/g) || []).length === 1, r);
	check('Fließtext bleibt', r.includes('Text bleibt.') && r.includes('Schluss.'), r);
}

// --- Mermaid-Bloecke und Einstellungen (Editor) ---
{
	const note = [
		'Text', '> [!info]- Bild', '> ```mermaid', "> %%{init: {'flowchart': {'curve': 'step'}}}%%",
		'> flowchart LR', '>     A["x"] --> B["y"]', '>', '>     class A drug', '> ```', '', '^id',
		'', 'Q: Karte', 'A: ```mermaid', 'graph TD', '  C --> D', '```'
	].join('\r\n');
	const b = C.findeMermaidBloecke(note);
	check('zwei Bloecke gefunden (Callout + Karte)', b.length === 2, b);
	check('Callout-Code ohne "> "', b[0].code.startsWith("%%{init") && b[0].code.includes('\n\n    class A drug'), b[0]);

	const neu = C.ersetzeMermaidCode(note, b[0], 'flowchart TD\n    A --> B\n\n    class A drug');
	check('ersetzt mit "> " und CRLF', neu.includes('> ```mermaid\r\n> flowchart TD\r\n>     A --> B\r\n>\r\n>     class A drug\r\n> ```\r\n\r\n^id'), neu);
	check('Rest bleibt', neu.endsWith('A: ```mermaid\r\ngraph TD\r\n  C --> D\r\n```'), neu);

	const e = C.leseEinstellungen(b[0].code);
	check('liest Richtung/Kurve/Abstand', e.richtung === 'LR' && e.kurve === 'step' && e.abstand === 'normal', e);
	const g = C.setzeEinstellungen(b[0].code, { richtung: 'TD', kurve: 'basis', abstand: 'weit' });
	const e2 = C.leseEinstellungen(g);
	check('setzt Richtung/Kurve/Abstand', e2.richtung === 'TD' && e2.kurve === 'basis' && e2.abstand === 'weit', g);
	check('Init-Zeile bleibt einzeilig mit einfachen Anführungszeichen', /^%%\{init: \{'flowchart': \{'curve': 'basis', 'nodeSpacing': 80, 'rankSpacing': 80\}\}\}%%$/m.test(g), g);
	check('Rest des Codes unverändert', g.includes('A["x"] --> B["y"]') && g.includes('class A drug'), g);
	const ohneInit = C.setzeEinstellungen('flowchart TD\n  A --> B', { kurve: 'step' });
	check('Init-Zeile wird vorangestellt', ohneInit.startsWith("%%{init: {'flowchart': {'curve': 'step'}}}%%\nflowchart TD"), ohneInit);
	check('Sequenzdiagramm: keine Richtung', C.leseEinstellungen('sequenceDiagram\n A->>B: x').richtung === null);
	check('senkrecht stellt LR um', C.senkrecht('graph LR\n A-->B') === 'graph TD\n A-->B');

	const gleich = C.ersetzeGleicheMermaid(note.replace(/\r\n/g, '\n') + '\n\nQ: X\nA: ```mermaid\n' + b[0].code + '\n```', b[0].code, 'flowchart TD\n  Z');
	check('gleiche Diagramme alle ersetzt', (gleich.match(/flowchart TD\n(> )?  Z/g) || []).length === 2, gleich);
}
{
	const v = C.parseSuggestions('````anki-insert\nNACH:\n# T\nTEXT:\n> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n````');
	check('Vorschlag: LR wird senkrecht', v[0].kind === 'insert' && v[0].text.includes('> flowchart TD'), v[0]);
	check('Norm erkennt reparierte Form', C.diagrammNorm('flowchart LR\n subgraph A (b)\n end') === C.diagrammNorm('flowchart TD\n subgraph sg1["A (b)"]\n end'));
}

console.log('');
if (failures > 0) {
	console.error(failures + ' Pruefung(en) fehlgeschlagen.');
	process.exit(1);
}
console.log('Alle Pruefungen bestanden.');
