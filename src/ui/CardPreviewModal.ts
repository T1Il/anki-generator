import { Modal, Setting, Notice, MarkdownRenderer, setIcon } from 'obsidian';
import { Card } from '../types';
import { CardEditModal } from './CardEditModal';
import AnkiGeneratorPlugin from '../main';

export class CardPreviewModal extends Modal {
	plugin: AnkiGeneratorPlugin;
	cards: Card[];
	deckName: string;
	instruction?: string;
	onSave: (cards: Card[], deletedCardIds: number[], newDeckName: string) => void;
	deletedCardIds: number[] = [];

	constructor(plugin: AnkiGeneratorPlugin, cards: Card[], deckName: string, onSave: (cards: Card[], deletedCardIds: number[], newDeckName: string) => void, instruction?: string) {
		super(plugin.app);
		this.plugin = plugin;
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

		// --- Sorting Controls ---
		const sortContainer = contentEl.createDiv({ cls: 'anki-preview-sort-container' });
		sortContainer.style.marginBottom = '15px';
		sortContainer.style.display = 'flex';
		sortContainer.style.alignItems = 'center';
		sortContainer.style.gap = '10px';

		sortContainer.createSpan({ text: 'Sortieren nach:' });
		const sortDropdown = sortContainer.createEl('select');
		sortDropdown.style.padding = '5px';
		sortDropdown.style.borderRadius = '4px';
		sortDropdown.style.border = '1px solid var(--background-modifier-border)';

		const options = [
			{ value: 'default', text: 'Standard (Erstellung)' },
			{ value: 'type', text: 'Kartentyp' },
			{ value: 'question', text: 'Frage (A-Z)' }
		];

		options.forEach(opt => {
			const option = sortDropdown.createEl('option', { text: opt.text, value: opt.value });
			if (this.currentSort === opt.value) option.selected = true;
		});

		sortDropdown.addEventListener('change', () => {
			this.currentSort = sortDropdown.value;
			this.sortCards();
			this.render();
		});

		// --- CSS Styles for Compact Design ---
		contentEl.createEl('style', {
			text: `
				.anki-compact-card {
					border: 1px solid var(--background-modifier-border);
					border-radius: 8px;
					margin-bottom: 12px;
					padding: 12px;
					background-color: var(--background-secondary);
					transition: transform 0.1s ease-in-out, box-shadow 0.1s ease-in-out;
				}
				.anki-compact-card:hover {
					box-shadow: 0 2px 8px rgba(0,0,0,0.1);
				}
				.anki-card-header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 8px;
					padding-bottom: 8px;
					border-bottom: 1px dashed var(--background-modifier-border);
				}
				.anki-card-type {
					font-size: 0.75em;
					font-weight: 600;
					text-transform: uppercase;
					letter-spacing: 0.5px;
					display: flex;
					align-items: center;
					gap: 4px;
					padding: 2px 6px;
					border-radius: 4px;
				}
				.anki-card-actions-compact {
					display: flex;
					gap: 10px;
				}
				.anki-icon-btn {
					cursor: pointer;
					font-size: 1.1em;
					opacity: 0.6;
					transition: opacity 0.2s, transform 0.2s;
					background: none;
					border: none;
					padding: 0;
					margin: 0;
				}
				.anki-icon-btn:hover {
					opacity: 1;
					transform: scale(1.1);
				}
				.anki-icon-btn.delete:hover {
					color: var(--text-error);
				}
				.anki-card-body {
					font-size: 0.95em;
					line-height: 1.5;
				}
				.anki-card-q {
					font-weight: 600;
					color: var(--text-normal);
					margin-bottom: 6px;
				}
				.anki-card-a {
					color: var(--text-muted);
				}
				.anki-card-divider {
					height: 1px;
					background-color: var(--background-modifier-border);
					margin: 6px 0;
					opacity: 0.5;
				}
				.anki-cloze-highlight {
					background-color: rgba(155, 89, 182, 0.15);
					color: var(--text-normal);
					border-bottom: 2px solid #9b59b6;
					padding: 0 2px;
					border-radius: 2px;
					font-weight: 500;
				}
				.anki-cloze-number {
					color: #9b59b6;
					font-weight: 700;
					font-size: 0.9em;
					margin-right: 4px;
				}
			`
		});

		const container = contentEl.createDiv({ cls: 'anki-preview-container' });
		if (this.cards.length === 0) {
			container.setText('Keine Karten in diesem Block gefunden.');
		}

		// Pfad der aktuellen Datei holen für Bilder-Auflösung
		const activeFile = this.app.workspace.getActiveFile();
		const sourcePath = activeFile ? activeFile.path : '';

		this.cards.forEach((card, index) => {
			const cardEl = container.createDiv({ cls: 'anki-compact-card' });

			// --- Card Styling based on Type ---
			let typeText = 'Basic';
			let typeIcon = '📝';
			let typeColor = 'var(--text-muted)';
			let typeBg = 'rgba(128, 128, 128, 0.1)';
			let borderColor = 'transparent';

			if (card.typeIn) {
				typeText = 'Type-In';
				typeIcon = '⌨️';
				typeColor = '#d4af37';
				typeBg = 'rgba(212, 175, 55, 0.15)';
				borderColor = '#d4af37';
			} else if (card.type === 'Cloze') {
				typeText = 'Lückentext';
				typeIcon = '🧩';
				typeColor = '#9b59b6';
				typeBg = 'rgba(155, 89, 182, 0.15)';
				borderColor = '#9b59b6';
			} else {
				typeColor = '#3498db';
				typeBg = 'rgba(52, 152, 219, 0.15)';
				borderColor = '#3498db';
			}

			// Apply border accent
			cardEl.style.borderLeft = `3px solid ${borderColor}`;

			// --- Header: Type & Actions ---
			const header = cardEl.createDiv({ cls: 'anki-card-header' });

			// Type Badge
			const typeBadge = header.createDiv({ cls: 'anki-card-type' });
			typeBadge.setText(`${typeIcon} ${typeText}`);
			typeBadge.style.color = typeColor;
			typeBadge.style.backgroundColor = typeBg;

			// Actions (Icons only)
			const actions = header.createDiv({ cls: 'anki-card-actions-compact' });

			// Edit Button
			const editBtn = actions.createEl('button', { cls: 'anki-card-action-btn' });
			setIcon(editBtn, 'pencil');
			editBtn.onclick = (e) => {
				e.stopPropagation();
				this.openEditModal(card, index);
			};

			// Delete Button
			const deleteBtn = actions.createEl('button', { cls: 'anki-card-action-btn delete-btn' });
			setIcon(deleteBtn, 'trash');
			deleteBtn.onclick = (e) => {
				e.stopPropagation();
				this.cards.splice(index, 1);
				this.renderCards();
			};

			// --- Body: Question & Answer ---
			const body = cardEl.createDiv({ cls: 'anki-card-body' });

			// Question
			const qDiv = body.createDiv({ cls: 'anki-card-q' });
			const highlightedQ = this.highlightClozes(card.q);
			MarkdownRenderer.render(this.app, highlightedQ, qDiv, sourcePath, this.plugin);

			// Answer
			const aDiv = body.createDiv({ cls: 'anki-card-a' });
			const highlightedA = this.highlightClozes(card.a);
			MarkdownRenderer.render(this.app, highlightedA, aDiv, sourcePath, this.plugin);
		});
	}

	currentSort: string = 'default';

	sortCards() {
		if (this.currentSort === 'default') {
			// No sorting needed
		} else if (this.currentSort === 'type') {
			this.cards.sort((a, b) => {
				const typeA = a.typeIn ? 'Type-In' : a.type;
				const typeB = b.typeIn ? 'Type-In' : b.type;
				return typeA.localeCompare(typeB);
			});
		} else if (this.currentSort === 'question') {
			this.cards.sort((a, b) => a.q.localeCompare(b.q));
		}
	}

	highlightClozes(text: string): string {
		return text.replace(/\{\{c(\d+)::([^}]+)\}\}/g, (match, num, content) => {
			return `<span class="anki-cloze-highlight"><span class="anki-cloze-number">[c${num}]</span>${content}</span>`;
		});
	}

	openEditModal(card: Card, index: number) {
		new CardEditModal(this.app, card, (updatedCard) => {
			this.cards[index] = updatedCard;
			this.render();
		}).open();
	}

	renderCards() {
		this.render();
	}

	onClose() {
		this.onSave(this.cards, this.deletedCardIds, this.deckName);
		this.contentEl.empty();
	}
}