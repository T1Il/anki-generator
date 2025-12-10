import { App, Editor, TFile } from 'obsidian';

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
	let html = text;
	
	// 1. Markdown Links [Text](URL) -> <a href="URL">Text</a>
	// Regex improvement: Handle spaces by encoding, and be non-greedy but robust.
	// OLD: /\[([^\]]+)\]\(([^)]+)\)/g
	// NEW: Handle balanced parentheses for cases like vault names with (Parens).
	// \(( [^()]* | \([^()]*\) )* \)
	html = html.replace(/\[([^\]]+)\]\(([^)]+(?:\([^)]+\)[^)]*)*)\)/g, (match, text, url) => {
		// Encode spaces in URL if they exist and are not already encoded
		const safeUrl = url.trim().replace(/\s/g, '%20');
		return `<a href="${safeUrl}">${text}</a>`;
	});

	html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
	
    // Optional: Kursiv *text* -> <i>text</i>
    html = html.replace(/\*([^*]+)\*/g, '<i>$1</i>');

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
/**
 * Konvertiert Obsidian Wikilinks in klickbare obsidian:// URIs für Anki.
 * [[Link|Alias]] -> <a href="obsidian://open?vault=...&file=Link">Alias</a>
 * [[Link]] -> <a href="obsidian://open?vault=...&file=Link">Link</a>
 * 
 * @param app Optional. If provided, checks if the target file exists.
 */
export function convertObsidianLinks(text: string, vaultName: string, currentFile?: string, app?: App): string {
	if (!text) return text;

	const encodedVault = encodeURIComponent(vaultName);

	// 1. Wikilinks [[Link]] oder [[Link|Alias]]
	// Fixed Regex: Capture Alias correctly in group 2.
	text = text.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (match, linkPath, alias) => {
        // Validation: Check if file exists if app is present
        if (app && currentFile) {
            // Split anchor if present
            const cleanPath = linkPath.split('#')[0];
            if (cleanPath) { 
                // Not a local link (does not start with # or is empty)
                const targetFile = app.metadataCache.getFirstLinkpathDest(cleanPath, currentFile);
                if (!targetFile) {
                    // File does not exist. Return plain text (Alias or Path).
                    return alias || linkPath;
                }
            }
        }

		let targetFile = linkPath;
		if (linkPath.startsWith('#') && currentFile) {
			targetFile = currentFile + linkPath;
		}
		const href = `obsidian://open?vault=${encodedVault}&file=${encodeURIComponent(targetFile)}`;
		
		return `<a href="${href}" style="text-decoration: underline; color: #007AFF;">${alias || linkPath}</a>`;
	});

	// 2. Standard Markdown Links [Text](#^id) or [Text](File.md)
	// We only care about ensuring they open in Obsidian. 
	// Specially handle LOCAL links: [Text](#...)
	return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
		if (url.startsWith('http')) return match; // Leave web links alone? Or convert to <a>?
		
        // Validation for Markdown links
        if (app && currentFile && !url.startsWith('#') && !url.includes('obsidian://')) {
             const cleanPath = url.split('#')[0];
             if (cleanPath) {
                 const targetFile = app.metadataCache.getFirstLinkpathDest(cleanPath, currentFile);
                 if (!targetFile) {
                     return linkText; // Return plain text
                 }
             }
        }

		// If it's a local link #...
		let targetUrl = url;
		if (url.startsWith('#') && currentFile) {
			const targetFile = currentFile + url;
			targetUrl = `obsidian://open?vault=${encodedVault}&file=${encodeURIComponent(targetFile)}`;
		} else if (!url.includes('obsidian://') && !url.startsWith('http')) {
             // Assume other relative links might need handling, but for now focus on #
        }
		
		// If we converted it to obsidian://, format it as A tag
		if (targetUrl.startsWith('obsidian://')) {
			return `<a href="${targetUrl}" style="text-decoration: underline; color: #007AFF;">${linkText}</a>`;
		}
		return match; // Return unchanged if not handled
	}).replace(/\[([^\]]+)\]\(([^)]*?)\^([a-zA-Z0-9]+)\)/g, (match, linkText, prefix, blockId) => {
		// 3. Fallback for AI Hallucinations like [Text](...^id) or [Text](^id)
		// Treat as local block reference [[#^id|Text]]
		if (currentFile) {
			const targetFile = currentFile + '#^' + blockId;
			const href = `obsidian://open?vault=${encodedVault}&file=${encodeURIComponent(targetFile)}`;
			return `<a href="${href}" style="text-decoration: underline; color: #007AFF;">${linkText}</a>`;
		}
		return match;
	});
}

/**
 * Checks for callouts (> [!name] ...) without a block ID.
 * Generates a logical block ID (^6chars) and appends it to the callout block.
 * Updates the editor content.
 */
export function ensureBlockIdsForCallouts(editor: Editor): void {
	const content = editor.getValue();
	const lines = content.split('\n');
	let changesMade = false;

	// Regex to identify callout start: > [!type] or > [!type] Title
	// Regex to identify callout start: > [!type] or >>> [!type]
	// Allows multiple > characters for nesting.
	const calloutStartRegex = /^>+\s*\[![^\]]+\]/;
	// Regex to check if a line is part of a block quote/callout (starts with >)
	const isBlockQuoteLine = (line: string) => line.trim().startsWith('>');
	// Regex to check for existing block ID anywhere in the line? 
	// Usually it's at the end: blockIdRegex = /\^[a-zA-Z0-9]{6}\s*$/;
	const blockIdRegex = /\^[a-zA-Z0-9]{6}\s*$/;

	for (let i = 0; i < lines.length; i++) {
		if (calloutStartRegex.test(lines[i])) {
			// Found start of callout.
			// Determine the end of this callout block.
			let j = i;
			while (j < lines.length && isBlockQuoteLine(lines[j])) {
				j++;
			}
			// j is now the index of the first line AFTER the callout.
			// The last line of the callout is j-1.

			let lastLineIndex = j - 1;
			let lastLine = lines[lastLineIndex];

			// Check if we already have a block ID at the end of the last line
			if (!blockIdRegex.test(lastLine)) {
				// No block ID found. Generate one.
				const newId = Math.random().toString(36).substring(2, 8);
				
				// Append to the last line.
				const trimmedRight = lastLine.trimEnd();
				lines[lastLineIndex] = `${trimmedRight} ^${newId}`;
				changesMade = true;
			}
			
			// Continue loop from j
			i = j - 1; 
		}
	}

	if (changesMade) {
		const newContent = lines.join('\n');
		const cursor = editor.getCursor();
		editor.setValue(newContent);
		editor.setCursor(cursor);
	}
}
