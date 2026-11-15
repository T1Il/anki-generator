/** Transparenz erkennen (Bilder für Anki auf Weiß). node scripts/transparenz-check.mjs */
import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import assert from 'assert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(os.tmpdir(), 'anki-obsidian-stub-transparenz.cjs');
fs.writeFileSync(stub, 'module.exports={loadPdfJs:async()=>null};');
const out = path.join(os.tmpdir(), 'anki-transparenz-check.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'src/anki/anhangBild.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, alias: { obsidian: stub }, logLevel: 'silent' });
const m = createRequire(import.meta.url)(out);
assert.equal(m.hatTransparenz(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])), false);
assert.equal(m.hatTransparenz(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0])), true);
assert.equal(m.hatTransparenz(new Uint8ClampedArray([9, 9, 9, 254])), false);
console.log('transparenz-check: ok');
