import { Modal, App as ObsidianApp, TextAreaComponent, ButtonComponent, Setting } from 'obsidian';

export class RevisionOptionsModal extends Modal {
    activeInstructions: string[];
    onUseExisting: () => void;
    onUseNew: (instruction: string) => void;

    constructor(
        app: ObsidianApp, 
        activeInstructions: string[], 
        onUseExisting: () => void, 
        onUseNew: (instruction: string) => void
    ) {
        super(app);
        this.activeInstructions = activeInstructions;
        this.onUseExisting = onUseExisting;
        this.onUseNew = onUseNew;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Karten überarbeiten" });

        // OPTION 1: Use Existing Instructions
        if (this.activeInstructions.length > 0) {
            const existingSection = contentEl.createDiv({ cls: 'anki-revision-section' });
            existingSection.style.marginBottom = '20px';
            existingSection.style.padding = '10px';
            existingSection.style.border = '1px solid var(--background-modifier-border)';
            existingSection.style.borderRadius = '5px';
            existingSection.style.backgroundColor = 'var(--background-secondary)';

            existingSection.createEl('h3', { text: "Bestehende Anweisungen verwenden" });
            const list = existingSection.createEl('ul');
            this.activeInstructions.forEach(instr => {
                list.createEl('li', { text: instr });
            });

            new ButtonComponent(existingSection)
                .setButtonText("Start")
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onUseExisting();
                });
            
            contentEl.createEl('hr');
        }

        // OPTION 2: New Instruction
        const newSection = contentEl.createDiv({ cls: 'anki-revision-section' });
        newSection.createEl('h3', { text: "Oder: Neue Anweisung eingeben" });
        newSection.createDiv({ text: "Diese Anweisung wird nur für diesen Lauf verwendet." }).style.marginBottom = '10px';
        newSection.style.color = 'var(--text-muted)';
        newSection.style.fontSize = '0.9em';

        let newInstruction = "";
        const textArea = new TextAreaComponent(newSection)
            .setPlaceholder("Anweisung...")
            .onChange((value) => {
                newInstruction = value;
            });
        textArea.inputEl.style.width = '100%';
        textArea.inputEl.rows = 3;

        const btnDiv = newSection.createDiv();
        btnDiv.style.marginTop = '10px';
        btnDiv.style.display = 'flex';
        btnDiv.style.justifyContent = 'flex-end';

        new ButtonComponent(btnDiv)
            .setButtonText("Start (Neu)")
            .onClick(() => {
                this.close();
                this.onUseNew(newInstruction);
            });
    }

    onClose() {
        this.contentEl.empty();
    }
}
