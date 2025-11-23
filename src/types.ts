export interface Card {
	q: string;
	a: string;
	id: number | null;
	type: 'Basic' | 'Cloze';
	typeIn?: boolean; // True if this is a type-in card (Basic with typing required)
}

export interface ImageInput {
	base64: string;
	mimeType: string;
	filename: string;
}

export interface ChatMessage {
	role: 'user' | 'ai';
	content: string;
}
