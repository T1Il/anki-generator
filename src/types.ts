export interface Card {
	type: 'Basic' | 'Cloze';
	q: string;
	a: string;
	id: number | null;
	typeIn?: boolean;
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
