import { App, Modal, Setting, TextAreaComponent, ButtonComponent, Notice } from 'obsidian';

export class ManualGenerationModal extends Modal {
	prompt: string;
	onSubmit: (response: string) => void;
	response: string = "";

	onCancel?: () => void;

	constructor(app: App, prompt: string, onSubmit: (response: string) => void, onCancel?: () => void) {
		super(app);
		this.prompt = prompt;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('anki-manual-modal');

		contentEl.createEl("h2", { text: "Manuelle Generierung (Fallback)" });
		contentEl.createEl("p", {
			text: "Die KI antwortet nicht oder ist überlastet. Du kannst den Prompt hier kopieren, ihn manuell an die KI (z.B. im Browser) senden und die Antwort unten einfügen."
		});
		
		const warningEl = contentEl.createDiv({ cls: 'anki-manual-warning' });
		warningEl.style.color = 'var(--text-warning)';
		warningEl.style.marginBottom = '10px';
		warningEl.style.fontStyle = 'italic';
		warningEl.setText("Wichtig: Verwende das Format 'Q: Frage' und 'A: Antwort', damit die Karten erkannt werden.");

		// 1. Prompt Display & Copy
		const promptContainer = contentEl.createDiv({ cls: 'manual-prompt-container' });
		promptContainer.createEl('h3', { text: '1. Prompt kopieren' });
		
		const promptTextArea = new TextAreaComponent(promptContainer);
		promptTextArea.setValue(this.prompt);
		promptTextArea.inputEl.rows = 10;
		promptTextArea.inputEl.style.width = "100%";
		promptTextArea.inputEl.style.fontFamily = "monospace";
		promptTextArea.inputEl.setAttr("readonly", "true");

		new Setting(promptContainer)
			.addButton(btn => btn
				.setButtonText("Prompt in Zwischenablage kopieren")
				.setCta()
				.onClick(() => {
					navigator.clipboard.writeText(this.prompt);
					new Notice("Prompt kopiert!");
				}));

		contentEl.createEl('hr');

		// 2. Response Input
		const responseContainer = contentEl.createDiv({ cls: 'manual-response-container' });
		responseContainer.createEl('h3', { text: '2. Antwort einfügen' });
		responseContainer.createEl('p', { text: 'Füge hier die Antwort der KI ein. Achte darauf, dass das Format stimmt (JSON oder Text, je nach Erwartung).' });

		const responseTextArea = new TextAreaComponent(responseContainer);
		responseTextArea.setPlaceholder("Füge hier die KI-Antwort ein...");
		responseTextArea.inputEl.rows = 10;
		responseTextArea.inputEl.style.width = "100%";
		responseTextArea.onChange((value) => {
			this.response = value;
		});

		// 3. Submit
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText("Antwort übernehmen")
				.setCta()
				.onClick(() => {
					if (!this.response.trim()) {
						new Notice("Bitte gib eine Antwort ein.");
						return;
					}
					console.log("ManualGenerationModal: Submitting response:", this.response.substring(0, 50) + "...");
					this.onSubmit(this.response);
					this.close();
				}));
	}

	onClose() {
		this.contentEl.empty();
		// If response is empty, it was cancelled (or closed without submit)
		if (!this.response && this.onCancel) {
			this.onCancel();
		}
	}
}
