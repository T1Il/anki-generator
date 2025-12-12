import { Editor, Notice } from 'obsidian';
import { t } from '../lang/helpers';

export async function archiveLegacyAnkiBlocks(editor: Editor) {
    const content = editor.getValue();
    const lines = content.split('\n');
    let inCodeBlock = false;
    let changesMade = false;

    // We collect replacements to apply them in reverse order (bottom up) to keep indices valid.
    const replacements: { start: number, end: number, lines: string[] }[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Track code block status
        if (trimmed.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }

        if (inCodeBlock) continue;

        // Detect Legacy Block Start
        // Pattern: "TARGET DECK" at start of line (case insensitive? usually uppercase)
        if (trimmed.startsWith('TARGET DECK') || trimmed.startsWith('TARGET DECK:')) {
            // Found potential legacy block start
            // Check if it's already inside a callout (starts with >)
            if (line.trimLeft().startsWith('>')) continue;

            const startLine = i;
            let endLine = -1;

            // Search for end of block
            // End conditions:
            // 1. Next Header (##)
            // 2. Start of Code Block (```)
            // 3. End of File
            // 4. Another TARGET DECK line (unlikely, but possible)

            for (let j = i + 1; j < lines.length; j++) {
                const subLine = lines[j];
                const subTrimmed = subLine.trim();

                if (subTrimmed.startsWith('```')) {
                    endLine = j; // End before the code block
                    break;
                }
                if (subTrimmed.startsWith('#')) {
                     // Check if it's a header
                     if (subLine.match(/^#{1,6}\s/)) {
                         endLine = j;
                         break;
                     }
                }
                // Optional: Stop at next TARGET DECK if we want to handle them separately? 
                // No, legacy blocks shouldn't be back to back without separation usually. 
                // But if they are, treating as one or separate is fine.
            }

            if (endLine === -1) endLine = lines.length;

            // Validate Range
            // We want to wrap lines [startLine, endLine - 1]
            // We strip trailing empty lines from the inclusion to be clean
            let effectiveEndLine = endLine;
            while (effectiveEndLine > startLine && lines[effectiveEndLine - 1].trim() === '') {
                effectiveEndLine--;
            }

            // Exclude leading empty lines? No, TARGET DECK is start.

            // Build Replacement
            const blockLines = lines.slice(startLine, effectiveEndLine);
            const wrappedLines = blockLines.map(l => `> ${l}`);
            
            // Add Callout Header
            // We check for Q/A content to trigger "Legacy Anki" label?
            // User requested "automatically einklappen und markieren".
            const header = `> [!example]- Archivierte Anki-Karten`;
            
            replacements.push({
                start: startLine,
                end: effectiveEndLine,
                lines: [header, ...wrappedLines]
            });
            
            // Move outer loop index to skip processed lines
            i = effectiveEndLine - 1; 
            changesMade = true;
        }
    }

    // Apply replacements from bottom to top
    if (changesMade) {
        replacements.sort((a, b) => b.start - a.start);
        
        for (const rep of replacements) {
            const rangeStart = { line: rep.start, ch: 0 };
            const rangeEnd = { line: rep.end, ch: 0 }; 
            // rangeEnd line implies replacing *up to* the start of that line. 
            // If rep.end is effectively the index of the line AFTER the block.
            
            const textToInsert = rep.lines.join('\n') + '\n';
            editor.replaceRange(textToInsert, rangeStart, rangeEnd);
        }
        
        new Notice(t('notice.legacyArchived') || "Alte Anki-Blöcke archiviert.");
    } else {
        new Notice("Keine alten Anki-Blöcke gefunden.");
    }
}

export async function unarchiveLegacyAnkiBlocks(editor: Editor) {
    const content = editor.getValue();
    const lines = content.split('\n');
    let changesMade = false;

    // We collect replacements to apply them in reverse order
    const replacements: { start: number, end: number, lines: string[] }[] = [];

    const calloutHeader = '> [!example]- Archivierte Anki-Karten';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Find Archive Header
        if (line.trim() === calloutHeader) {
            const startLine = i;
            let endLine = i + 1;

            // Collect lines that are part of this callout (must start with >)
            // The callout block ends when indentation breaks or pure empty line (standard obsidian block logic)
            // But here we specifically look for the "> " prefix we added.
            
            const restoredLines: string[] = [];

            while (endLine < lines.length) {
                const subLine = lines[endLine];
                
                // If line is NOT empty and does NOT start with >, break.
                // If it IS empty, it might be part of the block or end of it.
                // Obsidian callouts usually consume empty lines if they are quoted ">".
                // Our archive function added "> " to every line.
                
                if (subLine.trim() === '') {
                     // Empty line. If we continue, we treat it as part of block? 
                     // Or does archive function quoted empty lines? Yes: `wrappedLines = blockLines.map(l => \`> ${l}\`);`
                     // So an empty line became "> ".
                     // If it is PURE empty "", it breaks the block.
                     break;
                }

                if (!subLine.startsWith('>')) {
                    break;
                }

                // Strip one level of "> " or ">"
                let restoredLine = subLine.substring(1); 
                if (restoredLine.startsWith(' ')) {
                    restoredLine = restoredLine.substring(1);
                }
                
                restoredLines.push(restoredLine);
                endLine++;
            }

            // We replace [startLine, endLine] with restoredLines
            // Note: startLine is the Header, which we drop.
            
            replacements.push({
                start: startLine,
                end: endLine,
                lines: restoredLines
            });

            i = endLine - 1;
            changesMade = true;
        }
    }

    if (changesMade) {
        replacements.sort((a, b) => b.start - a.start);

        for (const rep of replacements) {
            const rangeStart = { line: rep.start, ch: 0 };
            const rangeEnd = { line: rep.end, ch: 0 };
            
            // Join lines. If restoredLines is empty (empty block?), we insert nothing?
            // Need to ensure we don't accidentally remove too much.
            
            const textToInsert = rep.lines.length > 0 ? (rep.lines.join('\n') + '\n') : '';
            editor.replaceRange(textToInsert, rangeStart, rangeEnd);
        }

        new Notice(t('notice.legacyUnarchived') || "Anki-Blöcke wiederhergestellt.");
    } else {
        new Notice("Keine archivierten Blöcke gefunden.");
    }
}
