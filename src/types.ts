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
	/**
	 * Die Kartenliste, die die KI mit dieser Antwort gesehen hat: Eintrag n
	 * gehoert zu `CARD: n+1`. Ohne sie zeigte jede Nummer nach dem Loeschen
	 * einer Karte auf die naechste – siehe kartenSuche.ts.
	 */
	karten?: KartenBezug[];
	/** Zustand der Vorschlaege dieser Antwort, Schluessel = Originalvorschlag. */
	vorschlaege?: Record<string, VorschlagZustand>;
	/** Welches Modell geantwortet hat (Anzeige). */
	modell?: string;
	/** Claude-CLI-Sitzung dieser Antwort – Rueckfragen knuepfen daran an. */
	agentSitzung?: string;
	/** Antwort einer Flaggen-Prüfung: deren Zeitpunkt, Schlüssel zur Ablage im Vault. */
	flaggenAm?: string;
}

/** Eine Karte, wie sie zum Zeitpunkt einer Anfrage im Block stand. */
export interface KartenBezug {
	id: number | null;
	q: string;
}

export interface VorschlagZustand {
	status?: 'applied' | 'dismissed';
	/** Bei Quellen: wohin sie schon eingetragen ist ('notiz', 'zotero'). */
	erledigt?: string[];
	/** Vom Nutzer bearbeitete Fassung (ein Suggestion-Objekt). */
	bearbeitet?: any;
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
