import { App, Modal, Setting } from 'obsidian';

// Provider Typ erweitert
type ModelSelectionCallback = (provider: 'gemini' | 'ollama' | 'openai') => void;

export class ModelSelectionModal extends Modal {
	onSubmit: ModelSelectionCallback;
	geminiAvailable: boolean;
	ollamaAvailable: boolean;
	openAiAvailable: boolean; // NEU

	constructor(app: App, geminiAvailable: boolean, ollamaAvailable: boolean, openAiAvailable: boolean, onSubmit: ModelSelectionCallback) {
		super(app);
		this.geminiAvailable = geminiAvailable;
		this.ollamaAvailable = ollamaAvailable;
		this.openAiAvailable = openAiAvailable;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "KI-Modell auswählen" });
		contentEl.createEl("p", { text: "Wähle das Modell, das für die Kartengenerierung verwendet werden soll:" });

		// Button für Gemini
		if (this.geminiAvailable) {
			new Setting(contentEl)
				.addButton(btn => btn
					.setButtonText("Google Gemini (Online)")
					.setCta()
					.onClick(() => {
						this.close();
						this.onSubmit('gemini');
					}));
		}

		// NEU: Button für OpenAI
		if (this.openAiAvailable) {
			new Setting(contentEl)
				.addButton(btn => btn
					.setButtonText("OpenAI (ChatGPT)")
					.onClick(() => {
						this.close();
						this.onSubmit('openai');
					}));
		}

		// Button für Ollama
		if (this.ollamaAvailable) {
			new Setting(contentEl)
				.addButton(btn => btn
					.setButtonText("Ollama (Lokal)")
					.onClick(() => {
						this.close();
						this.onSubmit('ollama');
					}));
		}

		if (!this.geminiAvailable && !this.ollamaAvailable && !this.openAiAvailable) {
			contentEl.createEl("p", { text: "Kein KI-Modell konfiguriert oder verfügbar." });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
