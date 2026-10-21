import { TFile } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { Card } from '../types';
import { cardsInfo, findCards, getNotesInfo, holeMediendatei } from '../anki/AnkiConnect';
import { getAnkiBlocks, parseCardsFromBlockSource } from '../anki/ankiParser';
import { compareCard } from '../anki/driftCheck';
import { befundeFuerKarte, bildQuellen, FLAGGEN, GeflaggteKarte, MedienInfo } from './flaggen';

/** Eine geflaggte Karte mit ihrem Platz im Vault (falls es ihn gibt). */
export interface FlaggenEintrag extends GeflaggteKarte {
	/** Notiz im Vault, aus der die Karte stammt. */
	pfad: string | null;
	vaultKarte: Card | null;
	deck: string;
}

export interface FlaggenStand {
	/** Je Notizpfad die geflaggten Karten, in Kartenreihenfolge. */
	notizen: Map<string, FlaggenEintrag[]>;
	/** Karten ohne Notiz im Vault. */
	waisen: FlaggenEintrag[];
	anzahl: number;
}

/** Nur die Karten-IDs mit Flagge – billig, für die Schwelle beim Start. */
export async function zaehleFlaggen(): Promise<number> {
	return (await findCards('-flag:0')).length;
}

/**
 * Alle geflaggten Karten aus Anki holen und dem Vault zuordnen.
 *
 * `cardsInfo` liefert keine Flagge, deshalb eine Suche je Farbe. Die Zuordnung
 * läuft über die `ID:`-Zeile: das ist die Anki-Notiz-ID.
 */
export async function sammleFlaggen(plugin: AnkiGeneratorPlugin): Promise<FlaggenStand> {
	const flaggeJeKarte = new Map<number, number>();
	for (const nummer of Object.keys(FLAGGEN).map(Number)) {
		for (const id of await findCards(`flag:${nummer}`)) flaggeJeKarte.set(id, nummer);
	}

	const infos = await cardsInfo(Array.from(flaggeJeKarte.keys()));
	const ort = await vaultIndex(plugin, new Set(infos.map((i: any) => i.note)));

	// Notizinhalt für den Driftvergleich (normalisiert, wie der Drift-Check).
	const noteInfos = await getNotesInfo(Array.from(new Set(infos.map((i: any) => i.note as number))));
	const noteInfo = new Map<number, any>();
	noteInfos.forEach((n: any) => { if (n?.noteId) noteInfo.set(n.noteId, n); });

	const medien = await medienInfos(infos);

	const notizen = new Map<string, FlaggenEintrag[]>();
	const waisen: FlaggenEintrag[] = [];

	for (const info of infos) {
		const sortiert = Object.entries(info.fields || {})
			.map(([name, v]: [string, any]) => ({ name, order: v.order ?? 0, value: String(v.value ?? '') }))
			.sort((a, b) => a.order - b.order);
		const felder = sortiert.map((f) => f.value);
		const o = ort.get(info.note) ?? null;
		const vaultKarte = o ? o.karte : null;

		let weichtAb = false;
		if (vaultKarte && noteInfo.has(info.note)) {
			try {
				weichtAb = compareCard(vaultKarte, noteInfo.get(info.note), plugin.settings).some((f) => f.differs);
			} catch { /* Vergleich ist nur ein Hinweis */ }
		}

		const anki = {
			felder,
			feldNamen: sortiert.map((f) => f.name),
			modell: String(info.modelName ?? ''),
			weichtAb,
			medien: felder.flatMap(bildQuellen).map((n) => medien.get(n)).filter(Boolean) as MedienInfo[]
		};

		const eintrag: FlaggenEintrag = {
			cardId: info.cardId,
			noteId: info.note,
			flagge: flaggeJeKarte.get(info.cardId) ?? 1,
			kartenNummer: o ? o.nummer : null,
			anki,
			befunde: befundeFuerKarte(anki, vaultKarte),
			pfad: o ? o.pfad : null,
			vaultKarte,
			deck: String(info.deckName ?? '')
		};

		if (eintrag.pfad) {
			const liste = notizen.get(eintrag.pfad) ?? [];
			liste.push(eintrag);
			notizen.set(eintrag.pfad, liste);
		} else {
			waisen.push(eintrag);
		}
	}

	for (const liste of notizen.values()) liste.sort((a, b) => (a.kartenNummer ?? 0) - (b.kartenNummer ?? 0));
	return { notizen, waisen, anzahl: infos.length };
}

/**
 * Notiz-ID → Datei, Karte und `CARD`-Nummer.
 *
 * Die Nummer zählt über alle Blöcke der Datei, genau wie die Kartenliste,
 * die der Chat der KI zeigt (ChatPanel.readNote).
 */
/** Notiz-ID → Datei vom letzten Mal: erst dort suchen, dann den ganzen Vault. */
const ortCache = new Map<number, string>();

async function vaultIndex(
	plugin: AnkiGeneratorPlugin,
	gesucht: Set<number>
): Promise<Map<number, { pfad: string; karte: Card; nummer: number }>> {
	const out = new Map<number, { pfad: string; karte: Card; nummer: number }>();
	if (gesucht.size === 0) return out;
	const idMuster = new RegExp(`^\\s*>?\\s*ID:\\s*(${Array.from(gesucht).join('|')})\\b`, 'm');
	const gelesen = new Set<string>();

	const lies = async (file: TFile) => {
		gelesen.add(file.path);
		if (plugin.settings.ignoredFiles.some((p) => file.path === p || file.path.startsWith(p + '/'))) return;
		const content = await plugin.app.vault.cachedRead(file);
		if (!content.includes('anki-cards') || !idMuster.test(content)) return;

		const karten = getAnkiBlocks(content)
			.map((b) => parseCardsFromBlockSource(b.innerClean))
			.reduce((acc, l) => acc.concat(l), [] as Card[]);
		karten.forEach((k, i) => {
			if (k.id && gesucht.has(k.id) && !out.has(k.id)) {
				out.set(k.id, { pfad: file.path, karte: k, nummer: i + 1 });
				ortCache.set(k.id, file.path);
			}
		});
	};

	// Meist stehen die Karten noch dort, wo sie beim letzten Mal standen.
	const bekannt = new Set<string>();
	gesucht.forEach((id) => { const p = ortCache.get(id); if (p) bekannt.add(p); });
	for (const p of bekannt) {
		const f = dateiFuer(plugin, p);
		if (f) await lies(f);
	}
	if (out.size === gesucht.size) return out;

	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (gelesen.has(file.path)) continue;
		await lies(file);
		if (out.size === gesucht.size) break;
	}
	return out;
}

/** Medien der geflaggten Karten: vorhanden? Bildmaße für den Querformat-Befund. */
async function medienInfos(infos: any[]): Promise<Map<string, MedienInfo>> {
	const namen = new Set<string>();
	for (const info of infos) {
		for (const v of Object.values(info.fields || {}) as any[]) {
			bildQuellen(String(v.value ?? '')).forEach((n) => namen.add(n));
		}
	}

	const out = new Map<string, MedienInfo>();
	for (const name of namen) {
		if (/\.(pdf|excalidraw|md|canvas)$/i.test(name)) continue;
		const gemerkt = medienCache.get(name);
		if (gemerkt && Date.now() - gemerkt.zeit < MEDIEN_MERKEN_MS) {
			out.set(name, gemerkt.info);
			continue;
		}
		try {
			const daten = await holeMediendatei(name);
			const info: MedienInfo = { name, vorhanden: !!daten };
			if (daten) Object.assign(info, await bildMasse(daten, name));
			out.set(name, info);
			medienCache.set(name, { info, zeit: Date.now() });
		} catch {
			// Ohne Antwort lieber keinen Befund als einen falschen.
		}
	}
	return out;
}

/**
 * Jedes Bild kam bei jedem Neuladen als Base64 aus Anki und wurde dekodiert –
 * nach jedem Abschließen, für alle Karten. Name und Maße ändern sich kaum.
 */
const medienCache = new Map<string, { info: MedienInfo; zeit: number }>();
const MEDIEN_MERKEN_MS = 30 * 60 * 1000;

function bildMasse(base64: string, name: string): Promise<{ breite?: number; hoehe?: number }> {
	return new Promise((resolve) => {
		const ext = (name.split('.').pop() || 'png').toLowerCase();
		const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
		const img = new Image();
		const fertig = (r: { breite?: number; hoehe?: number }) => { img.onload = img.onerror = null; resolve(r); };
		img.onload = () => fertig({ breite: img.naturalWidth, hoehe: img.naturalHeight });
		img.onerror = () => fertig({});
		window.setTimeout(() => fertig({}), 5000);
		img.src = `data:${mime};base64,${base64}`;
	});
}

/** Die Datei zu einem Pfad, falls es sie (noch) gibt. */
export function dateiFuer(plugin: AnkiGeneratorPlugin, pfad: string): TFile | null {
	const f = plugin.app.vault.getAbstractFileByPath(pfad);
	return f instanceof TFile ? f : null;
}
