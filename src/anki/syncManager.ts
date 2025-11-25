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

        // Get vault name from various sources
        let vaultName = plugin.settings.vaultName;

        // Try to get actual vault name from Obsidian
        if (!vaultName || vaultName === 'My Vault') {
            try {
                // Try getting from adapter basePath (most reliable)
                /* @ts-ignore */
                const basePath = plugin.app.vault.adapter.basePath;
                if (basePath) {
                    // Extract folder name from path
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
            } catch (e) {
                console.log("getName error", e);
            }
        }

        if (!vaultName) {
            vaultName = "Obsidian";
            console.warn("Vault Name konnte nicht ermittelt werden. Verwende 'Obsidian'.");
        }

        console.log("Using vault name:", vaultName);

        const updatedCardsWithIds: Card[] = [];
        const imageRegex = /!\[\[([^|\]]+)(?:\|[^\]]+)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g;

        for (const card of cards) {
            if (!card.q || card.q.trim().length === 0) {
                console.warn("Überspringe Karte mit leerer Frage:", card);
                continue;
            }

            notice.setMessage(`Verarbeite Karte: ${card.q.substring(0, 30)}...`);
            let ankiNoteId = card.id;
            const originalQ = card.q;
            const originalA = card.a;
            let processedQ = originalQ;
            let processedA = originalA;
            const imageProcessedMap = new Map<string, string>();

            const processImages = async (text: string): Promise<string> => {
                let processedText = text;
                const matches = Array.from(text.matchAll(imageRegex));
                for (const match of matches) {
                    const originalLink = match[0];
                    let imageName = match[1]?.trim();
                    if (!imageName && match[2]) {
                        const pathParts = match[2].split(/[\\/]/);
                        imageName = pathParts[pathParts.length - 1]?.trim();
                        if (imageName) imageName = decodeURIComponent(imageName);
                    }
                    if (!imageName) continue;
                    if (imageProcessedMap.has(imageName)) {
                        processedText = processedText.split(originalLink).join(`<img src="${imageProcessedMap.get(imageName)}">`);
                        continue;
                    }
                    try {
                        const imgFile = plugin.app.metadataCache.getFirstLinkpathDest(normalizePath(imageName), file.path);
                        if (imgFile instanceof TFile) {
                            notice.setMessage(`Lade Bild hoch: ${imgFile.name}...`);
                            const fileData = await plugin.app.vault.readBinary(imgFile);
                            const base64Data = arrayBufferToBase64(fileData);
                            const ankiFilename = await storeAnkiMediaFile(imgFile.name, base64Data);
                            imageProcessedMap.set(imageName, ankiFilename);
                            processedText = processedText.split(originalLink).join(`<img src="${ankiFilename}">`);
                        } else {
                            console.warn(`Bilddatei nicht gefunden beim Sync: ${imageName}`);
                            processedText = processedText.split(originalLink).join(`[Bild nicht gefunden: ${imageName}]`);
                        }
                    } catch (imgError) {
                        console.error(`Fehler bei Bild ${imageName} beim Sync:`, imgError);
                        notice.setMessage(`Fehler bei Bild ${imageName}: ${imgError.message}`);
                        processedText = processedText.split(originalLink).join(`[Fehler bei Bild: ${imageName}]`);
                    }
                }
                return processedText;
            };

            processedQ = await processImages(processedQ);
            processedA = await processImages(processedA);

            processedQ = convertObsidianLatexToAnki(processedQ);
            processedA = convertObsidianLatexToAnki(processedA);

            processedQ = convertObsidianLinks(processedQ, vaultName);
            processedA = convertObsidianLinks(processedA, vaultName);

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
                ankiFieldQ = ankiClozeTextField;
                ankiFieldA = "";
            }

            if (card.type === 'Basic' && (!ankiFieldQ || ankiFieldQ.trim().length === 0)) {
                console.warn("Überspringe Basic Karte (leeres Front-Feld):", originalQ);
                continue;
            }
            if (card.type === 'Cloze' && (!ankiClozeTextField || ankiClozeTextField.trim().length === 0)) {
                console.warn("Überspringe Cloze Karte (leeres Text-Feld):", originalQ);
                continue;
            }

            if (!ankiNoteId) {
                if (card.type === 'Basic') {
                    const frontField = card.typeIn ? plugin.settings.typeInFront : plugin.settings.basicFront;
                    ankiNoteId = await findAnkiNoteId(originalQ, frontField);
                } else if (card.type === 'Cloze') {
                    ankiNoteId = await findAnkiClozeNoteId(originalQ, plugin.settings.clozeText);
                }
            }

            if (ankiNoteId) {
                try {
                    notice.setMessage(`Aktualisiere Karte ${ankiNoteId}...`);
                    if (card.type === 'Basic') {
                        const frontField = card.typeIn ? plugin.settings.typeInFront : plugin.settings.basicFront;
                        const backField = card.typeIn ? plugin.settings.typeInBack : plugin.settings.basicBack;
                        await updateAnkiNoteFields(ankiNoteId, frontField, backField, ankiFieldQ, ankiFieldA);
                    } else if (card.type === 'Cloze') {
                        await updateAnkiClozeNoteFields(ankiNoteId, plugin.settings.clozeText, ankiClozeTextField);
                    }
                } catch (e) {
                    if (e.message?.includes("Note was not found")) {
                        notice.setMessage(`Karte ${ankiNoteId} nicht gefunden. Erstelle neu.`);
                        ankiNoteId = null;
                    } else { throw e; }
                }
            }

            if (!ankiNoteId) {
                try {
                    notice.setMessage(`Erstelle neue Karte für ${originalQ.substring(0, 30)}...`);
                    if (card.type === 'Basic') {
                        const model = card.typeIn ? plugin.settings.typeInModel : plugin.settings.basicModel;
                        let frontField = card.typeIn ? plugin.settings.typeInFront : plugin.settings.basicFront;
                        let backField = card.typeIn ? plugin.settings.typeInBack : plugin.settings.basicBack;

                        // Validate Field Names
                        const modelFields = await import('./AnkiConnect').then(m => m.getModelFieldNames(model));
                        if (modelFields.length > 0) {
                            if (!modelFields.includes(frontField) || !modelFields.includes(backField)) {
                                console.warn(`Feldnamen stimmen nicht überein für Modell '${model}'. Konfiguriert: ${frontField}/${backField}. Verfügbar: ${modelFields.join(', ')}`);
                                // Try to auto-map if we have exactly 2 fields
                                if (modelFields.length === 2) {
                                    frontField = modelFields[0];
                                    backField = modelFields[1];
                                    notice.setMessage(`Feldnamen automatisch angepasst: ${frontField} / ${backField}`);
                                } else {
                                    throw new Error(`Feldnamen '${frontField}'/'${backField}' existieren nicht im Modell '${model}'. Verfügbar: ${modelFields.join(', ')}. Bitte in den Einstellungen korrigieren.`);
                                }
                            }
                        }

                        ankiNoteId = await addAnkiNote(deckName, model, frontField, backField, ankiFieldQ, ankiFieldA);
                    } else if (card.type === 'Cloze') {
                        ankiNoteId = await addAnkiClozeNote(deckName, plugin.settings.clozeModel, plugin.settings.clozeText, ankiClozeTextField);
                    }
                } catch (e) {
                    if (e.message?.includes("cannot create note because it is a duplicate")) {
                        notice.setMessage(`Duplikat gefunden. Suche ID...`);
                        if (card.type === 'Basic') {
                            const frontField = card.typeIn ? plugin.settings.typeInFront : plugin.settings.basicFront;
                            ankiNoteId = await findAnkiNoteId(originalQ, frontField);
                        } else if (card.type === 'Cloze') {
                            ankiNoteId = await findAnkiClozeNoteId(originalQ, plugin.settings.clozeText);
                        }

                        if (!ankiNoteId) {
                            throw new Error(`Duplikat "${originalQ.substring(0, 20)}..." ID nicht gefunden.`);
                        } else {
                            notice.setMessage(`ID ${ankiNoteId} für Duplikat gefunden. Update...`);
                            if (card.type === 'Basic') {
                                const frontField = card.typeIn ? plugin.settings.typeInFront : plugin.settings.basicFront;
                                const backField = card.typeIn ? plugin.settings.typeInBack : plugin.settings.basicBack;
                                await updateAnkiNoteFields(ankiNoteId, frontField, backField, ankiFieldQ, ankiFieldA);
                            } else if (card.type === 'Cloze') {
                                await updateAnkiClozeNoteFields(ankiNoteId, plugin.settings.clozeText, ankiClozeTextField);
                            }
                        }
                    } else { throw e; }
                }
            }
            updatedCardsWithIds.push({ ...card, id: ankiNoteId });
        }

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
