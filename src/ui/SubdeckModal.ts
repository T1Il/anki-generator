import { App, Modal, Setting, TextAreaComponent, TextComponent } from 'obsidian';

export class SubdeckModal extends Modal {
	subdeck: string;
	additionalInstructions: string = ''; // Neue Eigenschaft
	initialValue: string;
	mainDeck: string;
	deckNames: string[];
	// Aktualisierte Callback-Signatur
	onSubmit: (subdeck: string, additionalInstructions: string, isBlockOnly: boolean) => void;

	constructor(app: App, mainDeck: string, initialValue: string, deckNames: string[], onSubmit: (subdeck: string, additionalInstructions: string, isBlockOnly: boolean) => void) {
		super(app);
		this.mainDeck = mainDeck;
		this.initialValue = initialValue;
		this.subdeck = initialValue;
		this.deckNames = deckNames;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Unterdeck & Anweisungen für Anki-Karten" });

		// Pfad-Vorschau (unverändert)
		const pathPreviewEl = contentEl.createDiv({ cls: "anki-path-preview" });
		const updatePreview = (subdeckValue: string) => {
			pathPreviewEl.empty();
			pathPreviewEl.createEl("p", { text: "Finaler Pfad:", cls: "anki-path-title" });
			const sanitizedSubdeck = subdeckValue.replace(/->/g, '::');
			const fullPath = `${this.mainDeck}::${sanitizedSubdeck || 'Standard'}`; // Zeige Standard, wenn leer
			const pathParts = fullPath.split('::').filter(p => p.length > 0);
			const listEl = pathPreviewEl.createEl("div", { cls: "anki-path-list" });
			pathParts.forEach((part, index) => {
				const itemEl = listEl.createEl("div", { cls: "anki-path-item" });
				itemEl.style.paddingLeft = `${index * 20}px`;
				const emoji = index === 0 ? '🗂️' : '📂';
				itemEl.setText(`${emoji} ${part}`);
			});
		};

		// Subdeck-Eingabe
		const subdeckSetting = new Setting(contentEl)
			.setName("Name des Unterdecks")
			.setDesc("Trenne Unter-Unterdecks mit '::' oder '->'. Leer lassen für 'Standard'.");

		let subdeckInput: TextComponent;
		subdeckSetting.addText((text) => {
			subdeckInput = text;
			text.setValue(this.initialValue).onChange((value) => {
				this.subdeck = value.replace(/->/g, '::');
				updatePreview(this.subdeck);
				renderSuggestions(value);
			});
		});

		// Suggestions Container
		const suggestionsContainer = contentEl.createDiv({ cls: 'anki-deck-suggestions-container' });
		suggestionsContainer.style.maxHeight = '150px';
		suggestionsContainer.style.overflowY = 'auto';
		suggestionsContainer.style.border = '1px solid rgba(255, 255, 255, 0.1)';
		suggestionsContainer.style.borderRadius = '5px';
		suggestionsContainer.style.padding = '5px';
		suggestionsContainer.style.marginTop = '-10px'; // Pull closer to input
		suggestionsContainer.style.marginBottom = '20px';
		suggestionsContainer.style.display = 'none'; // Hidden by default

		const renderSuggestions = (inputValue: string) => {
			suggestionsContainer.empty();
			const lowerInput = inputValue.toLowerCase();

			// Filter decks that start with mainDeck (optional, but good for context)
			// Actually, user might want to see all decks or just subdecks of mainDeck?
			// Let's show all relevant decks.
			// If input is empty, show all (or top level).
			// If input has value, filter.

			const matches = this.deckNames.filter(d =>
				d.toLowerCase().includes(lowerInput) &&
				d !== this.mainDeck // Don't suggest main deck itself as subdeck? Or maybe yes?
			);

			if (matches.length > 0) {
				suggestionsContainer.style.display = 'block';
				matches.forEach(deck => {
					// We want to suggest the SUBDECK part if it starts with mainDeck
					let displayValue = deck;
					let insertValue = deck;

					if (deck.startsWith(this.mainDeck + "::")) {
						insertValue = deck.substring(this.mainDeck.length + 2);
						displayValue = `... ${insertValue}`;
					} else if (deck === this.mainDeck) {
						return; // Skip main deck
					}

					const item = suggestionsContainer.createDiv({ cls: 'anki-deck-suggestion-item' });
					item.setText(displayValue);
					item.style.padding = '5px';
					item.style.cursor = 'pointer';
					item.style.borderRadius = '3px';

					item.onmouseover = () => {
						item.style.backgroundColor = 'rgba(74, 144, 226, 0.2)';
					};
					item.onmouseout = () => {
						item.style.backgroundColor = 'transparent';
					};

					item.onclick = () => {
						this.subdeck = insertValue;
						subdeckInput.setValue(insertValue);
						updatePreview(insertValue);
						suggestionsContainer.style.display = 'none';
					};
				});
			} else {
				suggestionsContainer.style.display = 'none';
			}
		};

		// --- NEU: Textarea für zusätzliche Anweisungen ---
		new Setting(contentEl)
			.setName("Zusätzliche Anweisungen (optional)")
			.setDesc("Füge hier temporäre Anweisungen hinzu, die *nur für diese Generierung* dem Hauptprompt vorangestellt werden (z.B. 'Fokussiere dich auf Definitionen').")
			.addTextArea((text: TextAreaComponent) => {
				text.setPlaceholder("Beispiel: Erstelle nur Lückentext-Karten...")
					.onChange(value => this.additionalInstructions = value)
					.inputEl.rows = 4;
				text.inputEl.style.width = '100%'; // Sorge für volle Breite
			});
		// --- ENDE NEU ---

		// Button (aktualisiert, um beide Werte zu übergeben)
		const btnSetting = new Setting(contentEl);

		btnSetting.addButton((btn) =>
			btn.setButtonText("Nur Block erstellen")
				.setTooltip("Erstellt nur den Anki-Block Header ohne KI-Generierung")
				.onClick(() => {
					this.close();
					this.onSubmit(this.subdeck || 'Standard', this.additionalInstructions, true);
				}));

		btnSetting.addButton((btn) =>
			btn.setButtonText("Generieren").setCta().onClick(() => {
				this.close();
				// Übergib beide Werte an den Callback
				this.onSubmit(this.subdeck || 'Standard', this.additionalInstructions, false);
			}));

		updatePreview(this.initialValue); // Initiale Vorschau
		// renderSuggestions(this.initialValue); // Don't show suggestions initially to keep it clean? Or yes?
		// Let's show them if input is empty to show available decks?
		// Or maybe only on focus? For now, let's leave it hidden until typed or if we want to show all.
		// If I want to show all, I can call renderSuggestions("") but that might be too many.
	}

	onClose() {
		this.contentEl.empty();
	}
}
