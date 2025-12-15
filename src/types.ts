export interface Card {
	type: 'Basic' | 'Cloze';
	q: string;
	a: string;
	id: number | null;
	typeIn?: boolean;
	originalText?: string; // Stores the raw text of the card
}



export interface ChatMessage {
	role: 'user' | 'ai';
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
}
