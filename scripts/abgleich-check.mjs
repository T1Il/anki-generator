/**
 * Fixture-Test für den Zotero-Abgleich: Prompt, CLI-Argumente, stream-json.
 *   node scripts/abgleich-check.mjs
 *
 * Mit --live <Notizpfad> <Sammlungsname> laeuft zusaetzlich ein echter Abgleich
 * gegen die laufende Zotero-App und die Claude CLI (dauert Minuten, kostet).
 */

import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// requestUrl ueber fetch nachbilden, damit der Zotero-Client auch ausserhalb
// von Obsidian laeuft.
const stubFile = path.join(os.tmpdir(), 'anki-obsidian-stub-abgleich.cjs');
fs.writeFileSync(stubFile, `module.exports = {
  requestUrl: async ({ url, headers }) => {
    // Wie Obsidian/Electron: Browser-Kennung mitsenden. Ohne den Kopf
    // Zotero-Allowed-Request bricht Zotero solche Anfragen ab.
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Electron obsidian', ...(headers || {}) } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
};\n`);

const entry = path.join(os.tmpdir(), 'anki-abgleich-entry.ts');
const src = (f) => JSON.stringify(path.join(root, f).replace(/\\/g, '/'));
fs.writeFileSync(entry, [
	`export * from ${src('src/agent/abgleichPrompt.ts')};`,
	`export * from ${src('src/agent/claudeAgent.ts')};`,
	`export * from ${src('src/agent/quellenPrompt.ts')};`,
	`export * from ${src('src/zotero/zoteroClient.ts')};`,
	`export * from ${src('src/chat/suggestions.ts')};`,
	`export * from ${src('src/anki/ankiParser.ts')};`
].join('\n'));

const outfile = path.join(os.tmpdir(), 'anki-abgleich-check.cjs');
await esbuild.build({
	entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node',
	target: 'es2020', external: ['obsidian'], outfile, logLevel: 'silent'
});

const require = createRequire(import.meta.url);
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'obsidian') return stubFile;
	return originalResolve.call(this, request, ...rest);
};
const m = require(outfile);

let failed = 0;
const check = (name, cond, info = '') => {
	console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + info}`);
	if (!cond) failed++;
};

const storage = path.join('C:', 'Zotero', 'storage');
const sources = [{
	key: 'A', itemType: 'book', title: 'Pharmakologie', creators: 'Karow', date: '2024', url: '',
	collectionName: 'Ondansetron',
	attachments: [{ key: 'X1', title: 'Buch.pdf', contentType: 'application/pdf',
		filePath: path.join(storage, 'X1', 'Buch.pdf'), fullTextPath: path.join(storage, 'X1', '.zotero-ft-cache') }],
	notes: ['Markierung: 4 mg i.v.']
}, {
	key: 'B', itemType: 'webpage', title: 'Gelbe Liste', creators: '', date: '', url: 'https://example.org',
	collectionName: 'Ondansetron',
	attachments: [{ key: 'L1', title: 'verknüpft', contentType: 'text/html',
		filePath: path.join('D:', 'Fremd', 'seite.html'), fullTextPath: null }],
	notes: []
}];

console.log('Prompt');
const prompt = m.buildAbgleichPrompt({
	noteTitle: 'Ondansetron', noteContent: 'Dosis 8 mg', cards: 'CARD: 1\nQ: Dosis?\nA: 8 mg',
	sources, research: false, extra: 'Kinderdosis prüfen'
});
check('enthält Notiz', prompt.includes('Dosis 8 mg'));
check('enthält Volltext-Pfad', prompt.includes('.zotero-ft-cache'));
check('enthält Zotero-Notiz', prompt.includes('Markierung: 4 mg'));
check('enthält Vorschlagsformat', prompt.includes('```anki-card') && prompt.includes('```anki-edit'));
check('verbietet Web ohne Recherche', prompt.includes('Recherchiere NICHT im Web'));
check('Zusatzauftrag', prompt.includes('Kinderdosis prüfen'));
check('Kartennummern', prompt.includes('CARD: 1'));
const mitWeb = m.buildAbgleichPrompt({ noteTitle: 'x', noteContent: '', cards: '', sources, research: true, extra: '' });
check('erlaubt Web mit Recherche', mitWeb.includes('WebSearch') && !mitWeb.includes('Recherchiere NICHT'));

console.log('Lesbare Verzeichnisse');
const dirs = m.readableDirs(sources, storage);
check('storage als Ganzes', dirs[0] === storage, JSON.stringify(dirs));
check('verknüpfter Ordner extra', dirs.includes(path.join('D:', 'Fremd')), JSON.stringify(dirs));
check('kein Anhangsordner einzeln', !dirs.some((d) => d.includes('X1')), JSON.stringify(dirs));

console.log('CLI-Argumente');
const ohne = m.agentArgs({ addDirs: [storage], research: false, model: '' });
check('Druckmodus + stream-json', ohne.includes('-p') && ohne.includes('stream-json'));
check('ohne Recherche kein Web', !ohne.includes('WebSearch'));
check('keine Schreibwerkzeuge', !ohne.some((a) => /^(Edit|Write|Bash)$/.test(a)));
check('add-dir', ohne.join(' ').includes('--add-dir ' + storage));
const mit = m.agentArgs({ addDirs: [], research: true, model: 'opus' });
check('mit Recherche Web', mit.includes('WebSearch') && mit.includes('WebFetch'));
check('Modell', mit.join(' ').includes('--model opus'));

console.log('stream-json');
const ev = m.describeStreamLine({ type: 'assistant', message: { content: [
	{ type: 'tool_use', name: 'Grep', input: { pattern: 'Ondansetron', path: storage } },
	{ type: 'text', text: 'Zwischenstand' }
] } });
check('Werkzeug erkannt', ev[0]?.kind === 'tool' && ev[0].detail === 'Ondansetron', JSON.stringify(ev));
check('Text erkannt', ev[1]?.kind === 'text');
check('anderes ignoriert', m.describeStreamLine({ type: 'system' }).length === 0);

console.log('Zotero');
const all = [
	{ key: 'M', name: 'Medikamente', parentKey: null, numItems: 0, numCollections: 1 },
	{ key: 'O', name: 'Ondansetron', parentKey: 'M', numItems: 6, numCollections: 1 },
	{ key: 'K', name: 'Kinder', parentKey: 'O', numItems: 2, numCollections: 0 }
];
check('Unterordner rekursiv', m.withDescendants(['M'], all).sort().join() === 'K,M,O');
check('Sammlungspfad', m.collectionPath('K', all) === 'Medikamente › Ondansetron › Kinder');
check('HTML entfernt', m.stripHtml('<p>a&amp;b</p><p>c</p>') === 'a&b\nc');

console.log('Medikament-Quellen');
const qp = m.buildQuellenPrompt({ wirkstoff: 'Ondansetron', treffer: [sources[1]], standardwerke: [sources[0]], schonImOrdner: [] });
check('Auftrag nennt alle Pflichtquellen', ['Fachinformation', 'Gelbe Liste', 'Medikamente im Rettungsdienst', 'SAA/BPR', 'DBRD', 'Karow', 'RD-Factsheets', 'Notfallguru'].every((w) => qp.includes(w)));
check('Auftrag mit ISBN', qp.includes('978-3-13-245794-2') && qp.includes('978-3-13-245797-3'));
check('Auftrag listet Bibliothek mit key und Volltext', qp.includes('key A ') && qp.includes('.zotero-ft-cache'));
const plan = m.parseQuellenPlan('Text\n```json\n{"quellen":[{"kategorie":"Karow","art":"vorhanden","key":"K1","titel":"Karow"},{"art":"vorhanden","titel":"ohne key"},{"kategorie":"Gelbe Liste","titel":"GL","url":"https://x"}],"hinweise":["MiR-Kapitel unklar"]}\n```');
check('Plan gelesen', plan.quellen.length === 2 && plan.hinweise[0] === 'MiR-Kapitel unklar', JSON.stringify(plan));
check('vorhanden ohne key verworfen', !plan.quellen.some((q) => q.titel === 'ohne key'));
check('art fehlt -> neu', plan.quellen[1].art === 'neu');
let wirft = false; try { m.parseQuellenPlan('kein json'); } catch { wirft = true; }
check('ohne JSON klare Meldung', wirft);
const zwei = m.parseQuellenPlan('```json\n{"quellen":[]}\n```\nkorrigiert:\n```json\n{"quellen":[{"titel":"neu","url":"u"}]}\n```');
check('letzter JSON-Block zaehlt', zwei.quellen.length === 1);

if (failed) {
	console.log(`\n${failed} Prüfung(en) fehlgeschlagen.`);
	process.exit(1);
}
console.log('\nAlle Pruefungen bestanden.');

// --- Live-Probe ------------------------------------------------------------
const qi = process.argv.indexOf('--quellen');
if (qi > 0) {
	const wirkstoff = process.argv[qi + 1];
	const dataDir = m.defaultZoteroDataDir();
	const client = new m.ZoteroClient('http://localhost:23119/api', dataDir);
	const alle = await client.collections();
	const ober = alle.find((c) => !c.parentKey && c.name === 'Medikamente');
	const ordner = ober && alle.find((c) => c.parentKey === ober.key && c.name.toLowerCase() === wirkstoff.toLowerCase());
	const schonImOrdner = ordner ? await client.sources([ordner.key], alle, false) : [];
	const gesehen = new Set(schonImOrdner.map((s) => s.key));
	const sammle = (xs) => xs.filter((s) => !gesehen.has(s.key) && gesehen.add(s.key));
	const standardwerke = [];
	for (const q of m.STANDARDWERK_SUCHE) standardwerke.push(...sammle(await client.search(q, 6)));
	const treffer = sammle(await client.search(wirkstoff, 25));
	console.log(`\nQuellen-Lauf ${wirkstoff}: ${schonImOrdner.length} im Ordner, ${standardwerke.length} Standardwerke, ${treffer.length} Treffer`);
	const t0 = Date.now();
	const res = await m.runClaudeAgent({
		cliPath: m.defaultCliPath(), prompt: m.buildQuellenPrompt({ wirkstoff, schonImOrdner, standardwerke, treffer }),
		cwd: dataDir, addDirs: [path.join(dataDir, 'storage')], research: true,
		onEvent: (e) => { if (e.kind === 'tool') console.log(`  [${e.name}] ${e.detail.slice(0, 110)}`); }
	});
	fs.writeFileSync(path.join(os.tmpdir(), 'quellen-ergebnis.md'), res.text);
	const plan = m.parseQuellenPlan(res.text);
	console.log(`\nFertig nach ${Math.round((Date.now() - t0) / 1000)} s, ${res.turns} Schritte, ${res.costUsd} $`);
	for (const q of plan.quellen) console.log(`  [${q.kategorie}] ${q.art}${q.key ? ' ' + q.key : ''} · ${q.typ || ''} · ${q.titel}\n      ${q.url || ''}${q.pdf_url && q.pdf_url !== q.url ? '\n      PDF: ' + q.pdf_url : ''}`);
	for (const h of plan.hinweise) console.log(`  Hinweis: ${h}`);
}

const li = process.argv.indexOf('--live');
if (li > 0) {
	const notePath = process.argv[li + 1];
	const sammlung = process.argv[li + 2];
	const research = process.argv.includes('--web');
	const dataDir = m.defaultZoteroDataDir();
	const client = new m.ZoteroClient('http://localhost:23119/api', dataDir);
	const cols = await client.collections();
	const keys = cols.filter((c) => c.name === sammlung).map((c) => c.key);
	const srcs = await client.sources(keys, cols, true);
	console.log(`\nLive: ${srcs.length} Quellen in „${sammlung}"`);
	srcs.forEach((s) => console.log(`  - ${s.title} | Dateien: ${s.attachments.filter((a) => a.fullTextPath || a.filePath).length}/${s.attachments.length}`));

	const content = fs.readFileSync(notePath, 'utf8');
	const cards = m.getAnkiBlocks(content).flatMap((b) => m.parseCardsFromBlockSource(b.innerClean));
	const p = m.buildAbgleichPrompt({
		noteTitle: path.basename(notePath, '.md'), noteContent: content,
		cards: m.formatCardsToExistingCardsString(cards), sources: srcs, research, extra: ''
	});
	const t0 = Date.now();
	const res = await m.runClaudeAgent({
		cliPath: m.defaultCliPath(), prompt: p, cwd: dataDir,
		addDirs: m.readableDirs(srcs, path.join(dataDir, 'storage')), research,
		onEvent: (e) => { if (e.kind === 'tool') console.log(`  [${e.name}] ${e.detail.slice(0, 110)}`); }
	});
	const out = path.join(os.tmpdir(), 'abgleich-ergebnis.md');
	fs.writeFileSync(out, res.text);
	const vs = m.parseSuggestions(res.text);
	console.log(`\nFertig nach ${Math.round((Date.now() - t0) / 1000)} s, ${res.turns} Schritte, ${res.costUsd} $`);
	console.log(`Vorschläge: ${vs.filter((v) => v.kind !== 'invalid').length} anwendbar, ${vs.filter((v) => v.kind === 'invalid').length} kaputt`);
	console.log(`Antwort: ${out}`);
}
