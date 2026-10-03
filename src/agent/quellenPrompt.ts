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
}

/** Suchbegriffe fuer die Standardwerke in der lokalen Bibliothek. */
export const STANDARDWERK_SUCHE = [
	'Allgemeine und spezielle Pharmakologie',
	'Medikamentenbuch zu den Musteralgorithmen',
	'DBRD Musteralgorithmen',
	'Standardarbeitsanweisungen und Behandlungspfade',
	'Medikamente im Rettungsdienst'
];

export function buildQuellenPrompt(a: QuellenAuftrag): string {
	const liste = (xs: ZoteroSource[]) => xs.length
		? xs.map(formatItem).join('\n')
		: '(keine)';

	return `Du stellst für eine Notfallsanitäter-Ausbildung die Quellen zum Wirkstoff
„${a.wirkstoff}" zusammen. Sie kommen in Zotero in den Ordner Medikamente/${a.wirkstoff}.
Du legst NICHTS selbst an – du lieferst eine Liste, die der Lernende prüft.

# Gewünschte Quellen

1. **Fachinformation** der Darreichungsform, die im Rettungsdienst verwendet wird
   (meist Injektionslösung/Ampulle; bei Spray, Tablette, Zäpfchen die passende Form).
   Suche ein öffentlich ladbares PDF (Hersteller, EMA, Fachinformationsdienst ohne
   Login). \`typ: "document"\`, \`herausgeber\` = Hersteller, \`pdf_url\` = direkter PDF-Link.
2. **Gelbe Liste**, Wirkstoffseite (https://www.gelbe-liste.de/wirkstoffe/…). \`typ: "webpage"\`.
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
     (NN = Kapitelnummer, Beispiele in der Bibliothek unten). Ermittle NN über das
     Inhaltsverzeichnis https://www.thieme-connect.de/products/ebooks/book/10.1055/b000001024
     und setze \`url\` und \`pdf_url\` auf diese Adresse. Findest du NN nicht sicher, lass
     beide leer und sag es in den Hinweisen.
4. **SAA/BPR** (neueste Ausgabe aus der Bibliothek) – NUR wenn der Wirkstoff darin vorkommt.
5. **DBRD-Musteralgorithmen** (neueste Ausgabe) und das **DBRD-Medikamentenbuch** – NUR
   wenn der Wirkstoff darin vorkommt.
6. **Karow** (Allgemeine und spezielle Pharmakologie) – immer.
7. **RD-Factsheets** (rd-factsheets.de) und/oder **Notfallguru** (notfallguru.de), falls es
   dort eine Seite zum Wirkstoff gibt. \`typ: "webpage"\`.
8. **Weitere**, höchstens 3: nur wissenschaftlich belastbare Quellen mit Bezug zur
   präklinischen Anwendung – Leitlinien (AWMF, ERC, ESC …), Cochrane-Reviews, systematische
   Reviews/Metaanalysen, große RCTs. Mit DOI, wenn vorhanden. Keine Blogs, keine Foren.

# Regeln

- Ob ein Wirkstoff in SAA/BPR, DBRD oder Medikamentenbuch vorkommt, prüfst du im
  Volltext (Pfade unten) mit Grep – auch Synonyme und Handelsnamen. Nicht raten.
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
