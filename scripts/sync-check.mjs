/** Auswahl im Sync-Fenster: Deck und einzelne Karten. Aufruf: node scripts/sync-check.mjs */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = await mkdtemp(path.join(os.tmpdir(), 'sync-check-'));
const ziel = path.join(ordner, 'a.mjs');
await build({ entryPoints: [path.join(wurzel, 'src/ui/syncAuswahl.ts')], bundle: true, format: 'esm', outfile: ziel, logLevel: 'error' });
const m = await import(pathToFileURL(ziel).href);

const k = (...i) => i.map((index) => ({ index, frage: `F${index}` }));
const mit = m.neueGruppe('Medizin::EKG', k(0, 2));
const ohne = m.neueGruppe(null, k(1, 3, 5));
const leer = m.neueGruppe(null, k(4));
leer.gewaehlt.clear();
assert.equal(m.gewaehltZahl([mit, ohne, leer]), 5);

let a = m.auftraege([mit, ohne, leer], '');
assert.deepEqual(a.fertig.map((x) => [x.deck, x.indizes]), [['Medizin::EKG', [0, 2]]]);
assert.deepEqual(a.ohneDeck, [ohne], 'Ohne Deck wartet, abgewählte Notizen zählen nicht');

a = m.auftraege([mit, ohne], 'Medizin::Neu');
assert.equal(a.ohneDeck.length, 0);
assert.equal(a.fertig[1].deck, 'Medizin::Neu', 'Deck für alle füllt Lücken');
assert.equal(a.fertig[0].deck, 'Medizin::EKG', 'Vorhandenes Deck bleibt');

ohne.neuesDeck = ' Medizin::Eigen ';
ohne.gewaehlt.delete(3);
a = m.auftraege([ohne], 'Medizin::Neu');
assert.deepEqual([a.fertig[0].deck, a.fertig[0].indizes], ['Medizin::Eigen', [1, 5]], 'Eigenes Deck und Auswahl gehen vor');

const decks = { 'Medizin/EKG': { 'M::EKG': 3, 'M::Alt': 1 }, Medizin: { 'M::Allg': 1 } };
assert.equal(m.deckVorschlag('Medizin/EKG/Bradykardie.md', decks), 'M::EKG', 'Häufigstes Deck im Ordner');
assert.equal(m.deckVorschlag('Medizin/Trauma/Sub/Becken.md', decks), 'M::Allg', 'Sonst das nächste Elternverzeichnis');
assert.equal(m.deckVorschlag('Anderes/X.md', decks), '');
assert.equal(m.passt('Kardioversion', [{ frage: 'Energie?' }], 'ener'), true);
assert.equal(m.passt('Kardioversion', [{ frage: 'Energie?' }], 'KARDIO'), true);
assert.equal(m.passt('Kardioversion', [{ frage: 'Energie?' }], 'atropin'), false);
assert.equal(m.passt('Kardioversion', [], ' '), true);

await rm(ordner, { recursive: true, force: true });
console.log('sync-check: ok');
