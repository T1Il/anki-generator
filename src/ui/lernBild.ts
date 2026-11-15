import { App, Menu, Modal, Notice, Platform, requestUrl, setIcon } from 'obsidian';

/** Bild als PNG, mindestens `breite` px breit, auf Weiß: Word, Notizen und Messenger nehmen PNG überall. */
function aufFlaeche(quelle: CanvasImageSource, b: number, h: number, breite: number): Promise<Blob> {
	const faktor = Math.max(1, breite / (b || 1));
	const flaeche = document.createElement('canvas');
	flaeche.width = Math.round((b || 300) * faktor);
	flaeche.height = Math.round((h || 150) * faktor);
	const ctx = flaeche.getContext('2d');
	if (!ctx) return Promise.reject(new Error('canvas'));
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, flaeche.width, flaeche.height);
	ctx.drawImage(quelle, 0, 0, flaeche.width, flaeche.height);
	return new Promise((fertig, fehler) => flaeche.toBlob((blob) => (blob ? fertig(blob) : fehler(new Error('toBlob'))), 'image/png'));
}

export const svgAdresse = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Eigene Skizze als PNG. Bewegte Skizzen geben ihr Anfangsbild. */
export function svgAlsPng(svg: string, breite = 1600): Promise<Blob> {
	return new Promise((fertig, fehler) => {
		const bild = new Image();
		bild.onload = () => { aufFlaeche(bild, bild.naturalWidth || 300, bild.naturalHeight || 150, Math.max(breite, 2 * (bild.naturalWidth || 300))).then(fertig, fehler); };
		bild.onerror = () => fehler(new Error('svg'));
		bild.src = svgAdresse(svg);
	});
}

/** Bild vom Server über requestUrl (kein CORS, keine verschmutzte Fläche), dann als PNG. */
export async function bildAlsPng(src: string): Promise<Blob> {
	const r = await requestUrl({ url: src });
	const roh = new Blob([r.arrayBuffer], { type: r.headers['content-type'] || 'image/png' });
	if (roh.type === 'image/png') return roh;
	const bmp = await createImageBitmap(roh);
	return aufFlaeche(bmp, bmp.width, bmp.height, bmp.width);
}

/**
 * In die Zwischenablage. Am Rechner über Electron: navigator.clipboard.write scheitert in Obsidian,
 * sobald das Fenster beim Auflösen den Fokus verliert. Sonst ClipboardItem mit dem Promise, damit
 * auf iOS die Nutzergeste nicht verfällt.
 */
export async function bildKopieren(png: Promise<Blob>): Promise<void> {
	const electron = Platform.isDesktopApp ? (window as any).require?.('electron') : null;
	if (electron?.clipboard && electron?.nativeImage) {
		const b = await png;
		const bild = electron.nativeImage.createFromBuffer((window as any).Buffer.from(await b.arrayBuffer()));
		if (bild.isEmpty()) throw new Error('leer');
		electron.clipboard.writeImage(bild);
		return;
	}
	await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export function kopierenMitRueckmeldung(knopf: HTMLElement | null, png: () => Promise<Blob>) {
	const alt = knopf?.getText();
	bildKopieren(png()).then(() => {
		if (knopf) { knopf.setText('Kopiert'); window.setTimeout(() => knopf.setText(alt || ''), 1500); } else new Notice('Bild kopiert');
	}).catch(() => new Notice('Bild kopieren ging hier nicht.'));
}

/** Bild groß: einpassen, Klick oder Doppeltipp zoomt, Strg+Rad und +/− stufenlos, verschieben per Ziehen. */
export class BildLupe extends Modal {
	private stufe = 1;
	constructor(app: App, private src: string, private titel: string, private png: () => Promise<Blob>) { super(app); }

	onOpen() {
		this.modalEl.addClass('anki-lp-lupe');
		this.titleEl.setText(this.titel || 'Abbildung');
		const buehne = this.contentEl.createDiv({ cls: 'anki-lp-lupe-buehne' });
		const img = buehne.createEl('img', { attr: { src: this.src, alt: this.titel || '' } });
		const leiste = this.contentEl.createDiv({ cls: 'anki-lp-lupe-leiste' });
		const knopf = (icon: string, name: string, fn: () => void) => {
			const b = leiste.createEl('button', { attr: { 'aria-label': name, title: name } });
			setIcon(b, icon);
			b.onclick = fn;
			return b;
		};
		const setzen = (s: number) => {
			this.stufe = Math.min(6, Math.max(1, s));
			buehne.toggleClass('is-gross', this.stufe > 1);
			img.style.width = this.stufe > 1 ? `${Math.round(this.stufe * 100)}%` : '';
		};
		knopf('zoom-out', 'Kleiner', () => setzen(this.stufe / 1.5));
		knopf('zoom-in', 'Größer', () => setzen(this.stufe * 1.5));
		const kopieren = leiste.createEl('button', { text: 'Kopieren', cls: 'mod-cta' });
		kopieren.onclick = () => kopierenMitRueckmeldung(kopieren, this.png);
		// Andere Bild-Plugins (Image Toolkit) hängen sich an jeden Bildklick; hier gehört er der Lupe.
		img.ondblclick = (e) => { e.stopPropagation(); setzen(this.stufe > 1 ? 1 : 2.5); };
		img.onclick = (e) => { e.stopPropagation(); if (!Platform.isMobile) setzen(this.stufe > 1 ? 1 : 2.5); };
		buehne.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setzen(this.stufe * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
		let zug: { x: number; y: number; l: number; t: number } | null = null;
		buehne.onpointerdown = (e) => { if (this.stufe > 1 && e.pointerType === 'mouse') zug = { x: e.clientX, y: e.clientY, l: buehne.scrollLeft, t: buehne.scrollTop }; };
		buehne.onpointermove = (e) => { if (zug) { buehne.scrollLeft = zug.l - (e.clientX - zug.x); buehne.scrollTop = zug.t - (e.clientY - zug.y); } };
		buehne.onpointerup = buehne.onpointerleave = () => { zug = null; };
	}

	onClose() { this.contentEl.empty(); }
}

/** Ein Bild im Chat: Klick öffnet die Lupe, Rechtsklick bzw. langes Drücken das Menü. */
export function bildBedienbar(app: App, img: HTMLImageElement, titel: string, png: () => Promise<Blob>, extern?: string, inNotiz?: () => void) {
	img.addClass('anki-lp-zoombar');
	img.onclick = (e) => { e.preventDefault(); e.stopPropagation(); new BildLupe(app, img.src, titel, png).open(); };
	img.addEventListener('contextmenu', (e) => {
		e.preventDefault();
		const m = new Menu();
		m.addItem((i) => i.setTitle('Bild kopieren').setIcon('copy').onClick(() => kopierenMitRueckmeldung(null, png)));
		m.addItem((i) => i.setTitle('Vergrößern').setIcon('maximize-2').onClick(() => new BildLupe(app, img.src, titel, png).open()));
		if (inNotiz) m.addItem((i) => i.setTitle('In Notiz einfügen').setIcon('image-plus').onClick(inNotiz));
		if (extern) m.addItem((i) => i.setTitle('In Zotero öffnen').setIcon('external-link').onClick(() => window.open(extern)));
		m.showAtMouseEvent(e);
	});
}
