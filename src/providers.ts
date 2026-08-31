import { requestUrl } from 'obsidian';
import { AnkiGeneratorSettings } from './settings';
import { AiProvider, ChatTurn, ImageInput } from './types';

export interface BuiltRequest {
	url: string;
	headers: Record<string, string>;
	body: any;
}

export interface RequestOptions {
	/** Systemkontext (Notizinhalt, Rolle). Wird providerspezifisch platziert. */
	system?: string;
	/** Streaming anfordern (nur Chat). */
	stream?: boolean;
	/** Obergrenze für die Antwort. */
	maxTokens?: number;
}

export interface ProviderDef {
	id: AiProvider;
	label: string;
	supportsStreaming: boolean;
	/** Wie der Stream-Body zerlegt wird. */
	streamFormat: 'sse' | 'ndjson';
	isAvailable(s: AnkiGeneratorSettings): boolean;
	buildRequest(s: AnkiGeneratorSettings, turns: ChatTurn[], images: ImageInput[], opts: RequestOptions): BuiltRequest;
	/** Extrahiert den Text aus einer vollständigen (nicht gestreamten) Antwort. */
	parseResponse(json: any): string;
	/** Extrahiert das Text-Delta aus einem einzelnen Stream-Payload. Leerstring = nichts beizutragen. */
	parseStreamEvent(payload: string): string;
	/** Ob ein Fehlerstatus einen Retry rechtfertigt (Überlastung / Rate Limit). */
	isRetryable(status: number, json: any): boolean;
	fetchModels(s: AnkiGeneratorSettings): Promise<Record<string, string>>;
}

// --- Hilfen ---------------------------------------------------------------

/** Ollama-Endpunkt auf die Basis-URL zurückführen (data.json enthält teils .../api/generate). */
function ollamaBase(endpoint: string): string {
	return (endpoint || '').replace(/\/(api\/(generate|chat))\/?$/, '').replace(/\/$/, '');
}

function lastUserIndex(turns: ChatTurn[]): number {
	for (let i = turns.length - 1; i >= 0; i--) {
		if (turns[i].role === 'user') return i;
	}
	return turns.length - 1;
}

/** JSON aus einem SSE-/NDJSON-Payload holen, ohne bei Teilstücken zu werfen. */
function safeJson(payload: string): any | null {
	const trimmed = payload.trim();
	if (!trimmed || trimmed === '[DONE]') return null;
	try {
		return JSON.parse(trimmed);
	} catch (e) {
		return null;
	}
}

// --- Gemini ---------------------------------------------------------------

const gemini: ProviderDef = {
	id: 'gemini',
	label: 'Google Gemini',
	supportsStreaming: true,
	streamFormat: 'sse',

	isAvailable: (s) => !!s.geminiApiKey,

	buildRequest(s, turns, images, opts) {
		if (!s.geminiApiKey) throw new Error('Gemini API Key nicht gesetzt.');
		const model = s.geminiModel || 'gemini-1.5-pro';
		const method = opts.stream ? 'streamGenerateContent' : 'generateContent';
		const query = opts.stream ? '?alt=sse&key=' + s.geminiApiKey : '?key=' + s.geminiApiKey;

		const attachAt = lastUserIndex(turns);
		const contents = turns.map((turn, i) => {
			const parts: any[] = [{ text: turn.content }];
			if (i === attachAt) {
				images.forEach((img) => parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } }));
			}
			return { role: turn.role === 'assistant' ? 'model' : 'user', parts };
		});

		const body: any = { contents };
		if (opts.system) body.system_instruction = { parts: [{ text: opts.system }] };

		return {
			url: 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':' + method + query,
			headers: { 'Content-Type': 'application/json' },
			body
		};
	},

	parseResponse(json) {
		const parts = json?.candidates?.[0]?.content?.parts;
		if (!Array.isArray(parts)) throw new Error('Unerwartete Antwortstruktur von Gemini.');
		const text = parts.map((p: any) => p?.text || '').join('');
		if (!text) throw new Error('Unerwartete Antwortstruktur von Gemini.');
		return text;
	},

	parseStreamEvent(payload) {
		const json = safeJson(payload);
		const parts = json?.candidates?.[0]?.content?.parts;
		if (!Array.isArray(parts)) return '';
		return parts.map((p: any) => p?.text || '').join('');
	},

	isRetryable: (status) => status === 429 || status === 503,

	async fetchModels(s) {
		const r = await requestUrl({
			url: 'https://generativelanguage.googleapis.com/v1beta/models?key=' + s.geminiApiKey,
			method: 'GET'
		});
		const out: Record<string, string> = {};
		(r.json.models || []).forEach((m: any) => {
			if (m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent')) {
				out[m.name.replace('models/', '')] = m.displayName || m.name;
			}
		});
		return out;
	}
};

// --- OpenAI ---------------------------------------------------------------

const openai: ProviderDef = {
	id: 'openai',
	label: 'OpenAI',
	supportsStreaming: true,
	streamFormat: 'sse',

	isAvailable: (s) => !!s.openAiApiKey,

	buildRequest(s, turns, images, opts) {
		if (!s.openAiApiKey) throw new Error('OpenAI API Key nicht gesetzt.');

		const attachAt = lastUserIndex(turns);
		const messages: any[] = [];
		messages.push({ role: 'system', content: opts.system || 'You are a helpful assistant.' });

		turns.forEach((turn, i) => {
			if (i === attachAt && images.length > 0) {
				const content: any[] = [{ type: 'text', text: turn.content }];
				images.forEach((img) =>
					content.push({ type: 'image_url', image_url: { url: 'data:' + img.mimeType + ';base64,' + img.base64 } })
				);
				messages.push({ role: turn.role, content });
			} else {
				messages.push({ role: turn.role, content: turn.content });
			}
		});

		const body: any = { model: s.openAiModel || 'gpt-4o', messages };
		if (opts.stream) body.stream = true;

		return {
			url: 'https://api.openai.com/v1/chat/completions',
			headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.openAiApiKey },
			body
		};
	},

	parseResponse(json) {
		const text = json?.choices?.[0]?.message?.content;
		if (typeof text !== 'string') throw new Error('Unerwartete Antwortstruktur von OpenAI.');
		return text;
	},

	parseStreamEvent(payload) {
		const json = safeJson(payload);
		return json?.choices?.[0]?.delta?.content || '';
	},

	isRetryable: (status) => status === 429 || status >= 500,

	async fetchModels(s) {
		const r = await requestUrl({
			url: 'https://api.openai.com/v1/models',
			method: 'GET',
			headers: { 'Authorization': 'Bearer ' + s.openAiApiKey }
		});
		const out: Record<string, string> = {};
		(r.json.data || [])
			.filter((m: any) => m.id.startsWith('gpt'))
			.sort((a: any, b: any) => b.created - a.created)
			.forEach((m: any) => (out[m.id] = m.id));
		return out;
	}
};

// --- Ollama ---------------------------------------------------------------

const ollama: ProviderDef = {
	id: 'ollama',
	label: 'Ollama (Lokal)',
	supportsStreaming: true,
	streamFormat: 'ndjson',

	isAvailable: (s) => s.ollamaEnabled && !!s.ollamaEndpoint && !!s.ollamaModel,

	buildRequest(s, turns, images, opts) {
		if (!s.ollamaEndpoint || !s.ollamaModel) throw new Error('Ollama Endpunkt oder Modell nicht konfiguriert.');

		const attachAt = lastUserIndex(turns);
		const messages: any[] = [];
		if (opts.system) messages.push({ role: 'system', content: opts.system });
		turns.forEach((turn, i) => {
			const msg: any = { role: turn.role, content: turn.content };
			if (i === attachAt && images.length > 0) msg.images = images.map((img) => img.base64);
			messages.push(msg);
		});

		return {
			url: ollamaBase(s.ollamaEndpoint) + '/api/chat',
			headers: { 'Content-Type': 'application/json' },
			body: { model: s.ollamaModel, messages, stream: !!opts.stream }
		};
	},

	parseResponse(json) {
		// /api/chat liefert message.content; ältere /api/generate-Antworten haben response.
		const text = json?.message?.content ?? json?.response;
		if (typeof text !== 'string') throw new Error('Unerwartete Antwortstruktur von Ollama.');
		return text;
	},

	parseStreamEvent(payload) {
		const json = safeJson(payload);
		return json?.message?.content ?? json?.response ?? '';
	},

	isRetryable: (status) => status >= 500,

	async fetchModels(s) {
		const r = await requestUrl({ url: ollamaBase(s.ollamaEndpoint) + '/api/tags', method: 'GET' });
		const out: Record<string, string> = {};
		(r.json.models || []).forEach((m: any) => (out[m.name] = m.name));
		return out;
	}
};

// --- Anthropic Claude -----------------------------------------------------

const ANTHROPIC_VERSION = '2023-06-01';

const claude: ProviderDef = {
	id: 'claude',
	label: 'Anthropic Claude',
	supportsStreaming: true,
	streamFormat: 'sse',

	isAvailable: (s) => !!s.claudeApiKey,

	buildRequest(s, turns, images, opts) {
		if (!s.claudeApiKey) throw new Error('Claude API Key nicht gesetzt.');

		const attachAt = lastUserIndex(turns);
		const messages = turns.map((turn, i) => {
			if (i === attachAt && images.length > 0) {
				// Bildblöcke gehören vor den Text.
				const content: any[] = images.map((img) => ({
					type: 'image',
					source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
				}));
				content.push({ type: 'text', text: turn.content });
				return { role: turn.role, content };
			}
			return { role: turn.role, content: turn.content };
		});

		const body: any = {
			model: s.claudeModel || 'claude-opus-5',
			// max_tokens ist bei Anthropic Pflicht.
			max_tokens: opts.maxTokens || (opts.stream ? 32000 : 16000),
			messages
		};

		if (opts.system) {
			// Der Notizkontext ist über alle Chat-Turns hinweg stabil -> cachen.
			body.system = [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }];
		}
		if (s.claudeEffort) body.output_config = { effort: s.claudeEffort };
		if (opts.stream) body.stream = true;

		return {
			url: 'https://api.anthropic.com/v1/messages',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': s.claudeApiKey,
				'anthropic-version': ANTHROPIC_VERSION,
				// Nötig, sobald der Request aus einem Browser-Kontext läuft (Streaming via fetch, Mobile).
				'anthropic-dangerous-direct-browser-access': 'true'
			},
			body
		};
	},

	parseResponse(json) {
		// Auf Opus 5 ist Thinking standardmäßig an: content[0] kann ein thinking-Block sein.
		const blocks = json?.content;
		if (!Array.isArray(blocks)) throw new Error('Unerwartete Antwortstruktur von Claude.');
		const text = blocks
			.filter((b: any) => b?.type === 'text')
			.map((b: any) => b.text || '')
			.join('');
		if (!text) throw new Error('Unerwartete Antwortstruktur von Claude.');
		return text;
	},

	parseStreamEvent(payload) {
		const json = safeJson(payload);
		if (json?.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
			return json.delta.text || '';
		}
		return '';
	},

	// 529 = overloaded_error, 429 = rate limit.
	isRetryable: (status) => status === 429 || status === 529 || status >= 500,

	async fetchModels(s) {
		const r = await requestUrl({
			url: 'https://api.anthropic.com/v1/models?limit=100',
			method: 'GET',
			headers: {
				'x-api-key': s.claudeApiKey,
				'anthropic-version': ANTHROPIC_VERSION,
				'anthropic-dangerous-direct-browser-access': 'true'
			}
		});
		const out: Record<string, string> = {};
		(r.json.data || []).forEach((m: any) => (out[m.id] = m.display_name || m.id));
		return out;
	}
};

// --- Registry -------------------------------------------------------------

export const PROVIDERS: Record<AiProvider, ProviderDef> = { gemini, openai, ollama, claude };

/** Reihenfolge für UI-Listen und Fallbacks. */
export const PROVIDER_ORDER: AiProvider[] = ['gemini', 'claude', 'openai', 'ollama'];

export function getProvider(id: AiProvider): ProviderDef {
	const def = PROVIDERS[id];
	if (!def) throw new Error('Ungültiger AI Provider: ' + id);
	return def;
}

export function getAvailableProviders(s: AnkiGeneratorSettings): AiProvider[] {
	return PROVIDER_ORDER.filter((id) => PROVIDERS[id].isAvailable(s));
}

/**
 * Der tatsächlich zu verwendende Provider.
 * Respektiert settings.aiProvider und weicht nur aus, wenn dieser nicht konfiguriert ist.
 */
export function resolveProvider(s: AnkiGeneratorSettings): AiProvider | null {
	const preferred = s.aiProvider as AiProvider;
	if (preferred && PROVIDERS[preferred] && PROVIDERS[preferred].isAvailable(s)) return preferred;
	const available = getAvailableProviders(s);
	return available.length > 0 ? available[0] : null;
}
