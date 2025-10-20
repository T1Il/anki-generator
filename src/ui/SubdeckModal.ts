import { App, Modal, Setting } from 'obsidian';

export class SubdeckModal extends Modal {
	subdeck: string;
	initialValue: string;
	mainDeck: string;
	onSubmit: (subdeck: string) => void;

	constructor(app: App, mainDeck: string, initialValue: string, onSubmit: (subdeck: string) => void) {
		super(app);
		this.mainDeck = mainDeck;
		this.initialValue = initialValue;
		this.subdeck = initialValue;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Unterdeck für Anki-Karten" });
		const pathPreviewEl = contentEl.createDiv({ cls: "anki-path-preview" });
		const updatePreview = (subdeckValue: string) => {
			pathPreviewEl.empty();
			pathPreviewEl.createEl("p", { text: "Finaler Pfad:", cls: "anki-path-title" });
			const sanitizedSubdeck = subdeckValue.replace(/->/g, '::');
			const fullPath = `${this.mainDeck}::${sanitizedSubdeck}`;
			const pathParts = fullPath.split('::').filter(p => p.length > 0);
			const listEl = pathPreviewEl.createEl("div", { cls: "anki-path-list" });
			pathParts.forEach((part, index) => {
				const itemEl = listEl.createEl("div", { cls: "anki-path-item" });
				itemEl.style.paddingLeft = `${index * 20}px`;
				const emoji = index === 0 ? '🗂️' : '📂';
				itemEl.setText(`${emoji} ${part}`);
			});
		};

		new Setting(contentEl).setName("Name des Unterdecks").setDesc("Du kannst Unter-Unterdecks mit '::' oder '->' trennen.").addText((text) =>
			text.setValue(this.initialValue).onChange((value) => {
				this.subdeck = value.replace(/->/g, '::');
				updatePreview(this.subdeck);
			}));

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Generieren").setCta().onClick(() => {
				this.close();
				this.onSubmit(this.subdeck || 'Standard');
			}));

		updatePreview(this.initialValue);
	}

	onClose() {
		this.contentEl.empty();
	}
}
