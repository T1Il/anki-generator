/**
 * Eingabefeld des Lernchats mit Links als Element: Im Feld steht nur der Titel des Ziels
 * („Noradrenalin › Nebenwirkungen“), gesendet wird der volle Wikilink. Ohne Framework,
 * damit es im Plugin und gleich gebaut im Web läuft.
 */
const LINK = /(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

export function linkAnzeige(ziel: string, alias?: string | null): string {
	if (alias) return alias;
	const [pfad, ...anker] = ziel.split('#');
	const name = pfad.split('/').pop() || pfad;
	const a = anker.join('#').replace(/^\^/, '');
	return a ? `${name} › ${a}` : name;
}

export class LinkFeld {
	constructor(public el: HTMLElement, platzhalter: string) {
		el.contentEditable = 'true';
		el.addClass?.('anki-lp-feld');
		el.setAttribute('role', 'textbox');
		el.setAttribute('aria-multiline', 'true');
		el.dataset.platzhalter = platzhalter;
		el.addEventListener('paste', (e) => {
			e.preventDefault();
			this.textEinfuegen(e.clipboardData?.getData('text/plain') || '');
		});
		el.addEventListener('input', () => this.leerMarkieren());
		this.leerMarkieren();
	}

	private leerMarkieren() { this.el.classList.toggle('is-leer', !this.wert().trim()); }

	/** Text mit Wikilinks fürs Senden. */
	wert(): string { return LinkFeld.serialisieren(this.el).replace(/ /g, ' '); }

	static serialisieren(wurzel: Node): string {
		let raus = '';
		wurzel.childNodes.forEach((n) => {
			if (n.nodeType === Node.TEXT_NODE) raus += n.nodeValue || '';
			else if (n instanceof HTMLElement) {
				if (n.dataset.link) raus += n.dataset.link;
				else if (n.tagName === 'BR') raus += '\n';
				else {
					const block = n.tagName === 'DIV' || n.tagName === 'P';
					if (block && raus && !raus.endsWith('\n')) raus += '\n';
					raus += LinkFeld.serialisieren(n);
				}
			}
		});
		return raus;
	}

	/** Text vor der Schreibmarke, so wie er gesendet würde. */
	vorMarke(): string {
		const sel = window.getSelection();
		if (!sel || !sel.rangeCount || !this.el.contains(sel.anchorNode)) return this.wert();
		const r = document.createRange();
		r.selectNodeContents(this.el);
		r.setEnd(sel.anchorNode as Node, sel.anchorOffset);
		const box = document.createElement('div');
		box.appendChild(r.cloneContents());
		return LinkFeld.serialisieren(box);
	}

	/** Klartext setzen; Wikilinks darin werden zu Elementen. */
	setzen(text: string) {
		this.el.innerHTML = '';
		let stand = 0;
		for (const m of text.matchAll(LINK)) {
			if ((m.index ?? 0) > stand) this.el.appendChild(document.createTextNode(text.slice(stand, m.index)));
			this.el.appendChild(this.pille(m[0], linkAnzeige(m[1], m[2])));
			stand = (m.index ?? 0) + m[0].length;
		}
		if (stand < text.length) this.el.appendChild(document.createTextNode(text.slice(stand)));
		this.leerMarkieren();
	}

	leeren() { this.setzen(''); }

	fokus(ansEnde = true) {
		this.el.focus();
		if (!ansEnde) return;
		const r = document.createRange();
		r.selectNodeContents(this.el);
		r.collapse(false);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(r);
	}

	pille(link: string, anzeige: string): HTMLElement {
		const p = document.createElement('span');
		p.className = `anki-lp-pille${/#\^/.test(link) ? ' is-block' : /#/.test(link) ? ' is-kopf' : ''}`;
		p.contentEditable = 'false';
		p.dataset.link = link;
		p.textContent = anzeige;
		p.title = link.slice(2, -2).split('|')[0];
		return p;
	}

	textEinfuegen(text: string) {
		const sel = window.getSelection();
		if (!sel || !sel.rangeCount) { this.el.appendChild(document.createTextNode(text)); return; }
		const r = sel.getRangeAt(0);
		r.deleteContents();
		const t = document.createTextNode(text);
		r.insertNode(t);
		r.setStartAfter(t);
		r.collapse(true);
		sel.removeAllRanges();
		sel.addRange(r);
		this.el.dispatchEvent(new Event('input', { bubbles: true }));
	}

	/**
	 * Die letzten `laenge` getippten Zeichen vor der Marke durch einen Link (als Element) oder Text ersetzen.
	 * Getippt wird immer in einen Textknoten, deshalb reicht es, in ihm (und notfalls davor liegenden) zu löschen.
	 */
	ersetzen(laenge: number, neu: { link?: string; anzeige?: string; text?: string }) {
		const sel = window.getSelection();
		if (!sel || !sel.rangeCount) return;
		const r = sel.getRangeAt(0);
		let knoten = r.startContainer, rest = laenge, ende = r.startOffset;
		const loeschen = document.createRange();
		loeschen.setEnd(knoten, ende);
		while (rest > 0 && knoten) {
			if (knoten.nodeType === Node.TEXT_NODE) {
				const weg = Math.min(rest, ende);
				loeschen.setStart(knoten, ende - weg);
				rest -= weg;
				if (!rest) break;
			}
			const vorher: Node | null = knoten.previousSibling;
			if (!vorher || vorher.nodeType !== Node.TEXT_NODE) break;
			knoten = vorher;
			ende = (vorher.nodeValue || '').length;
		}
		loeschen.deleteContents();
		if (neu.link) {
			const p = this.pille(neu.link, neu.anzeige || linkAnzeige(neu.link.slice(2, -2)));
			loeschen.insertNode(p);
			const luft = document.createTextNode(' ');
			p.after(luft);
			loeschen.setStart(luft, 1);
		} else {
			const t = document.createTextNode(neu.text || '');
			loeschen.insertNode(t);
			loeschen.setStart(t, t.length);
		}
		loeschen.collapse(true);
		sel.removeAllRanges();
		sel.addRange(loeschen);
		this.el.dispatchEvent(new Event('input', { bubbles: true }));
	}
}
