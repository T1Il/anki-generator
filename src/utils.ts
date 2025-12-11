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
    html = html.replace(/\[([^\]]+)\]\(([^)]+(?:\([^)]+\)[^)]*)*)\)/g, (match, text, url) => {
        const safeUrl = url.trim().replace(/\s/g, '%20');
        return `<a href="${safeUrl}">${text}</a>`;
    });

    html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    html = html.replace(/\*([^*]+)\*/g, '<i>$1</i>');
    html = html.replace(/\n(?!<br>)/g, '<br>');
    return html;
}

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
        default: return 'image/png';
    }
}

export function convertObsidianLatexToAnki(text: string): string {
    if (!text) return text;
    let converted = text.replace(/\$\$([\s\S]*?)\$\$/g, '\\[$1\\]');
    converted = converted.replace(/(?<!\\)\$(.+?)(?<!\\)\$/g, '\\($1\\)');
    return converted;
}

export function convertObsidianLinks(text: string, vaultName: string, currentFile?: string, app?: App): string {
    if (!text) return text;
    const encodedVault = encodeURIComponent(vaultName);

    text = text.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (match, linkPath, alias) => {
        if (app && currentFile) {
            const cleanPath = linkPath.split('#')[0];
            if (cleanPath) { 
                const targetFile = app.metadataCache.getFirstLinkpathDest(cleanPath, currentFile);
                if (!targetFile) {
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

    return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
        if (url.startsWith('http')) return match;
        
        if (app && currentFile && !url.startsWith('#') && !url.includes('obsidian://')) {
             const cleanPath = url.split('#')[0];
             if (cleanPath) {
                 const targetFile = app.metadataCache.getFirstLinkpathDest(cleanPath, currentFile);
                 if (!targetFile) {
                     return linkText;
                 }
             }
        }

        let targetUrl = url;
        if (url.startsWith('#') && currentFile) {
            const targetFile = currentFile + url;
            targetUrl = `obsidian://open?vault=${encodedVault}&file=${encodeURIComponent(targetFile)}`;
        }
        
        if (targetUrl.startsWith('obsidian://')) {
            return `<a href="${targetUrl}" style="text-decoration: underline; color: #007AFF;">${linkText}</a>`;
        }
        return match;
    }).replace(/\[([^\]]+)\]\(([^)]*?)\^([a-zA-Z0-9]+)\)/g, (match, linkText, prefix, blockId) => {
        if (currentFile) {
            const targetFile = currentFile + '#^' + blockId;
            const href = `obsidian://open?vault=${encodedVault}&file=${encodeURIComponent(targetFile)}`;
            return `<a href="${href}" style="text-decoration: underline; color: #007AFF;">${linkText}</a>`;
        }
        return match;
    });
}

export function ensureBlockIdsForCallouts(editor: Editor): void {
    const content = editor.getValue();
    const lines = content.split('\n');
    let changesMade = false;

    const calloutStartRegex = /^(>+\s*)\[!([^\]]+)\](.*)$/;
    const blockIdRegex = /\^[a-zA-Z0-9-]+\s*$/;

    const existingIds = new Set<string>();
    for (const line of lines) {
        const match = line.match(blockIdRegex);
        if (match) {
            existingIds.add(match[0].trim().substring(1));
        }
    }

    	// Loop through lines. 
    // Simplified: Top-Level Only. No collision complexity needed for bottom IDs if we ignore nested.
	for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(calloutStartRegex);
		if (match) {
            // match[1] = indentation ("> " or ">>")
            const nestingLevel = (match[1].match(/>/g) || []).length;
            
            // SKIP NESTED CALLOUTS
            if (nestingLevel > 1) {
                continue;
            }

			const type = match[2]; 
			const titleRaw = match[3]; 

			// Determine the end of THIS callout block.
			let j = i + 1;
			while (j < lines.length) {
                const line = lines[j].trim();
                // Check if line breaks the block
                // If we hit an empty line that is NOT a quote line, block ends.
                if (line === '' && !lines[j].trim().startsWith('>')) break;
                
                // If we hit a line that is NOT a quote, block ends.
                const quoteMatch = lines[j].match(/^(\s*>)+/);
                if (!quoteMatch) break;
                
                // If indentation drops below our level, block ends.
                const currentArrows = (quoteMatch[0].match(/>/g) || []).length;
                if (currentArrows < nestingLevel) break;
                
				j++;
			}

			let lastLineIndex = j - 1;
            if (lastLineIndex < i) lastLineIndex = i;

			let lastLine = lines[lastLineIndex];

			// Check if we already have a block ID
			if (!blockIdRegex.test(lastLine)) {
				const title = titleRaw ? titleRaw.trim() : type;
				const newId = generateSemanticBlockId(title, existingIds);
				const trimmedRight = lastLine.trimEnd();
				lines[lastLineIndex] = `${trimmedRight} ^${newId}`;
				existingIds.add(newId);
				changesMade = true;
			}
            // If ID exists, we do nothing. No collision handling for top-level needed usually.
		}
	}

    if (changesMade) {
        const newContent = lines.join('\n');
        const cursor = editor.getCursor();
        editor.setValue(newContent);
        editor.setCursor(cursor);
    }
}

function sanitizeTitleToId(text: string): string {
    let id = text.toLowerCase();
    id = id.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    id = id.replace(/[^a-z0-9]+/g, '-');
    id = id.replace(/^-+|-+$/g, '');
    if (!id) id = 'block';
    if (id.length > 30) id = id.substring(0, 30);
    return id;
}

function generateSemanticBlockId(text: string, existingIds: Set<string>): string {
    const id = sanitizeTitleToId(text);
    let uniqueId = id;
    let counter = 1;
    while (existingIds.has(uniqueId)) {
        uniqueId = `${id}-${counter}`;
        counter++;
    }
    return uniqueId;
}

export function removeAllBlockIds(editor: Editor): void {
    const content = editor.getValue();
    const lines = content.split('\n');
    const newLines: string[] = [];

    // Regex to match a line that is PURELY a block ID (inside a callout or not).
    // Matches:
    // - Optional whitespace
    // - One or more '>' (callout)
    // - Optional whitespace
    // - Optional artifacts: <!-- --> or \u200b (Zero Width Space)
    // - The Block ID: ^id
    // - Optional whitespace
    // - End of string
    const fullLineIdRegex = /^\s*(>*\s*)?(?:<!-- -->\s*)?(?:\u200b\s*)?\^[a-zA-Z0-9-]+\s*$/;

    // Regex to match inline block ID at the end of a line (to be stripped)
    const inlineIdRegex = /[ \t]+\^[a-zA-Z0-9-]+\s*$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 1. check if the WHOLE line is just a block ID (and callout markers)
        // If so, we SKIP it (effectively deleting the line).
        // Exception: what if it is > ^id but inside a text block?
        // If we delete " > ^id", we join the previous and next lines.
        // In a callout "> Text \n > ^id \n > Text", removing the middle line joins them?
        // No, it just removes that line. 
        // > Text
        // > Text
        // This is exactly what we want.
        
        if (fullLineIdRegex.test(line)) {
            // It is a dedicated ID line. Skip it.
            continue;
        }

        // 2. If it's a content line with an ID at the end, strip the ID.
        // e.g. "Text ^id" -> "Text"
        const cleanLine = line.replace(inlineIdRegex, '');
        newLines.push(cleanLine);
    }

    const newContent = newLines.join('\n');

    if (content !== newContent) {
        const cursor = editor.getCursor();
        editor.setValue(newContent);
        editor.setCursor(cursor);
    }
}
