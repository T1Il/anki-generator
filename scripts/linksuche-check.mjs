/** [[-Suche im Lernchat: Anfrage erkennen, Links lesen, Blocktext. node scripts/linksuche-check.mjs */
import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import assert from 'assert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(os.tmpdir(), 'anki-obsidian-stub-linksuche.cjs');
fs.writeFileSync(stub, 'module.exports={};');
const out = path.join(os.tmpdir(), 'anki-linksuche-check.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'src/ui/linkSuche.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, alias: { obsidian: stub }, logLevel: 'silent' });
const m = createRequire(import.meta.url)(out);

const t = 'Was steht in [[Norad';
assert.deepEqual(m.linkAnfrage(t, t.length), { start: 13, ziel: 'Norad', anker: null });
const t2 = 'Und [[Med/Noradrenalin#^ueb';
assert.deepEqual(m.linkAnfrage(t2, t2.length), { start: 4, ziel: 'Med/Noradrenalin', anker: '^ueb' });
assert.equal(m.linkAnfrage('[[A]] danach', 12), null);
assert.equal(m.linkAnfrage('[[A|Alias', 9), null);
assert.equal(m.linkAnfrage('kein Link', 9), null);

assert.deepEqual(m.linksIm('a [[Med/N#^x|N › Übersicht]] b [[C#Wirkung]] ![[bild.png]] [[D]]'), [
	{ ziel: 'Med/N', anker: '^x', anzeige: 'N › Übersicht' }, { ziel: 'C', anker: 'Wirkung', anzeige: null }, { ziel: 'D', anker: null, anzeige: null }]);

assert.deepEqual(m.blockText(['> [!medikament] Übersicht', '> Wirkstoff: X', '^uebersicht']), { text: 'Übersicht', art: 'medikament' });
assert.deepEqual(m.blockText(['> [!tip]- ', '> x ^a']), { text: 'tip', art: 'tip' });
assert.deepEqual(m.blockText(['- **Merke**: Dosis 1 mg ^merke']), { text: 'Merke: Dosis 1 mg', art: null });
assert.ok(m.notizRang('Noradrenalin', 'Med/Noradrenalin.md', 'noradr') > m.notizRang('Adrenalin und Noradrenalin', 'x.md', 'noradr'));
assert.ok(m.notizRang('Adrenalin und Noradrenalin', 'x.md', 'noradr') > m.notizRang('Katecholamine', 'Noradrenalin/Katecholamine.md', 'noradr'));
assert.equal(m.notizRang('Anterolateraler Infarkt', 'RDA/x.md', 'noradr'), 0);
console.log('linksuche-check: ok');
