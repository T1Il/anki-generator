import { App, Modal, Setting } from 'obsidian';

// Definiert den Typ für den Callback, der den ausgewählten Provider zurückgibt
type ModelSelectionCallback = (provider: 'gemini' | 'ollama') => void;

export class ModelSelectionModal extends Modal {
	onSubmit: ModelSelectionCallback;
	geminiAvailable: boolean;
	ollamaAvailable: boolean;

	constructor(app: App, geminiAvailable: boolean, ollamaAvailable: boolean, onSubmit: ModelSelectionCallback) {
		super(app);
		this.geminiAvailable = geminiAvailable;
		this.ollamaAvailable = ollamaAvailable;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "KI-Modell auswählen" });
		contentEl.createEl("p", { text: "Wähle das Modell, das für die Kartengenerierung verwendet werden soll:" });

		// Button für Gemini (nur wenn verfügbar)
		if (this.geminiAvailable) {
			new Setting(contentEl)
				.addButton(btn => btn
					.setButtonText("Google Gemini (Online)")
					.setCta() // Hauptoption hervorheben
					.onClick(() => {
						this.close();
						this.onSubmit('gemini');
					}));
		}

		// Button für Ollama (nur wenn verfügbar)
		if (this.ollamaAvailable) {
			new Setting(contentEl)
				.addButton(btn => btn
					.setButtonText("Ollama (Lokal)")
					.onClick(() => {
						this.close();
						this.onSubmit('ollama');
					}));
		}

		// Fallback, falls (unerwartet) keines verfügbar ist
		if (!this.geminiAvailable && !this.ollamaAvailable) {
			contentEl.createEl("p", { text: "Kein KI-Modell konfiguriert oder verfügbar." });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
