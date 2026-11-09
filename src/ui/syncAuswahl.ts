/** Auswahl im Sync-Fenster, ohne Oberfläche: welche Karten in welches Deck gehen. */
export interface SyncKarte { index: number; frage: string; antwort?: string; }

export interface SyncGruppe {
	/** Deck aus dem Block. Fehlt es, muss eines gewählt werden. */
	deck: string | null;
	/** Für diese Notiz gewähltes Deck. */
	neuesDeck: string;
	karten: SyncKarte[];
	gewaehlt: Set<number>;
}

export const neueGruppe = (deck: string | null, karten: SyncKarte[]): SyncGruppe => ({ deck, neuesDeck: '', karten, gewaehlt: new Set(karten.map((k) => k.index)) });

export const gewaehltZahl = (gruppen: SyncGruppe[]): number => gruppen.reduce((n, g) => n + g.gewaehlt.size, 0);

export const zielDeck = (g: SyncGruppe, fuerAlle: string): string | null => g.deck || g.neuesDeck.trim() || fuerAlle.trim() || null;

/** Nur Gruppen mit gewählten Karten zählen. Eine Notiz ohne Deck wartet, bis eines feststeht. */
export function auftraege(gruppen: SyncGruppe[], fuerAlle: string): { fertig: { gruppe: SyncGruppe; deck: string; indizes: number[] }[]; ohneDeck: SyncGruppe[] } {
	const fertig: { gruppe: SyncGruppe; deck: string; indizes: number[] }[] = [];
	const ohneDeck: SyncGruppe[] = [];
	for (const gruppe of gruppen) {
		if (!gruppe.gewaehlt.size) continue;
		const deck = zielDeck(gruppe, fuerAlle);
		if (deck) fertig.push({ gruppe, deck, indizes: [...gruppe.gewaehlt].sort((a, b) => a - b) });
		else ohneDeck.push(gruppe);
	}
	return { fertig, ohneDeck };
}

/** Vorschlag für eine Notiz ohne Deck: das häufigste Deck im Ordner, sonst in den Ordnern darüber. */
export function deckVorschlag(pfad: string, deckeJeOrdner: Record<string, Record<string, number>>): string {
	const teile = pfad.split('/').slice(0, -1);
	for (let n = teile.length; n > 0; n--) {
		const hier = deckeJeOrdner[teile.slice(0, n).join('/')];
		if (hier) return Object.entries(hier).sort((a, b) => b[1] - a[1])[0][0];
	}
	return '';
}

export function passt(name: string, karten: { frage: string; antwort?: string }[], suche: string): boolean {
	const q = suche.trim().toLowerCase();
	return !q || name.toLowerCase().includes(q) || karten.some((k) => `${k.frage} ${k.antwort || ''}`.toLowerCase().includes(q));
}
