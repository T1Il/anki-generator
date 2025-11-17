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
 * Wichtig: Muss aufgerufen werden, BEVOR basicMarkdownToHtml aufgerufen wird.
 */
export function convertObsidianLatexToAnki(text: string): string {
	if (!text) return text;

	// 1. Block Math: $$...$$ zu \[...\]
	let converted = text.replace(/\$\$([\s\S]*?)\$\$/g, '\\[$1\\]');

	// 2. Inline Math: $...$ zu \(...\)
	converted = converted.replace(/(?<!\\)\$(.+?)(?<!\\)\$/g, '\\($1\\)');

	return converted;
}

/**
 * Konvertiert Obsidian Wikilinks in klickbare obsidian:// URIs für Anki.
 * [[Link|Alias]] -> <a href="obsidian://open?vault=...&file=Link">Alias</a>
 * [[Link]] -> <a href="obsidian://open?vault=...&file=Link">Link</a>
 */
export function convertObsidianLinks(text: string, vaultName: string): string {
	if (!text) return text;

	const encodedVault = encodeURIComponent(vaultName);

	// Regex für [[Link]] oder [[Link|Alias]]
	// Matcht [[Gruppe1]] oder [[Gruppe1|Gruppe2]]
	return text.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (match, linkPath, alias) => {
		// Pfad und Vault-Name müssen URL-codiert werden (z.B. Leerzeichen zu %20)
		const href = `obsidian://open?vault=${encodedVault}&file=${encodeURIComponent(linkPath)}`;
		const linkText = alias || linkPath; // Nutze Alias wenn vorhanden, sonst den Pfad

		// Gib den HTML-Link zurück. Inline-Style für Farbe/Deko optional, hier Standard:
		return `<a href="${href}" style="text-decoration: underline; color: #007AFF;">${linkText}</a>`;
	});
}
