import { App, Modal } from 'obsidian';
import { Card } from '../types';
import { CardEditModal } from './CardEditModal';

export class CardPreviewModal extends Modal {
	cards: Card[];
	onSave: (cards: Card[]) => void;

	constructor(app: App, cards: Card[], onSave: (cards: Card[]) => void) {
		super(app);
		this.cards = [...cards];
		this.onSave = onSave;

		// Add a class to the modal window itself for wider layout
		this.modalEl.addClass('anki-preview-modal-wide');
	}

	onOpen() {
		this.render();
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Karten bearbeiten & verwalten" });

		const buttonContainer = contentEl.createDiv({ cls: 'anki-preview-button-container' });
		buttonContainer.createEl('button', { text: '➕ Neue Karte hinzufügen' }).addEventListener('click', () => {
			new CardEditModal(this.app, {}, (newCard) => {
				this.cards.push(newCard);
				this.render();
			}).open();
		});

		const container = contentEl.createDiv({ cls: 'anki-preview-container' });
		if (this.cards.length === 0) {
			container.setText('Keine Karten in diesem Block gefunden.');
		}

		this.cards.forEach((card, index) => {
			const cardEl = container.createDiv({ cls: 'anki-preview-card' });

			const content = cardEl.createDiv({ cls: 'anki-preview-content' });
			content.createEl('div', { cls: 'anki-preview-question', text: card.q });
			content.createEl('hr', { cls: 'anki-preview-separator' });
			content.createEl('div', { cls: 'anki-preview-answer', text: card.a });

			const actions = cardEl.createDiv({ cls: 'anki-card-actions' });
			actions.createEl('button', { text: '✏️ Bearbeiten' }).addEventListener('click', () => {
				new CardEditModal(this.app, card, (updatedCard) => {
					this.cards[index] = updatedCard;
					this.render();
				}).open();
			});

			actions.createEl('button', { text: '🗑️ Löschen', cls: 'anki-delete-button' }).addEventListener('click', () => {
				this.cards.splice(index, 1);
				this.render();
			});
		});
	}

	onClose() {
		this.onSave(this.cards);
		this.contentEl.empty();
	}
}

