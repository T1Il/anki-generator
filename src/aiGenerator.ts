import { requestUrl, Notice, App, TFile } from 'obsidian';
import { AnkiGeneratorSettings, DEFAULT_SETTINGS } from './settings';
import { DebugModal } from './ui/DebugModal';
import { ManualGenerationModal } from './ui/ManualGenerationModal';
import { ImageInput, ChatMessage, ChatTurn, AiProvider } from './types';
import { getProvider, RequestOptions } from './providers';
import { SUGGESTION_FORMAT_INSTRUCTIONS } from './chat/suggestions';

export async function generateCardsWithAI(
	app: App,
	noteContent: string,
	existingCards: string,
	provider: AiProvider,
	settings: AnkiGeneratorSettings,
	additionalInstructions: string | null,
	images: ImageInput[] = [],
	files: TFile[] = [], // NEW
	noteTitle: string,
	isRevision: boolean = false,
	abortSignal?: { aborted: boolean }
): Promise<{ cards: string, feedbackPromise: Promise<string> }> {

	// --- 1. Construct Card Prompt (User's Prompt) ---
	const cardPrompt = constructPrompt(noteContent, existingCards, settings, additionalInstructions, isRevision, noteTitle);

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

		// --- 3. Execute Generation (Sequential for Feedback) ---
		// Allow manual mode for card generation
		cardsResponse = await callAIProvider(app, provider, settings, cardPrompt, images, files, abortSignal, true);
        
        let feedbackPromise: Promise<string> = Promise.resolve("");

		if (settings.enableFeedback && !isRevision) {
			feedbackPromise = (async () => {
				if (abortSignal?.aborted) throw new Error("Aborted by user");

				// Append note content and generated cards to feedback prompt
				// Note: We use the LOCAL feedbackPrompt variable, ensuring we don't mutate shared state if any
				let currentFeedbackPrompt = feedbackPrompt;
				currentFeedbackPrompt += `\n\nOriginal Content:\n"""\n${noteContent}\n"""`;
				currentFeedbackPrompt += `\n\nGenerierte Karten:\n"""\n${cardsResponse}\n"""`;
				currentFeedbackPrompt += '\n\n' + SUGGESTION_FORMAT_INSTRUCTIONS;

				console.log(`--- Feedback Prompt ---\n${currentFeedbackPrompt.substring(0, 200)}...\n--- End Feedback Prompt ---`);

				// Disable manual mode for feedback generation
				return await callAIProvider(app, provider, settings, currentFeedbackPrompt, [], [], abortSignal, false);
			})();
		} else {
			console.log("Feedback generation disabled in settings or skipped (Revision).");
		}

		console.log("Generation Complete (Cards received). Feedback running in background.");
		console.log("Cards Length:", cardsResponse.length);

		return {
			cards: cardsResponse.trim(),
			feedbackPromise
		};

	} catch (error) {
		console.error("Error during generation:", error);
		throw error;
	}
}

export function constructPrompt(
	noteContent: string,
	existingCards: string,
	settings: AnkiGeneratorSettings,
	additionalInstructions: string | null,
	isRevision: boolean,
	noteTitle: string
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

	// encodeURIComponent leaves '(' and ')' untouched, which breaks the markdown link
	// syntax [text](url) when vault or file names contain parens (e.g. "NFS-Ausbildung (Till)").
	// We additionally encode parens to keep links parseable.
	const encodeForMarkdownUrl = (s: string) =>
		encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29');
	const noteURI = `obsidian://open?vault=${encodeForMarkdownUrl(settings.vaultName)}&file=${encodeForMarkdownUrl(noteTitle)}`;

	return cardPrompt
		.split('{{noteContent}}').join(noteContent)
		.split('{{existingCards}}').join(existingCards)
		.split('{{noteURI}}').join(noteURI);
}

export async function generateFeedbackOnly(
	app: App,
	noteContent: string,
	provider: AiProvider,
	settings: AnkiGeneratorSettings,
    abortSignal?: { aborted: boolean }
): Promise<string> {
	let feedbackPrompt = settings.useCustomFeedbackPrompt ? settings.feedbackPrompt : DEFAULT_SETTINGS.feedbackPrompt;
	if (!feedbackPrompt || typeof feedbackPrompt !== 'string') {
		feedbackPrompt = DEFAULT_SETTINGS.feedbackPrompt;
	}
	feedbackPrompt = feedbackPrompt.replace('{{noteContent}}', noteContent);
	// Ohne diese Anweisung liefert das Feedback nur Fliesstext und die
	// Vorschlaege lassen sich nicht per Klick uebernehmen.
	feedbackPrompt += '\n\n' + SUGGESTION_FORMAT_INSTRUCTIONS;

	return await callAIProvider(app, provider, settings, feedbackPrompt, [], [], abortSignal, false);
}

/**
 * Systemkontext für den Chat: Notizinhalt, vorhandene Karten und das Format,
 * in dem Änderungsvorschläge kommen müssen.
 */
export function buildChatSystemPrompt(noteContent: string, existingCards?: string): string {
	let system = `Du bist ein hilfreicher Tutor für die Präklinik (Rettungsdienst).
Du hilfst beim Lerninhalt und bei den daraus erzeugten Anki-Karten.
Antworte knapp und inhaltlich.

Hier ist der Lerninhalt der Notiz:
"""
${noteContent}
"""`;

	if (existingCards && existingCards.trim() && existingCards.trim() !== 'Keine.') {
		system += `

Diese Anki-Karten existieren bereits zu dieser Notiz:
"""
${existingCards}
"""`;
	}

	return system + '\n\n' + SUGGESTION_FORMAT_INSTRUCTIONS;
}

/** UI-Historie ('ai') in API-Rollen ('assistant') übersetzen. */
export function toChatTurns(history: ChatMessage[], newMessage?: string): ChatTurn[] {
	const turns: ChatTurn[] = history.map(msg => ({
		role: msg.role === 'user' ? 'user' : 'assistant',
		content: msg.content
	} as ChatTurn));

	if (newMessage !== undefined) {
		turns.push({ role: 'user', content: newMessage });
	}

	// Die APIs verlangen einen User-Turn am Anfang.
	while (turns.length > 0 && turns[0].role !== 'user') turns.shift();
	return turns;
}

export async function generateChatResponse(
	app: App,
	history: ChatMessage[],
	newMessage: string,
	noteContent: string,
	provider: AiProvider,
	settings: AnkiGeneratorSettings,
	abortSignal?: { aborted: boolean },
	existingCards?: string
): Promise<string> {
	const turns = toChatTurns(history, newMessage);
	return await callAIProviderTurns(app, provider, settings, turns, [], [], abortSignal, false, {
		system: buildChatSystemPrompt(noteContent, existingCards)
	});
}

/**
 * Gestreamte Chat-Antwort. Fällt automatisch auf den nicht-gestreamten Pfad
 * zurück, wenn fetch scheitert (z. B. CORS auf Mobile).
 */
export async function streamChatResponse(
	app: App,
	history: ChatMessage[],
	newMessage: string,
	noteContent: string,
	provider: AiProvider,
	settings: AnkiGeneratorSettings,
	signal: AbortSignal,
	onDelta: (text: string) => void,
	existingCards?: string
): Promise<string> {
	const def = getProvider(provider);
	const turns = toChatTurns(history, newMessage);
	const opts: RequestOptions = { system: buildChatSystemPrompt(noteContent, existingCards), stream: true };

	if (def.supportsStreaming) {
		try {
			return await streamViaFetch(def, settings, turns, opts, signal, onDelta);
		} catch (error) {
			if (signal.aborted || (error as Error).message === 'Aborted by user') throw error;
			console.warn(`Streaming für ${provider} fehlgeschlagen, weiche auf requestUrl aus:`, error);
		}
	}

	// Fallback: eine Antwort am Stück.
	const text = await callAIProviderTurns(
		app, provider, settings, turns, [], [], signal as any, false,
		{ system: opts.system }
	);
	onDelta(text);
	return text;
}

/** SSE- bzw. NDJSON-Stream lesen und Deltas durchreichen. */
async function streamViaFetch(
	def: ReturnType<typeof getProvider>,
	settings: AnkiGeneratorSettings,
	turns: ChatTurn[],
	opts: RequestOptions,
	signal: AbortSignal,
	onDelta: (text: string) => void
): Promise<string> {
	const req = def.buildRequest(settings, turns, [], opts);

	const response = await fetch(req.url, {
		method: 'POST',
		headers: req.headers,
		body: JSON.stringify(req.body),
		signal
	});

	if (!response.ok) {
		let detail = '';
		try { detail = await response.text(); } catch (e) { /* egal */ }
		throw new Error(`HTTP ${response.status} von ${def.id}: ${detail.substring(0, 300)}`);
	}
	if (!response.body) throw new Error('Keine Stream-Antwort erhalten.');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let full = '';

	const handlePayload = (payload: string) => {
		const delta = def.parseStreamEvent(payload);
		if (delta) {
			full += delta;
			onDelta(delta);
		}
	};

	const consumeLine = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		if (def.streamFormat === 'sse') {
			if (!trimmed.startsWith('data:')) return;
			handlePayload(trimmed.substring(5));
		} else {
			handlePayload(trimmed);
		}
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			// Das letzte Element kann eine unvollständige Zeile sein.
			buffer = lines.pop() || '';
			lines.forEach(consumeLine);
		}
		if (buffer) consumeLine(buffer);
	} finally {
		try { reader.releaseLock(); } catch (e) { /* egal */ }
	}

	return full;
}

/** Bequemlichkeits-Wrapper: ein einzelner User-Prompt ohne Historie. */
async function callAIProvider(
	app: App,
	provider: AiProvider,
	settings: AnkiGeneratorSettings,
	prompt: string,
	images: ImageInput[],
	files: TFile[] = [],
	abortSignal?: { aborted: boolean },
	allowManualMode: boolean = true
): Promise<string> {
	return callAIProviderTurns(
		app, provider, settings,
		[{ role: 'user', content: prompt }],
		images, files, abortSignal, allowManualMode, {}
	);
}

async function callAIProviderTurns(
	app: App,
	provider: AiProvider,
	settings: AnkiGeneratorSettings,
	turns: ChatTurn[],
	images: ImageInput[],
	files: TFile[] = [],
	abortSignal?: { aborted: boolean },
	allowManualMode: boolean = true,
	opts: RequestOptions = {}
): Promise<string> {

	const def = getProvider(provider);
	const req = def.buildRequest(settings, turns, images, opts);
	const requestBodyString = JSON.stringify(req.body);

	// Für den manuellen Modus brauchen wir den reinen Text.
	const promptForManualMode = turns.map(turn => turn.content).join('\n\n');

	console.log(`Sende Request Body an ${provider}:`, requestBodyString.substring(0, 500) + (requestBodyString.length > 500 ? '...' : ''));

	const timeoutMs = 90000; // 90 Sekunden - denkende Modelle brauchen laenger
	const maxRetries = settings.maxRetries || 0;
	let attempt = 0;

	const openManualMode = (): Promise<string> => new Promise<string>((resolve) => {
		new ManualGenerationModal(app, promptForManualMode, (manualResponse) => {
			resolve(manualResponse);
		}, () => {
			console.log("Manual generation cancelled.");
			resolve("");
		}, files).open();
	});

	while (attempt <= maxRetries) {
		if (abortSignal?.aborted) {
			throw new Error("Aborted by user");
		}

		try {
			const timeoutPromise = new Promise<any>((_, reject) => {
				setTimeout(() => reject(new Error("Timeout: API took too long")), timeoutMs);
			});

			const response = await Promise.race([
				requestUrl({
					url: req.url,
					method: 'POST',
					headers: req.headers,
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
				const retryable = def.isRetryable(response.status, responseJson);

				if (retryable && attempt < maxRetries) {
					console.log(`${provider} ueberlastet/limitiert (${response.status}). Neuer Versuch... (${attempt + 1}/${maxRetries})`);
					attempt++;
					await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
					continue;
				}

				handleApiError(app, provider, response.status, responseJson, requestBodyString, settings, retryable);
				return ""; // handleApiError wirft
			}

			const rawText = def.parseResponse(responseJson);

			console.log(`AI Raw Response from ${provider}:`, rawText.substring(0, 500) + (rawText.length > 500 ? '...' : ''));
			return rawText;

		} catch (error) {
			if ((error as Error).message === "Aborted by user") throw error;

			console.error(`Fehler bei der Anfrage an ${provider} (Versuch ${attempt + 1}):`, error);

			const isTimeout = (error as Error).message.includes("Timeout");
			if (isTimeout && attempt < maxRetries) {
				console.log(`Timeout. Retrying... (${attempt + 1}/${maxRetries})`);
				attempt++;
				continue;
			}

			if (attempt >= maxRetries) {
				if (settings.enableManualMode && allowManualMode) {
					new Notice(`Fehler oder Timeout bei ${provider} nach ${attempt} Versuchen. Oeffne manuellen Modus...`);
					return openManualMode();
				}

				if ((error as any).isOverloaded || (error as any).isNetworkError) {
					throw error;
				}

				const err = new Error(`Netzwerkfehler oder unerwarteter Fehler bei ${provider}. Details siehe Konsole.`);
				// @ts-ignore
				err.requestBody = requestBodyString;
				throw err;
			}

			if (!isTimeout && !(error as any).isOverloaded) {
				if (settings.enableManualMode && allowManualMode) {
					new Notice(`Fehler bei ${provider}. Oeffne manuellen Modus...`);
					return openManualMode();
				}
				throw error;
			}

			attempt++;
		}
	}

	return "";
}

function handleApiError(app: App, provider: string, status: number, responseJson: any, requestBodyString: string, settings: AnkiGeneratorSettings, retryable: boolean = false) {
	let userFriendlyMessage = `API Fehler (${provider}, Status ${status})`;
	let errorDetails = `Status: ${status}\nBody:\n${JSON.stringify(responseJson, null, 2)}`;
	// Ueberlastung/Rate-Limit bestimmt der jeweilige Provider-Adapter.
	const isOverloaded = retryable;
	const isNetworkError = status === 0;

	if (responseJson?.error?.message) {
		const apiMessage = responseJson.error.message;
		userFriendlyMessage = `API Fehler (${provider}, ${status}): ${apiMessage}`;
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