import { App, Modal, Setting, TextAreaComponent, ButtonComponent, Notice, TFile, setIcon } from 'obsidian';
import { arrayBufferToBase64 } from '../utils';

export class ManualGenerationModal extends Modal {
	prompt: string;
	onSubmit: (response: string) => void;
	response: string = "";
	images: TFile[] = [];

	onCancel?: () => void;

	constructor(app: App, prompt: string, onSubmit: (response: string) => void, onCancel?: () => void, images: TFile[] = []) {
		super(app);
		this.prompt = prompt;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
		this.images = images;
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

		// --- IMAGES SECTION ---
		if (this.images.length > 0) {
			const imagesContainer = contentEl.createDiv({ cls: 'manual-images-container' });
			imagesContainer.style.marginBottom = '20px';
			imagesContainer.createEl('h3', { text: 'Referenzierte Bilder' });
			imagesContainer.createEl('p', { text: 'Diese Bilder werden im Text referenziert. Du kannst sie kopieren und in deinen KI-Chat einfügen.' });

			const imageList = imagesContainer.createDiv({ cls: 'manual-image-list' });
			imageList.style.display = 'flex';
			imageList.style.flexWrap = 'wrap';
			imageList.style.gap = '10px';
            imageList.style.marginBottom = '10px';

            if (this.images.length > 1) {
                const hint = imagesContainer.createEl('div');
                hint.setText("Info: Bitte Bilder einzeln kopieren (Mehrfach-Kopieren wird technisch nicht unterstützt).");
                hint.style.fontSize = "0.8em";
                hint.style.color = "var(--text-muted)";
                hint.style.marginBottom = "10px";
            }

			this.images.forEach(file => {
				const imgWrapper = imageList.createDiv({ cls: 'manual-image-wrapper' });
				imgWrapper.style.border = '1px solid var(--background-modifier-border)';
				imgWrapper.style.padding = '5px';
				imgWrapper.style.borderRadius = '5px';
				imgWrapper.style.width = '150px';
				imgWrapper.style.display = 'flex';
				imgWrapper.style.flexDirection = 'column';
				imgWrapper.style.alignItems = 'center';

				const imgName = imgWrapper.createDiv({ text: file.name });
				imgName.style.fontSize = '0.8em';
				imgName.style.marginBottom = '5px';
				imgName.style.overflow = 'hidden';
				imgName.style.textOverflow = 'ellipsis';
				imgName.style.whiteSpace = 'nowrap';
				imgName.style.width = '100%';
				imgName.style.textAlign = 'center';

				// Thumbnail (using app.vault.getResourcePath would be correct for display)
				const imgEl = imgWrapper.createEl('img');
				imgEl.src = this.app.vault.getResourcePath(file);
				imgEl.style.maxWidth = '100%';
				imgEl.style.maxHeight = '100px';
				imgEl.style.objectFit = 'contain';
				imgEl.style.marginBottom = '5px';

				const copyBtn = new ButtonComponent(imgWrapper);
				copyBtn.setButtonText("Kopieren");
				copyBtn.setIcon("copy");
				copyBtn.onClick(async () => {
					try {
						const arrayBuffer = await this.app.vault.readBinary(file);
						const blob = new Blob([arrayBuffer], { type: 'image/png' }); // Basic assumption, acceptable for clipboard?
						// Clipboard Item Type must match actual mime type usually
						// Let's try generic approach or detect mime
						let mimeType = 'image/png';
						if (file.extension === 'jpg' || file.extension === 'jpeg') mimeType = 'image/jpeg';
						else if (file.extension === 'webp') mimeType = 'image/webp';
										
						const item = new ClipboardItem({ [mimeType]: blob });
						await navigator.clipboard.write([item]);
						new Notice("Bild in Zwischenablage kopiert!");
					} catch (err) {
						console.error("Copy image failed", err);
						new Notice("Fehler beim Kopieren des Bildes: " + err);
					}
				});
			});
		}

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

		new Setting(responseContainer)
			.addButton(btn => btn
				.setButtonText("📋 Aus Zwischenablage einfügen")
				.setTooltip("Fügt den Inhalt deiner Zwischenablage in das Textfeld ein")
				.onClick(async () => {
					try {
						const text = await navigator.clipboard.readText();
						responseTextArea.setValue(text);
						this.response = text; // Update internal state
						new Notice("Text eingefügt!");
					} catch (e) {
						new Notice("Fehler beim Zugriff auf die Zwischenablage.");
					}
				}));

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
