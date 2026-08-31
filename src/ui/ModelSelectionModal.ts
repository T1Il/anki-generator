import { App, Modal, Setting } from 'obsidian';
import { AiProvider } from '../types';
import { PROVIDERS } from '../providers';

type ModelSelectionCallback = (provider: AiProvider) => void;

export class ModelSelectionModal extends Modal {
	onSubmit: ModelSelectionCallback;
	providers: AiProvider[];

	constructor(app: App, providers: AiProvider[], onSubmit: ModelSelectionCallback) {
		super(app);
		this.providers = providers;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "KI-Modell auswählen" });
		contentEl.createEl("p", { text: "Wähle das Modell, das für die Kartengenerierung verwendet werden soll:" });

		if (this.providers.length === 0) {
			contentEl.createEl("p", { text: "Kein KI-Modell konfiguriert oder verfügbar." });
			return;
		}

		this.providers.forEach((id, index) => {
			new Setting(contentEl)
				.addButton(btn => {
					btn.setButtonText(PROVIDERS[id].label);
					// Der erste Eintrag ist der bevorzugte Provider.
					if (index === 0) btn.setCta();
					btn.onClick(() => {
						this.close();
						this.onSubmit(id);
					});
				});
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
