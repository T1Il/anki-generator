import { Card } from '../types';
import { hasCloze, stripClozeSyntax } from '../anki/ankiParser';
import { htmlToPlain } from '../anki/driftCheck';
import { containsMermaid } from '../mermaidRenderer';

/**
 * Geflaggte Karten: was die Farben bedeuten, was sich ohne KI erkennen lässt
 * und was die KI als Auftrag bekommt.
 *
 * Reine Logik ohne Obsidian und ohne AnkiConnect – geprüft in
 * scripts/flaggen-check.mjs. Das Einsammeln steht in sammeln.ts.
 *
 * Gemessen am Bestand vom 16.10.2026: Von 28 geflaggten Karten waren die
 * meisten technisch kaputt (Anki hinter dem Vault, PDF/Excalidraw als Bild,
 * Formatierungsreste, Lückentexte ohne Antwort) – das braucht keine KI und
 * soll sie auch nicht raten lassen.
 */

export interface FlaggenArt {
	nummer: number;
	farbe: string;
	/** CSS-Farbe für die Markierung in der Liste. */
	css: string;
	bedeutung: string;
	/** Was die KI mit so einer Karte tun soll. */
	auftrag: string;
}

const ALLGEMEIN = 'Finde selbst, was an der Karte nicht stimmt (fachlich, Formulierung, Darstellung, Kontext) und korrigiere es.';

/**
 * Die Namen beschreiben den Fehler der Karte, nicht die Abhilfe – so stehen
 * sie auch in AnkiDroid (Kartenbrowser → Optionen → Flaggen umbenennen).
 */
export const FLAGGEN: Record<number, FlaggenArt> = {
	1: { nummer: 1, farbe: 'rot', css: '#e5484d', bedeutung: 'Fehler (unbestimmt)', auftrag: ALLGEMEIN },
	2: { nummer: 2, farbe: 'orange', css: '#f76b15', bedeutung: 'Frage mehrdeutig', auftrag: 'Die Frage lässt mehrere Antworten zu oder ihr fehlt der Kontext. Stelle sie so, dass sie ohne die Notiz eindeutig beantwortbar ist (Thema nennen, genau eine Antwort erwartet).' },
	3: { nummer: 3, farbe: 'grün', css: '#30a46c', bedeutung: 'Zu viel Inhalt', auftrag: 'Die Karte enthält mehrere Fakten. Teile sie in atomare Karten: die alte löschen (OP: delete), die neuen hinzufügen (OP: add).' },
	4: { nummer: 4, farbe: 'blau', css: '#0090ff', bedeutung: 'Überflüssig', auftrag: 'Die Karte ist doppelt, irrelevant oder veraltet und soll gelöscht werden (OP: delete). Steckt darin Wissen, das sonst fehlt, schlage zusätzlich eine bessere Karte vor.' },
	5: { nummer: 5, farbe: 'pink', css: '#d6409f', bedeutung: 'Darstellung kaputt / hinzufügen', auftrag: 'Die Darstellung ist kaputt oder fehlt. Kaputt (Bild fehlt, Diagramm, Formatierung, LaTeX): Anki-Darstellung mit der Notiz vergleichen und die Ursache in der Notiz beheben; steht sie dort richtig, genügt erneutes Übertragen. Fehlt ein Schaubild: nach den Diagrammregeln ein Mermaid-Diagramm in die Notiz (anki-insert) und als Antwort einer Karte, die es abfragt. Jeder Knoten muss im Lerninhalt stehen; ist der Stoff kein Ablauf, sag in einem Satz, warum kein Diagramm passt.' },
	6: { nummer: 6, farbe: 'türkis', css: '#12a594', bedeutung: 'Antwort unpräzise', auftrag: 'Die Antwort stimmt, ist aber vage oder ohne Begründung. Präzisiere sie und ergänze eine kurze Erklärung (ein Satz, warum es so ist), ohne die Karte aufzublähen.' },
	7: { nummer: 7, farbe: 'lila', css: '#8e4ec6', bedeutung: 'Fakt zweifelhaft', auftrag: 'Vermutlich ein fachlicher Fehler. Prüfe die Aussage gegen Zotero und den Vault. Stimmt sie nicht, korrigiere Karte und Notiz und nenne die Quelle.' }
};

export function flaggenArt(nummer: number): FlaggenArt {
	return FLAGGEN[nummer] ?? FLAGGEN[1];
}

// --- Befunde ohne KI -----------------------------------------------------------

export type BefundArt = 'veraltet' | 'anhang' | 'querformat' | 'rest' | 'lueckentext';

export interface Befund {
	art: BefundArt;
	text: string;
	/**
	 * Erneutes Übertragen aus dem Vault behebt es (die Notiz ist richtig, nur
	 * Anki trägt einen alten oder kaputt übertragenen Stand).
	 */
	neuUebertragen?: boolean;
}

/** Eine Mediendatei, auf die die Karte in Anki zeigt. */
export interface MedienInfo {
	name: string;
	vorhanden: boolean;
	breite?: number;
	hoehe?: number;
}

/** Was von Anki über die Karte bekannt ist. */
export interface AnkiSeite {
	/** Feldinhalte (HTML) in Feldreihenfolge. */
	felder: string[];
	/** Feldnamen in derselben Reihenfolge – zum Zurückschreiben bei Karten ohne Notiz. */
	feldNamen?: string[];
	/** Notiztyp – nur zur Anzeige. */
	modell: string;
	/** Weicht der Inhalt (normalisiert) vom Vault ab? Aus driftCheck.compareCard. */
	weichtAb?: boolean;
	medien?: MedienInfo[];
}

/** Ab diesem Seitenverhältnis ist ein Bild auf dem Hochkant-Handy zu klein. */
export const QUERFORMAT_AB = 2.2;

const NICHT_DARSTELLBAR = /\.(pdf|excalidraw|excalidraw\.md|md|canvas)$/i;

/** Dateinamen aller `<img src>` eines Feldes. */
export function bildQuellen(html: string): string[] {
	const out: string[] = [];
	const re = /<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) out.push(decodeURIComponentSicher(m[1]));
	return out;
}

function decodeURIComponentSicher(s: string): string {
	try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Alles, was sich ohne KI an einer Karte erkennen lässt.
 *
 * Bewusst konservativ: ein Befund landet als Hinweis im Auftrag an die KI und
 * in der Liste. Eine Falschmeldung kostet dort Aufmerksamkeit, deshalb nur
 * Muster, die im Bestand tatsächlich vorkamen.
 */
export function befundeFuerKarte(anki: AnkiSeite, vault: Card | null): Befund[] {
	const befunde: Befund[] = [];
	const alles = anki.felder.join('\n');
	const vaultText = vault ? vault.q + '\n' + vault.a : '';

	// 1. Fehlermarken, die der Sync selbst hineinschreibt.
	if (alles.includes('[Mermaid-Diagramm konnte nicht gerendert werden]')) {
		const imVault = vault && containsMermaid(vaultText);
		befunde.push({
			art: imVault ? 'veraltet' : 'anhang',
			text: imVault
				? 'Anki zeigt „Mermaid-Diagramm konnte nicht gerendert werden“, im Vault steht das Diagramm.'
				: 'Anki zeigt „Mermaid-Diagramm konnte nicht gerendert werden“.',
			neuUebertragen: !!imVault
		});
	}
	const fehlend = /\[Bild nicht gefunden: ([^\]]+)\]/g;
	let fm: RegExpExecArray | null;
	while ((fm = fehlend.exec(alles))) {
		befunde.push({ art: 'anhang', text: `Beim Übertragen fehlte die Datei „${fm[1]}“ im Vault.` });
	}

	// 2. Anhänge, die Anki nicht anzeigen kann oder die fehlen.
	for (const name of anki.felder.flatMap(bildQuellen)) {
		if (NICHT_DARSTELLBAR.test(name)) {
			const art = /\.pdf$/i.test(name) ? 'PDF' : /excalidraw/i.test(name) ? 'Excalidraw-Zeichnung' : 'Notiz';
			befunde.push({
				art: 'anhang',
				text: `„${name}“ ist eine ${art} als Bild – Anki kann sie nicht anzeigen.`,
				neuUebertragen: art !== 'Notiz'
			});
			continue;
		}
		const info = anki.medien?.find((m) => m.name === name);
		if (info && !info.vorhanden) {
			befunde.push({ art: 'anhang', text: `„${name}“ fehlt in Ankis Medienordner.`, neuUebertragen: !!vault });
		} else if (info?.breite && info?.hoehe && info.breite / info.hoehe >= QUERFORMAT_AB) {
			befunde.push({
				art: 'querformat',
				text: `„${name}“ ist im Querformat (${info.breite}×${info.hoehe}) und am Handy sehr klein.`
			});
		}
	}

	// 3. LaTeX auf der Antwortseite einer Tippkarte: Anki vergleicht dort
	//    zeichenweise, MathJax läuft nicht (seit 1.14 wird Unicode übertragen).
	if (vault?.typeIn && /\\\(|\\\[/.test(anki.felder[1] ?? '')) {
		befunde.push({
			art: 'veraltet',
			text: 'Die Tippantwort zeigt rohes LaTeX (z. B. „\\(\\leq\\)“) statt des Zeichens.',
			neuUebertragen: true
		});
	}

	// 4. Formatierungsreste im sichtbaren Text.
	const sichtbar = anki.felder.map(htmlToPlainMitSternen).join('\n');
	if (/\*\*|__/.test(sichtbar)) {
		befunde.push({ art: 'rest', text: 'Im Text stehen Markdown-Reste (`**` oder `__`).' });
	}
	const blockId = sichtbar.match(/(?:^|\s)\^([a-z0-9][a-z0-9-]{2,})\b/i);
	if (blockId) {
		befunde.push({ art: 'rest', text: `Im Text steht die Block-ID „^${blockId[1]}“.` });
	}
	if (/\[\[[^\]]+\]\]/.test(sichtbar)) {
		befunde.push({ art: 'rest', text: 'Im Text steht ein roher Wikilink `[[…]]`.' });
	}

	// 5. Lückentexte, die so nicht funktionieren.
	if (vault && vault.type === 'Cloze') {
		const luecken = Array.from(vault.q.matchAll(/\{\{c\d+::([^}]*?)(?:::[^}]*)?\}\}/g)).map((m) => m[1].trim());
		if (hasCloze(vault.q) && vault.a && vault.a.trim()) {
			befunde.push({
				art: 'lueckentext',
				text: `Die Antwortzeile „${kurz(vault.a)}“ wird beim Lückentext nicht übertragen – in Anki fehlt sie.`
			});
		}
		const ohneLuecken = stripClozeSyntax(vault.q.replace(/\{\{c\d+::[^}]*\}\}/g, ' '));
		for (const l of luecken) {
			if (l.length >= 3 && enthaeltWort(ohneLuecken, l)) {
				befunde.push({ art: 'lueckentext', text: `Die Lösung „${l}“ steht zusätzlich im Text.` });
				break;
			}
		}
		const ohneMarken = stripClozeSyntax(vault.q).replace(/\s*\^[\w-]+\s*$/, '').trim();
		if (/(\?|\.\.\.|…)$/.test(ohneMarken)) {
			befunde.push({ art: 'lueckentext', text: 'Als Frage formuliert – ein Lückentext braucht eine Aussage.' });
		}
	}

	// 6. Allgemeine Abweichung vom Vault, sofern nicht schon erklärt.
	if (anki.weichtAb && !befunde.some((b) => b.art === 'veraltet')) {
		befunde.push({ art: 'veraltet', text: 'Anki weicht von der Notiz ab (nach der letzten Änderung nicht übertragen).', neuUebertragen: true });
	}

	return befunde;
}

/** Wie htmlToPlain, lässt aber `**` und `^id` stehen – genau die werden gesucht. */
function htmlToPlainMitSternen(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"');
}

function enthaeltWort(text: string, wort: string): boolean {
	const esc = wort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

function kurz(t: string, max = 60): string {
	const e = t.replace(/\s+/g, ' ').trim();
	return e.length > max ? e.slice(0, max - 1) + '…' : e;
}

/** Ist die Karte allein durch erneutes Übertragen zu reparieren? */
export function nurNeuUebertragen(befunde: Befund[]): boolean {
	return befunde.length > 0 && befunde.every((b) => b.neuUebertragen);
}

// --- Auftrag an die KI ---------------------------------------------------------

export interface GeflaggteKarte {
	cardId: number;
	noteId: number;
	flagge: number;
	/** Nummer in der Kartenliste der Notiz (1-basiert) = `CARD: n` im Prompt. */
	kartenNummer: number | null;
	anki: AnkiSeite;
	befunde: Befund[];
}

/**
 * Die Nachricht, mit der der Stapel eine Notiz prüfen lässt.
 *
 * Der Systemprompt (Notiz, Kartenliste mit `CARD: n`, Vorschlagsformat) kommt
 * vom normalen Chat. Hier steht nur, welche Karten geflaggt sind, wie Anki sie
 * zeigt und was die Vorprüfung gefunden hat.
 */
export function pruefAuftrag(karten: GeflaggteKarte[], mitQuellen: boolean): string {
	const teile: string[] = [
		'**Geflaggte Karten prüfen**',
		'',
		'Diese Karten dieser Notiz wurden beim Lernen in AnkiDroid geflaggt. Prüfe jede einzeln.'
	];

	for (const k of karten) {
		const art = flaggenArt(k.flagge);
		teile.push('', `### CARD: ${k.kartenNummer ?? '?'} — Flagge ${art.farbe}: ${art.bedeutung}`);
		teile.push(`Auftrag: ${art.auftrag}`);
		teile.push('So zeigt Anki die Karte gerade:');
		k.anki.felder.forEach((f, i) => {
			const name = i === 0 ? 'Vorderseite' : i === 1 ? 'Rückseite' : `Feld ${i + 1}`;
			teile.push(`- ${name}: ${einzeilig(htmlToPlain(f) || f) || '(leer)'}`);
		});
		if (k.befunde.length) {
			teile.push('Befunde der automatischen Prüfung:');
			k.befunde.forEach((b) => teile.push(`- ${b.text}${b.neuUebertragen ? ' (wird beim Abschließen neu übertragen)' : ''}`));
		}
	}

	teile.push(
		'',
		'## Regeln',
		'- Antworte je Karte mit einer Überschrift `### CARD: n` und darunter entweder Vorschlagsblöcken oder dem Satz „In Ordnung“ mit kurzem Grund.',
		'- Änderungen an Karten als `anki-card` (update/add/delete), fachliche Fehler im Fließtext zusätzlich als `anki-edit` – die Notiz ist die Quelle der Karte.',
		'- Ist eine Karte nur durch erneutes Übertragen zu reparieren (siehe Befunde), schreibe „Wird neu übertragen“ und schlage nichts vor.',
		'- Ein Lückentext braucht eine Aussage mit genau der gesuchten Lücke; eine Antwortzeile (`A:`) wird bei Lückentexten nicht übertragen.',
		'- Eine Frage muss ohne die Notiz verständlich sein: das Krankheitsbild oder Thema gehört in die Frage.',
		'- PDF- und Excalidraw-Anhänge zeigt das Plugin ab jetzt als Bild; ein Bild im Querformat kannst du nicht ändern – schlage höchstens eine Textantwort zusätzlich vor.'
	);
	if (mitQuellen) {
		teile.push('- Prüfe fachliche Aussagen gegen Zotero (Arbeitsverzeichnis, Unterordner storage/) und den Obsidian-Vault. Nenne die verwendete Quelle in einem Satz.');
	}
	return teile.join('\n');
}

/** Auftrag für Karten, zu denen es keine Notiz im Vault gibt. */
export function waisenAuftrag(karten: GeflaggteKarte[], mitQuellen: boolean): string {
	const teile: string[] = [
		'**Geflaggte Karten ohne Notiz prüfen**',
		'',
		'Diese Anki-Karten wurden in AnkiDroid geflaggt und haben keine Obsidian-Notiz. Korrigiert wird direkt in Anki.',
		'Beziehe dich mit `ID: <Nummer>` auf die Karte (nicht mit CARD:).'
	];
	for (const k of karten) {
		const art = flaggenArt(k.flagge);
		teile.push('', `### ID: ${k.noteId} — Flagge ${art.farbe}: ${art.bedeutung}`);
		teile.push(`Auftrag: ${art.auftrag}`);
		teile.push(`Typ: ${k.anki.modell}`);
		k.anki.felder.forEach((f, i) => teile.push(`- ${i === 0 ? 'Vorderseite' : i === 1 ? 'Rückseite' : `Feld ${i + 1}`}: ${einzeilig(htmlToPlain(f) || f) || '(leer)'}`));
		k.befunde.forEach((b) => teile.push(`- Befund: ${b.text}`));
	}
	teile.push(
		'',
		'## Regeln',
		'- Antworte je Karte mit `### ID: n` und darunter einem `anki-card`-Block (OP: update oder delete, `ID:` Pflicht) oder „In Ordnung“ mit kurzem Grund.',
		'- Bei einem Lückentext gehört der ganze Text mit {{c1::…}} in `Q:`, `A:` bleibt leer.'
	);
	if (mitQuellen) teile.push('- Prüfe fachliche Aussagen gegen Zotero und den Obsidian-Vault und nenne die Quelle in einem Satz.');
	return teile.join('\n');
}

/**
 * Der Auftrag, wie er im Chat-Verlauf steht: Kopfzeile sichtbar, der Rest in
 * einem eingeklappten Callout. Das Modell bekommt denselben Text – im Chat
 * stand sonst eine Bildschirmseite Regeln vor jeder Antwort.
 */
export function eingeklappt(auftrag: string, anzahl: number): string {
	const [kopf, ...rest] = auftrag.split('\n');
	const titel = `${kopf} (${anzahl} ${anzahl === 1 ? 'Karte' : 'Karten'})`;
	return titel + '\n\n> [!abstract]- Auftrag\n' + rest.map((z) => '> ' + z).join('\n');
}

/** Der Text der KI zu einer Karte ohne Notiz, ohne Vorschlagsblöcke. */
export function waisenBegruendung(antwort: string, noteId: number): string {
	const teile = antwort.split(/^###\s+/m);
	const teil = teile.find((t) => new RegExp(`^ID:\\s*${noteId}\\b`).test(t));
	if (!teil) return '';
	return teil
		.replace(/^[^\n]*\n?/, '')
		.replace(/```[\s\S]*?```/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function einzeilig(t: string, max = 400): string {
	const e = t.replace(/\s+/g, ' ').trim();
	return e.length > max ? e.slice(0, max - 1) + '…' : e;
}

/**
 * Schlüssel des geprüften Stands einer Notiz. Ändert sich eine Flagge oder
 * kommt eine Karte dazu, wird die Notiz neu geprüft – sonst übersprungen.
 */
export function stapelSchluessel(karten: { cardId: number; flagge: number }[]): string {
	return karten
		.map((k) => `${k.cardId}:${k.flagge}`)
		.sort()
		.join(',');
}

/**
 * Ist der aktuelle Stand schon geprüft? Ja, solange keine Flagge dazukam oder
 * sich änderte. Fällt eine weg (abgeschlossen, „Flagge entfernen“, am Handy
 * zurückgenommen), bleibt der Rest geprüft – sonst bezahlte jedes Entfernen
 * eine neue Prüfung der ganzen Notiz.
 */
export function schonGeprueft(aktuell: string, gespeichert: string | undefined): boolean {
	if (gespeichert === undefined) return false;
	const alt = new Set(gespeichert.split(',').filter(Boolean));
	return aktuell.split(',').filter(Boolean).every((k) => alt.has(k));
}

// --- Abschließen ----------------------------------------------------------------

export interface AbschlussPlan {
	/** Je Block (Index in getAnkiBlocks) die Kartenindizes, die übertragen werden. */
	uebertragen: Map<number, number[]>;
	/** Anki-Notizen, deren Karte im Vault nicht mehr existiert. */
	loeschen: number[];
	/** Karten, deren Flagge entfernt wird. */
	entflaggen: number[];
}

/**
 * Was „Abschließen“ für eine Notiz tut, berechnet aus dem aktuellen Vault.
 *
 * - Eine geflaggte Karte, deren ID noch im Block steht, wird übertragen.
 * - Neue Karten ohne ID im selben Block gehen mit (Aufteilen erzeugt sie).
 * - Steht die ID nirgends mehr, wurde die Karte im Vault gelöscht: in Anki
 *   löschen. Eine Flagge zu entfernen ist dann unnötig.
 */
export function abschlussPlan(
	geflaggt: { cardId: number; noteId: number }[],
	bloecke: Card[][]
): AbschlussPlan {
	const uebertragen = new Map<number, number[]>();
	const loeschen: number[] = [];
	const entflaggen: number[] = [];

	const ort = new Map<number, { block: number; index: number }>();
	bloecke.forEach((cards, b) => cards.forEach((c, i) => {
		if (c.id) ort.set(c.id, { block: b, index: i });
	}));

	const hinzu = (block: number, index: number) => {
		const liste = uebertragen.get(block) ?? [];
		if (!liste.includes(index)) liste.push(index);
		uebertragen.set(block, liste);
	};

	for (const g of geflaggt) {
		const o = ort.get(g.noteId);
		if (!o) {
			if (!loeschen.includes(g.noteId)) loeschen.push(g.noteId);
			continue;
		}
		hinzu(o.block, o.index);
		entflaggen.push(g.cardId);
	}

	// Neue Karten in betroffenen Blöcken mitnehmen – auch in Blöcken, aus denen
	// eine geflaggte Karte gelöscht wurde, solange der Block bekannt ist.
	const betroffen = new Set<number>(uebertragen.keys());
	if (loeschen.length && bloecke.length === 1) betroffen.add(0);
	for (const b of betroffen) {
		bloecke[b].forEach((c, i) => {
			if (!c.id && c.q.trim()) hinzu(b, i);
		});
	}
	for (const [b, liste] of uebertragen) uebertragen.set(b, liste.sort((x, y) => x - y));

	return { uebertragen, loeschen, entflaggen };
}
