import { App, Modal, Editor, Setting, Notice } from 'obsidian';
import { t } from '../lang/helpers';
// Import icons if needed, or use emoji/text

export class BlockIdManagerModal extends Modal {
	editor: Editor;
	blockIds: { id: string, line: number, text: string }[] = [];

	constructor(app: App, editor: Editor) {
		super(app);
		this.editor = editor;
	}

	onOpen() {
		this.scanBlockIds();
		this.display();
	}

	scanBlockIds() {
		const content = this.editor.getValue();
		const lines = content.split('\n');
		this.blockIds = [];

		// Regex to find block ID at end of line: ^abcde123 or ^semantic-id
		const blockIdRegex = /\^([a-zA-Z0-9-]+)\s*$/;

		lines.forEach((line, index) => {
			const match = line.match(blockIdRegex);
			if (match) {
				this.blockIds.push({
					id: match[1],
					line: index,
					text: line
				});
			}
		});
	}

	display() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Block IDs verwalten' });

		if (this.blockIds.length === 0) {
			contentEl.createEl('p', { text: 'Keine Block-IDs in diesem Dokument gefunden.' });
			return;
		}

		const listContainer = contentEl.createDiv({ cls: 'block-id-list' });
		listContainer.style.maxHeight = '400px';
		listContainer.style.overflowY = 'auto';

		this.blockIds.forEach((item) => {
			const row = listContainer.createDiv({ cls: 'block-id-item' });
			row.style.display = 'flex';
			row.style.justifyContent = 'space-between';
			row.style.alignItems = 'center';
			row.style.padding = '10px';
			row.style.borderBottom = '1px solid var(--background-modifier-border)';

			// ID Info
			const infoDiv = row.createDiv();
			infoDiv.createEl('span', { text: `^${item.id}`, cls: 'block-id-name' });
			infoDiv.createEl('span', { 
				text: ` (Zeile ${item.line + 1})`, 
				cls: 'block-id-line',
				attr: { style: 'color: var(--text-muted); font-size: 0.9em;' } 
			});

			// Preview context (optional, short snippet)
			const context = item.text.replace(/\s*\^[a-zA-Z0-9-]+\s*$/, '').trim();
			if (context) {
				const shortContext = context.length > 40 ? context.substring(0, 37) + '...' : context;
				infoDiv.createDiv({ 
					text: shortContext, 
					attr: { style: 'font-size: 0.8em; color: var(--text-mutex); margin-top: 2px;' } 
				});
			}

			// Delete Button
			const deleteBtn = row.createEl('button', { text: '🗑️' });
			deleteBtn.title = "ID löschen";
			deleteBtn.onclick = async () => {
				await this.deleteBlockId(item.line, item.id);
			};
		});
	}

	async deleteBlockId(lineIndex: number, id: string) {
		// Get current line content to be sure/safe
		const lineContent = this.editor.getLine(lineIndex);
		
		// Regex to remove ONLY this specific ID at the end
		// Escape ID for regex just in case, though alphanumeric+dashes is safe
		const idRegex = new RegExp(`\\s*\\^${id}\\s*$`);

		if (idRegex.test(lineContent)) {
			const newLineContent = lineContent.replace(idRegex, '');
			this.editor.setLine(lineIndex, newLineContent);
			new Notice(`Block ID ^${id} gelöscht.`);
			
			// Refresh list
			this.scanBlockIds();
			this.display();
		} else {
			new Notice("Fehler: Block-ID konnte in der Zeile nicht gefunden werden (Inhalt geändert?).");
			this.scanBlockIds(); // Rescan explicitly
			this.display();
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
