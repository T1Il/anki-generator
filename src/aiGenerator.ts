import { requestUrl, Notice } from 'obsidian';
import { AnkiGeneratorSettings } from './settings';

export async function generateCardsWithAI(
	noteContent: string,
	existingCards: string,
	provider: 'gemini' | 'ollama',
	settings: AnkiGeneratorSettings
): Promise<string> {

	const finalPrompt = settings.prompt
		.replace('{{noteContent}}', noteContent)
		.replace('{{existingCards}}', existingCards);

	console.log(`--- Prompt sent to ${provider} ---\n${finalPrompt}\n--- End Prompt ---`);

	let apiUrl = "";
	let requestBody: any = {};
	let requestBodyString = "";

	if (provider === 'gemini') {
		if (!settings.geminiApiKey) throw new Error("Gemini API Key nicht gesetzt.");
		apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${settings.geminiApiKey}`;
		requestBody = { contents: [{ parts: [{ text: finalPrompt }] }] };
	} else if (provider === 'ollama') {
		if (!settings.ollamaEndpoint || !settings.ollamaModel) throw new Error("Ollama Endpunkt oder Modell nicht konfiguriert.");
		apiUrl = settings.ollamaEndpoint;
		requestBody = { model: settings.ollamaModel, prompt: finalPrompt, stream: false };
	} else {
		throw new Error("Ungültiger AI Provider angegeben.");
	}

	requestBodyString = JSON.stringify(requestBody);

	try {
		const response = await requestUrl({
			url: apiUrl,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: requestBodyString,
			throw: false // Wir behandeln Fehler manuell
		});

		const responseJson = response.json;

		if (response.status >= 300) {
			// Fehlerbehandlung für API-Fehler
			handleApiError(provider, response.status, responseJson, requestBodyString);
			return ""; // Im Fehlerfall leeren String zurückgeben oder Fehler werfen? Vorerst leer.
		}

		// Erfolgreiche Antwortverarbeitung
		if (provider === 'gemini') {
			if (!responseJson?.candidates?.[0]?.content?.parts?.[0]?.text) {
				console.error("Unerwartete Antwortstruktur von Gemini:", responseJson);
				throw new Error("Unerwartete Antwortstruktur von Gemini.");
			}
			return responseJson.candidates[0].content.parts[0].text.trim();
		} else if (provider === 'ollama') {
			if (typeof responseJson?.response !== 'string') {
				console.error("Unerwartete Antwortstruktur von Ollama:", responseJson);
				throw new Error("Unerwartete Antwortstruktur von Ollama.");
			}
			return responseJson.response.trim();
		}

	} catch (error) {
		// Netzwerkfehler oder andere unerwartete Fehler
		console.error(`Unerwarteter Fehler bei der Anfrage an ${provider}:`, error);
		const err = new Error(`Netzwerkfehler oder unerwarteter Fehler bei ${provider}. Details siehe Konsole.`);
		// @ts-ignore
		err.requestBody = requestBodyString; // Hänge Request Body an für Debugging
		// @ts-ignore
		err.debugDetails = error.stack || error.message;
		throw err; // Werfe den Fehler weiter, damit er im generationManager behandelt wird
	}
	return ""; // Sollte nie erreicht werden
}

// Hilfsfunktion zur strukturierten Fehlerbehandlung von API-Antworten
function handleApiError(provider: string, status: number, responseJson: any, requestBodyString: string) {
	let userFriendlyMessage = `API Fehler (${provider}, Status ${status})`;
	let errorDetails = `Status: ${status}\nBody:\n${JSON.stringify(responseJson, null, 2)}`;
	let isOverloaded = false;
	let isNetworkError = status === 0; // requestUrl gibt 0 bei Netzwerkfehlern

	if (responseJson?.error?.message) {
		const apiMessage = responseJson.error.message;
		userFriendlyMessage = `API Fehler (${provider}, ${status}): ${apiMessage}`;
		if (provider === 'gemini' && status === 503 && apiMessage.toLowerCase().includes("overloaded")) {
			isOverloaded = true;
		}
	} else if (status >= 500 && !isNetworkError) {
		userFriendlyMessage = `API Serverfehler (${provider}, Status ${status}). Prüfe Serverstatus.`;
		isOverloaded = true; // Annahme bei 5xx
	} else if (status >= 400 && !isNetworkError) {
		userFriendlyMessage = `API Client-Fehler (${provider}, Status ${status}). Prüfe API Key oder Anfrage.`;
	} else if (isNetworkError) {
		userFriendlyMessage = `Netzwerkfehler beim Verbinden mit ${provider}. Läuft der Dienst?`;
	}

	const error = new Error(userFriendlyMessage);
	// @ts-ignore
	error.debugDetails = errorDetails;
	// @ts-ignore
	error.isOverloaded = isOverloaded;
	// @ts-ignore
	error.isNetworkError = isNetworkError;
	// @ts-ignore
	error.requestBody = requestBodyString;
	throw error; // Werfe den aufbereiteten Fehler
}
