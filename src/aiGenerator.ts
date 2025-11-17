// src/aiGenerator.ts

import { requestUrl, Notice, App } from 'obsidian';
import { AnkiGeneratorSettings, DEFAULT_SETTINGS } from './settings';
import { DebugModal } from './ui/DebugModal';
import { ImageInput } from './types';

export async function generateCardsWithAI(
	app: App,
	noteContent: string,
	existingCards: string,
	provider: 'gemini' | 'ollama' | 'openai',
	settings: AnkiGeneratorSettings,
	additionalInstructions: string | null,
	images: ImageInput[] = []
): Promise<string> {

	let basePrompt = settings.prompt;
	if (typeof basePrompt !== 'string') {
		console.warn("generateCardsWithAI: settings.prompt war kein String. Fallback auf DEFAULT_SETTINGS.prompt.");
		basePrompt = DEFAULT_SETTINGS.prompt;
		if (typeof basePrompt !== 'string') {
			throw new Error("Interner Fehler: Standard-Prompt ist ungültig.");
		}
	}

	let finalPrompt = basePrompt;
	if (additionalInstructions && additionalInstructions.trim().length > 0) {
		const insertionMarker = "Hier ist der Text";
		const markerIndex = basePrompt.indexOf(insertionMarker);

		if (markerIndex !== -1) {
			const beforeMarker = basePrompt.substring(0, markerIndex);
			const afterMarker = basePrompt.substring(markerIndex);
			finalPrompt = `${beforeMarker.trimRight()}\n\n**Zusätzliche Anweisungen für diese Generierung:**\n${additionalInstructions.trim()}\n\n${afterMarker.trimLeft()}`;
			console.log("Zusätzliche Anweisungen vor dem Text-Marker eingefügt.");

		} else {
			console.warn("Konnte den Einfüge-Marker im Prompt nicht finden. Füge zusätzliche Anweisungen am Anfang ein.");
			finalPrompt = `${additionalInstructions.trim()}\n\n---\n\n${basePrompt}`;
		}
	}

	finalPrompt = finalPrompt
		.replace('{{noteContent}}', noteContent)
		.replace('{{existingCards}}', existingCards);

	console.log(`--- Prompt sent to ${provider} (Images: ${images.length}) ---\n${finalPrompt.substring(0, 200)}...\n--- End Prompt ---`);

	let apiUrl = "";
	let requestBody: any = {};
	let requestHeaders: any = { 'Content-Type': 'application/json' };
	let requestBodyString = "";

	if (provider === 'gemini') {
		if (!settings.geminiApiKey) throw new Error("Gemini API Key nicht gesetzt.");

		const modelToUse = settings.geminiModel || 'gemini-1.5-pro';
		apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${settings.geminiApiKey}`;

		const parts: any[] = [{ text: finalPrompt }];
		images.forEach(img => {
			parts.push({
				inline_data: {
					mime_type: img.mimeType,
					data: img.base64
				}
			});
		});

		requestBody = { contents: [{ parts: parts }] };

	} else if (provider === 'openai') {
		if (!settings.openAiApiKey) throw new Error("OpenAI API Key nicht gesetzt.");

		apiUrl = 'https://api.openai.com/v1/chat/completions';
		requestHeaders['Authorization'] = `Bearer ${settings.openAiApiKey}`;

		const userContent: any[] = [{ type: "text", text: finalPrompt }];

		// Bilder für OpenAI hinzufügen (data URI Format)
		images.forEach(img => {
			userContent.push({
				type: "image_url",
				image_url: {
					url: `data:${img.mimeType};base64,${img.base64}`
				}
			});
		});

		requestBody = {
			model: settings.openAiModel || 'gpt-4o',
			messages: [
				{ role: "system", content: "Du bist ein hilfreicher Assistent, der Anki-Karten erstellt." },
				{ role: "user", content: userContent }
			]
		};

	} else if (provider === 'ollama') {
		if (!settings.ollamaEndpoint || !settings.ollamaModel) throw new Error("Ollama Endpunkt oder Modell nicht konfiguriert.");
		apiUrl = settings.ollamaEndpoint;

		requestBody = {
			model: settings.ollamaModel,
			prompt: finalPrompt,
			stream: false
		};

		if (images.length > 0) {
			requestBody.images = images.map(img => img.base64);
		}
	} else {
		throw new Error("Ungültiger AI Provider angegeben.");
	}

	requestBodyString = JSON.stringify(requestBody);
	console.log("Sende Request Body:", requestBodyString);

	try {
		const response = await requestUrl({
			url: apiUrl,
			method: 'POST',
			headers: requestHeaders,
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
				throw new Error("Unerwartete Antwortstruktur von Gemini.");
			}
			return responseJson.candidates[0].content.parts[0].text.trim();
		} else if (provider === 'openai') {
			if (!responseJson?.choices?.[0]?.message?.content) {
				throw new Error("Unerwartete Antwortstruktur von OpenAI.");
			}
			return responseJson.choices[0].message.content.trim();
		} else if (provider === 'ollama') {
			if (typeof responseJson?.response !== 'string') {
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
	}

	if (!isOverloaded) {
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
