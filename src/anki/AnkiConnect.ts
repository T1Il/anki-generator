import { requestUrl } from 'obsidian';

async function ankiConnectRequest(action: string, params: object): Promise<any> {
	try {
		const response = await requestUrl({
			url: 'http://localhost:8765',
			method: 'POST',
			body: JSON.stringify({ action, version: 6, params }),
			headers: { 'Content-Type': 'application/json' },
		});
		const json = response.json;
		if (json.error) {
			console.log("AnkiConnect Error:", json.error, "Params:", params);
			throw new Error(json.error);
		}
		return json.result;
	} catch (e) {
		console.log("Request Params causing error:", params);
		// @ts-ignore
		if (e.body) console.log("Error Body:", e.body);
		console.error("Rohes Fehlerobjekt von ankiConnectRequest:", e);
		// @ts-ignore
		throw new Error(`AnkiConnect-Anfrage fehlgeschlagen für Aktion '${action}'. Ursprünglicher Fehler: ${e.message || e}`);
	}
}

export async function getCardCountForDeck(deckName: string): Promise<number> {
	const result = await ankiConnectRequest('findCards', { query: `deck:"${deckName}"` });
	return result ? result.length : 0;
}

export async function getNotesInfo(noteIds: number[]): Promise<any[]> {
    if (noteIds.length === 0) return [];
    return ankiConnectRequest('notesInfo', { notes: noteIds });
}

export async function findAnkiNoteId(front: string, frontFieldName: string, deckName?: string): Promise<number | null> {
    // 1. First attempt: Strict exact match (fastest)
    const escapedFront = front.replace(/"/g, '\\"');
    const exactQuery = `${frontFieldName}:"${escapedFront}"`;
    let noteIds = await ankiConnectRequest('findNotes', { query: exactQuery });
    
    if (noteIds && noteIds.length > 0) return noteIds[0];

    // 2. Second attempt: Search by substring
    const safeFront = front.replace(/["':\(\)]/g, " ").replace(/\s+/g, " ").trim().substring(0, 50);
    if (safeFront.length > 5) {
        const sloppyQuery = `${frontFieldName}:"${safeFront}*"`;
        noteIds = await ankiConnectRequest('findNotes', { query: sloppyQuery });

        if (noteIds && noteIds.length > 0) {
            const notesInfo = await getNotesInfo(noteIds);
            for (const note of notesInfo) {
                if (note.fields && note.fields[frontFieldName] && note.fields[frontFieldName].value === front) {
                    return note.noteId;
                }
            }
            if (noteIds.length === 1) return noteIds[0]; 
        }
    }

    // 3. Fallback: Search ENTIRE DECK (Heavy, but guaranteed to find it if it exists)
    if (deckName) {
         console.log(`Fallback: Searching entire deck '${deckName}' for duplicate...`);
         console.log(`Fallback: Looking for front field '${frontFieldName}' with content length ${front.length}`);
         // Limit to cards in that deck
         const allDeckNotes = await ankiConnectRequest('findNotes', { query: `deck:"${deckName}"` });
         if (allDeckNotes && allDeckNotes.length > 0) {
             console.log(`Fallback: Found ${allDeckNotes.length} notes in deck. Scanning content...`);
             // We process in chunks to avoid overwhelming notesInfo
             const chunkSize = 20; // Smaller chunk for debug safety
             for (let i = 0; i < allDeckNotes.length; i += chunkSize) {
                 const chunk = allDeckNotes.slice(i, i + chunkSize);
                 const chunkInfo = await getNotesInfo(chunk);
                 for (const note of chunkInfo) {
                     if (note.fields && note.fields[frontFieldName]) {
                         const val = note.fields[frontFieldName].value;
                         if (val === front) {
                             console.log("Fallback: Found duplicate via EXACT deck scan!");
                             return note.noteId;
                         }
                         // Debug: Print near misses or just the first few invalid ones to see format
                         if (val.includes(front.substring(0, 20))) {
                             console.log(`Fallback: Potential match found but equality failed. \nAnki: '${val}'\nObsidian: '${front}'`);
                             
                             // FIX: Strip HTML tags for comparison (Anki might have <b>, <i> etc.)
                             const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '');
                             const cleanVal = stripHtml(val).trim();
                             const cleanFront = stripHtml(front).trim();

                             if (cleanVal === cleanFront) {
                                  console.log("Fallback: Found duplicate via STRIPPED HTML check!");
                                  return note.noteId;
                             }
                         }
                     }
                 }
             }
         } else {
             console.log("Fallback: No notes returned for deck query.");
         }
    }
    
    return null;
}

export async function findAnkiClozeNoteId(questionText: string, textFieldName: string, deckName?: string): Promise<number | null> {
    // 1. First attempt: Standard strict search
    const searchQuery = questionText.replace(/____/g, '*').replace(/"/g, '\\"');
    const query = `${textFieldName}:"${searchQuery}"`;
    let noteIds = await ankiConnectRequest('findNotes', { query });
    
    if (noteIds && noteIds.length > 0) return noteIds[0];

    // 2. Fallback: Search by clean substring
    const cleanText = questionText.substring(0, 50).replace(/["':\(\)\{\}]/g, " ").trim();
    if (cleanText.length > 5) {
        const sloppyQuery = `${textFieldName}:"${cleanText}*"`;
        noteIds = await ankiConnectRequest('findNotes', { query: sloppyQuery });
         if (noteIds && noteIds.length > 0) {
            // Verify
            const notesInfo = await getNotesInfo(noteIds);
            for (const note of notesInfo) {
                if (note.fields && note.fields[textFieldName] && note.fields[textFieldName].value === questionText) {
                    return note.noteId;
                }
            }
             if (noteIds.length === 1) return noteIds[0]; 
        }
    }

    // 3. Fallback: Search ENTIRE DECK
    if (deckName) {
         const allDeckNotes = await ankiConnectRequest('findNotes', { query: `deck:"${deckName}"` });
         if (allDeckNotes && allDeckNotes.length > 0) {
             const chunkSize = 50;
             for (let i = 0; i < allDeckNotes.length; i += chunkSize) {
                 const chunk = allDeckNotes.slice(i, i + chunkSize);
                 const chunkInfo = await getNotesInfo(chunk);
                 for (const note of chunkInfo) {
                     if (note.fields && note.fields[textFieldName] && note.fields[textFieldName].value === questionText) {
                         return note.noteId;
                     }
                 }
             }
         }
    }

    return null;
}

export async function deleteAnkiNotes(noteIds: number[]): Promise<void> {
	if (noteIds.length === 0) return;
	return ankiConnectRequest('deleteNotes', { notes: noteIds });
}

export async function createAnkiDeck(deckName: string): Promise<void> {
	return ankiConnectRequest('createDeck', { deck: deckName });
}

export async function deleteAnkiDeck(deckName: string): Promise<void> {
	console.log(`Lösche Deck '${deckName}'`);
	return ankiConnectRequest('deleteDecks', { decks: [deckName], cardsToo: true });
}

export async function getDeckNames(): Promise<string[]> {
	try {
		const result = await ankiConnectRequest('deckNames', {});
		return result || [];
	} catch (e) {
		console.error("Error fetching deck names:", e);
		return [];
	}
}

export async function getModelFieldNames(modelName: string): Promise<string[]> {
	try {
		const result = await ankiConnectRequest('modelFieldNames', { modelName });
		return result || [];
	} catch (e) {
		console.error(`Error fetching field names for model ${modelName}:`, e);
		return [];
	}
}

export async function addAnkiNote(deckName: string, modelName: string, frontField: string, backField: string, front: string, back: string): Promise<number> {
	const fields: any = {};
	fields[frontField] = front;
	fields[backField] = back;

	const result = await ankiConnectRequest('addNote', {
		note: {
			deckName: deckName,
			modelName: modelName,
			fields: fields,
			tags: ['obsidian-anki-generator']
		}
	});
	return result;
}

export async function addAnkiClozeNote(deckName: string, modelName: string, textField: string, text: string): Promise<number> {
	const fields: any = {};
	fields[textField] = text;

	const result = await ankiConnectRequest('addNote', {
		note: {
			deckName: deckName,
			modelName: modelName,
			fields: fields,
			tags: ['obsidian-anki-generator']
		}
	});
	return result;
}

export async function updateAnkiNoteFields(noteId: number, frontField: string, backField: string, front: string, back: string): Promise<void> {
	const fields: any = {};
	fields[frontField] = front;
	fields[backField] = back;

	return ankiConnectRequest('updateNoteFields', {
		note: {
			id: noteId,
			fields: fields
		}
	});
}

export async function updateAnkiClozeNoteFields(noteId: number, textField: string, text: string): Promise<void> {
	const fields: any = {};
	fields[textField] = text;

	return ankiConnectRequest('updateNoteFields', {
		note: {
			id: noteId,
			fields: fields
		}
	});
}

export async function storeAnkiMediaFile(filename: string, base64Data: string): Promise<string> {
	try {
		const result = await ankiConnectRequest('storeMediaFile', {
			filename: filename,
			data: base64Data
		});
		if (!result || typeof result !== 'string') {
			throw new Error(`Anki hat keinen gültigen Dateinamen für ${filename} zurückgegeben (Antwort: ${result}).`);
		}
		return result;
	} catch (e) {
		console.error(`Fehler beim Speichern der Mediendatei ${filename} in Anki:`, e);
		throw new Error(`Konnte Mediendatei ${filename} nicht in Anki speichern. ${e.message}`);
	}
}

export async function getCardIdsForNote(noteId: number): Promise<number[]> {
	console.log(`Suche Karten für Note ID: ${noteId}`);
	const result = await ankiConnectRequest('findCards', { query: `nid:${noteId}` });
	console.log(`Gefundene Karten für Note ${noteId}:`, result);
	return result || [];
}

export async function changeDeck(cardIds: number[], deckName: string): Promise<void> {
	if (cardIds.length === 0) return;
	console.log(`Verschiebe Karten ${cardIds} nach Deck '${deckName}'`);
	return ankiConnectRequest('changeDeck', { cards: cardIds, deck: deckName });
}

export async function moveAnkiNotesToDeck(noteIds: number[], deckName: string): Promise<void> {
	if (noteIds.length === 0) return;

	console.log(`Starte Verschieben von ${noteIds.length} Notes nach '${deckName}'`);

	// First ensure the deck exists
	await createAnkiDeck(deckName);

	// For each note, find its cards and move them
	for (const noteId of noteIds) {
		const cardIds = await getCardIdsForNote(noteId);
		if (cardIds.length > 0) {
			await changeDeck(cardIds, deckName);
		} else {
			console.warn(`Keine Karten für Note ID ${noteId} gefunden.`);
		}
	}
}
