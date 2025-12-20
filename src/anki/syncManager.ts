import { Notice, TFile, normalizePath } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { Card } from '../types';
import { deleteAnkiNotes, createAnkiDeck, findAnkiNoteId, findAnkiClozeNoteId, updateAnkiNoteFields, updateAnkiClozeNoteFields, addAnkiNote, addAnkiClozeNote, storeAnkiMediaFile } from './AnkiConnect';
import { arrayBufferToBase64, basicMarkdownToHtml, convertObsidianLatexToAnki, convertObsidianLinks } from '../utils';
import { findSpecificAnkiBlock, formatCardsToString } from './ankiParser';

export async function syncAnkiBlock(plugin: AnkiGeneratorPlugin, originalSourceContent: string, deckName: string | null, cards: Card[], file: TFile) {
    const notice = new Notice('Synchronisiere mit Anki...', 0);
    try {
        if (!deckName) throw new Error("Kein 'TARGET DECK' im anki-cards Block gefunden.");
        await createAnkiDeck(deckName);

        // Get vault name
        let vaultName = plugin.settings.vaultName;
        if (!vaultName || vaultName === 'My Vault') {
            try {
                /* @ts-ignore */
                const basePath = plugin.app.vault.adapter.basePath;
                if (basePath) {
                    const pathParts = basePath.split(/[\\/]/);
                    vaultName = pathParts[pathParts.length - 1] || vaultName;
                }
            } catch (e) {
                console.log("basePath error", e);
            }
        }
        if (!vaultName || vaultName === 'My Vault') {
            try {
                /* @ts-ignore */
                vaultName = plugin.app.vault.getName();
            } catch (e) { console.log("getName error", e); }
        }
        if (!vaultName) vaultName = "Obsidian";

        console.log(`[SyncManager] Starting optimized sync for ${cards.length} cards.`);
        notice.setMessage(`Vorbereiten von ${cards.length} Karten...`);

        const updatedCardsWithIds: Card[] = [...cards]; // Copy to mutate
        const imageRegex = /!\[\[([^|\]]+)(?:\|[^\]]+)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g;

        // --- STEP 1: Process Images (Batch) ---
        // Collect all images first
        const imageMap = new Map<string, TFile>(); // Name -> TFile
        const uniqueImageNames = new Set<string>();

        const extractImages = (text: string) => {
            if (!text) return;
            const matches = Array.from(text.matchAll(imageRegex));
            for (const match of matches) {
                let imageName = match[1]?.trim();
                if (!imageName && match[2]) {
                    const pathParts = match[2].split(/[\\/]/);
                    imageName = pathParts[pathParts.length - 1]?.trim();
                    if (imageName) imageName = decodeURIComponent(imageName);
                }
                if (imageName) uniqueImageNames.add(imageName);
            }
        };

        for (const card of cards) {
            extractImages(card.q);
            extractImages(card.a);
        }

        // Resolve Files
        const filesToUpload: {filename: string, data: string}[] = [];
        const uploadedImageMap = new Map<string, string>(); // OriginalName -> AnkiFilename

        if (uniqueImageNames.size > 0) {
            notice.setMessage(`Verarbeite ${uniqueImageNames.size} Bilder...`);
            for (const name of uniqueImageNames) {
                const imgFile = plugin.app.metadataCache.getFirstLinkpathDest(normalizePath(name), file.path);
                if (imgFile instanceof TFile) {
                    imageMap.set(name, imgFile);
                    try {
                        const fileData = await plugin.app.vault.readBinary(imgFile);
                        const base64Data = arrayBufferToBase64(fileData);
                        filesToUpload.push({ filename: imgFile.name, data: base64Data });
                    } catch (e) {
                        console.error(`Error reading image ${name}`, e);
                    }
                }
            }

            if (filesToUpload.length > 0) {
                const ankiFilenames = await import('./AnkiConnect').then(m => m.storeAnkiMediaFiles(filesToUpload));
                filesToUpload.forEach((f, i) => {
                    const ankiName = ankiFilenames[i];
                    if (ankiName) {
                        // Map both the exact filename and the original lookup name if possible
                        uploadedImageMap.set(f.filename, ankiName);
                        // Also map the keys from uniqueImageNames that resolved to this file
                        for (const [origName, tfile] of imageMap.entries()) {
                            if (tfile.name === f.filename) {
                                uploadedImageMap.set(origName, ankiName);
                            }
                        }
                    }
                });
            }
        }

        // --- STEP 2: Process Text & Prepare Batches ---
        
        const replaceImages = (text: string): string => {
            let processedText = text;
            // Re-run regex to replace
            // We use a simple approach: iterate matches again
             const matches = Array.from(text.matchAll(imageRegex));
             // Go backwards to preserve indices? No, string replace by content is safer if unique
             // But we can just use split/join which replaces all instances
             // However, beware of overlapping matches if we are not careful.
             // Let's use the same logic as original but with lookup
             for (const match of matches) {
                const originalLink = match[0];
                let imageName = match[1]?.trim();
                if (!imageName && match[2]) {
                    const pathParts = match[2].split(/[\\/]/);
                    imageName = pathParts[pathParts.length - 1]?.trim();
                    if (imageName) imageName = decodeURIComponent(imageName);
                }
                
                if (imageName && uploadedImageMap.has(imageName)) {
                    processedText = processedText.split(originalLink).join(`<img src="${uploadedImageMap.get(imageName)}">`);
                } else if (imageName) {
                     // Not found or failed
                     processedText = processedText.split(originalLink).join(`[Bild nicht gefunden: ${imageName}]`);
                }
            }
            return processedText;
        };

        const cardsToUpdate: { card: Card, index: number, noteId: number, front: string, back: string, clozeText: string }[] = [];
        const cardsToAdd: { card: Card, index: number, front: string, back: string, clozeText: string, model: string, f1: string, f2: string }[] = [];

        // Pre-process One Loop
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            if (!card.q || card.q.trim().length === 0) continue;

            let processedQ = replaceImages(card.q);
            let processedA = replaceImages(card.a);

            processedQ = convertObsidianLatexToAnki(processedQ);
            processedA = convertObsidianLatexToAnki(processedA);
            processedQ = convertObsidianLinks(processedQ, vaultName, file.path, plugin.app);
            processedA = convertObsidianLinks(processedA, vaultName, file.path, plugin.app);

            const htmlQ = basicMarkdownToHtml(processedQ);
            const htmlA = basicMarkdownToHtml(processedA);

            let ankiFieldQ = htmlQ;
            let ankiFieldA = htmlA;
            let ankiClozeTextField = "";

            if (card.type === 'Cloze') {
                const clozeRegex = /(?<!\w)____(?!\w)/;
                ankiClozeTextField = clozeRegex.test(htmlQ)
                    ? htmlQ.replace(clozeRegex, `{{c1::${htmlA}}}`)
                    : `${htmlQ} {{c1::${htmlA}}}`;
                 // Clear others
                 ankiFieldQ = ""; ankiFieldA = "";
            } else {
                 if (!ankiFieldQ || ankiFieldQ.trim().length === 0) continue;
            }

            // Distribute
            if (card.id) {
                cardsToUpdate.push({
                    card, index: i, noteId: card.id,
                    front: ankiFieldQ,
                    back: ankiFieldA,
                    clozeText: ankiClozeTextField
                });
            } else {
                // Determine Model and Fields for New Card
                 let model = "";
                 let f1 = ""; // Front or Text Field
                 let f2 = ""; // Back Field (empty for Cloze)
                 
                 if (card.type === 'Basic') {
                    model = card.typeIn ? plugin.settings.typeInModel : plugin.settings.basicModel;
                    const confFront = card.typeIn ? plugin.settings.typeInFront : plugin.settings.basicFront;
                    const confBack = card.typeIn ? plugin.settings.typeInBack : plugin.settings.basicBack;
                    f1 = confFront;
                    f2 = confBack;
                 } else {
                    model = plugin.settings.clozeModel;
                    f1 = plugin.settings.clozeText;
                 }

                 cardsToAdd.push({
                    card, index: i,
                    front: ankiFieldQ,
                    back: ankiFieldA,
                    clozeText: ankiClozeTextField,
                    model, f1, f2
                 });
            }
        }

        // --- STEP 3: Batch Add New Cards ---
        if (cardsToAdd.length > 0) {
            notice.setMessage(`Erstelle ${cardsToAdd.length} neue Karten...`);
            
            // Group by model to minimize API calls
            const modelGroups = new Map<string, typeof cardsToAdd>();
            for (const item of cardsToAdd) {
                if (!modelGroups.has(item.model)) modelGroups.set(item.model, []);
                // @ts-ignore
                modelGroups.get(item.model).push(item);
            }

            // Resolve fields per model
            for (const [model, items] of modelGroups.entries()) {
                let modelFields: string[] = [];
                try {
                     modelFields = await import('./AnkiConnect').then(m => m.getModelFieldNames(model));
                } catch (e) { console.warn(`Could not fetch fields for model ${model}`, e); }

                if (modelFields.length > 0) {
                     // Check fields for the first item (all items in group share model/configured fields)
                     // However, settings might have changed, but here they come from the loop which uses current settings.
                     // IMPORTANT: All items in this group share 'f1' and 'f2' derived from settings at loop time.
                     if (items.length > 0) {
                        const first = items[0];
                        
                        // BASIC CARD AUTO-CORRECTION
                        if (first.card.type === 'Basic') {
                            if (!modelFields.includes(first.f1) || !modelFields.includes(first.f2)) {
                                console.warn(`Mismatch for model ${model}: Configured=${first.f1}/${first.f2}, Available=${modelFields}`);
                                
                                if (modelFields.length === 2) {
                                    // Auto-correct all items in this group
                                    const newF1 = modelFields[0];
                                    const newF2 = modelFields[1];
                                    console.log(`Auto-correcting to ${newF1}/${newF2}`);
                                    for (const item of items) {
                                        item.f1 = newF1;
                                        item.f2 = newF2;
                                    }
                                } else {
                                     // Attempt fuzzy match or strict error? 
                                     // Original code threw error. Here we might fail entire batch.
                                     // Let's see if we can perform simple 'Front'/'Back' resolution
                                     const resolve = (val: string, alts: string[]) => {
                                         if (modelFields.includes(val)) return val;
                                         for (const alt of alts) if (modelFields.includes(alt)) return alt;
                                         return null;
                                     };
                                     
                                     const resolvedF1 = resolve(first.f1, ['Vorderseite', 'Question', 'Frage', 'Front']);
                                     const resolvedF2 = resolve(first.f2, ['Rückseite', 'Answer', 'Antwort', 'Back']);
                                     
                                     if (resolvedF1 && resolvedF2) {
                                         for (const item of items) {
                                             item.f1 = resolvedF1;
                                             item.f2 = resolvedF2;
                                         }
                                     }
                                }
                            }
                        }
                        
                        // CLOZE CARD RESOLUTION
                         else if (first.card.type === 'Cloze') {
                             if (!modelFields.includes(first.f1)) {
                                 const resolve = (val: string, alts: string[]) => {
                                     if (modelFields.includes(val)) return val;
                                     for (const alt of alts) if (modelFields.includes(alt)) return alt;
                                     return null;
                                 };
                                 const resolvedText = resolve(first.f1, ['Text', 'Inhalt', 'Cloze', 'Lückentext']);
                                 if (resolvedText) {
                                     for (const item of items) item.f1 = resolvedText;
                                 }
                             }
                        }
                     }
                }
            }

            const notesPayload = cardsToAdd.map(c => {
                const fields: any = {};
                // Helper to safely strip HTML if fields are mapped to plain text (not handled here, we assume Anki handles HTML)
                if (c.card.type === 'Basic') {
                    fields[c.f1] = c.front;
                    fields[c.f2] = c.back;
                } else {
                    fields[c.f1] = c.clozeText;
                }
                return {
                    deckName: deckName,
                    modelName: c.model,
                    fields: fields,
                    tags: ['obsidian-anki-generator']
                };
            });

            const newIds = await import('./AnkiConnect').then(m => m.addAnkiNotes(notesPayload));
            
            // Process results
            for (let k = 0; k < newIds.length; k++) {
                const newId = newIds[k];
                const cItem = cardsToAdd[k];
                
                if (newId) {
                    updatedCardsWithIds[cItem.index] = { ...cItem.card, id: newId };
                } else {
                    console.warn(`Could not create card at index ${cItem.index} (batch result null).`);
                    // Handle fallback: Check if it exists caused by duplication or actual failure?
                    // "cannot create note because it is empty" means the FIELD MAPPING failed.
                    // We can try to double check individually or just verify one by one?
                    // For now, let's try the duplicate check fallback just in case it WAS a duplicate.
                    try {
                        const existingId = cItem.card.type === 'Basic' 
                            ? await findAnkiNoteId(cItem.front, cItem.f1, deckName)
                            : await findAnkiClozeNoteId(cItem.clozeText, cItem.f1, deckName);
                        
                        if (existingId) {
                            updatedCardsWithIds[cItem.index] = { ...cItem.card, id: existingId };
                             // Also trigger update just in case content differs
                             cardsToUpdate.push({
                                card: cItem.card,
                                index: cItem.index,
                                noteId: existingId,
                                front: cItem.front,
                                back: cItem.back,
                                clozeText: cItem.clozeText
                            });
                        } else {
                             new Notice(`Fehler beim Erstellen von Karte: "${cItem.card.q.substring(0,15)}..." Prüfe Kartentyp & Felder.`);
                        }
                    } catch (e) {
                         console.error("Fallback check failed", e);
                    }
                }
            }
        }

        // --- STEP 4: Update Existing Cards (Parallel) ---
        if (cardsToUpdate.length > 0) {
            notice.setMessage(`Aktualisiere ${cardsToUpdate.length} Karten...`);
            
            // Fetch Info for Field Resolution
            const uniqueIds = Array.from(new Set(cardsToUpdate.map(c => c.noteId)));
            const noteInfoMap = new Map<number, any>();
            
            // Batch fetch info
            try {
                const infos = await import('./AnkiConnect').then(m => m.getNotesInfo(uniqueIds));
                infos.forEach((info: any) => noteInfoMap.set(info.noteId, info));
            } catch (e) {
                console.error("Failed to batch fetch info", e);
            }

            const CONCURRENCY = 5;
            const chunks = [];
            for (let i = 0; i < cardsToUpdate.length; i += CONCURRENCY) {
                chunks.push(cardsToUpdate.slice(i, i + CONCURRENCY));
            }

            for (const chunk of chunks) {
                await Promise.all(chunk.map(async (cItem) => {
                    const noteInfo = noteInfoMap.get(cItem.noteId);
                    
                    // Field Resolution Logic
                     const availableFields = noteInfo?.fields ? Object.keys(noteInfo.fields) : [];
                     const resolve = (conf: string, alts: string[]) => {
                        if (availableFields.includes(conf)) return conf;
                        for (const alt of alts) if (availableFields.includes(alt)) return alt;
                        return conf;
                     };

                     try {
                        if (cItem.card.type === 'Basic') {
                            const confFront = cItem.card.typeIn ? plugin.settings.typeInFront : plugin.settings.basicFront;
                            const confBack = cItem.card.typeIn ? plugin.settings.typeInBack : plugin.settings.basicBack;
                            
                            const realFront = resolve(confFront, ['Vorderseite', 'Question', 'Frage', 'Front']);
                            const realBack = resolve(confBack, ['Rückseite', 'Answer', 'Antwort', 'Back']);

                            await updateAnkiNoteFields(cItem.noteId, realFront, realBack, cItem.front, cItem.back);
                        } else {
                            const confText = plugin.settings.clozeText;
                            const realText = resolve(confText, ['Text', 'Inhalt', 'Cloze']);
                            
                            await updateAnkiClozeNoteFields(cItem.noteId, realText, cItem.clozeText);
                        }
                     } catch (e) {
                         console.error(`Failed to update note ${cItem.noteId}`, e);
                         // If note not found, ID became invalid?
                         if (e.message?.includes("Note was not found")) {
                             // Handle re-creation? For now just log. Requires re-run to create new.
                             new Notice(`Karte ${cItem.noteId} nicht in Anki gefunden. Beim nächsten Mal wird sie neu erstellt.`);
                             updatedCardsWithIds[cItem.index] = { ...cItem.card, id: null }; // Reset ID
                         }
                     }
                }));
            }
        }

        // --- STEP 5: Save Back to File ---
        const currentFileContent = await plugin.app.vault.read(file);
        const { matchIndex, originalFullBlockSource } = findSpecificAnkiBlock(currentFileContent, originalSourceContent);

        if (matchIndex === -1) {
            throw new Error("Konnte den zu synchronisierenden Anki-Block nicht finden.");
        }

        const lines = originalFullBlockSource.split('\n');
        const instructionLine = lines.find(l => l.trim().startsWith('INSTRUCTION:'));
        const statusLine = lines.find(l => l.trim().startsWith('STATUS:'));
        const instruction = instructionLine ? instructionLine.replace('INSTRUCTION:', '').trim() : undefined;
        const status = statusLine ? statusLine.replace('STATUS:', '').trim() : undefined;

        const deckLine = `TARGET DECK: ${deckName}`;
        const newBlockContent = formatCardsToString(deckLine, updatedCardsWithIds, instruction, status);
        const finalBlockSource = `\`\`\`anki-cards\n${newBlockContent}\n\`\`\``;
        const updatedFileContent = currentFileContent.substring(0, matchIndex) + finalBlockSource + currentFileContent.substring(matchIndex + originalFullBlockSource.length);

        await plugin.app.vault.modify(file, updatedFileContent);
        notice.hide();
        new Notice('Synchronisation erfolgreich!');
        plugin.app.workspace.trigger('markdown-preview-rerender');

    } catch (error) {
        notice.hide();
        const errorMsg = error instanceof Error ? error.message : String(error);
        new Notice('Anki-Sync Fehler: ' + errorMsg, 10000);
        console.error("Anki-Sync Fehler:", error);
    }
}

export async function saveAnkiBlockChanges(plugin: AnkiGeneratorPlugin, originalSourceContent: string, updatedCards: Card[], deletedCardIds: number[], newDeckName?: string) {
    const notice = new Notice('Speichere Änderungen...', 0);
    try {
        if (deletedCardIds.length > 0) {
            await deleteAnkiNotes(deletedCardIds);
            new Notice(`${deletedCardIds.length} Karte(n) gelöscht!`);
        }
        const file = plugin.app.workspace.getActiveFile();
        if (!file) throw new Error("Keine aktive Datei.");
        const currentFileContent = await plugin.app.vault.read(file);

        const { matchIndex, originalFullBlockSource } = findSpecificAnkiBlock(currentFileContent, originalSourceContent);

        if (matchIndex === -1) {
            throw new Error("Konnte den zu speichernden Anki-Block nicht finden.");
        }

        const lines = originalFullBlockSource.split('\n');
        let deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:')) || `TARGET DECK: ${plugin.settings.mainDeck}::Standard`;
        const instructionLine = lines.find(l => l.trim().startsWith('INSTRUCTION:'));
        const statusLine = lines.find(l => l.trim().startsWith('STATUS:'));
        const instruction = instructionLine ? instructionLine.replace('INSTRUCTION:', '').trim() : undefined;
        const status = statusLine ? statusLine.replace('STATUS:', '').trim() : undefined;

        if (newDeckName) {
            deckLine = `TARGET DECK: ${newDeckName}`;
        }

        const newBlockContent = formatCardsToString(deckLine, updatedCards, instruction, status);

        const finalBlockSource = `\`\`\`anki-cards\n${newBlockContent}\n\`\`\``;
        const updatedFileContent = currentFileContent.substring(0, matchIndex) + finalBlockSource + currentFileContent.substring(matchIndex + originalFullBlockSource.length);

        await plugin.app.vault.modify(file, updatedFileContent);
        notice.hide();
        new Notice("Änderungen gespeichert!");
        plugin.app.workspace.trigger('markdown-preview-rerender');

    } catch (e) {
        notice.hide();
        new Notice("Fehler beim Speichern: " + e.message, 7000);
        console.error("Fehler beim Speichern:", e);
    }
}
