export interface Card {
	q: string;
	a: string;
	id: number | null;
	type: 'Basic' | 'Cloze';
}

export interface ImageInput {
	base64: string;
	mimeType: string;
	filename: string;
}
