/**
 * Die Quellen, die eine Notiz selbst schon zitiert.
 *
 * Tills Notizen belegen auf zwei Arten:
 *   - Zotero-Links: `[Titel](zotero://select/library/items/KEY)` und
 *     `([pdf](zotero://open-pdf/library/items/KEY?page=237))`,
 *   - Pandoc-Zitate aus Better BibTeX: `[@wehlingKlinischePharmakologie2011, p. 268]`.
 *
 * Der Abgleich nimmt sie direkt in den Kontext, damit der Agent genau diese
 * Werke prueft – samt der zitierten Seite – statt sie erst suchen zu muessen.
 * Reine Textauswertung; aufgeloest wird im ZoteroClient.
 */

export interface NotizZitat {
	/** `key`: Zotero-Item- oder Anhangsschluessel, `citekey`: Better-BibTeX-Schluessel. */
	art: 'key' | 'citekey';
	id: string;
	/** Zitierte Stellen („S. 237", „p. 268"), ohne Doppelte. */
	stellen: string[];
	/** Linktext aus der Notiz, falls vorhanden – Rueckfall, wenn Zotero schweigt. */
	titel?: string;
}

const MAX_STELLEN = 12;

export function zitateInNotiz(md: string): NotizZitat[] {
	const nachId = new Map<string, NotizZitat>();
	const merke = (art: NotizZitat['art'], id: string, stelle?: string | null, titel?: string | null) => {
		const k = art + ':' + id;
		let z = nachId.get(k);
		if (!z) {
			z = { art, id, stellen: [] };
			nachId.set(k, z);
		}
		const s = stelle?.replace(/\s+/g, ' ').trim();
		if (s && !z.stellen.includes(s) && z.stellen.length < MAX_STELLEN) z.stellen.push(s);
		const t = titel?.replace(/\s+/g, ' ').trim();
		if (t && !z.titel && !/^(pdf|zotero|link|↗)$/i.test(t)) z.titel = t;
	};

	// Zotero-Links, nur die eigene Bibliothek (Gruppen kennt die lokale API unter users/0 nicht).
	const link = /(?:\[([^\]\n]*)\]\()?zotero:\/\/(?:select|open-pdf)\/library\/items\/([A-Z0-9]{8})(\?[^\s)"'>\]]*)?/g;
	for (const m of md.matchAll(link)) {
		const seite = m[3] ? /[?&]page=(\d+)/.exec(m[3])?.[1] : null;
		merke('key', m[2], seite ? `S. ${seite}` : null, m[1]);
	}

	// Pandoc-Zitate: `[@a, p. 3; @b]` – nur in eckigen Klammern, sonst waere jede Mailadresse eins.
	const gruppe = /\[([^\[\]\n]*@[^\[\]\n]*)\]?/g;
	for (const g of md.matchAll(gruppe)) {
		for (const teil of g[1].split(';')) {
			const m = /^\s*-?@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*?)\s*(?:,\s*(.+?))?\s*$/.exec(teil);
			if (m) merke('citekey', m[1], m[2] || null);
		}
	}

	return [...nachId.values()];
}
