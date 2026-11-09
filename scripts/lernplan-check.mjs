/** Lernplan-Anbindung: NDJSON, Rückmeldung, Anfragen. node scripts/lernplan-check.mjs */
import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import assert from 'assert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(os.tmpdir(), 'anki-obsidian-stub-lernplan.cjs');
fs.writeFileSync(stub, `module.exports={_setze:(a)=>{global.__antwort=a},_letzte:()=>global.__letzte,requestUrl:async(o)=>{global.__letzte=o;return global.__antwort;}};`);
const out = path.join(os.tmpdir(), 'anki-lernplan-check.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'src/lernplan/lernplanApi.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, alias: { obsidian: stub }, logLevel: 'silent' });
const req = createRequire(import.meta.url);
const m = req(out), ob = req(stub);

assert.deepEqual(m.chatEreignisse('{"type":"text","text":"a"}\nkaputt\n\n{"type":"done"}\n').map((e) => e.type), ['text', 'done']);
const k = m.rueckmeldungAus({ kind: 'card', q: 'F?', a: 'A' }, 'verworfen', 'zu_lang', 'kürzer');
assert.equal(k.typ, 'karte'); assert.equal(k.vorne, 'F?'); assert.equal(k.grund_text, 'kürzer');

assert.equal(m.rueckmeldungAus({ kind: 'edit', replace: 'x' }, 'verworfen').typ, 'widerspruch');
assert.equal(m.rueckmeldungAus({ kind: 'quelle' }, 'verworfen'), null);
const gl = m.aufgabenGliedern([
	{ kw: 46, jahr: 2026, index: 2, text: 'Karten', passt: false },
	{ kw: 46, jahr: 2026, index: 0, text: 'x', kurz: 'Sinus', gruppe: 'Kap. 3.1.7', passt: true },
	{ kw: 46, jahr: 2026, index: 1, text: 'y', kurz: 'AV-Block', gruppe: 'Kap. 3.1.7', passt: true, verknuepft: true },
	{ kw: 47, jahr: 2026, index: 0, text: 'EKG', woche: 'EKG' }], '');
assert.deepEqual(gl.passend.map((a) => a.kurz), ['Sinus']);
assert.deepEqual(gl.wochen.map((w) => w.kw), [46, 47]);
assert.equal(gl.wochen[0].gruppen[0].aufgaben.length, 1);
assert.deepEqual(m.aufgabenGliedern(gl.wochen[0].gruppen[0].aufgaben, 'av').wochen[0].gruppen[0].aufgaben.map((a) => a.kurz), ['AV-Block']);
const api = new m.LernplanApi(() => 'https://x/');
ob._setze({ status: 200, json: {} });
await api.verknuepfen({ kw: 46, jahr: 2026, index: 3, text: 'T' }, 'A.md');
assert.equal(ob._letzte().url, 'https://x/api/lernplan/aufgabe/notiz');
assert.deepEqual(JSON.parse(ob._letzte().body), { kw: 46, jahr: 2026, index: 3, pfad: 'A.md', text: 'T' });
ob._setze({ status: 409, json: {} });
await assert.rejects(api.verknuepfen({ kw: 46, jahr: 2026, index: 3, text: 'T' }, 'A.md'), /neu laden/);
ob._setze({ status: 503, json: { detail: 'Weg' } });
await assert.rejects(api.plan(), /Weg/);
await assert.rejects(new m.LernplanApi(() => '').plan(), /Adresse/);
console.log('lernplan-check: ok');
