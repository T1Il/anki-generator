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
