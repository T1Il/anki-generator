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
	let noteIds: any = null;

	// 1. First attempt: Strict exact match (fastest) - KEEP HTML for exact match
	const escapedFront = front.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const exactQuery = `${frontFieldName}:"${escapedFront}"`;
	noteIds = await ankiConnectRequest('findNotes', { query: exactQuery });
	if (noteIds && noteIds.length > 0) return noteIds[0];

	// Helper to strip HTML and decode entities
	const normalizeText = (html: string) => {
		// 1. Strip Tags
		let text = html.replace(/<[^>]*>/g, ' ');
		// 2. Decode common entities
		text = text.replace(/&nbsp;/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"');
		// 3. Normalize whitespace (collapse multiple spaces/newlines to single space)
		return text.replace(/\s+/g, ' ').trim();
	};

	const cleanAuthoredFront = normalizeText(front);

	// 2. Second attempt: Search by substring (HTML stripped)
	const safeFront = cleanAuthoredFront.substring(0, 50).replace(/["':\(\)]/g, " ").trim();
	if (safeFront.length > 5) {
		const sloppyQuery = `${frontFieldName}:"${safeFront}*"`;
		noteIds = await ankiConnectRequest('findNotes', { query: sloppyQuery });

		if (noteIds && noteIds.length > 0) {
			const notesInfo = await getNotesInfo(noteIds);
			for (const note of notesInfo) {
				// Strict check
				if (note.fields && note.fields[frontFieldName] && note.fields[frontFieldName].value === front) {
					return note.noteId;
				}
				// Relaxed check
				if (note.fields && note.fields[frontFieldName]) {
					const val = note.fields[frontFieldName].value;
					const cleanVal = normalizeText(val);
					if (cleanVal === cleanAuthoredFront) return note.noteId;
				}
			}
			if (noteIds.length === 1) return noteIds[0];
		}
	}

	// 2.5a: Broad Search in Deck (SafeFront is now HTML-free)
	if (deckName && safeFront.length > 5) {
		const broadQuery = `deck:"${deckName}" "${safeFront}*"`;
		try {
			noteIds = await ankiConnectRequest('findNotes', { query: broadQuery });

			if (noteIds && noteIds.length > 0) {
				const notesInfo = await getNotesInfo(noteIds);
				for (const note of notesInfo) {
					if (note.fields && note.fields[frontFieldName] && note.fields[frontFieldName].value === front) return note.noteId;
					if (note.fields) {
						const values = Object.values(note.fields).map((f: any) => f.value);
						if (values.includes(front)) return note.noteId;
						// Relaxed check on all fields
						const cleanValues = values.map((v: string) => normalizeText(v));
						if (cleanValues.includes(cleanAuthoredFront)) return note.noteId;
					}
				}
				if (noteIds.length === 1) return noteIds[0];
			}
		} catch (e) { /* ignore */ }
	}

	// 2.5b: Global Broad Search
	if (safeFront.length > 5) {
		const globalQuery = `"${safeFront}*"`;
		try {
			noteIds = await ankiConnectRequest('findNotes', { query: globalQuery });

			if (noteIds && noteIds.length > 0) {
				const notesInfo = await getNotesInfo(noteIds);
				for (const note of notesInfo) {
					if (note.fields && note.fields[frontFieldName] && note.fields[frontFieldName].value === front) return note.noteId;
					if (note.fields && note.fields[frontFieldName] && note.fields[frontFieldName].value.includes(front)) return note.noteId;
					// Relaxed check
					if (note.fields && note.fields[frontFieldName]) {
						const val = note.fields[frontFieldName].value;
						if (normalizeText(val) === cleanAuthoredFront) return note.noteId;
					}
				}
				if (noteIds.length === 1) return noteIds[0];
			}
		} catch (e) { /* ignore */ }
	}

	// 3. Fallback: Search ENTIRE DECK (Heavy)
	if (deckName) {
		const allDeckNotes = await ankiConnectRequest('findNotes', { query: `deck:"${deckName}"` });

		if (allDeckNotes && allDeckNotes.length > 0) {
			const chunkSize = 20;
			for (let i = 0; i < allDeckNotes.length; i += chunkSize) {
				const chunk = allDeckNotes.slice(i, i + chunkSize);
				const chunkInfo = await getNotesInfo(chunk);
				for (const note of chunkInfo) {
					if (note.fields && note.fields[frontFieldName]) {
						const val = note.fields[frontFieldName].value;
						if (val === front) return note.noteId;
						if (val.includes(front.substring(0, 20))) {
							if (normalizeText(val) === cleanAuthoredFront) return note.noteId;
						}
					}
				}
			}
		}
	}

	return null;
}

export async function findAnkiClozeNoteId(questionText: string, textFieldName: string, deckName?: string): Promise<number | null> {
	let noteIds: any = null;

	// 1. First attempt: Standard strict search
	const searchQuery = questionText.replace(/\\/g, '\\\\').replace(/____/g, '*').replace(/"/g, '\\"');
	const exactQuery = `${textFieldName}:"${searchQuery}"`;
	noteIds = await ankiConnectRequest('findNotes', { query: exactQuery });
	if (noteIds && noteIds.length > 0) return noteIds[0];

	// Helper to strip HTML and decode entities
	const normalizeText = (html: string) => {
		// 1. Strip Tags
		let text = html.replace(/<[^>]*>/g, ' ');
		// 2. Decode common entities
		text = text.replace(/&nbsp;/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"');
		// 3. Normalize whitespace (collapse multiple spaces/newlines to single space)
		return text.replace(/\s+/g, ' ').trim();
	};

	const cleanAuthoredText = normalizeText(questionText);

	// 2. Fallback: Search by clean substring
	const safeFront = cleanAuthoredText.substring(0, 50).replace(/["':\(\)\{\}]/g, " ").trim();
	if (safeFront.length > 5) {
		const sloppyQuery = `${textFieldName}:"${safeFront}*"`;
		noteIds = await ankiConnectRequest('findNotes', { query: sloppyQuery });

		if (noteIds && noteIds.length > 0) {
			const notesInfo = await getNotesInfo(noteIds);
			for (const note of notesInfo) {
				if (note.fields && note.fields[textFieldName] && note.fields[textFieldName].value === questionText) {
					return note.noteId;
				}
				if (note.fields && note.fields[textFieldName]) {
					const val = note.fields[textFieldName].value;
					const cleanVal = normalizeText(val);
					if (cleanVal === cleanAuthoredText) return note.noteId;
				}
			}
			if (noteIds.length === 1) return noteIds[0];
		}
	}

	// 2.5a: Broad search for Cloze in Deck
	if (deckName && safeFront.length > 5) {
		const broadQuery = `deck:"${deckName}" "${safeFront}*"`;
		try {
			noteIds = await ankiConnectRequest('findNotes', { query: broadQuery });

			if (noteIds && noteIds.length > 0) {
				const notesInfo = await getNotesInfo(noteIds);
				for (const note of notesInfo) {
					if (note.fields && note.fields[textFieldName] && note.fields[textFieldName].value === questionText) {
						return note.noteId;
					}
					if (note.fields) {
						const values = Object.values(note.fields).map((f: any) => f.value);
						if (values.includes(questionText)) return note.noteId;

						const cleanValues = values.map((v: string) => normalizeText(v));
						if (cleanValues.includes(cleanAuthoredText)) return note.noteId;
					}
				}
				if (noteIds.length === 1) return noteIds[0];
			}
		} catch (e) { /* ignore */ }
	}

	// 2.5b: Global Broad Search for Cloze
	if (safeFront.length > 5) {
		const globalQuery = `"${safeFront}*"`;
		try {
			noteIds = await ankiConnectRequest('findNotes', { query: globalQuery });

			if (noteIds && noteIds.length > 0) {
				const notesInfo = await getNotesInfo(noteIds);
				for (const note of notesInfo) {
					if (note.fields && note.fields[textFieldName] && note.fields[textFieldName].value === questionText) return note.noteId;
					if (note.fields && note.fields[textFieldName] && note.fields[textFieldName].value.includes(questionText)) return note.noteId;

					if (note.fields && note.fields[textFieldName]) {
						const val = note.fields[textFieldName].value;
						if (normalizeText(val) === cleanAuthoredText) return note.noteId;
					}
				}
				if (noteIds.length === 1) return noteIds[0];
			}
		} catch (e) { /* ignore */ }
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

	// Optimize: Parallelize the move operations with a concurrency limit
	const CONCURRENCY_LIMIT = 5;
	const chunkedPromises = [];

	for (let i = 0; i < noteIds.length; i += CONCURRENCY_LIMIT) {
		const chunk = noteIds.slice(i, i + CONCURRENCY_LIMIT);
		chunkedPromises.push(Promise.all(chunk.map(async (noteId) => {
			const cardIds = await getCardIdsForNote(noteId);
			if (cardIds.length > 0) {
				await changeDeck(cardIds, deckName);
			} else {
				console.warn(`Keine Karten für Note ID ${noteId} gefunden.`);
			}
		})));
	}

	await Promise.all(chunkedPromises);
}

export async function addAnkiNotes(notes: any[]): Promise<(number | null)[]> {
	if (notes.length === 0) return [];
	// AnkiConnect 'addNotes' action takes a list of notes
	return ankiConnectRequest('addNotes', { notes });
}

export async function storeAnkiMediaFiles(files: { filename: string, data: string }[]): Promise<string[]> {
	// Parallelize uploads with a concurrency limit to avoid overwhelming Anki
	const CONCURRENCY_LIMIT = 5;
	const results: string[] = new Array(files.length).fill("");

	for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
		const chunk = files.slice(i, i + CONCURRENCY_LIMIT).map((file, idx) => ({ file, originalIdx: i + idx }));
		await Promise.all(chunk.map(async ({ file, originalIdx }) => {
			try {
				const result = await storeAnkiMediaFile(file.filename, file.data);
				results[originalIdx] = result;
			} catch (e) {
				console.error(`Failed to batch store file ${file.filename}:`, e);
				results[originalIdx] = ""; // Marker for failure
			}
		}));
	}
	return results;
}
