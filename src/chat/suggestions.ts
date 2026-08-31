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
	q: string;
	a: string;
	typeIn: boolean;
}

export type Suggestion = EditSuggestion | CardSuggestion;

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
ID: 12345
Q: Die neue Frage
A: Die neue Antwort
\`\`\`

- \`OP:\` ist \`update\`, \`add\` oder \`delete\`.
- \`ID:\` ist bei \`update\` und \`delete\` Pflicht und muss eine existierende
  Karten-ID sein. Bei \`add\` weglassen.
- Bei \`delete\` genügen \`OP:\` und \`ID:\`.
- Für Lückentext schreibst du die Lücken mit \`{{c1::...}}\` in \`Q:\` und lässt
  \`A:\` weg. Für Type-In-Karten benutze \`A (type):\` statt \`A:\`.

Bevorzuge \`anki-card\`, wenn es um Karten geht - das ist zuverlässiger als
Textsuche. Benutze \`anki-edit\` nur für den Fließtext der Notiz.
`.trim();

// 3 oder mehr Backticks erlauben - Modelle nutzen gern vier.
const FENCE = /^[ \t]*`{3,}(anki-edit|anki-card)[ \t]*$/;
const CLOSE_FENCE = /^[ \t]*`{3,}[ \t]*$/;

/** Zerlegt eine KI-Antwort in Vorschläge. Unbekannte oder kaputte Blöcke werden übersprungen. */
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

		const kind = open[1];
		const body: string[] = [];
		i++;
		while (i < lines.length && !CLOSE_FENCE.test(lines[i])) {
			body.push(lines[i]);
			i++;
		}
		i++; // schließende Fence überspringen

		const parsed = kind === 'anki-edit' ? parseEditBlock(body) : parseCardBlock(body);
		if (parsed) out.push(parsed);
	}

	return out;
}

function parseEditBlock(body: string[]): EditSuggestion | null {
	const findIdx = body.findIndex((l) => l.trim() === 'FIND:');
	const replaceIdx = body.findIndex((l) => l.trim() === 'REPLACE:');

	// Einzeilige Kurzform: "FIND: x" / "REPLACE: y"
	if (findIdx === -1 || replaceIdx === -1 || replaceIdx < findIdx) {
		const findLine = body.find((l) => l.trim().startsWith('FIND:'));
		const replaceLine = body.find((l) => l.trim().startsWith('REPLACE:'));
		if (!findLine || !replaceLine) return null;
		const find = findLine.trim().substring(5).trim();
		const replace = replaceLine.trim().substring(8).trim();
		if (!find) return null;
		return { kind: 'edit', find, replace };
	}

	const find = body.slice(findIdx + 1, replaceIdx).join('\n').trim();
	const replace = body.slice(replaceIdx + 1).join('\n').trim();
	if (!find) return null;
	return { kind: 'edit', find, replace };
}

function parseCardBlock(body: string[]): CardSuggestion | null {
	let op: 'add' | 'update' | 'delete' | null = null;
	let id: number | null = null;
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

	if (!op) return null;
	if ((op === 'update' || op === 'delete') && id === null) return null;
	if (op !== 'delete' && !q.trim()) return null;

	return { kind: 'card', op, id, q: q.trim(), a: a.trim(), typeIn };
}

/** Entfernt die Vorschlagsblöcke, damit der Fließtext separat gerendert werden kann. */
export function stripSuggestionBlocks(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const kept: string[] = [];

	let i = 0;
	while (i < lines.length) {
		if (FENCE.test(lines[i])) {
			i++;
			while (i < lines.length && !CLOSE_FENCE.test(lines[i])) i++;
			i++;
			continue;
		}
		kept.push(lines[i]);
		i++;
	}

	return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
