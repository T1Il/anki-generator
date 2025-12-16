import { Modal, App as ObsidianApp, Setting, TextComponent, ButtonComponent } from 'obsidian';

export class DeckSelectionModal extends Modal {
	onSubmit: (result: string) => void;
	deckName: string;
	deckNames: string[];
	mainDeck: string;
	constructor(app: ObsidianApp, currentDeck: string, deckNames: string[], onSubmit: (result: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
		this.deckName = currentDeck;
		this.deckNames = deckNames;
		// Extract mainDeck from currentDeck or use first part of any deck
		this.mainDeck = currentDeck.split('::')[0] || 'Default';
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Deck ändern" });
		contentEl.createEl("p", { text: "Wähle ein existierendes Deck oder gib einen neuen Namen ein." });
		const container = contentEl.createDiv();
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.gap = '10px';
		// Preview Area
		const previewEl = container.createDiv({ cls: 'anki-deck-preview' });
		previewEl.style.padding = '10px';
		previewEl.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
		previewEl.style.borderRadius = '5px';
		previewEl.style.fontFamily = 'monospace';
		previewEl.style.marginBottom = '10px';
		this.updatePreview(previewEl, this.deckName);
		// Input field using Setting
		const deckSetting = new Setting(container)
			.setName("Deck Name")
			.setDesc("Gib den Namen des Decks ein oder wähle aus der Liste.");
		let deckInput: TextComponent;
		deckSetting.addText((text) => {
			deckInput = text;
			text.setValue(this.deckName)
				.setPlaceholder("Deck Name")
				.onChange((value) => {
					this.deckName = value;
					this.updatePreview(previewEl, value);
					this.renderSuggestions(suggestionsEl, deckInput, previewEl);
				});
			text.inputEl.style.width = '100%';
		});
		// Suggestions List
		const suggestionsEl = container.createDiv({ cls: 'anki-deck-suggestions' });
		suggestionsEl.style.maxHeight = '400px';
		suggestionsEl.style.overflowY = 'auto';
		suggestionsEl.style.border = '1px solid rgba(255, 255, 255, 0.1)';
		suggestionsEl.style.borderRadius = '5px';
		suggestionsEl.style.padding = '5px';
		suggestionsEl.style.marginTop = '-10px';
		suggestionsEl.style.marginBottom = '10px';
		suggestionsEl.style.display = 'block'; // Always visible
		this.renderSuggestions(suggestionsEl, deckInput!, previewEl);
		// Focus input
		setTimeout(() => deckInput.inputEl.focus(), 50);
		const btnContainer = contentEl.createDiv();
		btnContainer.style.marginTop = '10px';
		btnContainer.style.display = 'flex';
		btnContainer.style.justifyContent = 'flex-end';
		new ButtonComponent(btnContainer)
			.setButtonText("Ändern & Verschieben")
			.setCta()
			.onClick(() => {
				this.close();
				this.onSubmit(this.deckName);
			});
	}
	updatePreview(el: HTMLElement, name: string) {
		el.empty();
		if (!name) {
			el.setText("Vorschau: (Kein Name)");
			return;
		}
		const parts = name.split("::");
		const hierarchy = parts.join(" ➤ ");
		el.setText("Vorschau: " + hierarchy);
	}
	renderSuggestions(container: HTMLElement, input: TextComponent, previewEl: HTMLElement) {
		container.empty();
		container.style.display = 'block'; // Always show
		// Build a tree structure from filtered deck names
		interface TreeNode {
			name: string;
			fullPath: string;
			children: Map<string, TreeNode>;
			level: number;
		}
		const root: TreeNode = { name: '', fullPath: '', children: new Map(), level: -1 };
		// Parse all decks into tree - ONLY decks within mainDeck
		this.deckNames.forEach(deckPath => {
			// Skip if not a subdeck of mainDeck
			if (!deckPath.startsWith(this.mainDeck + "::")) return;
			// Extract subdeck part (remove mainDeck prefix)
			const relevantPath = deckPath.substring(this.mainDeck.length + 2);
			const parts = relevantPath.split('::');
			let currentNode = root;
			parts.forEach((part, index) => {
				if (!currentNode.children.has(part)) {
					const pathSoFar = parts.slice(0, index + 1).join('::');
					currentNode.children.set(part, {
						name: part,
						fullPath: pathSoFar,
						children: new Map(),
						level: index
					});
				}
				currentNode = currentNode.children.get(part)!;
			});
		});
		// Render tree recursively
		const renderNode = (node: TreeNode, parentEl: HTMLElement) => {
			node.children.forEach(child => {
				const item = parentEl.createDiv({ cls: 'anki-deck-suggestion-item' });
				item.style.padding = '5px';
				item.style.paddingLeft = `${child.level * 20 + 5}px`;
				item.style.cursor = 'pointer';
				item.style.borderRadius = '3px';
				item.style.transition = 'background-color 0.2s';
				const emoji = child.level === 0 ? '🗂️' : '📂';
				item.setText(`${emoji} ${child.name}`);
				item.style.fontSize = '0.9em';
				// Check if this deck is in the path of the input
				// Normalize both to compare relative paths
				const normalizedInput = this.deckName.replace(this.mainDeck + '::', '').toLowerCase();
				const isMatch = child.fullPath.toLowerCase() === normalizedInput;
				const isInPath = normalizedInput.startsWith(child.fullPath.toLowerCase() + '::') || isMatch;
				if (isInPath) {
					item.style.backgroundColor = isMatch ? 'rgba(74, 144, 226, 0.4)' : 'rgba(74, 144, 226, 0.2)';
					item.style.fontWeight = isMatch ? 'bold' : '600';
				}
				item.onmouseover = () => {
					if (!isInPath) {
						item.style.backgroundColor = 'rgba(74, 144, 226, 0.15)';
					}
				};
				item.onmouseout = () => {
					if (!isInPath) {
						item.style.backgroundColor = 'transparent';
					} else {
						item.style.backgroundColor = isMatch ? 'rgba(74, 144, 226, 0.4)' : 'rgba(74, 144, 226, 0.2)';
					}
				};
				item.onclick = () => {
					// Set full path including mainDeck
					this.deckName = this.mainDeck + '::' + child.fullPath;
					input.setValue(this.deckName);
					this.updatePreview(previewEl, this.deckName);
					this.renderSuggestions(container, input, previewEl); // Re-render to highlight
				};
				// Recursively render children
				renderNode(child, parentEl);
			});
		};
		renderNode(root, container);
	}
}
