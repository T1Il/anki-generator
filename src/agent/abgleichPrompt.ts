import { SUGGESTION_FORMAT_INSTRUCTIONS } from '../chat/suggestions';
import type { ZoteroSource } from '../zotero/zoteroClient';

export interface AbgleichAuftrag {
	noteTitle: string;
	noteContent: string;
	/** Kartenliste wie im Chat (`CARD: n` …), damit `anki-card`-Vorschlaege greifen. */
	cards: string;
	sources: ZoteroSource[];
	/** Darf der Agent ueber Zotero hinaus im Web recherchieren? */
	research: boolean;
	/** Freier Zusatzauftrag aus dem Dialog. */
	extra: string;
}

/**
 * Der Auftrag an den Claude-Agenten.
 *
 * Der Agent bekommt die Notiz im Prompt, die Quellen nur als Dateipfade: ein
 * Lehrbuch hat Hunderte Seiten, er soll darin gezielt suchen statt alles in
 * den Kontext zu ziehen. Zurueck kommen Vorschlagsbloecke im Chat-Format –
 * angewendet wird erst, wenn jemand auf „Übernehmen" klickt.
 */
export function buildAbgleichPrompt(a: AbgleichAuftrag): string {
	const quellen = a.sources.map((s, i) => formatSource(s, i + 1)).join('\n\n');

	return `Du bist ein sorgfältiger Fachlektor für Notfallmedizin und Pharmakologie.
Du prüfst eine Lernnotiz einer Notfallsanitäter-Ausbildung gegen die Quellen,
die der Lernende dafür in Zotero gesammelt hat, und schlägst Korrekturen vor.

# Arbeitsweise

1. Lies die Notiz und die Karten unten vollständig.
2. Arbeite JEDE Quelle durch. Bei einer Quelle mit Volltext-Cache (\`.zotero-ft-cache\`,
   reiner Text) suche darin mit Grep gezielt nach dem Thema der Notiz (Wirkstoffname,
   Handelsnamen, Synonyme) und lies die Fundstellen mit Read samt Umgebung. Große
   Bücher nie komplett lesen. Ohne Cache lies die Datei selbst (PDF/HTML) mit Read.
3. Vergleiche jede fachliche Aussage der Notiz und der Karten mit den Quellen:
   Dosierungen, Konzentrationen, Indikationen, Kontraindikationen, Wirkmechanismus,
   Wirkeintritt/-dauer, Nebenwirkungen, Interaktionen, Altersgrenzen.
4. Achte besonders auf
   - **Fehler**: die Notiz widerspricht einer Quelle,
   - **Widersprüche zwischen Quellen**: benenne beide Stellen; im Rettungsdienst gehen
     SAA/BPR und DBRD-Musteralgorithmen der Fachinformation vor, Leitlinien den Lehrbüchern,
   - **Lücken**: Wichtiges aus den Quellen fehlt in der Notiz,
   - **Karten**: falsch, mehrdeutig gestellt, zu groß (aufteilen) oder doppelt.
${a.research ? `5. Du DARFST zusätzlich im Web recherchieren (WebSearch/WebFetch), z. B. nach aktuellen
   Leitlinien oder der aktuellen Fachinformation. Kennzeichne solche Belege als
   „außerhalb Zotero" mit URL, damit der Lernende sie in Zotero aufnehmen kann.` :
`5. Recherchiere NICHT im Web. Belege kommen ausschließlich aus den Zotero-Quellen.`}

Du änderst KEINE Dateien. Deine Antwort ist der einzige Weg zurück.

# Antwort (Deutsch)

- **Kurzbefund**: 2–4 Sätze, wie gut die Notiz zu den Quellen passt.
- **Abweichungen**: je Punkt die Aussage der Notiz, was die Quelle sagt, und der Beleg
  als „Quelle Nr. – Titel, S. x" (Seite, wenn erkennbar).
- **Widersprüche zwischen Quellen** und **Lücken**, falls vorhanden.
- Zu jedem Punkt, den man beheben kann, ein Vorschlagsblock (Format unten).
  Vorschläge nur, wo ein Beleg vorliegt – nie aus dem Gedächtnis.
- Was in den Quellen nicht zu finden war, sag ausdrücklich (nicht raten).

${SUGGESTION_FORMAT_INSTRUCTIONS}
${a.extra.trim() ? `\n# Zusätzlicher Auftrag\n\n${a.extra.trim()}\n` : ''}
# Quellen aus Zotero (${a.sources.length})

${quellen || '(keine)'}

# Notiz „${a.noteTitle}"

<<<NOTIZ
${a.noteContent}
NOTIZ>>>

# Karten der Notiz (Nummern für \`CARD:\`)

${a.cards}
`;
}

function formatSource(s: ZoteroSource, nr: number): string {
	const kopf = [`## Quelle ${nr}: ${s.title}`];
	const meta = [s.creators, s.date, s.itemType, `Sammlung: ${s.collectionName}`].filter(Boolean).join(' · ');
	if (meta) kopf.push(meta);
	if (s.url) kopf.push(`URL: ${s.url}`);

	const dateien = s.attachments.map((at) => {
		const teile = [`- Anhang „${at.title}" (${at.contentType || 'Datei'})`];
		if (at.fullTextPath) teile.push(`  Volltext: ${at.fullTextPath}`);
		if (at.filePath) teile.push(`  Datei: ${at.filePath}`);
		if (!at.fullTextPath && !at.filePath) teile.push('  (lokal nicht vorhanden)');
		return teile.join('\n');
	});
	if (dateien.length === 0) dateien.push('- keine Anhänge – nur die Metadaten oben');

	const notizen = s.notes
		.filter(Boolean)
		.map((n) => '> ' + n.slice(0, 4000).replace(/\n/g, '\n> '));

	return [...kopf, ...dateien, ...(notizen.length ? ['Zotero-Notizen:', ...notizen] : [])].join('\n');
}

/**
 * Verzeichnisse, die der Agent lesen darf (fuer `--add-dir`): Zoteros
 * storage-Ordner als Ganzes, dazu die Ordner verknuepfter Dateien, die
 * ausserhalb liegen. Sonst stuende je Anhang ein eigenes Verzeichnis in argv.
 */
export function readableDirs(sources: ZoteroSource[], storageRoot: string): string[] {
	const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const root = norm(storageRoot);
	const dirs = new Set<string>();
	let brauchtStorage = false;
	for (const s of sources) {
		for (const at of s.attachments) {
			for (const p of [at.fullTextPath, at.filePath]) {
				if (!p) continue;
				if (root && norm(p).startsWith(root + '/')) { brauchtStorage = true; continue; }
				const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
				if (cut > 0) dirs.add(p.slice(0, cut));
			}
		}
	}
	return brauchtStorage ? [storageRoot, ...dirs] : [...dirs];
}
