export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = '';
	const bytes = new Uint8Array(buffer);
	const len = bytes.byteLength;
	for (let i = 0; i < len; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export function basicMarkdownToHtml(text: string): string {
	if (!text) return "";
	let html = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
	// Ersetzt Zeilenumbrüche, die NICHT direkt auf <br> folgen, durch <br>
	// Dies verhindert doppelte <br>, wenn der Text bereits HTML-Zeilenumbrüche enthält
	html = html.replace(/\n(?!<br>)/g, '<br>');
	return html;
}

// Normalisiert Zeilenumbrüche für konsistente Vergleiche
export function normalizeNewlines(str: string): string {
	return str.replace(/\r\n/g, '\n');
}

export function getMimeType(extension: string): string {
	const ext = extension.toLowerCase();
	switch (ext) {
		case 'png': return 'image/png';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'webp': return 'image/webp';
		case 'heic': return 'image/heic';
		case 'heif': return 'image/heif';
		default: return 'image/png'; // Fallback
	}
}

/**
 * Konvertiert Obsidian-Style LaTeX ($...$ und $$...$$) in Anki-kompatibles Format (\(..._) und \[...\]).
 * Wichtig: Muss aufgerufen werden, BEVOR basicMarkdownToHtml aufgerufen wird, 
 * da sonst Zeilenumbrüche in Block-Math zerstört werden könnten (wobei basicMarkdownToHtml sehr simpel ist).
 */
export function convertObsidianLatexToAnki(text: string): string {
	if (!text) return text;

	// 1. Block Math: $$...$$ zu \[...\]
	// Wir nutzen [\s\S]*?, um auch über Zeilenumbrüche hinweg zu matchen.
	let converted = text.replace(/\$\$([\s\S]*?)\$\$/g, '\\[$1\\]');

	// 2. Inline Math: $...$ zu \(...\)
	// Regex Erklärung:
	// (?<!\\)\$      -> Ein $, vor dem KEIN Backslash steht (escape check)
	// (.+?)          -> Der Inhalt (non-greedy), mindestens 1 Zeichen
	// (?<!\\)\$      -> Ein $, vor dem KEIN Backslash steht
	// Wir schließen Fälle aus, wo $ für Währung stehen könnte (z.B. $50), indem wir annehmen, 
	// dass LaTeX-User im Plugin-Kontext meist mathematische Ausdrücke meinen.
	converted = converted.replace(/(?<!\\)\$(.+?)(?<!\\)\$/g, '\\($1\\)');

	return converted;
}
