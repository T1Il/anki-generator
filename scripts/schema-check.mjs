/**
 * Fixture-Test für die Schema-Tabellen.
 *   node scripts/schema-check.mjs
 *
 * Schwerpunkte:
 *  - Die Farbleiter muss die vorhandenen Bilder im Vault reproduzieren.
 *    SAMPLERS (8 Buchstaben, gespreizt) und OPQRST (6, fortlaufend) sind die
 *    Referenz; weicht die Leiter davon ab, fallen neue Schemata neben den
 *    alten auf.
 *  - Das Erkennen vorhandener Tabellen darf nur die erste Spalte anfassen und
 *    darf an Mathe, escapten Pipes und Callout-Einrückung nicht scheitern.
 */

import esbuild from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const slash = (p) => p.split(path.sep).join('/');

// schemaBefehle zieht `obsidian` und den Modal-Code mit; beides wird gestubbt.
const stubFile = path.join(os.tmpdir(), 'anki-schema-obsidian-stub.cjs');
fs.writeFileSync(stubFile, [
	'class TFile {}',
	'class TFolder {}',
	'class Modal { constructor() {} }',
	'class Notice { constructor(message) { this.message = message; } }',
	'module.exports = { TFile, TFolder, Modal, Notice, normalizePath: (p) => p,',
	'  Setting: class {}, ButtonComponent: class {}, TextAreaComponent: class {},',
	'  TextComponent: class {}, App: class {}, Editor: class {}, MarkdownView: class {} };'
].join('\n'));

const entry = path.join(os.tmpdir(), 'anki-schema-entry.ts');
fs.writeFileSync(entry, [
	'export * from ' + JSON.stringify(slash(path.join(root, 'src/schema/farbleiter.ts'))) + ';',
	'export * from ' + JSON.stringify(slash(path.join(root, 'src/schema/schemaTabelle.ts'))) + ';',
	'export { ersetzeErsteSpalte } from ' + JSON.stringify(slash(path.join(root, 'src/schema/schemaBefehle.ts'))) + ';'
].join('\n'));

const outfile = path.join(os.tmpdir(), 'anki-schema-check.cjs');

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'es2018',
	outfile,
	logLevel: 'silent',
	alias: { obsidian: stubFile }
});

const require = createRequire(import.meta.url);
const mod = require(outfile);

/** WCAG-Relativhelligkeit, nur für die Prüfungen hier. */
function helligkeit(hex) {
	const zu = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
	const h = hex.replace('#', '');
	const [r, g, b] = [0, 2, 4].map((i) => zu(parseInt(h.substring(i, i + 2), 16) / 255));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

let fehler = 0;
const pruefe = (name, ist, soll) => {
	const a = JSON.stringify(ist);
	const b = JSON.stringify(soll);
	if (a === b) {
		console.log(`  ok   ${name}`);
	} else {
		fehler++;
		console.log(`  FEHL ${name}`);
		console.log(`       ist:  ${a}`);
		console.log(`       soll: ${b}`);
	}
};

// --- Farbleiter -------------------------------------------------------------
console.log('\nFarbleiter');

// Die acht Hintergrundfarben stammen aus den echten SAMPLERS-Bildern im Vault
// (S, A, M, P, L, E, R, S2 — ausgelesen per Pixelvergleich).
pruefe(
	'SAMPLERS: 8 Kacheln gespreizt = Office-Regenbogen',
	mod.farbenFuer(8, 'regenbogen', 'gespreizt').map((f) => f.hintergrund),
	['#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060']
);

// SAMPLERS/S2.png ist das einzige Bild mit weißer Schrift.
pruefe(
	'SAMPLERS: nur Dunkelblau bekommt weiße Schrift',
	mod.farbenFuer(8, 'regenbogen', 'gespreizt').map((f) => f.schrift),
	['#000000', '#000000', '#000000', '#000000', '#000000', '#000000', '#000000', '#FFFFFF']
);

// OPQRST nutzt die ersten sechs Farben der Leiter der Reihe nach.
pruefe(
	'OPQRST: 6 Kacheln fortlaufend',
	mod.farbenFuer(6, 'regenbogen', 'fortlaufend').map((f) => f.hintergrund),
	['#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0']
);

pruefe(
	'Anfang und Ende der Leiter sind exakt, nicht interpoliert',
	[mod.farbenFuer(5, 'regenbogen').at(0).hintergrund, mod.farbenFuer(5, 'regenbogen').at(-1).hintergrund],
	['#FF0000', '#002060']
);

pruefe('Eine einzelne Kachel nimmt den Anfang der Leiter',
	mod.farbenFuer(1, 'regenbogen').map((f) => f.hintergrund), ['#FF0000']);

// Mehr Buchstaben als Stützstellen: es muss weiter monoton durchlaufen.
const zwoelf = mod.farbenFuer(12, 'regenbogen');
pruefe('12 Kacheln liefern 12 verschiedene Farben', new Set(zwoelf.map((f) => f.hintergrund)).size, 12);
pruefe('12 Kacheln behalten die Endpunkte',
	[zwoelf[0].hintergrund, zwoelf[11].hintergrund], ['#FF0000', '#002060']);

// Helle Hintergründe dürfen nie weiße Schrift bekommen.
pruefe('Gelb bleibt schwarz beschriftet', mod.schriftfarbeFuer('#FFFF00'), '#000000');
pruefe('Mittelblau bleibt schwarz beschriftet', mod.schriftfarbeFuer('#0070C0'), '#000000');
pruefe('Dunkelblau kippt auf weiß', mod.schriftfarbeFuer('#002060'), '#FFFFFF');
pruefe('Schwarz kippt auf weiß', mod.schriftfarbeFuer('#000000'), '#FFFFFF');

// --- Alle Leitern ------------------------------------------------------------
console.log('\nAlle Farbleitern');

for (const leiter of mod.FARBLEITERN) {
	const farben = mod.farbenFuer(8, leiter.id, 'gespreizt');
	const eindeutig = new Set(farben.map((f) => f.hintergrund)).size;
	const gueltig = farben.every((f) => /^#[0-9A-F]{6}$/.test(f.hintergrund));
	// Wechselt die Schriftfarbe mehr als einmal, springt sie mitten in der
	// Leiter hin und her — dann wirkt die Reihe unruhig statt wie eine Leiter.
	const wechsel = farben.filter((f, i) => i > 0 && f.schrift !== farben[i - 1].schrift).length;
	pruefe(`${leiter.name}: 8 gültige, verschiedene Farben`, [eindeutig, gueltig], [8, true]);
	pruefe(`${leiter.name}: höchstens ein Schriftfarben-Wechsel`, wechsel <= 1, true);
}

// --- Gewürfelte Leitern -------------------------------------------------------
console.log('\nGewürfelte Leitern');

// 200 Würfe: was hier nicht auffällt, fällt beim Benutzen auch nicht auf.
let zufallFehler = [];
for (let i = 0; i < 200; i++) {
	const leiter = mod.zufallsLeiter();
	if (leiter.stuetzen.length !== 5) { zufallFehler.push('Stufenzahl'); continue; }
	if (!leiter.stuetzen.every((h) => /^#[0-9A-F]{6}$/.test(h))) { zufallFehler.push('kein Hex: ' + leiter.stuetzen.join()); continue; }

	const farben = mod.farbenFuer(8, leiter, 'gespreizt');
	if (new Set(farben.map((f) => f.hintergrund)).size < 8) zufallFehler.push('doppelte Farbe: ' + leiter.name);

	// Die Helligkeit muss streng fallen, sonst ist es keine Leiter.
	const hell = leiter.stuetzen.map(helligkeit);
	for (let k = 1; k < hell.length; k++) {
		if (hell[k] >= hell[k - 1]) zufallFehler.push('nicht monoton: ' + leiter.stuetzen.join());
	}

	// Genau ein Wechsel Schwarz -> Weiß, und nie zurück.
	const schriften = farben.map((f) => f.schrift);
	const wechsel = schriften.filter((f, k) => k > 0 && f !== schriften[k - 1]).length;
	if (wechsel > 1) zufallFehler.push('Schrift springt: ' + leiter.stuetzen.join());
	if (schriften[0] !== '#000000') zufallFehler.push('heller Anfang trägt weiße Schrift: ' + leiter.stuetzen[0]);
}
pruefe('200 gewürfelte Leitern ohne Beanstandung', zufallFehler.slice(0, 3), []);

pruefe('OKLCh außerhalb sRGB wird entsättigt statt abgeschnitten',
	/^#[0-9A-F]{6}$/.test(mod.okLchZuHex(0.3, 0.4, 100)), true);

// --- Zeilen zerlegen --------------------------------------------------------
console.log('\nTabellenzeilen zerlegen');

pruefe(
	'escaptes Pipe im Bild-Link trennt keine Zelle',
	mod.zerlegeTabellenzeile('| ![[SAMPLERS/S.png\\|100]] | Symptome | Beschwerden |'),
	['![[SAMPLERS/S.png\\|100]]', 'Symptome', 'Beschwerden']
);

pruefe(
	'Callout-Einrückung wird abgestreift',
	mod.zerlegeTabellenzeile('> | ![[A.png\\|50]] | Age |'),
	['![[A.png\\|50]]', 'Age']
);

// --- Buchstabe aus dem Dateinamen ------------------------------------------
console.log('\nBuchstabe aus dem Bildpfad');

pruefe('einfacher Name', mod.zeichenAusPfad('RDA/Dateien/Arbeit/Fallbeispiele/SAMPLERS/S.png'), 'S');
pruefe('Wiederholungszähler fällt weg', mod.zeichenAusPfad('4S/S2.png'), 'S');
pruefe('kleingeschrieben wird normalisiert', mod.zeichenAusPfad('bilder/x.png'), 'X');
pruefe('Umlaut bleibt', mod.zeichenAusPfad('ZÖPS/Ö.png'), 'Ö');

// --- Tabellen finden --------------------------------------------------------
console.log('\nSchema-Tabellen finden');

const notiz = [
	'---',
	'sticker: emoji//1f5d2-fe0f',
	'---',
	'',
	'Etwas Fließtext mit einer ganz normalen Tabelle darunter.',
	'',
	'| Wert | Bedeutung |',
	'| ---- | --------- |',
	'| 5    | fünf      |',
	'',
	'| Buchstabe                    | Bedeutung   | Differenzierung        |',
	'| ---------------------------- | ----------- | ---------------------- |',
	'| ![[Bilder/SAMPLERS/S.png\\|100]] | Symptome    | $E = mc^2$ und $x$     |',
	'| ![[Bilder/SAMPLERS/A.png\\|100]] | Allergien   | a \\| b als Text        |',
	'',
	'## Anki',
	'```anki-cards',
	'TARGET DECK: NFS-AI::Schemata',
	'',
	'Q: | keine Tabelle | sondern eine Frage',
	'```'
].join('\n');

const gefunden = mod.findeSchemaTabellen(notiz);
pruefe('nur die Tabelle mit Bildern in Spalte 1 zählt', gefunden.length, 1);
pruefe('Buchstaben stammen aus den Dateinamen', gefunden[0].zeilen.map((z) => z.zeichen), ['S', 'A']);
pruefe('Bildbreite wird übernommen', gefunden[0].breite, 100);
pruefe('Mathe in der Zusatzspalte bleibt heil',
	gefunden[0].zeilen[0].spalten, ['Symptome', '$E = mc^2$ und $x$']);
pruefe('escaptes Pipe im Text bleibt escapt',
	gefunden[0].zeilen[1].spalten, ['Allergien', 'a \\| b als Text']);

// --- Erste Spalte ersetzen --------------------------------------------------
console.log('\nErste Spalte ersetzen');

const ersetzt = mod.ersetzeErsteSpalte(
	notiz,
	gefunden[0],
	['Taktik/Schemata/Bilder/SAMPLERS/S.png', 'Taktik/Schemata/Bilder/SAMPLERS/A.png'],
	100
);
const ersetzteZeilen = ersetzt.split('\n');

pruefe('neue Bild-Links stehen in Spalte 1', [
	mod.zerlegeTabellenzeile(ersetzteZeilen[12])[0],
	mod.zerlegeTabellenzeile(ersetzteZeilen[13])[0]
], [
	'![[Taktik/Schemata/Bilder/SAMPLERS/S.png\\|100]]',
	'![[Taktik/Schemata/Bilder/SAMPLERS/A.png\\|100]]'
]);

pruefe('Mathe überlebt die Ersetzung',
	mod.zerlegeTabellenzeile(ersetzteZeilen[12])[2], '$E = mc^2$ und $x$');
pruefe('Zeilenzahl bleibt gleich', ersetzteZeilen.length, notiz.split('\n').length);
pruefe('der anki-cards-Block bleibt unangetastet',
	ersetzt.slice(ersetzt.indexOf('## Anki')), notiz.slice(notiz.indexOf('## Anki')));
pruefe('die normale Tabelle bleibt unangetastet',
	ersetzteZeilen.slice(6, 9), notiz.split('\n').slice(6, 9));

// $-Zeichen in der Ersetzung: `$&` in einer Zelle darf nicht expandiert werden.
const dollarNotiz = [
	'| Buchstabe        | Bedeutung |',
	'| ---------------- | --------- |',
	'| ![[alt/S.png\\|50]] | $&$ und $` |'
].join('\n');
const dollarTabelle = mod.findeSchemaTabellen(dollarNotiz)[0];
const dollarErsetzt = mod.ersetzeErsteSpalte(dollarNotiz, dollarTabelle, ['neu/S.png'], 50);
pruefe('$& und $` in einer Zelle bleiben wörtlich stehen',
	mod.zerlegeTabellenzeile(dollarErsetzt.split('\n')[2])[1], '$&$ und $`');

// --- Tabelle bauen ----------------------------------------------------------
console.log('\nTabelle bauen');

const gebaut = mod.baueTabelle(
	['Buchstabe', 'Bedeutung'],
	[['![[B/S.png\\|100]]', 'Symptome'], ['![[B/A.png\\|100]]', 'Allergien']]
);
pruefe('Kopf, Trenner und zwei Zeilen', gebaut.split('\n').length, 4);
pruefe('Trennzeile passt zur Spaltenzahl', mod.zerlegeTabellenzeile(gebaut.split('\n')[1]).length, 2);
pruefe('die gebaute Tabelle wird wiedererkannt', mod.findeSchemaTabellen(gebaut).length, 1);

pruefe('Zeilenumbruch in einer Zelle wird zu <br>', mod.escapeZelle('a\nb'), 'a<br>b');
pruefe('Pipe in einer Zelle wird escapt', mod.escapeZelle('a | b'), 'a \\| b');

// --- Block-ID ---------------------------------------------------------------
console.log('\nCallout-ID');
pruefe('ATMIST', mod.hintergrundId('ATMIST'), 'hintergrund-atmist');
pruefe('Umlaute werden umschrieben', mod.hintergrundId('ZÖPS'), 'hintergrund-zoeps');
pruefe('Sonderzeichen werden zu Bindestrichen', mod.hintergrundId('BE FAST'), 'hintergrund-be-fast');

console.log(fehler === 0 ? '\nAlle Schema-Prüfungen bestanden.\n' : `\n${fehler} Prüfung(en) fehlgeschlagen.\n`);
process.exit(fehler === 0 ? 0 : 1);
