import { requestUrl } from 'obsidian';

async function ankiConnectRequest(action: string, params: object): Promise<any> {
	try {
		const response = await requestUrl({
			url: 'http://127.0.0.1:8765',
			method: 'POST',
			body: JSON.stringify({ action, version: 6, params }),
			headers: { 'Content-Type': 'application/json' },
		});
		const json = response.json;
		if (json.error) { throw new Error(json.error); }
		return json.result;
	} catch (e) {
		throw new Error("Konnte AnkiConnect nicht erreichen. Läuft Anki im Hintergrund?");
	}
}

export async function addAnkiNote(deckName: string, front: string, back: string): Promise<number> {
	return ankiConnectRequest('addNote', { note: { deckName, modelName: "Basic", fields: { Front: front, Back: back }, tags: [] } });
}

export async function updateAnkiNoteFields(id: number, front: string, back: string): Promise<void> {
	return ankiConnectRequest('updateNoteFields', { note: { id, fields: { Front: front, Back: back } } });
}
