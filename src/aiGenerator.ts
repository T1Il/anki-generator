// src/aiGenerator.ts

import { requestUrl, Notice, App } from 'obsidian';
import { AnkiGeneratorSettings, DEFAULT_SETTINGS } from './settings';
import { DebugModal } from './ui/DebugModal';
import { ImageInput } from './types';

export async function generateCardsWithAI(
	app: App,
	noteContent: string,
	existingCards: string,
	provider: 'gemini' | 'ollama',
	settings: AnkiGeneratorSettings,
	additionalInstructions: string | null,
	images: ImageInput[] = [] // Neuer Parameter für Bilder
): Promise<string> {

	let basePrompt = settings.prompt;
	if (typeof basePrompt !== 'string') {
		console.warn("generateCardsWithAI: settings.prompt war kein String. Fallback auf DEFAULT_SETTINGS.prompt.");
		basePrompt = DEFAULT_SETTINGS.prompt;
		if (typeof basePrompt !== 'string') {
			throw new Error("Interner Fehler: Standard-Prompt ist ungültig.");
		}
	}

	// --- NEU: Zusätzliche Anweisungen an spezifischer Stelle einfügen ---
	let finalPrompt = basePrompt; // Starte mit dem Basis-Prompt
	if (additionalInstructions && additionalInstructions.trim().length > 0) {
		const insertionMarker = "Hier ist der Text"; // Die Zeile, *vor* der eingefügt werden soll
		const markerIndex = basePrompt.indexOf(insertionMarker);

		if (markerIndex !== -1) {
			// Füge die Anweisungen VOR dem Marker ein
			const beforeMarker = basePrompt.substring(0, markerIndex);
			const afterMarker = basePrompt.substring(markerIndex);
			finalPrompt = `${beforeMarker.trimRight()}\n\n**Zusätzliche Anweisungen für diese Generierung:**\n${additionalInstructions.trim()}\n\n${afterMarker.trimLeft()}`;
			console.log("Zusätzliche Anweisungen vor dem Text-Marker eingefügt.");

		} else {
			// Fallback: Füge die Anweisungen ganz am Anfang ein (wie zuvor)
			console.warn("Konnte den Einfüge-Marker im Prompt nicht finden. Füge zusätzliche Anweisungen am Anfang ein.");
			finalPrompt = `${additionalInstructions.trim()}\n\n---\n\n${basePrompt}`;
		}
	}
	// --- ENDE NEU ---

	// Ersetze Platzhalter erst *nach* dem Einfügen der zusätzlichen Anweisungen
	finalPrompt = finalPrompt
		.replace('{{noteContent}}', noteContent)
		.replace('{{existingCards}}', existingCards);


	console.log(`--- Prompt sent to ${provider} (Images: ${images.length}) ---\n${finalPrompt.substring(0, 8000)}...\n--- End Prompt ---`);

	let apiUrl = "";
	let requestBody: any = {};
	let requestBodyString = "";

	if (provider === 'gemini') {
		if (!settings.geminiApiKey) throw new Error("Gemini API Key nicht gesetzt.");
		apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${settings.geminiApiKey}`;

		// Aufbau des Multimodal-Requests für Gemini
		const parts: any[] = [{ text: finalPrompt }];

		// Bilder als inline_data hinzufügen
		images.forEach(img => {
			parts.push({
				inline_data: {
					mime_type: img.mimeType,
					data: img.base64
				}
			});
		});

		requestBody = { contents: [{ parts: parts }] };

	} else if (provider === 'ollama') {
		if (!settings.ollamaEndpoint || !settings.ollamaModel) throw new Error("Ollama Endpunkt oder Modell nicht konfiguriert.");
		apiUrl = settings.ollamaEndpoint;

		requestBody = {
			model: settings.ollamaModel,
			prompt: finalPrompt,
			stream: false
		};

		// Wenn Bilder vorhanden sind, füge sie für Ollama hinzu (erwartet Array von base64 Strings)
		if (images.length > 0) {
			requestBody.images = images.map(img => img.base64);
		}
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
			throw: false
		});

		const responseJson = response.json;

		if (response.status >= 300) {
			handleApiError(app, provider, response.status, responseJson, requestBodyString);
			return "";
		}

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
		console.error(`Unerwarteter Fehler bei der Anfrage an ${provider}:`, error);
		const err = new Error(`Netzwerkfehler oder unerwarteter Fehler bei ${provider}. Details siehe Konsole.`);
		// @ts-ignore
		err.requestBody = requestBodyString;
		// @ts-ignore
		err.debugDetails = error.stack || error.message;
		throw err;
	}
	return "";
}

// handleApiError bleibt unverändert
function handleApiError(app: App, provider: string, status: number, responseJson: any, requestBodyString: string) {
	let userFriendlyMessage = `API Fehler (${provider}, Status ${status})`;
	let errorDetails = `Status: ${status}\nBody:\n${JSON.stringify(responseJson, null, 2)}`;
	let isOverloaded = false;
	let isNetworkError = status === 0;

	if (responseJson?.error?.message) {
		const apiMessage = responseJson.error.message;
		userFriendlyMessage = `API Fehler (${provider}, ${status}): ${apiMessage}`;
		if (provider === 'gemini' && status === 503 && apiMessage.toLowerCase().includes("overloaded")) {
			isOverloaded = true;
		}
	} else if (status >= 500 && !isNetworkError) {
		userFriendlyMessage = `API Serverfehler (${provider}, Status ${status}). Prüfe Serverstatus.`;
		isOverloaded = true;
	} else if (status >= 400 && !isNetworkError) {
		userFriendlyMessage = `API Client-Fehler (${provider}, Status ${status}). Prüfe API Key oder Anfrage.`;
	} else if (isNetworkError) {
		userFriendlyMessage = `Netzwerkfehler beim Verbinden mit ${provider}. Läuft der Dienst?`;
	}

	if (!isOverloaded || provider !== 'gemini') {
		new DebugModal(app, requestBodyString, errorDetails).open();
		new Notice(userFriendlyMessage + " Details im Modal.", 10000);
	} else {
		new Notice(userFriendlyMessage, 10000);
	}

	const error = new Error(userFriendlyMessage);
	// @ts-ignore
	error.isOverloaded = isOverloaded;
	// @ts-ignore
	error.isNetworkError = isNetworkError;
	throw error;
}
