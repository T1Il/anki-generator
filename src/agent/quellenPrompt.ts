import type { ZoteroSource } from '../zotero/zoteroClient';

/** Eine Quelle, wie der Agent sie vorschlaegt und das Backend sie annimmt. */
export interface QuellenVorschlag {
	kategorie: string;
	art: 'neu' | 'vorhanden';
	key?: string;
	titel: string;
	typ?: string;
	url?: string;
	pdf_url?: string;
	seitenkopie?: boolean;
	herausgeber?: string;
	autoren?: string[];
	jahr?: string;
	doi?: string;
	buch?: string;
	verlag?: string;
	isbn?: string;
	auflage?: string;
	ort?: string;
	seiten?: string;
	grund?: string;
}

export interface QuellenPlan {
	quellen: QuellenVorschlag[];
	hinweise: string[];
}

export interface QuellenAuftrag {
	wirkstoff: string;
	/** Treffer der Bibliothekssuche nach dem Wirkstoff (Kapitel, Gelbe Liste …). */
	treffer: ZoteroSource[];
	/** Standardwerke: Karow, Medikamentenbuch, DBRD, SAA/BPR, „Medikamente im RD". */
	standardwerke: ZoteroSource[];
	/** Was schon in Medikamente/<Wirkstoff> liegt. */
	schonImOrdner: ZoteroSource[];
	/** Kapitel aus „Medikamente im Rettungsdienst", die schon in Zotero liegen (Nummer aus der URL). */
	thiemeKapitel?: ThiemeKapitel[];
	/** Auszug aus der Notiz (Übersicht: Handelsname, Darreichung) – welches Präparat gemeint ist. */
	notizAuszug?: string;
	/** Freie Tipps des Lernenden für diese Suche. */
	tipps?: string;
}

export interface ThiemeKapitel { nr: number; titel: string }

/** Suchbegriffe fuer die Standardwerke in der lokalen Bibliothek. */
export const STANDARDWERK_SUCHE = [
	'Allgemeine und spezielle Pharmakologie',
	'Medikamentenbuch zu den Musteralgorithmen',
	'DBRD Musteralgorithmen',
	'Standardarbeitsanweisungen und Behandlungspfade',
	'Medikamente im Rettungsdienst',
	'European Resuscitation Council',
	'Reanimation'
];

/**
 * Wirkstoffe, die in den Algorithmen gegeneinander austauschbar gefuehrt
 * werden. Kommt nur das Gegenstueck vor, gehoert die Quelle trotzdem dazu –
 * Methylprednisolon steht in SAA/BPR und DBRD als „Prednisolon(-Äquivalent)"
 * (Agentenlauf 13.10.2026 liess beide deshalb weg).
 */
const AEQUIVALENTE: string[][] = [
	['Methylprednisolon', 'Prednisolon', 'Prednison'],
	['Esketamin', 'Ketamin'],
	['Adrenalin', 'Epinephrin'],
	['Noradrenalin', 'Norepinephrin'],
	['Glyceroltrinitrat', 'Nitroglycerin', 'Nitrospray'],
	['Glukose', 'Glucose', 'Dextrose'],
	['Akrinor', 'Cafedrin', 'Theodrenalin'],
	['Acetylsalicylsäure', 'ASS', 'Aspirin'],
	['Dimetinden', 'Dimetindenmaleat', 'Fenistil'],
	['Clemastin', 'Tavegil'],
	['Butylscopolamin', 'Buscopan']
];

export function aequivalenteVon(wirkstoff: string): string[] {
	// Genauer Name zuerst: „Methylprednisolon" enthaelt „Prednisolon" – ueber
	// includes() allein fiele das Aequivalent weg.
	const w = wirkstoff.trim().toLowerCase();
	const gruppe = AEQUIVALENTE.find((g) => g.some((x) => x.toLowerCase() === w))
		?? AEQUIVALENTE.find((g) => g.some((x) => w.includes(x.toLowerCase())));
	return gruppe ? gruppe.filter((x) => x.toLowerCase() !== w) : [];
}

/** Kapitelnummer aus einer thieme-connect-URL (…/f-0002-00NN-b000001024). */
export function thiemeKapitelNr(url: string | undefined): number | null {
	const m = (url || '').match(/f-0002-0*(\d+)-b000001024/);
	return m ? parseInt(m[1], 10) : null;
}

export function buildQuellenPrompt(a: QuellenAuftrag): string {
	const liste = (xs: ZoteroSource[]) => xs.length
		? xs.map(formatItem).join('\n')
		: '(keine)';
	const aeq = aequivalenteVon(a.wirkstoff);
	const kapitel = (a.thiemeKapitel || []).slice().sort((x, y) => x.nr - y.nr);

	return `Du stellst für eine Notfallsanitäter-Ausbildung die Quellen zum Wirkstoff
„${a.wirkstoff}" zusammen. Sie kommen in Zotero in den Ordner Medikamente/${a.wirkstoff}.
Du legst NICHTS selbst an – du lieferst eine Liste, die der Lernende prüft.
${a.tipps?.trim() ? `
# Tipps des Lernenden (haben Vorrang vor allem Folgenden)

${a.tipps.trim()}
` : ''}${a.notizAuszug?.trim() ? `
# Aus seiner Notiz zu ${a.wirkstoff}

${a.notizAuszug.trim()}
` : ''}
# Gewünschte Quellen

1. **Fachinformation** der Darreichungsform, die im Rettungsdienst verwendet wird
   (meist Injektionslösung/Ampulle; bei Spray, Tablette, Zäpfchen die passende Form).
   Nennt die Notiz oben ein Präparat (Handelsname, Stärke), nimm DESSEN Fachinformation.
   Sonst die im deutschen Rettungsdienst gängigste Injektionslösung – die Alternativen
   nennst du in den Hinweisen, statt zurückzufragen.
   Suche ein öffentlich ladbares PDF (Hersteller, EMA, Fachinformationsdienst ohne
   Login). \`typ: "document"\`, \`herausgeber\` = Hersteller, \`pdf_url\` = direkter PDF-Link.
2. **Gelbe Liste**, Wirkstoffseite (https://www.gelbe-liste.de/wirkstoffe/…). \`typ: "webpage"\`.
   Läuft WebFetch dort in eine Weiterleitungsschleife, die Websuche zeigt die Seite aber,
   nimm die URL trotzdem – der Server lädt sie mit Browserkennung.
3. **„Medikamente im Rettungsdienst"** (Wanka/Weiß, Thieme, 3. Aufl. 2025,
   ISBN 978-3-13-245794-2 / 978-3-13-245797-3), das KAPITEL zu diesem Wirkstoff.
   - Liegt es schon als Buchabschnitt in der Bibliothek (siehe Treffer), nimm es als \`vorhanden\`.
   - Sonst neu als \`typ: "bookSection"\`: \`titel\` = Kapitelname wie im Buch,
     \`buch: "Medikamente im Rettungsdienst"\`, \`verlag: "Georg Thieme Verlag KG"\`,
     \`ort: "Stuttgart"\`, \`isbn: "978-3-13-245794-2"\`,
     \`auflage: "3., aktualisierte und erweiterte Auflage"\`, \`jahr: "2025"\`,
     \`autoren: ["Wanka, Volker", "Weiß, Stefan"]\`,
     \`seitenkopie: false\`. Die Kapitel haben die URL
     \`http://www.thieme-connect.de/products/ebooks/lookinside/10.1055/f-0002-00NN-b000001024\`
     (NN = Kapitelnummer, zweistellig). Das Inhaltsverzeichnis sperrt Thieme für Skripte
     mit einer Bot-Abfrage – versuche es gar nicht erst. Die Kapitel sind ALPHABETISCH
     nach Wirkstoff nummeriert; diese Nummern sind sicher (aus der Bibliothek):
${kapitel.length ? kapitel.map((k) => `     - ${String(k.nr).padStart(2, '0')}: ${k.titel}`).join('\n') : '     (keine bekannt)'}
     Ist NN damit eindeutig, setze \`url\` und \`pdf_url\`. Sonst lass beide leer und nenne
     in den Hinweisen die in Frage kommenden Nummern samt fertiger URL zum Anklicken.
4. **SAA/BPR** (neueste Ausgabe aus der Bibliothek) – wenn der Wirkstoff ODER ein
   Äquivalent darin vorkommt.
5. **DBRD-Musteralgorithmen** (neueste Ausgabe) und das **DBRD-Medikamentenbuch** – wenn
   der Wirkstoff oder ein Äquivalent darin vorkommt.
6. **ERC-Leitlinien** (European Resuscitation Council, neueste Ausgabe; deutsche Fassung
   des GRC, wo vorhanden) – das Kapitel, in dem der Wirkstoff vorkommt (z. B. ALS,
   Paediatric Life Support, Special Circumstances/Anaphylaxie). Erst in der Bibliothek
   suchen, sonst über Resuscitation (DOI) oder grc-org.de. Kommt er im ERC nicht vor, weglassen.
7. **Karow** (Allgemeine und spezielle Pharmakologie) – immer.
8. **RD-Factsheets** (rd-factsheets.de) und/oder **Notfallguru** (notfallguru.de), falls es
   dort eine Seite zum Wirkstoff gibt – bei einem Äquivalent dessen Seite, mit Hinweis
   im \`grund\`. \`typ: "webpage"\`.
9. **Weitere**, höchstens 3: nur wissenschaftlich belastbare Quellen mit Bezug zur
   präklinischen Anwendung – Leitlinien (AWMF, ESC …), Cochrane-Reviews, systematische
   Reviews/Metaanalysen, große RCTs. Mit DOI, wenn vorhanden. Keine Blogs, keine Foren.

# Regeln

- Ob ein Wirkstoff in SAA/BPR, DBRD, Medikamentenbuch oder ERC vorkommt, prüfst du im
  Volltext (Pfade unten) mit Grep – auch Synonyme und Handelsnamen. Nicht raten.
- **Äquivalente zählen.**${aeq.length ? ` Für ${a.wirkstoff} sind das: ${aeq.join(', ')}.` : ''} Nennt eine
  Quelle nur das Äquivalent („Prednisolon-Äquivalent", „oder Methylprednisolon",
  gleiche Indikation mit Umrechnung), gehört sie dazu; der \`grund\` sagt, unter welchem
  Namen der Wirkstoff dort steht. Das entscheidest du selbst, statt zurückzufragen.
- Liefert eine Datei keinen Text (Scan ohne Textebene), sag in den Hinweisen genau
  welche (Dateiname) – der Lernende muss sie dann per OCR durchsuchbar machen.
- Jede neue URL musst du mit WebFetch oder WebSearch gesehen haben. Keine erfundenen Links.
- Was schon im Ordner liegt (Liste unten), schlägst du NICHT noch einmal vor.
- Liegt eine passende Quelle schon irgendwo in der Bibliothek, nimm sie als
  \`art: "vorhanden"\` mit ihrem \`key\` – nicht neu.
- Von mehreren Ausgaben desselben Werks nimm die neueste.
- \`grund\`: ein Satz, warum die Quelle dazugehört (z. B. „Injektionslösung 2 mg/ml wie auf dem RTW").

# Antwort

Kurz in Deutsch, was du gefunden hast und was nicht. Danach GENAU EIN Block:

\`\`\`json
{
  "quellen": [
    {"kategorie": "Fachinformation", "art": "neu", "typ": "document", "titel": "…",
     "url": "…", "pdf_url": "…", "herausgeber": "…", "jahr": "2024", "grund": "…"},
    {"kategorie": "Karow", "art": "vorhanden", "key": "ABCD1234", "titel": "…", "grund": "…"}
  ],
  "hinweise": ["Was nicht gefunden wurde oder geprüft werden sollte"]
}
\`\`\`

# Bibliothek

## Schon im Ordner Medikamente/${a.wirkstoff}
${liste(a.schonImOrdner)}

## Standardwerke
${liste(a.standardwerke)}

## Treffer für „${a.wirkstoff}"
${liste(a.treffer)}
`;
}

/**
 * Nachsuchen in derselben Sitzung: der Lernende hat die Liste gesehen und
 * gibt eine Ergaenzung oder einen Tipp. Zurueck kommt die GANZE Liste neu –
 * dann muss das Modal nichts zusammenfuehren, was der Agent umsortiert hat.
 * `liste` ist der aktuelle Stand inkl. selbst hinzugefuegter Quellen.
 */
export function buildNachsuchePrompt(wunsch: string, liste: QuellenVorschlag[]): string {
	return `# Ergänzung des Lernenden

${wunsch.trim()}

# Aktueller Stand der Liste

Das ist die Liste, wie sie jetzt im Dialog steht – auch Quellen, die der Lernende
selbst eingetragen hat. Behalte alles, was der Wunsch nicht ausdrücklich ändert.

\`\`\`json
${JSON.stringify({ quellen: liste }, null, 1)}
\`\`\`

Arbeite den Wunsch mit denselben Regeln wie bisher ab. Antwort: kurz, was du
geändert hast, danach GENAU EIN \`\`\`json-Block mit der VOLLSTÄNDIGEN neuen Liste
und den Hinweisen (gleiches Format wie zuvor).`;
}

function formatItem(s: ZoteroSource): string {
	const teile = [`- key ${s.key} · ${s.itemType} · „${s.title}"`];
	const meta = [s.creators, s.date].filter(Boolean).join(', ');
	if (meta) teile[0] += ` (${meta})`;
	if (s.url) teile.push(`  URL: ${s.url}`);
	for (const at of s.attachments) {
		if (at.fullTextPath) teile.push(`  Volltext: ${at.fullTextPath}`);
		else if (at.filePath) teile.push(`  Datei: ${at.filePath}`);
	}
	return teile.join('\n');
}

/**
 * Den JSON-Plan aus der Antwort holen: der LETZTE ```json-Block. Wirft mit
 * lesbarer Meldung, wenn keiner da ist oder er nicht passt.
 */
export function parseQuellenPlan(antwort: string): QuellenPlan {
	const bloecke = [...antwort.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
	if (!bloecke.length) throw new Error('Die Antwort des Agenten enthält keinen JSON-Block.');
	let roh: any;
	try {
		roh = JSON.parse(bloecke[bloecke.length - 1][1]);
	} catch (e: any) {
		throw new Error('Der JSON-Block des Agenten ist fehlerhaft: ' + (e?.message || e));
	}
	const quellen: QuellenVorschlag[] = (Array.isArray(roh?.quellen) ? roh.quellen : [])
		.filter((q: any) => q && typeof q === 'object')
		.map((q: any) => ({
			...q,
			art: q.art === 'vorhanden' ? 'vorhanden' : 'neu',
			kategorie: String(q.kategorie || 'Weitere'),
			titel: String(q.titel || q.key || 'Ohne Titel'),
			autoren: Array.isArray(q.autoren) ? q.autoren.map(String) : undefined
		}))
		// „vorhanden" ohne key und „neu" ohne URL und ohne Buch sind nicht anlegbar.
		.filter((q: QuellenVorschlag) => q.art === 'vorhanden' ? !!q.key : !!(q.url || q.buch || q.titel));
	const hinweise = Array.isArray(roh?.hinweise) ? roh.hinweise.map(String) : [];
	return { quellen, hinweise };
}
