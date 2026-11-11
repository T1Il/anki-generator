/** Markdown-Tabellen → HTML (Breitkomplextachykardien, 11.11.2026). Aufruf: node scripts/tabelle-check.mjs */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = await mkdtemp(path.join(os.tmpdir(), 'tabelle-check-'));
const ziel = path.join(ordner, 't.mjs');
await build({ entryPoints: [path.join(wurzel, 'src/markdownTabelle.ts')], bundle: true, format: 'esm', outfile: ziel, logLevel: 'error' });
const { markdownTabellenZuHtml: t } = await import(pathToFileURL(ziel).href);

const karte = [
    '| | Frequenz | QRS | ST-T |',
    '|---|---|---|---|',
    '| Kammertachykardie | ca. 100–200/min | breit, abgrenzbar | nachweisbar |',
    '| Kammerflimmern | > 200/min | nicht abgrenzbar | nicht nachweisbar |',
].join('\n');
const html = t(karte);
assert.ok(html.startsWith('<table'), 'Tabelle erkannt');
assert.ok(!html.includes('\n'), 'keine Zeilenumbrüche — sonst zerreißt <br> sie');
assert.equal((html.match(/<th[ >]/g) || []).length, 4);
assert.equal((html.match(/<tr>/g) || []).length, 3);
assert.ok(html.includes('>ca. 100–200/min</td>'));
assert.ok(!html.includes('---'));

// Text davor und danach bleibt, Ausrichtung, \| im Zelltext
const gemischt = t('Vorher\n| a | b |\n|:--|--:|\n| x \\| y | 2 |\nNachher');
assert.ok(gemischt.startsWith('Vorher\n<table'));
assert.ok(gemischt.endsWith('</table>\nNachher'));
assert.ok(gemischt.includes('text-align:left') && gemischt.includes('text-align:right'));
assert.ok(gemischt.includes('>x | y</td>'));

// Kein Trenner → keine Tabelle; eine Linie --- ist kein Trenner
assert.equal(t('a | b\n---'), 'a | b\n---');
assert.equal(t('a | b\nc | d'), 'a | b\nc | d');
assert.equal(t('nur Text'), 'nur Text');

console.log('tabelle-check: ok');
