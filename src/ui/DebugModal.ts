import { App, Modal, Setting } from 'obsidian';

export class DebugModal extends Modal {
	requestBody: string;
	errorDetails: string;

	constructor(app: App, requestBody: string, errorDetails: string) {
		super(app);
		this.requestBody = requestBody;
		this.errorDetails = errorDetails;
		this.modalEl.addClass('anki-debug-modal'); // Für optionales, breiteres Styling
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "API-Fehlerdetails (Debug)" });
		contentEl.createEl("p", {
			text: "Ein Fehler ist bei der Anfrage an die Gemini API aufgetreten. Hier sind die Details zum Kopieren und Melden."
		});

		// 1. Das, was wir gesendet haben (Request)
		new Setting(contentEl)
			.setName("Request Body (Gesendete Daten)")
			.setDesc("Dies wurde an die Google API gesendet. (Zum Kopieren klicken)")
			.addTextArea(text => {
				text.setValue(this.requestBody)
					.inputEl.rows = 15;
				text.inputEl.style.width = "100%";
				text.inputEl.style.fontFamily = "monospace";
				text.inputEl.setAttr("readonly", "true");
			});

		// 2. Das, was der Server geantwortet hat (Response/Error)
		new Setting(contentEl)
			.setName("Error Response (Antwort vom Server)")
			.setDesc("Dies hat der Server geantwortet. (Status 503, 400, etc.)")
			.addTextArea(text => {
				text.setValue(this.errorDetails)
					.inputEl.rows = 10;
				text.inputEl.style.width = "100%";
				text.inputEl.style.fontFamily = "monospace";
				text.inputEl.setAttr("readonly", "true");
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}
