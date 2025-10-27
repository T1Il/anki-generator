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
			console.log("AnkiConnect Error:", json.error, "Params:", params); // Log bei Fehler
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

export async function findAnkiNoteId(front: string): Promise<number | null> {
	const escapedFront = front.replace(/"/g, '\\"');
	const query = `Front:"${escapedFront}"`;
	const noteIds = await ankiConnectRequest('findNotes', { query });
	if (noteIds && noteIds.length > 0) {
		return noteIds[0];
	}
	return null;
}

export async function findAnkiClozeNoteId(questionText: string): Promise<number | null> {
	// WICHTIG: Suche nach dem Feld *ohne* die Cloze-Ersetzung, aber mit Wildcard statt ____
	const searchQuery = questionText.replace(/____/g, '*').replace(/"/g, '\\"');
	// Standardmäßig heißt das erste Feld bei Cloze-Notizen "Text"
	const query = `Text:"${searchQuery}"`;
	const noteIds = await ankiConnectRequest('findNotes', { query });
	if (noteIds && noteIds.length > 0) {
		return noteIds[0];
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

export async function addAnkiNote(deckName: string, modelName: string, front: string, back: string): Promise<number> {
	const result = await ankiConnectRequest('addNote', {
		note: {
			deckName,
			modelName,
			fields: { Front: front, Back: back },
			tags: []
		}
	});
	if (typeof result !== 'number') {
		throw new Error(`Ungültige Note ID von addNote zurückgegeben: ${result}`);
	}
	return result;
}

export async function addAnkiClozeNote(deckName: string, modelName: string, text: string): Promise<number> {
	// Der 'text' Parameter sollte hier bereits den formatierten Cloze-Text enthalten (z.B. "Hauptstadt ist {{c1::Berlin}}.")
	const result = await ankiConnectRequest('addNote', {
		note: {
			deckName,
			modelName,
			// Standardmäßig heißt das Feld für Cloze "Text"
			fields: { Text: text },
			tags: []
		}
	});
	if (typeof result !== 'number') {
		throw new Error(`Ungültige Note ID von addNote (Cloze) zurückgegeben: ${result}`);
	}
	return result;
}

export async function updateAnkiNoteFields(id: number, front: string, back: string): Promise<void> {
	return ankiConnectRequest('updateNoteFields', {
		note: {
			id,
			fields: { Front: front, Back: back }
		}
	});
}

export async function updateAnkiClozeNoteFields(id: number, textWithCloze: string): Promise<void> {
	// Der 'textWithCloze' Parameter enthält den vollständigen Text mit {{c1::...}}
	return ankiConnectRequest('updateNoteFields', {
		note: {
			id,
			// Standardmäßig heißt das Feld für Cloze "Text"
			fields: { Text: textWithCloze }
		}
	});
}

// --- NEUE FUNKTION ZUM HOCHLADEN VON MEDIEN ---
export async function storeAnkiMediaFile(filename: string, base64Data: string): Promise<string> {
	try {
		const result = await ankiConnectRequest('storeMediaFile', {
			filename: filename, // Gewünschter Dateiname
			data: base64Data    // Bilddaten als Base64-String
		});
		if (!result || typeof result !== 'string') {
			throw new Error(`Anki hat keinen gültigen Dateinamen für ${filename} zurückgegeben (Antwort: ${result}).`);
		}
		// Anki gibt den tatsächlich verwendeten Dateinamen zurück
		return result;
	} catch (e) {
		console.error(`Fehler beim Speichern der Mediendatei ${filename} in Anki:`, e);
		throw new Error(`Konnte Mediendatei ${filename} nicht in Anki speichern. ${e.message}`);
	}
}
// --- ENDE NEUE FUNKTION ---
