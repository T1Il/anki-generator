/**
 * Rechtsrahmen in den Plugin-Prompts: mitgelieferte Kopie, vom Server ersetzbar.
 *   node scripts/rechtsrahmen-check.mjs
 */
import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import assert from 'assert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(os.tmpdir(), 'anki-rechtsrahmen-check.cjs');
await esbuild.build({
	entryPoints: [path.join(root, 'src/chat/suggestions.ts')], bundle: true, platform: 'node', format: 'cjs',
	outfile: out, external: ['obsidian'], logLevel: 'silent'
});
const m = createRequire(import.meta.url)(out);

for (const w of ['SAA/BPR:', '§ 2a:', 'Fachlich:', 'erlernt', 'Weiterversorgung', '„Verboten“']) {
	assert(m.SUGGESTION_FORMAT_INSTRUCTIONS.includes(w), `Kopie im Prompt fehlt: ${w}`);
}
m.rechtsrahmenSetzen('NEUER RAHMEN VOM SERVER');
assert(m.SUGGESTION_FORMAT_INSTRUCTIONS.includes('NEUER RAHMEN VOM SERVER'), 'Server-Text ersetzt die Kopie');
assert(!m.SUGGESTION_FORMAT_INSTRUCTIONS.includes('Fachlich:'), 'Kopie darf nicht doppelt bleiben');
assert(m.KARTEN_QUALITAET_MIT_RAHMEN().includes('NEUER RAHMEN VOM SERVER'), 'Kartengenerierung kennt den Rahmen');
m.rechtsrahmenSetzen('   ');
assert(m.SUGGESTION_FORMAT_INSTRUCTIONS.includes('NEUER RAHMEN VOM SERVER'), 'Leere Antwort ändert nichts');
console.log('rechtsrahmen-check: ok');
