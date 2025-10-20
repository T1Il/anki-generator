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

// Sucht global, um Ankis Verhalten nachzuahmen
export async function findAnkiNoteId(front: string): Promise<number | null> {
	const escapedFront = front.replace(/"/g, '\\"');
	const query = `"${escapedFront}"`; // Sucht in allen relevanten Feldern
	const noteIds = await ankiConnectRequest('findNotes', { query });
	if (noteIds && noteIds.length > 0) {
		return noteIds[0];
	}
	return null;
}

// Sucht global, um Ankis Verhalten nachzuahmen
export async function findAnkiClozeNoteId(questionText: string): Promise<number | null> {
	const searchQuery = questionText.replace(/____/g, '*').replace(/"/g, '\\"');
	const query = `"*${searchQuery}*"`; // Sucht in allen relevanten Feldern
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
