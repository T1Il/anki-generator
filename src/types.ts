export interface Card {
	type: 'Basic' | 'Cloze';
	q: string;
	a: string;
	id: number | null;
	typeIn?: boolean;
	originalText?: string; // Stores the raw text of the card
}

/** Alle unterstützten KI-Anbieter. */
export type AiProvider = 'gemini' | 'openai' | 'ollama' | 'claude';

/** Eine Nachricht in der Chat-Historie (UI-Sicht). */
export interface ChatMessage {
	role: 'user' | 'ai';
	content: string;
}

/**
 * Ein Gesprächsschritt so, wie ihn die Provider-APIs erwarten.
 * Bewusst getrennt von ChatMessage: die UI kennt 'ai', die APIs 'assistant'.
 */
export interface ChatTurn {
	role: 'user' | 'assistant';
	content: string;
}

export interface ImageInput {
	base64: string;
	mimeType: string;
	filename: string;
}

export interface CardPreviewState {
	searchQuery: string;
	sortOrder: 'default' | 'type' | 'question';
	filter: 'all' | 'synced' | 'unsynced';
	expandedIndices: Set<number>;
	isAllExpanded: boolean;
	isChatOpen: boolean;
	isQuestionsOpen?: boolean;
	questionsScrollTop?: number;
}
