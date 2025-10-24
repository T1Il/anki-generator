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
			console.log(json);
			throw new Error(json.error);
		}
		return json.result;
	} catch (e) {
		console.log(params);
		console.log(e.body);
		console.error("Rohes Fehlerobjekt von ankiConnectRequest:", e);
		throw new Error(`AnkiConnect-Anfrage fehlgeschlagen. Ursprünglicher Fehler: ${e.message}`);
	}
}

export async function getCardCountForDeck(deckName: string): Promise<number> {
	const result = await ankiConnectRequest('findCards', { query: `deck:"${deckName}"` });
	return result ? result.length : 0;
}

// --- MODIFIZIERTE SUCHE ---
// Sucht nun gezielt im "Front"-Feld nach einer exakten Übereinstimmung.
export async function findAnkiNoteId(front: string): Promise<number | null> {
	const escapedFront = front.replace(/"/g, '\\"');
	// Anki's Duplikat-Check für "Basic"-Karten prüft standardmäßig das "Front"-Feld.
	const query = `Front:"${escapedFront}"`;
	const noteIds = await ankiConnectRequest('findNotes', { query });
	if (noteIds && noteIds.length > 0) {
		return noteIds[0];
	}
	return null;
}

// --- MODIFIZIERTE SUCHE ---
// Sucht nun gezielt im "Text"-Feld.
export async function findAnkiClozeNoteId(questionText: string): Promise<number | null> {
	// Ersetzt ____ mit der Anki-Wildcard *
	const searchQuery = questionText.replace(/____/g, '*').replace(/"/g, '\\"');
	// Anki's Duplikat-Check für "Cloze"-Karten prüft das "Text"-Feld (das erste Feld).
	// Diese Suche ist viel genauer als die alte `"*...*"`-Suche.
	const query = `Text:"${searchQuery}"`;
	const noteIds = await ankiConnectRequest('findNotes', { query });
	if (noteIds && noteIds.length > 0) {
		return noteIds[0];
	}
	return null;
}
// --- ENDE DER MODIFIKATIONEN ---

export async function deleteAnkiNotes(noteIds: number[]): Promise<void> {
	if (noteIds.length === 0) return;
	return ankiConnectRequest('deleteNotes', { notes: noteIds });
}

export async function createAnkiDeck(deckName: string): Promise<void> {
	return ankiConnectRequest('createDeck', { deck: deckName });
}

export async function addAnkiNote(deckName: string, modelName: string, front: string, back: string): Promise<number> {
	return ankiConnectRequest('addNote', {
		note: {
			deckName,
			modelName,
			fields: { Front: front, Back: back },
			tags: []
		}
	});
}

export async function addAnkiClozeNote(deckName: string, modelName: string, text: string): Promise<number> {
	return ankiConnectRequest('addNote', {
		note: {
			deckName,
			modelName,
			fields: { Text: text },
			tags: []
		}
	});
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
	return ankiConnectRequest('updateNoteFields', {
		note: {
			id,
			fields: { Text: textWithCloze }
		}
	});
}
