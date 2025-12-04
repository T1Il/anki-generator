import { requestUrl, Notice, App } from 'obsidian';
import { AnkiGeneratorSettings, DEFAULT_SETTINGS } from './settings';
import { DebugModal } from './ui/DebugModal';
import { ManualGenerationModal } from './ui/ManualGenerationModal';
import { ImageInput, ChatMessage } from './types';

export async function generateCardsWithAI(
	app: App,
	noteContent: string,
	existingCards: string,
	provider: 'gemini' | 'ollama' | 'openai',
	settings: AnkiGeneratorSettings,
	additionalInstructions: string | null,
	images: ImageInput[] = [],
	isRevision: boolean = false,
	abortSignal?: { aborted: boolean }
): Promise<{ cards: string, feedback: string }> {

	// --- 1. Construct Card Prompt (User's Prompt) ---
	const cardPrompt = constructPrompt(noteContent, existingCards, settings, additionalInstructions, isRevision);

	// --- 2. Construct Feedback Prompt ---
	let feedbackPrompt = settings.useCustomFeedbackPrompt ? settings.feedbackPrompt : DEFAULT_SETTINGS.feedbackPrompt;
	if (!feedbackPrompt || typeof feedbackPrompt !== 'string') {
		feedbackPrompt = DEFAULT_SETTINGS.feedbackPrompt;
	}
	feedbackPrompt = feedbackPrompt.replace('{{noteContent}}', noteContent);

	console.log(`--- Starting Generation (${provider}) ---`);
	console.log(`--- Card Prompt (Images: ${images.length}) ---\n${cardPrompt.substring(0, 200)}...\n--- End Card Prompt ---`);

	try {
		let cardsResponse = "";
		let feedbackResponse = "";

		// --- 3. Execute Generation (Sequential for Feedback) ---
		// Allow manual mode for card generation
		cardsResponse = await callAIProvider(app, provider, settings, cardPrompt, images, abortSignal, true);

		if (settings.enableFeedback) {
			if (abortSignal?.aborted) throw new Error("Aborted by user");

			// Append note content and generated cards to feedback prompt
			feedbackPrompt += `\n\nOriginal Content:\n"""\n${noteContent}\n"""`;
			feedbackPrompt += `\n\nGenerierte Karten:\n"""\n${cardsResponse}\n"""`;

			console.log(`--- Feedback Prompt ---\n${feedbackPrompt.substring(0, 200)}...\n--- End Feedback Prompt ---`);

			// Disable manual mode for feedback generation
			feedbackResponse = await callAIProvider(app, provider, settings, feedbackPrompt, [], abortSignal, false);
		} else {
			console.log("Feedback generation disabled in settings.");
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

export function constructPrompt(
	noteContent: string,
	existingCards: string,
	settings: AnkiGeneratorSettings,
	additionalInstructions: string | null,
	isRevision: boolean
): string {
	let basePrompt = settings.useCustomPrompt ? settings.prompt : DEFAULT_SETTINGS.prompt;
	if (typeof basePrompt !== 'string') {
		console.warn("constructPrompt: settings.prompt war kein String. Fallback auf DEFAULT_SETTINGS.prompt.");
		basePrompt = DEFAULT_SETTINGS.prompt;
	}

	let cardPrompt = basePrompt;

	if (isRevision) {
		cardPrompt = `Du bist ein Assistent, der bestehende Anki-Karteikarten überarbeitet.
Deine Aufgabe ist es, die unten aufgeführten "Bestehenden Karten" basierend auf der folgenden Anweisung zu ändern.
Behalte das Format strikt bei (Q:/A:).
Lösche keine Karten, es sei denn, die Anweisung verlangt es explizit.
Ändere den Inhalt der Karten entsprechend der Anweisung.

Anweisung zur Überarbeitung:
"${additionalInstructions || 'Überarbeite die Karten sinnvoll.'}"

Hier ist der Kontext (Notizinhalt), falls benötigt:
"""
{{noteContent}}
"""

Bestehende Karten (diese sollen überarbeitet werden):
{{existingCards}}

Gib NUR die überarbeiteten Karten zurück.`;
	} else {
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
	}

	return cardPrompt
		.replace('{{noteContent}}', noteContent)
		.replace('{{existingCards}}', existingCards);
}

export async function generateFeedbackOnly(
	app: App,
	noteContent: string,
	provider: 'gemini' | 'ollama' | 'openai',
	settings: AnkiGeneratorSettings
): Promise<string> {
	let feedbackPrompt = settings.useCustomFeedbackPrompt ? settings.feedbackPrompt : DEFAULT_SETTINGS.feedbackPrompt;
	if (!feedbackPrompt || typeof feedbackPrompt !== 'string') {
		feedbackPrompt = DEFAULT_SETTINGS.feedbackPrompt;
	}
	feedbackPrompt = feedbackPrompt.replace('{{noteContent}}', noteContent);

	return await callAIProvider(app, provider, settings, feedbackPrompt, []);
}

export async function generateChatResponse(
	app: App,
	history: ChatMessage[],
	newMessage: string,
	noteContent: string,
	provider: 'gemini' | 'ollama' | 'openai',
	settings: AnkiGeneratorSettings
): Promise<string> {

	let systemContext = `Du bist ein hilfreicher Tutor. Hier ist der Kontext (Lerninhalt):\n"""\n${noteContent}\n"""\n\n`;

	let fullPrompt = systemContext;

	history.forEach(msg => {
		fullPrompt += `${msg.role === 'user' ? 'User' : 'AI'}: ${msg.content}\n`;
	});

	fullPrompt += `User: ${newMessage}\nAI:`;

	return await callAIProvider(app, provider, settings, fullPrompt, []);
}

async function callAIProvider(
	app: App,
	provider: 'gemini' | 'ollama' | 'openai',
	settings: AnkiGeneratorSettings,
	prompt: string,
	images: ImageInput[],
	abortSignal?: { aborted: boolean },
	allowManualMode: boolean = true
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

	const timeoutMs = 45000; // 45 seconds timeout
	const maxRetries = settings.maxRetries || 0;
	let attempt = 0;

	while (attempt <= maxRetries) {
		if (abortSignal?.aborted) {
			throw new Error("Aborted by user");
		}

		try {
			// Race between the request and the timeout
			const timeoutPromise = new Promise<any>((_, reject) => {
				setTimeout(() => reject(new Error("Timeout: API took too long")), timeoutMs);
			});

			const response = await Promise.race([
				requestUrl({
					url: apiUrl,
					method: 'POST',
					headers: requestHeaders,
					body: requestBodyString,
					throw: false
				}),
				timeoutPromise
			]);

			if (abortSignal?.aborted) {
				throw new Error("Aborted by user");
			}

			const responseJson = response.json;

			if (response.status >= 300) {
				// Special handling for 503 (Overloaded) to trigger retries
				if (response.status === 503 && attempt < maxRetries) {
					console.log(`API Overloaded (503). Retrying... (${attempt + 1}/${maxRetries})`);
					attempt++;
					await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff-ish
					continue;
				}

				handleApiError(app, provider, response.status, responseJson, requestBodyString, settings);
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
			if ((error as Error).message === "Aborted by user") throw error;

			console.error(`Fehler bei der Anfrage an ${provider} (Versuch ${attempt + 1}):`, error);

			// If it's a timeout, we might want to retry as well
			const isTimeout = (error as Error).message.includes("Timeout");
			if (isTimeout && attempt < maxRetries) {
				console.log(`Timeout. Retrying... (${attempt + 1}/${maxRetries})`);
				attempt++;
				continue;
			}

			// If we are out of retries or it's a non-retriable error:
			if (attempt >= maxRetries) {
				if (settings.enableManualMode && allowManualMode) {
					new Notice(`Fehler oder Timeout bei ${provider} nach ${attempt} Versuchen. Öffne manuellen Modus...`);
					return new Promise<string>((resolve) => {
						new ManualGenerationModal(app, prompt, (manualResponse) => {
							resolve(manualResponse);
						}, () => {
							// On Cancel
							console.log("Manual generation cancelled.");
							resolve(""); // Resolve with empty string to stop loading but not throw error
						}).open();
					});
				}

				if ((error as any).isOverloaded || (error as any).isNetworkError) {
					throw error;
				}
				
				const err = new Error(`Netzwerkfehler oder unerwarteter Fehler bei ${provider}. Details siehe Konsole.`);
				// @ts-ignore
				err.requestBody = requestBodyString;
				throw err;
			}
			
			// If we caught an error that is NOT a timeout and NOT isOverloaded, we probably shouldn't retry (e.g. 400 Bad Request).
			if (!isTimeout && !(error as any).isOverloaded) {
				// Fatal error, don't retry.
				if (settings.enableManualMode && allowManualMode) {
					new Notice(`Fehler bei ${provider}. Öffne manuellen Modus...`);
					return new Promise<string>((resolve) => {
						new ManualGenerationModal(app, prompt, (manualResponse) => {
							resolve(manualResponse);
						}, () => {
							console.log("Manual generation cancelled.");
							resolve("");
						}).open();
					});
				}
				throw error;
			}
			
			attempt++; // Should have been handled by continue, but just in case
		}
	}
	
	return ""; // Should be unreachable if logic is correct
}

function handleApiError(app: App, provider: string, status: number, responseJson: any, requestBodyString: string, settings: AnkiGeneratorSettings) {
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

	// If manual mode is enabled, we just throw the error so it can be caught in callAIProvider
	// and trigger the manual modal. We do NOT open the DebugModal.
	// NOTE: We don't know 'allowManualMode' here easily, but we throw anyway. 
	// The caller (callAIProvider) checks allowManualMode before opening the modal.
	if (settings.enableManualMode) {
		const error = new Error(userFriendlyMessage);
		// @ts-ignore
		error.isOverloaded = isOverloaded;
		// @ts-ignore
		error.isNetworkError = isNetworkError;
		throw error;
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