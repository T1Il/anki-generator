import { App, Modal, Setting, TextAreaComponent } from 'obsidian';
import { Card } from '../types';

export class CardEditModal extends Modal {
	card: Partial<Card>;
	onSubmit: (result: Card) => void;

	constructor(app: App, card: Partial<Card>, onSubmit: (result: Card) => void) {
		super(app);
		this.card = card;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: this.card.q ? "Karte bearbeiten" : "Neue Karte erstellen" });

		let question = this.card.q || '';
		let answer = this.card.a || '';

		new Setting(contentEl)
			.setName("Frage")
			.setDesc("Gib hier die Frage oder den Lückentext ein.")
			.addTextArea((text: TextAreaComponent) => {
				text.setValue(question)
					.onChange(value => question = value)
					.inputEl.rows = 5;
			});

		new Setting(contentEl)
			.setName("Antwort")
			.setDesc("Gib hier die Antwort ein.")
			.addTextArea((text: TextAreaComponent) => {
				text.setValue(answer)
					.onChange(value => answer = value)
					.inputEl.rows = 5;
			});

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText("Speichern")
				.setCta()
				.onClick(() => {
					const type = question.includes('____') ? 'Cloze' : 'Basic';
					this.onSubmit({ q: question, a: answer, id: this.card.id || null, type });
					this.close();
				}));
	}

	onClose() {
		this.contentEl.empty();
	}
}
