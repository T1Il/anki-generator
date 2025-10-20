export interface Card {
	q: string;
	a: string;
	id: number | null;
	type: 'Basic' | 'Cloze';
}
