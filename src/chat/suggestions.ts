/**
 * Maschinenlesbare Änderungsvorschläge der KI.
 *
 * Früher hat die KI nur frei zitiert ("> Zitat") und der Client hat versucht,
 * das Zitat exakt in der Notiz wiederzufinden - das schlug fast immer fehl.
 * Stattdessen fordert der Prompt jetzt explizite Blöcke an, die sich direkt
 * anwenden lassen.
 */

export interface EditSuggestion {
	kind: 'edit';
	find: string;
	replace: string;
}

export interface CardSuggestion {
	kind: 'card';
	op: 'add' | 'update' | 'delete';
	id: number | null;
	/**
	 * Kartennummer aus der Prompt-Liste (1-basiert, über alle Blöcke der Notiz).
	 * Frisch generierte Karten haben noch keine `ID:` - ohne diesen Handle waren
	 * sie für `update` und `delete` unerreichbar.
	 */
	ref: number | null;
	q: string;
	a: string;
	typeIn: boolean;
}

/**
 * Ein Block, den die KI zwar als Vorschlag markiert hat, der sich aber nicht
 * anwenden lässt. Wird bewusst mitgeliefert: vorher verschwand so ein Block
 * spurlos, weil parseSuggestions ihn verwarf und stripSuggestionBlocks ihn
 * trotzdem aus dem Fließtext entfernte.
 */
export interface InvalidSuggestion {
	kind: 'invalid';
	raw: string;
	reason: string;
}

/**
 * Neuen Text NACH einer Ankerzeile einfuegen – fuer Ergaenzungen wie ein
 * Mermaid-Diagramm. Mit FIND/REPLACE musste die KI dafuer den Anker im
 * REPLACE wiederholen; verschrieb sie ihn dabei, war die Zeile veraendert.
 */
export interface InsertSuggestion {
	kind: 'insert';
	after: string;
	text: string;
}

export type Suggestion = EditSuggestion | CardSuggestion | InsertSuggestion | InvalidSuggestion;

/** Ergebnis eines Blockparsers - bei Fehlschlag mit Begründung für die UI. */
type ParseOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Wann und wie die KI ein Mermaid-Diagramm vorschlaegt. Der Stil ist der der
 * vorhandenen Notizen (Glyceroltrinitrat): eingeklapptes Callout, flowchart TD,
 * stufige Kanten, vier Farbklassen. Gilt fuer Chat, Feedback und Zotero-Agent.
 */
export const DIAGRAMM_REGELN = `
## Diagramme (Mermaid)

Schlage ein Mermaid-Diagramm vor, wenn die Notiz einen **Ablauf** beschreibt, der als
Bild schneller verstanden wird – und es noch kein Diagramm dazu gibt:
- Wirkmechanismus als Kaskade (Wirkstoff → Rezeptor/Enzym → Botenstoff → Effekt),
- Pharmakokinetik (Aufnahme → Verteilung → Metabolisierung → Ausscheidung),
- Entscheidungswege (Indikation/Kontraindikation prüfen → Dosis), Algorithmen.

Kein Diagramm für bloße Aufzählungen, Vergleiche (dafür eine Tabelle) oder
Abläufe mit weniger als 3 Schritten ohne Verzweigung. Höchstens ca. 12 Knoten.
Jeder Knoten muss durch die Notiz oder eine Quelle gedeckt sein – nichts erfinden.

Form – genau so, als \`anki-insert\` direkt nach dem passenden Callout oder der Überschrift:

\`\`\`\`anki-insert
NACH:
#### Wirkmechanismus
TEXT:
> [!info]- 🧬 Wirkmechanismus <Wirkstoff>
> \`\`\`mermaid
> %%{init: {'flowchart': {'curve': 'step'}}}%%
> flowchart TD
>     A["💊 <b>Wirkstoff</b>"] --> B["Rezeptor/Enzym"]
>     B --> C["Effekt"]
>     C --> D["✅ Klinische Wirkung"]
>
>     classDef drug fill:#ffe4e1,stroke:#c0392b,stroke-width:2px,color:#000
>     classDef msg  fill:#d4edda,stroke:#155724,stroke-width:2px,color:#000
>     classDef eff  fill:#cce5ff,stroke:#004085,color:#000
>     classDef res  fill:#e2d5f1,stroke:#4a148c,stroke-width:2px,color:#000
>     class A drug
>     class B msg
>     class C eff
>     class D res
> \`\`\`
\`\`\`\`

Regeln für den Mermaid-Code:
- Jede Zeile des Callouts beginnt mit \`> \`.
- Beschriftungen IMMER in \`["…"]\` (Klammern, Umlaute, Pfeile, Sonderzeichen sind
  sonst Syntaxfehler). Zeilenumbruch mit \`<br/>\`, Hervorhebung mit \`<b>\`/\`<i>\`.
- Knoten-IDs nur aus Buchstaben/Ziffern. Hemmung als gestrichelte Kante \`-. hemmt .->\`.
- Klassen: \`drug\` = Wirkstoff, \`msg\` = Botenstoff/Enzym/Zwischenschritt,
  \`eff\` = Effekt am Organ, \`res\` = klinisches Ergebnis.

Zu JEDEM Diagramm gehört eine Karte, die es abfragt (Anki bekommt das Diagramm
beim Sync als Bild):

\`\`\`\`anki-card
OP: add
Q: Zeige das Schema zum Wirkmechanismus von [[<Notizname>]].
A: \`\`\`mermaid
%%{init: {'flowchart': {'curve': 'step'}}}%%
flowchart TD
    (derselbe Code wie im Diagramm, ohne "> ")
\`\`\`
\`\`\`\`
`.trim();

/**
 * Offene Fragen, die der Lernende in die Notiz schreibt („(Frage: …)").
 * Die KI beantwortet sie mit Beleg und baut die Antwort an der Stelle ein –
 * die Frage verschwindet mit demselben Klick.
 */
export const FRAGEN_REGELN = `
## Offene Fragen in der Notiz

Der Lernende notiert offene Fragen direkt in der Notiz, z. B. \`(Frage: …)\`,
\`Frage: …\`, \`??\` oder \`TODO: …\`. Suche die Notiz danach ab und gehe auf JEDE ein:
- Beantworte sie im Fließtext kurz und mit Beleg (Quelle, Seite).
- Schlage ein \`anki-edit\` vor, das die Frage entfernt und die Antwort als Aussage
  an genau dieser Stelle einbaut (FIND = die Zeile mit der Frage, REPLACE = die Zeile
  ohne Frage, ergänzt um die Antwort).
- Lässt sich eine Frage nicht belegen, sag das ausdrücklich und lass sie stehen.
`.trim();

/**
 * Wird an Chat- und Feedback-Prompts angehängt. Bewusst deutsch, weil alle
 * anderen Prompts des Plugins deutsch sind.
 */
export const SUGGESTION_FORMAT_INSTRUCTIONS = `
## Format für konkrete Änderungen

Wenn du eine konkrete Änderung vorschlägst, gib sie IMMER in einem der folgenden
Blöcke aus. Nur so kann ich sie per Klick übernehmen. Schreibe zusätzlich einen
kurzen Satz in normalem Text, warum du die Änderung vorschlägst.

**Text in der Notiz ändern:**

\`\`\`anki-edit
FIND:
Der Text exakt so, wie er in der Notiz steht.
REPLACE:
Der neue Text.
\`\`\`

Regeln für FIND:
- MUSS zeichengenau aus der Notiz kopiert sein - inklusive Markdown, Wikilinks
  (\`[[#^id|Begriff]]\`), Sternchen und Satzzeichen.
- Niemals kürzen, niemals \`[...]\` oder \`…\` einfügen.
- So kurz wie möglich, aber eindeutig (ein Satz reicht meist).

**Karte ändern, hinzufügen oder löschen:**

\`\`\`anki-card
OP: update
CARD: 3
Q: Die neue Frage
A: Die neue Antwort
\`\`\`

- \`OP:\` ist \`update\`, \`add\` oder \`delete\`.
- \`CARD:\` ist die Nummer aus der Kartenliste oben. Bei \`update\` und
  \`delete\` Pflicht, bei \`add\` weglassen.
- \`ID:\` darfst du zusätzlich angeben, wenn die Karte eine hat. Karten ohne
  \`ID:\` sind nur noch nicht mit Anki synchronisiert - über \`CARD:\` kannst
  du sie genauso ändern und löschen.
- Bei \`delete\` genügen \`OP:\` und \`CARD:\`.
- Für Lückentext schreibst du die Lücken mit \`{{c1::...}}\` in \`Q:\` und lässt
  \`A:\` weg. Für Type-In-Karten benutze \`A (type):\` statt \`A:\`.

**Neuen Abschnitt einfügen (nach einer bestehenden Zeile):**

\`\`\`anki-insert
NACH:
Eine Zeile exakt so, wie sie in der Notiz steht (z. B. eine Überschrift).
TEXT:
Der neue Text, der danach eingefügt wird.
\`\`\`

Bevorzuge \`anki-card\`, wenn es um Karten geht - das ist zuverlässiger als
Textsuche. Benutze \`anki-edit\` für Änderungen am Fließtext und
\`anki-insert\` für Ergänzungen.

**Enthält ein Vorschlag selbst einen Code-Block (z. B. \`\`\`mermaid), öffne und
schließe den Vorschlagsblock mit VIER Backticks.**

${FRAGEN_REGELN}

${DIAGRAMM_REGELN}
`.trim();

// 3 oder mehr Backticks erlauben - Modelle nutzen gern vier.
const FENCE = /^[ \t]*(`{3,})(anki-edit|anki-card|anki-insert)[ \t]*$/;

/**
 * Schliessende Fence passend zur oeffnenden: mindestens gleich viele Backticks.
 *
 * Vorher schloss JEDE ```-Zeile den Vorschlag. Eine Karte, deren Antwort ein
 * ```mermaid-Block ist, endete damit an dessen Ende, und der Rest lief als
 * Fliesstext weiter.
 */
function closeFenceFor(open: string): RegExp {
	return new RegExp('^[ \\t]*`{' + open.length + ',}[ \\t]*$');
}

/**
 * Zerlegt eine KI-Antwort in Vorschläge. Kaputte Blöcke werden als
 * 'invalid' mitgeliefert, damit sie in der UI sichtbar bleiben.
 */
export function parseSuggestions(markdown: string): Suggestion[] {
	const out: Suggestion[] = [];
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');

	let i = 0;
	while (i < lines.length) {
		const open = lines[i].match(FENCE);
		if (!open) {
			i++;
			continue;
		}

		const kind = open[2];
		const close = closeFenceFor(open[1]);
		const body: string[] = [];
		i++;
		while (i < lines.length && !close.test(lines[i])) {
			body.push(lines[i]);
			i++;
		}
		i++; // schließende Fence überspringen

		const parsed: ParseOutcome<Suggestion> = kind === 'anki-edit'
			? parseEditBlock(body)
			: kind === 'anki-insert'
				? parseInsertBlock(body)
				: parseCardBlock(body);

		out.push(parsed.ok
			? parsed.value
			: { kind: 'invalid', raw: body.join('\n').trim(), reason: parsed.reason });
	}

	return out;
}

function parseEditBlock(body: string[]): ParseOutcome<EditSuggestion> {
	const findIdx = body.findIndex((l) => l.trim() === 'FIND:');
	const replaceIdx = body.findIndex((l) => l.trim() === 'REPLACE:');

	// Einzeilige Kurzform: "FIND: x" / "REPLACE: y"
	if (findIdx === -1 || replaceIdx === -1 || replaceIdx < findIdx) {
		const findLine = body.find((l) => l.trim().startsWith('FIND:'));
		const replaceLine = body.find((l) => l.trim().startsWith('REPLACE:'));
		if (!findLine || !replaceLine) {
			return { ok: false, reason: 'Der Block braucht eine FIND:- und eine REPLACE:-Zeile.' };
		}
		const find = findLine.trim().substring(5).trim();
		const replace = replaceLine.trim().substring(8).trim();
		if (!find) return { ok: false, reason: 'FIND: ist leer.' };
		return { ok: true, value: { kind: 'edit', find, replace } };
	}

	const find = body.slice(findIdx + 1, replaceIdx).join('\n').trim();
	const replace = body.slice(replaceIdx + 1).join('\n').trim();
	if (!find) return { ok: false, reason: 'FIND: ist leer.' };
	return { ok: true, value: { kind: 'edit', find, replace } };
}

function parseInsertBlock(body: string[]): ParseOutcome<InsertSuggestion> {
	const afterIdx = body.findIndex((l) => /^(NACH|AFTER):$/i.test(l.trim()));
	const textIdx = body.findIndex((l) => /^TEXT:$/i.test(l.trim()));
	if (afterIdx === -1 || textIdx === -1 || textIdx < afterIdx) {
		return { ok: false, reason: 'Der Block braucht eine NACH:- und eine TEXT:-Zeile.' };
	}
	const after = body.slice(afterIdx + 1, textIdx).join('\n').trim();
	// TEXT nur an den Raendern kuerzen – Einrueckung im Mermaid-Code und das
	// „> " der Callout-Zeilen muessen bleiben.
	const text = body.slice(textIdx + 1).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
	if (!after) return { ok: false, reason: 'NACH: ist leer.' };
	if (!text) return { ok: false, reason: 'TEXT: ist leer.' };
	return { ok: true, value: { kind: 'insert', after, text } };
}

function parseCardBlock(body: string[]): ParseOutcome<CardSuggestion> {
	let op: 'add' | 'update' | 'delete' | null = null;
	let id: number | null = null;
	let ref: number | null = null;
	let q = '';
	let a = '';
	let typeIn = false;

	// 'q' | 'a' | null - wohin gehören Folgezeilen ohne eigenen Schlüssel?
	let current: 'q' | 'a' | null = null;

	for (const line of body) {
		const trimmed = line.trim();

		const opMatch = trimmed.match(/^OP:\s*(add|update|delete)\s*$/i);
		if (opMatch) {
			op = opMatch[1].toLowerCase() as 'add' | 'update' | 'delete';
			current = null;
			continue;
		}

		const idMatch = trimmed.match(/^ID:\s*(\d+)\s*$/);
		if (idMatch) {
			id = parseInt(idMatch[1], 10);
			current = null;
			continue;
		}

		// "CARD: 3" - die Nummer aus der Kartenliste im Prompt. Auch "KARTE:",
		// weil der Rest der Anweisungen deutsch ist und Modelle das mischen.
		const refMatch = trimmed.match(/^(?:CARD|KARTE):\s*(\d+)\s*$/i);
		if (refMatch) {
			ref = parseInt(refMatch[1], 10);
			current = null;
			continue;
		}

		if (/^Q:/.test(trimmed)) {
			q = trimmed.substring(2).trim();
			current = 'q';
			continue;
		}

		if (/^A \(type\):/i.test(trimmed)) {
			a = trimmed.substring(9).trim();
			typeIn = true;
			current = 'a';
			continue;
		}

		if (/^A:/.test(trimmed)) {
			a = trimmed.substring(2).trim();
			current = 'a';
			continue;
		}

		if (current === 'q') q += '\n' + line;
		else if (current === 'a') a += '\n' + line;
	}

	if (!op) {
		return { ok: false, reason: 'Kein OP: add, update oder delete im Block.' };
	}
	if ((op === 'update' || op === 'delete') && id === null && ref === null) {
		return { ok: false, reason: `OP: ${op} braucht eine CARD:- oder ID:-Zeile.` };
	}
	if (op !== 'delete' && !q.trim()) {
		return { ok: false, reason: 'Kein Q: im Block.' };
	}

	return { ok: true, value: { kind: 'card', op, id, ref, q: q.trim(), a: a.trim(), typeIn } };
}

/** Entfernt die Vorschlagsblöcke, damit der Fließtext separat gerendert werden kann. */
export function stripSuggestionBlocks(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const kept: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const open = lines[i].match(FENCE);
		if (open) {
			const close = closeFenceFor(open[1]);
			i++;
			while (i < lines.length && !close.test(lines[i])) i++;
			i++;
			continue;
		}
		kept.push(lines[i]);
		i++;
	}

	return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * KEIN FENCE, DEN DAS PLUGIN SELBST VERARBEITET, DARF IN DEN CHAT-RENDERER.
 *
 * `MarkdownRenderer.render()` ruft die registrierten Code-Block-Prozessoren
 * auf – auch den eigenen fuer `anki-cards`. Der baut dann die komplette
 * Karten-Oberflaeche mitten in eine Chat-Blase, mit dem sourcePath der Notiz,
 * und stoesst von dort erneut ein Rendern an. Die Oberflaeche friert ein,
 * und zwar schon beim Aktivieren des Plugins, weil die Chat-Ansicht ihren
 * gespeicherten Verlauf wiederherstellt.
 *
 * Aufgetreten bei einer KI-Antwort, die `anki-cards` schrieb, wo `FENCE`
 * `anki-card` erwartet. Der Block galt deshalb nicht als Vorschlag, wurde
 * nicht weggeschnitten – und lief in den eigenen Prozessor.
 *
 * `stripSuggestionBlocks()` haerter zu machen reicht nicht: es wuerde nur
 * diese eine Schreibweise abfangen. Die Regel muss lauten, dass ueberhaupt
 * keine vom Plugin belegte Sprachmarke den Renderer erreicht. Sie wird
 * deshalb entfernt – der Block ist dann ein gewoehnlicher Code-Block.
 */
export function entschaerfePluginFences(markdown: string): string {
	return markdown.replace(
		/^([ \t]*`{3,})[ \t]*(?:anki-cards?|anki-edit|anki-insert)[ \t]*$/gm,
		'$1text'
	);
}

/**
 * Stabiler Schluessel fuer einen Vorschlag.
 *
 * Derselbe Chat kann zweimal offen sein – als Seitenleiste und als Tab. Wird
 * ein Vorschlag in der einen Ansicht uebernommen, muss die andere ihn als
 * erledigt markieren. Sonst steht dort weiter "Uebernehmen", und der zweite
 * Klick scheitert daran, dass der gesuchte Text schon ersetzt ist – das sieht
 * nach einem Fehler aus, obwohl alles richtig gelaufen ist.
 *
 * Der Schluessel kommt aus dem INHALT, nicht aus der Position: dieselbe
 * Nachricht steht in beiden Ansichten womoeglich an unterschiedlicher Stelle,
 * und eine frisch gestreamte Antwort verschiebt die Zaehlung ohnehin.
 */
export function schluesselFuer(vorschlag: Suggestion): string {
	switch (vorschlag.kind) {
		case 'edit':
			return JSON.stringify(['edit', vorschlag.find, vorschlag.replace]);
		case 'insert':
			return JSON.stringify(['insert', vorschlag.after, vorschlag.text]);
		case 'card':
			return JSON.stringify([
				'card', vorschlag.op, vorschlag.id, vorschlag.ref,
				vorschlag.q, vorschlag.a, vorschlag.typeIn === true
			]);
		default:
			return JSON.stringify(['invalid', vorschlag.raw]);
	}
}

/**
 * Mermaid-Quelltext aus einem Vorschlag – fuer Vorschau und Pruefung im Chat.
 * Versteht Callout-Zeilen („> ") und Karten-Antworten.
 */
export function mermaidAusVorschlag(v: Suggestion): string[] {
	const text = v.kind === 'insert' ? v.text
		: v.kind === 'edit' ? v.replace
			: v.kind === 'card' ? v.a : '';
	const out: string[] = [];
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^((?:[ \t]*>)*)[ \t]*`{3,}mermaid[ \t]*$/i);
		if (!m) continue;
		const quote = m[1];
		const code: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			let l = lines[j];
			if (quote) {
				const q = l.match(/^((?:[ \t]*>)*)[ \t]?/);
				l = l.slice(q ? q[0].length : 0);
			}
			if (/^[ \t]*`{3,}[ \t]*$/.test(l)) break;
			code.push(l);
		}
		out.push(code.join('\n').trim());
		i = j;
	}
	return out.filter(Boolean);
}
