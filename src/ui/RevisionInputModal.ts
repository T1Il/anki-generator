import { Modal, App as ObsidianApp, TextAreaComponent, ButtonComponent } from 'obsidian';

export class RevisionInputModal extends Modal {
	onSubmit: (result: string) => void;
	instruction: string;
	title: string;
	initialValue: string;
    customTitle: string;

	constructor(app: ObsidianApp, onSubmit: (result: string) => void, initialValue: string = "", customTitle: string = "") {
		super(app);
		this.onSubmit = onSubmit;
		this.instruction = initialValue;
		this.initialValue = initialValue;
        this.customTitle = customTitle;
	}

	onOpen() {
		const { contentEl } = this;
        const defaultTitle = this.initialValue ? "Anweisung bearbeiten" : "Karten überarbeiten";
		contentEl.createEl("h2", { text: this.customTitle || defaultTitle });

		new TextAreaComponent(contentEl)
			.setPlaceholder("Anweisung...")
			.setValue(this.initialValue)
			.onChange((value) => {
				this.instruction = value;
			})
			.inputEl.style.width = '100%';

		const btnContainer = contentEl.createDiv();
		btnContainer.style.marginTop = '10px';
		btnContainer.style.display = 'flex';
		btnContainer.style.justifyContent = 'flex-end';

		new ButtonComponent(btnContainer)
			.setButtonText(this.initialValue ? "Speichern" : "Start")
			.setCta()
			.onClick(() => {
				this.close();
				this.onSubmit(this.instruction);
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
