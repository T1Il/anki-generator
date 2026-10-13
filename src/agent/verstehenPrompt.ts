/**
 * Auftraege zum Verstehen statt zum Abfragen: der Claude-Agent erklaert, wie
 * die Aussagen einer Notiz zusammenhaengen, und holt sich, was in der Notiz
 * fehlt, aus dem Vault, aus Zotero oder aus dem Web – nicht nur fuer
 * Medikamente.
 */

export interface RechercheOrte {
	/** Wurzel des Obsidian-Vaults, oder null (dann keine Querverweise). */
	vaultDir: string | null;
	/** Zoteros storage-Ordner, oder null. */
	zoteroStorage: string | null;
}

/**
 * Wo der Agent suchen darf und wie. Gilt fuer jede Agenten-Frage im Chat:
 * Zotero ist als Ganzes lesbar, nicht nur die Quellen eines Wirkstoffs.
 */
export function rechercheHinweise(o: RechercheOrte): string {
	const orte: string[] = [];
	if (o.vaultDir) orte.push(`- **Vault** (\`${o.vaultDir}\`): die übrigen Lernnotizen. Such dort mit Grep/Glob nach
  den Begriffen der Frage. Verweise auf eine Notiz nur mit \`[[Notizname]]\`, wenn du die Datei
  gefunden hast – nie geratene Namen.`);
	if (o.zoteroStorage) orte.push(`- **Zotero** (\`${o.zoteroStorage}\`): die ganze Bibliothek, Lehrbücher aller Fächer.
  Volltexte liegen als \`<Ordner>/.zotero-ft-cache\` (reiner Text): such mit Grep über
  \`**/.zotero-ft-cache\` nach Fachbegriffen und Synonymen und lies die Fundstellen mit Read samt
  Umgebung. Welches Werk ein Ordner ist, zeigt der Dateiname daneben (Glob \`<Ordner>/*\`).
  Große Bücher nie komplett lesen.`);
	orte.push(`- **Web** (WebSearch/WebFetch) nur für das, was Vault und Zotero nicht hergeben. Kennzeichne
  solche Belege als „außerhalb Zotero" mit URL.`);
	return `## Werkzeuge und Recherche

Du darfst lesen und suchen, aber KEINE Dateien ändern – Änderungen schlägst du ausschließlich in
den Vorschlagsblöcken vor. Steht die Antwort nicht in der Notiz, recherchiere sie:
${orte.join('\n')}

Belege jede Aussage, die nicht aus der Notiz stammt, kurz: \`(Werk, S. x)\`, \`([[Notiz]])\` oder
\`(URL)\`. Was du nirgends belegen kannst, kennzeichne als „nicht belegt" statt es zu glätten.`;
}

/**
 * Der Auftrag „Konzeptkarte": die Zusammenhaenge der Notiz als Mermaid-Karte,
 * dazu Warum-Ketten und Pruefragen. Er geht als Nachricht des Nutzers an den
 * Agenten – Notiz, Kartenliste und Vorschlagsformat liefert der Chat-Kontext.
 */
export function buildKonzeptkartenAuftrag(noteTitle: string, schwerpunkt: string): string {
	return `# Auftrag: Konzeptkarte zu „${noteTitle}"

Ziel ist VERSTEHEN, nicht Abfragen: Zeig, wie die Aussagen der Notiz zusammenhängen –
warum etwas so ist und was daraus folgt. Schlage KEINE Anki-Karten vor (\`anki-card\`).
${schwerpunkt.trim() ? `\nSchwerpunkt des Lernenden: ${schwerpunkt.trim()}\n` : ''}
## Vorgehen

1. Bestimme die Kernbegriffe der Notiz (Stoffe, Mechanismen, Effekte, Krankheitsbilder,
   Maßnahmen).
2. Frag bei jeder Aussage „warum?" und „was folgt daraus?". Fehlt die Antwort in der Notiz,
   recherchiere sie (Vault, Zotero, Web – siehe Werkzeuge). Such ausdrücklich nach Verbindungen
   zu Nachbarthemen und zur Praxis im Rettungsdienst (Notfallbild, Medikament, Maßnahme).
3. Prüf nebenbei, ob die Notiz etwas Falsches oder Unscharfes sagt.

## Antwort (Deutsch)

**Die Karte** als EIN \`anki-insert\`-Vorschlag: ein eingeklapptes Callout
\`> [!info]- 🗺️ Zusammenhänge\` mit einem Mermaid-Diagramm, eingefügt hinter dem Übersichts-Callout
(oder hinter der ersten Überschrift). Für diese Karte gelten die allgemeinen Diagrammregeln mit
diesen Abweichungen – es ist ausdrücklich ein Begriffsnetz, keine Kaskade:
- \`flowchart TD\`, 10–20 Knoten, Themenblöcke als Subgraphen (\`subgraph gk["Glukokortikoide"]\`).
- JEDE Kante trägt ihre Beziehung als Beschriftung: \`A -->|"steigert"| B\`, \`A -->|"deshalb"| B\`,
  \`A -->|"Folge"| B\`; Hemmung gestrichelt: \`A -.->|"hemmt"| B\`.
- Klassen wie in den Diagrammregeln (\`drug\`, \`msg\`, \`eff\`, \`res\`), dazu für alles, was NICHT in
  der Notiz steht, sondern aus deiner Recherche kommt:
  \`classDef neu fill:#fff8dc,stroke:#b8860b,stroke-width:2px,stroke-dasharray:5 3,color:#000\`
- Knotentexte kurz (höchstens ~6 Wörter). Die Erklärung steht in den Warum-Ketten, nicht im Knoten.
- Hängen Knoten an nummerierten Warum-Ketten, setz die Nummer in den Knoten: \`["① Hypokaliämie"]\`.

**Warum-Ketten**: nummeriert (①, ②, …), je 1–3 Sätze, die eine Verbindung der Karte erklären.
Jede mit Beleg; neue Inhalte (Klasse \`neu\`) immer mit Quelle. Die wichtigsten zuerst.

**Verbindungen im Vault**: Notizen, die zum Verständnis beitragen, als \`[[Link]]\` mit einem
Halbsatz, warum. Nur gefundene Notizen.

**Unstimmigkeiten**: Was in der Notiz falsch oder unscharf ist, mit Beleg und je einem
\`anki-edit\`-Vorschlag.

**Lücken**: Was für das Verständnis fehlt, als \`anki-insert\` an die passende Stelle (in ein
Callout mit \`>\`-Zeilen), jeweils mit Quelle im Text.

**Prüf dich selbst**: 3 Warum-Fragen, die nur beantworten kann, wer die Zusammenhänge verstanden
hat – die Antworten in einem eingeklappten Callout \`> [!check]- Antworten\` darunter.

Wenn Mermaid-Code in einem Vorschlag steht, öffne und schließe den Vorschlagsblock mit VIER Backticks.`;
}
