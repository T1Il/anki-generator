import { App, Modal, Setting, Notice, MarkdownRenderer } from 'obsidian';
import { Card } from '../types';
import { CardEditModal } from './CardEditModal';

export class CardPreviewModal extends Modal {
	cards: Card[];
	deckName: string;
	instruction?: string;
	onSave: (cards: Card[], deletedCardIds: number[], newDeckName: string) => void;
	deletedCardIds: number[] = []; // Speichert die IDs der gelöschten Karten

	constructor(app: App, cards: Card[], deckName: string, onSave: (cards: Card[], deletedCardIds: number[], newDeckName: string) => void, instruction?: string) {
		super(app);
		this.cards = [...cards];
		this.deckName = deckName || "";
		this.instruction = instruction;
		this.onSave = onSave;
		this.modalEl.addClass('anki-preview-modal-wide');
	}

	onOpen() {
		this.render();
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Karten bearbeiten & verwalten" });

		// --- Instruction Display ---
		if (this.instruction) {
			const instructionEl = contentEl.createDiv({ cls: 'anki-instruction-preview' });
			instructionEl.style.color = '#4a90e2';
			instructionEl.style.fontStyle = 'italic';
			instructionEl.style.borderLeft = '3px solid #4a90e2';
			instructionEl.style.paddingLeft = '10px';
			instructionEl.style.marginBottom = '15px';
			instructionEl.style.padding = '10px';
			instructionEl.style.backgroundColor = 'rgba(74, 144, 226, 0.1)';
			instructionEl.style.borderRadius = '5px';
			instructionEl.createEl('strong', { text: 'Anweisung: ' });
			instructionEl.createSpan({ text: `"${this.instruction}"` });
		}

		// --- Deck Name Input ---
		new Setting(contentEl)
			.setName("Target Deck")
			.setDesc("Der Name des Decks in Anki, in das diese Karten synchronisiert werden.")
			.addText(text => text
				.setValue(this.deckName)
				.onChange(value => {
					this.deckName = value;
				})
				.inputEl.style.width = '100%'
			);

		const buttonContainer = contentEl.createDiv({ cls: 'anki-preview-button-container' });
		buttonContainer.style.marginTop = '20px';

		buttonContainer.createEl('button', { text: '➕ Neue Karte hinzufügen' }).addEventListener('click', () => {
			new CardEditModal(this.app, {}, (newCard) => {
				this.cards.push(newCard);
				this.render();
			}).open();
		});

		// --- Delete All Button ---
		const deleteAllBtn = buttonContainer.createEl('button', { text: '🗑️ Alle löschen', cls: 'anki-delete-button' });
		deleteAllBtn.style.marginLeft = '10px';
		deleteAllBtn.addEventListener('click', () => {
			if (confirm("Möchtest du wirklich ALLE Karten in diesem Block löschen? Dies kann nicht rückgängig gemacht werden.")) {
				// Alle existierenden IDs zur Löschliste hinzufügen
				this.cards.forEach(card => {
					if (card.id) {
						this.deletedCardIds.push(card.id);
					}
				});
				this.cards = [];
				this.render();
				new Notice("Alle Karten wurden zum Löschen markiert.");
			}
		});

		const container = contentEl.createDiv({ cls: 'anki-preview-container' });
		if (this.cards.length === 0) {
			container.setText('Keine Karten in diesem Block gefunden.');
		}

		this.cards.forEach((card, index) => {
			const cardEl = container.createDiv({ cls: 'anki-preview-card' });
			const content = cardEl.createDiv({ cls: 'anki-preview-content' });

			// Question
			const questionDiv = content.createDiv({ cls: 'anki-preview-question' });
			const highlightedQ = this.highlightClozes(card.q);
			MarkdownRenderer.render(this.app, highlightedQ, questionDiv, '', null as any);

			content.createEl('hr', { cls: 'anki-preview-separator' });

			// Answer
			const answerDiv = content.createDiv({ cls: 'anki-preview-answer' });
			const highlightedA = this.highlightClozes(card.a);
			MarkdownRenderer.render(this.app, highlightedA, answerDiv, '', null as any);

			const actions = cardEl.createDiv({ cls: 'anki-card-actions' });
			actions.createEl('button', { text: '✏️ Bearbeiten' }).addEventListener('click', () => {
				new CardEditModal(this.app, card, (updatedCard) => {
					this.cards[index] = updatedCard;
					this.render();
				}).open();
			});

			actions.createEl('button', { text: '🗑️ Löschen', cls: 'anki-delete-button' }).addEventListener('click', () => {
				// Karte aus der lokalen Liste entfernen
				const [deletedCard] = this.cards.splice(index, 1);
				// Wenn die Karte eine ID hatte, diese für die Löschung in Anki vormerken
				if (deletedCard && deletedCard.id) {
					this.deletedCardIds.push(deletedCard.id);
				}
				this.render();
			});
		});
	}

	highlightClozes(text: string): string {
		// Highlight cloze deletions: {{c1::answer}}
		// Replace with markdown highlighting
		return text.replace(/\{\{c(\d+)::([^}]+)\}\}/g, (match, num, content) => {
			return `==**[c${num}]** ${content}==`;
		});
	}

	onClose() {
		// Beim Schließen die aktualisierte Kartenliste UND die Liste der gelöschten IDs zurückgeben
		this.onSave(this.cards, this.deletedCardIds, this.deckName);
		this.contentEl.empty();
	}
}
