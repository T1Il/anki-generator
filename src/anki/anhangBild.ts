import { App, TFile, loadPdfJs } from 'obsidian';
import { arrayBufferToBase64 } from '../utils';

/**
 * Anhänge, die Anki nicht als Bild zeigen kann, vor dem Hochladen zu PNG.
 *
 * Bis 1.21 lud der Sync jede eingebettete Datei unverändert hoch und schrieb
 * `<img src="…">` – bei einer PDF oder einer Excalidraw-Zeichnung
 * (`.excalidraw.md`, also Markdown) blieb in Anki nur das leere Bildsymbol.
 * Gefunden über geflaggte Karten am 16.10.2026.
 */

export function istExcalidraw(file: TFile): boolean {
	return file.extension === 'excalidraw' || file.name.endsWith('.excalidraw.md');
}

export function brauchtUmwandlung(file: TFile): boolean {
	return file.extension === 'pdf' || istExcalidraw(file);
}

/**
 * PNG-Dateiname für Anki: `Zeichnung.excalidraw.md` → `Zeichnung.excalidraw.png`,
 * `EKG.pdf` → `EKG.pdf.png`. Die Endung bleibt im Namen, damit eine gleichnamige
 * echte PNG im Medienordner nicht überschrieben wird.
 */
export function pngName(file: TFile): string {
	return file.name.replace(/\.excalidraw\.md$/i, '.excalidraw') + '.png';
}

/** Die Datei als PNG (Base64) oder null, wenn es nicht geht. */
export async function alsPng(app: App, file: TFile): Promise<string | null> {
	try {
		if (file.extension === 'pdf') return await pdfAlsPng(app, file);
		if (istExcalidraw(file)) return await excalidrawAlsPng(app, file);
	} catch (e) {
		console.error('[Anhang] Umwandlung fehlgeschlagen:', file.path, e);
	}
	return null;
}

/** Höchstens so viele Seiten, untereinander – Anki läuft hochkant am Handy. */
const MAX_SEITEN = 4;
const ZIELBREITE = 1200;

async function pdfAlsPng(app: App, file: TFile): Promise<string | null> {
	const pdfjs: any = await loadPdfJs();
	const daten = new Uint8Array(await app.vault.readBinary(file));
	const doc = await pdfjs.getDocument({ data: daten }).promise;
	const anzahl = Math.min(doc.numPages, MAX_SEITEN);

	const seiten: HTMLCanvasElement[] = [];
	for (let i = 1; i <= anzahl; i++) {
		const seite = await doc.getPage(i);
		const basis = seite.getViewport({ scale: 1 });
		const viewport = seite.getViewport({ scale: ZIELBREITE / basis.width });
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(viewport.width);
		canvas.height = Math.round(viewport.height);
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await seite.render({ canvasContext: ctx, viewport }).promise;
		seiten.push(canvas);
	}
	if (!seiten.length) return null;

	const gesamt = document.createElement('canvas');
	gesamt.width = Math.max(...seiten.map((c) => c.width));
	gesamt.height = seiten.reduce((h, c) => h + c.height, 0);
	const g = gesamt.getContext('2d');
	if (!g) return null;
	let y = 0;
	for (const c of seiten) {
		g.drawImage(c, 0, y);
		y += c.height;
	}
	return gesamt.toDataURL('image/png').split(',')[1] ?? null;
}

async function excalidrawAlsPng(app: App, file: TFile): Promise<string | null> {
	const plugin = (app as any).plugins?.plugins?.['obsidian-excalidraw-plugin'];
	const ea = plugin?.ea ?? (window as any).ExcalidrawAutomate;
	if (!ea?.createPNG) {
		console.warn('[Anhang] Excalidraw-Plugin nicht geladen – Zeichnung bleibt ohne Bild:', file.path);
		return null;
	}
	if (typeof ea.reset === 'function') ea.reset();
	// Weißer Hintergrund und helles Thema: Anki zeigt die Karte auch im
	// Nachtmodus mit dem PNG wie es ist.
	const blob: Blob = await ea.createPNG(file.path, 2, { withBackground: true, withTheme: false }, undefined, 'light');
	if (!blob) return null;
	return arrayBufferToBase64(await blob.arrayBuffer());
}
