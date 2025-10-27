import { App, Modal, Setting, TextAreaComponent } from 'obsidian';

export class SubdeckModal extends Modal {
	subdeck: string;
	additionalInstructions: string = ''; // Neue Eigenschaft
	initialValue: string;
	mainDeck: string;
	// Aktualisierte Callback-Signatur
	onSubmit: (subdeck: string, additionalInstructions: string) => void;

	constructor(app: App, mainDeck: string, initialValue: string, onSubmit: (subdeck: string, additionalInstructions: string) => void) {
		super(app);
		this.mainDeck = mainDeck;
		this.initialValue = initialValue;
		this.subdeck = initialValue;
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

		// Subdeck-Eingabe (unverändert)
		new Setting(contentEl).setName("Name des Unterdecks").setDesc("Trenne Unter-Unterdecks mit '::' oder '->'. Leer lassen für 'Standard'.").addText((text) =>
			text.setValue(this.initialValue).onChange((value) => {
				this.subdeck = value.replace(/->/g, '::');
				updatePreview(this.subdeck);
			}));

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
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Generieren").setCta().onClick(() => {
				this.close();
				// Übergib beide Werte an den Callback
				this.onSubmit(this.subdeck || 'Standard', this.additionalInstructions);
			}));

		updatePreview(this.initialValue); // Initiale Vorschau
	}

	onClose() {
		this.contentEl.empty();
	}
}
