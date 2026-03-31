
import { App, FuzzySuggestModal, TFile } from 'obsidian';

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
    onChoose: (result: TFile) => void;

    constructor(app: App, onChoose: (result: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder("Datei auswählen...");
    }

    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles();
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(item);
    }
}
