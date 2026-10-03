import { Card } from '../types';
import { CardSuggestion } from './suggestions';

export interface KartenTreffer {
	bi: number;
	ci: number;
	/** Wie die Karte gefunden wurde – fuer den Hinweis in der Oberflaeche. */
	weg: 'id' | 'card' | 'frage';
}

export type KartenSuche =
	| { ok: true; treffer: KartenTreffer }
	| {
		ok: false;
		message: string;
		/**
		 * Die genannte ID steht nur in einem `<!--ID: …-->`-Kommentar, also bei
		 * einer alten Karte ausserhalb der anki-cards-Bloecke. Die Oberflaeche
		 * bietet dann an, den Vorschlag als neue Karte zu uebernehmen.
		 */
		alteKarte: boolean;
	};

/**
 * Die Karte finden, auf die sich ein update/delete-Vorschlag bezieht.
 *
 * Reihenfolge: Anki-ID, dann CARD-Nummer, dann Aehnlichkeit der Frage. Der
 * dritte Weg faengt den haeufigsten KI-Fehler ab: eine `ID:` aus einem alten
 * `<!--ID: …-->`-Kommentar der Notiz, die zu keiner Karte im Block gehoert.
 */
export function findeKarte(
	content: string,
	bloecke: { cards: Card[] }[],
	vorschlag: CardSuggestion
): KartenSuche {
	const flat: { bi: number; ci: number }[] = [];
	bloecke.forEach((b, bi) => b.cards.forEach((_, ci) => flat.push({ bi, ci })));

	if (vorschlag.id !== null) {
		for (let bi = 0; bi < bloecke.length; bi++) {
			const ci = bloecke[bi].cards.findIndex((c) => c.id === vorschlag.id);
			if (ci >= 0) return { ok: true, treffer: { bi, ci, weg: 'id' } };
		}
	}

	if (vorschlag.ref !== null) {
		const pos = flat[vorschlag.ref - 1];
		if (pos) return { ok: true, treffer: { ...pos, weg: 'card' } };
		if (vorschlag.id === null) {
			return {
				ok: false, alteKarte: false,
				message: `CARD: ${vorschlag.ref} gibt es nicht — die Notiz hat ${flat.length} Karten.`
			};
		}
	}

	if (vorschlag.q) {
		const best = aehnlichsteFrage(vorschlag.q, flat.map((p) => bloecke[p.bi].cards[p.ci].q));
		if (best !== null) return { ok: true, treffer: { ...flat[best], weg: 'frage' } };
	}

	const alteKarte = vorschlag.id !== null
		&& new RegExp(`<!--\\s*ID:\\s*${vorschlag.id}\\s*-->`).test(content);
	if (alteKarte) {
		return {
			ok: false, alteKarte: true,
			message: `ID ${vorschlag.id} gehört zu einer alten Karte außerhalb des anki-cards-Blocks.`
		};
	}
	return {
		ok: false, alteKarte: false,
		message: vorschlag.id !== null
			? `Karte mit ID ${vorschlag.id} gibt es in der Notiz nicht (vermutlich erfunden).`
			: 'Der Vorschlag nennt weder CARD: noch ID:.'
	};
}

function woerter(text: string): Set<string> {
	const sauber = text
		.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
		.replace(/\[\[([^\]]*)\]\]/g, '$1')
		.replace(/\([^)]*obsidian:\/\/[^)]*\)/g, ' ')
		.replace(/\{\{c\d+::([^}]*)\}\}/g, '$1')
		.toLowerCase()
		.replace(/[^a-zäöüß0-9]+/g, ' ');
	return new Set(sauber.split(' ').filter((w) => w.length >= 3));
}

/**
 * Index der eindeutig aehnlichsten Frage oder null. Eindeutig heisst: deutlich
 * vor der zweitbesten – lieber gar keine Zuordnung als die falsche Karte.
 */
export function aehnlichsteFrage(frage: string, kandidaten: string[]): number | null {
	const a = woerter(frage);
	if (a.size === 0) return null;
	const werte = kandidaten.map((k) => {
		const b = woerter(k);
		let schnitt = 0;
		a.forEach((w) => { if (b.has(w)) schnitt++; });
		const vereinigung = a.size + b.size - schnitt;
		return vereinigung ? schnitt / vereinigung : 0;
	});
	let best = -1;
	let zweit = 0;
	werte.forEach((w, i) => {
		if (best < 0 || w > werte[best]) {
			if (best >= 0) zweit = Math.max(zweit, werte[best]);
			best = i;
		} else zweit = Math.max(zweit, w);
	});
	if (best < 0 || werte[best] < 0.5 || werte[best] - zweit < 0.15) return null;
	return best;
}
