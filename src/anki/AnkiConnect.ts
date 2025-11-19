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

export async function findAnkiNoteId(front: string, frontFieldName: string): Promise<number | null> {
	const escapedFront = front.replace(/"/g, '\\"');
	// Suche dynamisch nach dem Feldnamen
	const query = `${frontFieldName}:"${escapedFront}"`;
	const noteIds = await ankiConnectRequest('findNotes', { query });
	if (noteIds && noteIds.length > 0) {
		return noteIds[0];
	}
	return null;
}

export async function findAnkiClozeNoteId(questionText: string, textFieldName: string): Promise<number | null> {
	const searchQuery = questionText.replace(/____/g, '*').replace(/"/g, '\\"');
	// Suche dynamisch nach dem Textfeld
	const query = `${textFieldName}:"${searchQuery}"`;
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

export async function addAnkiNote(deckName: string, modelName: string, frontField: string, backField: string, front: string, back: string): Promise<number> {
	const fields: any = {};
	fields[frontField] = front;
	fields[backField] = back;

	const result = await ankiConnectRequest('addNote', {
		note: {
			deckName,
			modelName,
			fields: fields,
			tags: []
		}
	});
	if (typeof result !== 'number') {
		throw new Error(`Ungültige Note ID von addNote zurückgegeben: ${result}`);
	}
	return result;
}

export async function addAnkiClozeNote(deckName: string, modelName: string, textField: string, text: string): Promise<number> {
	const fields: any = {};
	fields[textField] = text;

	const result = await ankiConnectRequest('addNote', {
		note: {
			deckName,
			modelName,
			fields: fields,
			tags: []
		}
	});
	if (typeof result !== 'number') {
		throw new Error(`Ungültige Note ID von addNote (Cloze) zurückgegeben: ${result}`);
	}
	return result;
}

export async function updateAnkiNoteFields(id: number, frontField: string, backField: string, front: string, back: string): Promise<void> {
	const fields: any = {};
	fields[frontField] = front;
	fields[backField] = back;

	return ankiConnectRequest('updateNoteFields', {
		note: {
			id,
			fields: fields
		}
	});
}

export async function updateAnkiClozeNoteFields(id: number, textField: string, textWithCloze: string): Promise<void> {
	const fields: any = {};
	fields[textField] = textWithCloze;

	return ankiConnectRequest('updateNoteFields', {
		note: {
			id,
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
