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
): Promise<{ cards: string, feedback: string }> {

	// --- 1. Construct Card Prompt (User's Prompt) ---
	let basePrompt = settings.prompt;
	if (typeof basePrompt !== 'string') {
		console.warn("generateCardsWithAI: settings.prompt war kein String. Fallback auf DEFAULT_SETTINGS.prompt.");
		basePrompt = DEFAULT_SETTINGS.prompt;
		if (typeof basePrompt !== 'string') {
			throw new Error("Interner Fehler: Standard-Prompt ist ungültig.");
		}
	}

	let cardPrompt = basePrompt;
	if (additionalInstructions && additionalInstructions.trim().length > 0) {
		const insertionMarker = "Hier ist der Text";
		const markerIndex = basePrompt.indexOf(insertionMarker);

		if (markerIndex !== -1) {
			const beforeMarker = basePrompt.substring(0, markerIndex);
			const afterMarker = basePrompt.substring(markerIndex);
			cardPrompt = `${beforeMarker.trimRight()}\n\n**Zusätzliche Anweisungen für diese Generierung:**\n${additionalInstructions.trim()}\n\n${afterMarker.trimLeft()}`;
		} else {
			console.warn("Konnte den Einfüge-Marker im Prompt nicht finden. Füge zusätzliche Anweisungen am Anfang ein.");
			cardPrompt = `${additionalInstructions.trim()}\n\n---\n\n${basePrompt}`;
		}
	}

	cardPrompt = cardPrompt
		.replace('{{noteContent}}', noteContent)
		.replace('{{existingCards}}', existingCards);

	// --- 2. Construct Feedback Prompt ---
	let feedbackPrompt = settings.feedbackPrompt;
	if (!feedbackPrompt || typeof feedbackPrompt !== 'string') {
		feedbackPrompt = DEFAULT_SETTINGS.feedbackPrompt;
	}
	feedbackPrompt = feedbackPrompt.replace('{{noteContent}}', noteContent);

	console.log(`--- Starting Parallel Generation (${provider}) ---`);
	console.log(`--- Card Prompt (Images: ${images.length}) ---\n${cardPrompt.substring(0, 200)}...\n--- End Card Prompt ---`);

	try {
		let cardsResponse = "";
		let feedbackResponse = "";

		if (settings.enableFeedback) {
			console.log(`--- Feedback Prompt ---\n${feedbackPrompt.substring(0, 200)}...\n--- End Feedback Prompt ---`);
			// --- 3a. Execute Parallel Requests (Cards + Feedback) ---
			const results = await Promise.all([
				callAIProvider(app, provider, settings, cardPrompt, images),
				callAIProvider(app, provider, settings, feedbackPrompt, [])
			]);
			cardsResponse = results[0];
			feedbackResponse = results[1];
		} else {
			console.log("Feedback generation disabled in settings.");
			// --- 3b. Execute Single Request (Cards only) ---
			cardsResponse = await callAIProvider(app, provider, settings, cardPrompt, images);
		}

		console.log("Generation Complete.");
		console.log("Cards Length:", cardsResponse.length);
		console.log("Feedback Length:", feedbackResponse.length);

		return {
			cards: cardsResponse.trim(),
			feedback: feedbackResponse.trim()
		};

	} catch (error) {
		console.error("Error during parallel generation:", error);
		throw error;
	}
}

export async function generateFeedbackOnly(
	app: App,
	noteContent: string,
	provider: 'gemini' | 'ollama' | 'openai',
	settings: AnkiGeneratorSettings
): Promise<string> {
	let feedbackPrompt = settings.feedbackPrompt;
	if (!feedbackPrompt || typeof feedbackPrompt !== 'string') {
		feedbackPrompt = DEFAULT_SETTINGS.feedbackPrompt;
	}
	feedbackPrompt = feedbackPrompt.replace('{{noteContent}}', noteContent);

	return await callAIProvider(app, provider, settings, feedbackPrompt, []);
}

async function callAIProvider(
	app: App,
	provider: 'gemini' | 'ollama' | 'openai',
	settings: AnkiGeneratorSettings,
	prompt: string,
	images: ImageInput[]
): Promise<string> {

	let apiUrl = "";
	let requestBody: any = {};
	let requestHeaders: any = { 'Content-Type': 'application/json' };

	if (provider === 'gemini') {
		if (!settings.geminiApiKey) throw new Error("Gemini API Key nicht gesetzt.");
		const modelToUse = settings.geminiModel || 'gemini-1.5-pro';
		apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${settings.geminiApiKey}`;

		const parts: any[] = [{ text: prompt }];
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

		const userContent: any[] = [{ type: "text", text: prompt }];
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
				{ role: "system", content: "You are a helpful assistant." },
				{ role: "user", content: userContent }
			]
		};

	} else if (provider === 'ollama') {
		if (!settings.ollamaEndpoint || !settings.ollamaModel) throw new Error("Ollama Endpunkt oder Modell nicht konfiguriert.");
		apiUrl = settings.ollamaEndpoint;
		requestBody = {
			model: settings.ollamaModel,
			prompt: prompt,
			stream: false
		};
		if (images.length > 0) {
			requestBody.images = images.map(img => img.base64);
		}
	} else {
		throw new Error("Ungültiger AI Provider angegeben.");
	}

	const requestBodyString = JSON.stringify(requestBody);
	console.log(`Sende Request Body an ${provider}:`, requestBodyString.substring(0, 500) + (requestBodyString.length > 500 ? '...' : ''));

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
			return ""; // handleApiError throws
		}

		let rawText = "";
		if (provider === 'gemini') {
			if (!responseJson?.candidates?.[0]?.content?.parts?.[0]?.text) {
				throw new Error("Unerwartete Antwortstruktur von Gemini.");
			}
			rawText = responseJson.candidates[0].content.parts[0].text;
		} else if (provider === 'openai') {
			if (!responseJson?.choices?.[0]?.message?.content) {
				throw new Error("Unerwartete Antwortstruktur von OpenAI.");
			}
			rawText = responseJson.choices[0].message.content;
		} else if (provider === 'ollama') {
			if (typeof responseJson?.response !== 'string') {
				throw new Error("Unerwartete Antwortstruktur von Ollama.");
			}
			rawText = responseJson.response;
		}

		console.log(`AI Raw Response from ${provider}:`, rawText.substring(0, 500) + (rawText.length > 500 ? '...' : ''));
		return rawText;

	} catch (error) {
		if ((error as any).isOverloaded || (error as any).isNetworkError) {
			throw error;
		}
		console.error(`Unerwarteter Fehler bei der Anfrage an ${provider}:`, error);
		const err = new Error(`Netzwerkfehler oder unerwarteter Fehler bei ${provider}. Details siehe Konsole.`);
		// @ts-ignore
		err.requestBody = requestBodyString;
		throw err;
	}
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