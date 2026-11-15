/**
 * Kartenregeln des Plugins („Generieren“) für den Karten-Durchgang des Fitness-Managers exportieren, damit beide
 * dieselben Regeln haben. node scripts/kartenregeln-export.mjs <Zieldatei>
 * Standard-Ziel: /opt/fitness-manager/tools/lerndurchgang/KARTENREGELN.md
 */
import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(os.tmpdir(), 'anki-obsidian-stub-regeln.cjs');
fs.writeFileSync(stub, `module.exports=new Proxy({}, {get:(t,k)=>k==='__esModule'?false:class{}});`);
const eintrag = path.join(os.tmpdir(), 'anki-regeln-eintrag.ts');
fs.writeFileSync(eintrag, `export { DEFAULT_SETTINGS } from ${JSON.stringify(path.join(root, 'src/settings.ts'))};\nexport { KARTEN_QUALITAET, DIAGRAMM_REGELN } from ${JSON.stringify(path.join(root, 'src/chat/suggestions.ts'))};`);
const out = path.join(os.tmpdir(), 'anki-regeln.cjs');
await esbuild.build({ entryPoints: [eintrag], bundle: true, platform: 'node', format: 'cjs', outfile: out, alias: { obsidian: stub },
	external: ['electron', '@codemirror/*', '@lezer/*'], logLevel: 'silent' });
globalThis.window = { localStorage: { getItem: () => 'de' } };
globalThis.localStorage = globalThis.window.localStorage;
const m = createRequire(import.meta.url)(out);

const prompt = m.DEFAULT_SETTINGS.prompt;
const von = prompt.indexOf('Deine Aufgabe ist es');
const bis = prompt.indexOf('Hier ist der Lerninhalt');
if (von < 0 || bis < 0) throw new Error('Prompt-Marken nicht gefunden');
const regeln = prompt.slice(von, bis).trim()
	.replace(/verlinke auf die aktuelle Notiz selbst: `\[Schlagwort\]\(\{\{noteURI\}\}\)`/, 'verlinke auf die aktuelle Notiz selbst: `[[Notizname|Schlagwort]]`');
const rest = regeln.match(/\{\{(noteURI|noteContent|existingCards)\}\}/);
if (rest) throw new Error('Platzhalter übrig: ' + rest[0]);

const ziel = process.argv[2] || '/opt/fitness-manager/tools/lerndurchgang/KARTENREGELN.md';
fs.writeFileSync(ziel, `<!-- Automatisch aus dem Obsidian-Plugin (anki-generator: npm run kartenregeln). Nicht von Hand ändern. -->

## Kartenregeln wie „Generieren“ im Plugin

Diese Regeln gelten für jede Karte dieses Laufs. \`Q:\` ist bei dir das Feld \`vorne\`, \`A:\` das Feld \`hinten\`.
Eintipp-Karten (\`A (type):\`) gibt es im Durchgang nicht: nimm dafür eine Basic-Karte oder eine Lücke.

${regeln}

${m.KARTEN_QUALITAET.replace(/\n\nStreiche Karten[\s\S]*$/, '')}
`);
console.log('Kartenregeln geschrieben:', ziel);
