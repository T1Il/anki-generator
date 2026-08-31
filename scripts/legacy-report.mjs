/**
 * Bestandsaufnahme des Altformats (Obsidian_to_Anki) im Vault.
 *
 *   node scripts/legacy-report.mjs [--out bericht.md]
 *
 * Wandelt NICHTS um. Beantwortet nur: was liegt wo, welche Karten haben eine
 * ID, existiert die noch in Anki, in welchem Deck, und wo drohen Dubletten mit
 * dem neuen anki-cards-Format.
 *
 * Anki muss laufen (AnkiConnect), sonst wird der Abgleich übersprungen.
 */

import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const vault = path.resolve(root, '../../..');

const outArg = process.argv.indexOf('--out');
const outFile = outArg !== -1 ? process.argv[outArg + 1] : null;

// --- Parser des Plugins laden ---------------------------------------------
const stubFile = path.join(os.tmpdir(), 'anki-obsidian-stub.cjs');
fs.writeFileSync(stubFile, 'module.exports = {};\n');
const entry = path.join(os.tmpdir(), 'legacy-entry.ts');
fs.writeFileSync(entry, [
	'export * from ' + JSON.stringify(path.join(root, 'src/anki/ankiParser.ts').replace(/\\/g, '/')) + ';',
	'export * from ' + JSON.stringify(path.join(root, 'src/anki/driftCheck.ts').replace(/\\/g, '/')) + ';'
].join('\n'));
const outfile = path.join(os.tmpdir(), 'legacy-bundle.cjs');

await esbuild.build({
	entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node',
	target: 'es2018', external: ['obsidian'], outfile, logLevel: 'silent'
});

const require = createRequire(import.meta.url);
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
	if (r === 'obsidian') return stubFile;
	return orig.call(this, r, ...a);
};
const P = require(outfile);

// --- AnkiConnect ----------------------------------------------------------
async function anki(action, params) {
	const res = await fetch('http://127.0.0.1:8765', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, version: 6, params })
	});
	const json = await res.json();
	if (json.error) throw new Error(json.error);
	return json.result;
}

// --- Vault einlesen -------------------------------------------------------
function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith('.')) continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, out);
		else if (e.name.endsWith('.md')) out.push(full);
	}
	return out;
}

const ID_COMMENT = /<!--\s*ID:\s*(\d+)\s*-->/;

/** Zerlegt einen Altformat-Abschnitt in Karten. */
function parseLegacy(text) {
	const cards = [];
	let deck = null;

	// In Einheiten zerlegen: Leerzeile trennt Karten.
	const units = text.split(/\n\s*\n/);

	for (const unit of units) {
		const lines = unit.split('\n').filter((l) => l.trim().length > 0);
		if (lines.length === 0) continue;

		const deckLine = lines.find((l) => /^[ \t]*TARGET DECK[ \t]*:/i.test(l));
		if (deckLine) {
			deck = deckLine.replace(/^[ \t]*TARGET DECK[ \t]*:/i, '').trim();
			if (lines.length === 1) continue;
		}

		const body = lines.filter((l) => l !== deckLine);
		if (body.length === 0) continue;

		let id = null;
		const content = [];
		for (const l of body) {
			const m = l.match(ID_COMMENT);
			if (m) { id = parseInt(m[1], 10); continue; }
			content.push(l);
		}
		if (content.length === 0) continue;

		const sepIdx = content.findIndex((l) => l.trim() === 'xxx');
		const hasBlank = content.some((l) => /(?<!\w)____(?!\w)/.test(l));

		if (sepIdx === -1 && !hasBlank) continue; // kein Kartenmuster

		const q = (sepIdx === -1 ? content : content.slice(0, sepIdx)).join('\n').trim();
		const a = (sepIdx === -1 ? [] : content.slice(sepIdx + 1)).join('\n').trim();
		if (!q) continue;

		cards.push({ deck, q, a, id, type: hasBlank && sepIdx === -1 ? 'Cloze' : 'Basic' });
	}

	return cards;
}

const files = walk(vault);
const legacyByFile = new Map();
const newFormatQuestions = new Set();
let newFormatCards = 0;

for (const f of files) {
	let content;
	try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }

	const blocks = P.getAnkiBlocks(content);

	// Fragen im NEUEN Format sammeln (fuer die Dublettenpruefung)
	for (const b of blocks) {
		for (const c of P.parseCardsFromBlockSource(b.innerClean)) {
			newFormatCards++;
			newFormatQuestions.add(P.noteToPlain(c.q).toLowerCase());
		}
	}

	if (!/TARGET DECK/i.test(content)) continue;

	// Bereiche der neuen Bloecke und aller Code-Fences ausblenden
	const chars = content.split('');
	blocks.forEach((b) => { for (let i = b.start; i < b.end; i++) chars[i] = ' '; });
	const outside = chars.join('').replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));

	const cards = parseLegacy(outside);
	if (cards.length) legacyByFile.set(path.relative(vault, f), cards);
}

const all = Array.from(legacyByFile.values()).flat();
const withId = all.filter((c) => c.id !== null);
const withoutId = all.filter((c) => c.id === null);

// --- Anki abgleichen ------------------------------------------------------
let ankiUp = true;
const idState = new Map(); // id -> { exists, deck, model }

try {
	const ids = withId.map((c) => c.id);
	for (let i = 0; i < ids.length; i += 200) {
		const slice = ids.slice(i, i + 200);
		const infos = await anki('notesInfo', { notes: slice });

		const liveCardIds = [];
		const liveIndex = [];
		infos.forEach((n, k) => {
			if (n && n.noteId) {
				liveIndex.push({ id: slice[k], model: n.modelName, card: n.cards?.[0] });
				if (n.cards?.[0]) liveCardIds.push(n.cards[0]);
			} else {
				idState.set(slice[k], { exists: false });
			}
		});

		let deckOf = new Map();
		if (liveCardIds.length) {
			const ci = await anki('cardsInfo', { cards: liveCardIds });
			ci.forEach((c) => deckOf.set(c.cardId, c.deckName));
		}
		liveIndex.forEach((e) => {
			idState.set(e.id, { exists: true, model: e.model, deck: deckOf.get(e.card) || '?' });
		});
	}
} catch (e) {
	ankiUp = false;
	console.error('AnkiConnect nicht erreichbar - Abgleich uebersprungen: ' + e.message);
}

// --- Auswertung -----------------------------------------------------------
const live = withId.filter((c) => idState.get(c.id)?.exists);
const orphan = withId.filter((c) => idState.get(c.id) && !idState.get(c.id).exists);

const deckCount = new Map();
live.forEach((c) => {
	const d = idState.get(c.id).deck;
	deckCount.set(d, (deckCount.get(d) || 0) + 1);
});
const modelCount = new Map();
live.forEach((c) => {
	const m = idState.get(c.id).model;
	modelCount.set(m, (modelCount.get(m) || 0) + 1);
});

const dupes = all.filter((c) => newFormatQuestions.has(P.noteToPlain(c.q).toLowerCase()));

// --- Bericht --------------------------------------------------------------
const L = [];
const w = (s = '') => L.push(s);

w('# Altbestand im Obsidian_to_Anki-Format');
w();
w('Reine Bestandsaufnahme, nichts wurde verändert.');
w();
w('## Überblick');
w();
w('| | |');
w('|---|---:|');
w(`| Notizen im Vault | ${files.length} |`);
w(`| Karten im neuen \`anki-cards\`-Format | ${newFormatCards} |`);
w(`| **Karten im Altformat** | **${all.length}** |`);
w(`| davon in Dateien | ${legacyByFile.size} |`);
w(`| davon mit \`<!--ID:-->\` | ${withId.length} |`);
w(`| davon ohne ID (nie synchronisiert) | ${withoutId.length} |`);
if (ankiUp) {
	w(`| ID existiert noch in Anki | ${live.length} |`);
	w(`| ID verwaist (Karte in Anki gelöscht) | ${orphan.length} |`);
}
w(`| Fragen, die es im neuen Format schon gibt | ${dupes.length} |`);
w();

if (ankiUp && deckCount.size) {
	w('## Wo die Alt-Karten in Anki liegen');
	w();
	w('| Deck | Karten |');
	w('|---|---:|');
	Array.from(deckCount.entries()).sort((a, b) => b[1] - a[1])
		.forEach(([d, n]) => w(`| \`${d}\` | ${n} |`));
	w();
	w('| Notiztyp | Karten |');
	w('|---|---:|');
	Array.from(modelCount.entries()).sort((a, b) => b[1] - a[1])
		.forEach(([m, n]) => w(`| ${m} | ${n} |`));
	w();
}

w('## Dateien');
w();
w('| Datei | Karten | mit ID | ohne ID | verwaist |');
w('|---|---:|---:|---:|---:|');
Array.from(legacyByFile.entries())
	.sort((a, b) => b[1].length - a[1].length)
	.forEach(([f, cards]) => {
		const wi = cards.filter((c) => c.id !== null).length;
		const or = cards.filter((c) => c.id !== null && idState.get(c.id) && !idState.get(c.id).exists).length;
		w(`| ${f.replace(/\\/g, '/')} | ${cards.length} | ${wi} | ${cards.length - wi} | ${or} |`);
	});
w();

if (dupes.length) {
	w('## Mögliche Dubletten');
	w();
	w('Diese Fragen stehen bereits im neuen Format. Eine Umwandlung würde sie doppelt anlegen.');
	w();
	dupes.slice(0, 40).forEach((c) => w(`- ${c.q.split('\n')[0].substring(0, 110)}`));
	if (dupes.length > 40) w(`- … und ${dupes.length - 40} weitere`);
	w();
}

if (orphan.length) {
	w('## Verwaiste IDs');
	w();
	w('Die Karte wurde in Anki gelöscht, die ID steht aber noch in der Notiz.');
	w('Bei einer Umwandlung müsste die ID entfernt werden, sonst schlägt der Sync fehl.');
	w();
	orphan.slice(0, 25).forEach((c) => w(`- \`${c.id}\` — ${c.q.split('\n')[0].substring(0, 90)}`));
	if (orphan.length > 25) w(`- … und ${orphan.length - 25} weitere`);
	w();
}

const report = L.join('\n');
if (outFile) {
	fs.writeFileSync(path.resolve(process.cwd(), outFile), report, 'utf8');
	console.log('Bericht geschrieben: ' + outFile);
} else {
	console.log(report);
}
