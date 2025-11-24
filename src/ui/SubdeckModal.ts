import { App, Modal, Setting, TextAreaComponent, TextComponent } from 'obsidian';

export class SubdeckModal extends Modal {
	subdeck: string;
	additionalInstructions: string = ''; // Neue Eigenschaft
	initialValue: string;
	mainDeck: string;
	deckNames: string[];
	// Aktualisierte Callback-Signatur
	onSubmit: (subdeck: string, additionalInstructions: string, isBlockOnly: boolean) => void;

	constructor(app: App, mainDeck: string, initialValue: string, deckNames: string[], onSubmit: (subdeck: string, additionalInstructions: string, isBlockOnly: boolean) => void) {
		super(app);
		this.mainDeck = mainDeck;
		this.initialValue = initialValue;
		this.subdeck = initialValue;
		this.deckNames = deckNames;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Unterdeck & Anweisungen für Anki-Karten" });

		// Pfad-Vorschau (unverändert)
		const pathPreviewEl = contentEl.createDiv({ cls: "anki-path-preview" });
		const updatePreview = (subdeckValue: string) => {
			pathPreviewEl.empty();
			pathPreviewEl.createEl("p", { text: "Finaler Pfad:", cls: "anki-path-title" });
			const sanitizedSubdeck = subdeckValue.replace(/->/g, '::');
			const fullPath = `${this.mainDeck}::${sanitizedSubdeck || 'Standard'}`; // Zeige Standard, wenn leer
			const pathParts = fullPath.split('::').filter(p => p.length > 0);
			const listEl = pathPreviewEl.createEl("div", { cls: "anki-path-list" });
			pathParts.forEach((part, index) => {
				const itemEl = listEl.createEl("div", { cls: "anki-path-item" });
				itemEl.style.paddingLeft = `${index * 20}px`;
				const emoji = index === 0 ? '🗂️' : '📂';
				itemEl.setText(`${emoji} ${part}`);
			});
		};

		// Subdeck-Eingabe
		const subdeckSetting = new Setting(contentEl)
			.setName("Name des Unterdecks")
			.setDesc("Trenne Unter-Unterdecks mit '::' oder '->'. Leer lassen für 'Standard'.");

		let subdeckInput: TextComponent;
		subdeckSetting.addText((text) => {
			subdeckInput = text;
			text.setValue(this.initialValue).onChange((value) => {
				this.subdeck = value.replace(/->/g, '::');
				updatePreview(this.subdeck);
				renderSuggestions(value);
			});
		});

		// Suggestions Container
		const suggestionsContainer = contentEl.createDiv({ cls: 'anki-deck-suggestions-container' });
		suggestionsContainer.style.maxHeight = '400px';
		suggestionsContainer.style.overflowY = 'auto';
		suggestionsContainer.style.border = '1px solid rgba(255, 255, 255, 0.1)';
		suggestionsContainer.style.borderRadius = '5px';
		suggestionsContainer.style.padding = '5px';
		suggestionsContainer.style.marginTop = '-10px'; // Pull closer to input
		suggestionsContainer.style.marginBottom = '20px';
		suggestionsContainer.style.display = 'block'; // Always visible

		const renderSuggestions = (inputValue: string) => {
			suggestionsContainer.empty();
			suggestionsContainer.style.display = 'block'; // Always show

			// Build a tree structure from all deck names
			interface TreeNode {
				name: string;
				fullPath: string;
				children: Map<string, TreeNode>;
				level: number;
			}

			const root: TreeNode = { name: '', fullPath: '', children: new Map(), level: -1 };

			// Parse all decks into tree - only include decks within mainDeck
			this.deckNames.forEach(deckPath => {
				// Skip if not a subdeck of mainDeck
				if (!deckPath.startsWith(this.mainDeck + "::")) return;

				// Extract subdeck part
				let relevantPath = deckPath.substring(this.mainDeck.length + 2);


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
					item.style.paddingLeft = `${child.level * 20}px`;
					item.style.padding = '5px';
					item.style.paddingLeft = `${child.level * 20 + 5}px`;
					item.style.cursor = 'pointer';
					item.style.borderRadius = '3px';
					item.style.transition = 'background-color 0.2s';

					const emoji = child.level === 0 ? '🗂️' : '📂';
					item.setText(`${emoji} ${child.name}`);
					item.style.fontSize = '0.9em';

					// Check if this deck is in the path of the input
					const normalizedInput = inputValue.replace(/->/g, '::').toLowerCase();
					const isMatch = child.fullPath.toLowerCase() === normalizedInput;
					const isInPath = normalizedInput.startsWith(child.fullPath.toLowerCase() + '::') || isMatch;

					if (isInPath) {
						item.style.backgroundColor = isMatch ? 'rgba(74, 144, 226, 0.4)' : 'rgba(74, 144, 226, 0.2)'; // Darker for exact match
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
						this.subdeck = child.fullPath;
						subdeckInput.setValue(child.fullPath);
						updatePreview(child.fullPath);
						renderSuggestions(child.fullPath); // Re-render to highlight
					};

					// Recursively render children
					if (child.children.size > 0) {
						renderNode(child, parentEl);
					}
				});
			};

			renderNode(root, suggestionsContainer);
		};

		// --- NEU: Textarea für zusätzliche Anweisungen ---
		const instructionSetting = new Setting(contentEl)
			.setName("Zusätzliche Anweisungen (optional)")
			.setDesc("Füge hier temporäre Anweisungen hinzu, die *nur für diese Generierung* dem Hauptprompt vorangestellt werden (z.B. 'Fokussiere dich auf Definitionen').")
			.addTextArea((text: TextAreaComponent) => {
				text.setPlaceholder("Beispiel: Erstelle nur Lückentext-Karten...")
					.onChange(value => this.additionalInstructions = value);
				text.inputEl.rows = 15;
				text.inputEl.cols = 50;
				text.inputEl.style.width = '100%';
				text.inputEl.style.minHeight = '300px';
				text.inputEl.style.height = '300px';
				text.inputEl.style.maxHeight = '500px';
				text.inputEl.style.resize = 'vertical';
				text.inputEl.style.setProperty('height', '300px', 'important');
			});

		// Make the control element full width
		instructionSetting.settingEl.style.display = 'grid';
		instructionSetting.settingEl.style.gridTemplateColumns = '1fr';
		instructionSetting.controlEl.style.width = '100%';
		instructionSetting.controlEl.style.maxWidth = '100%';
		// --- ENDE NEU ---

		// Button (aktualisiert, um beide Werte zu übergeben)
		const btnSetting = new Setting(contentEl);

		btnSetting.addButton((btn) =>
			btn.setButtonText("Nur Block erstellen")
				.setTooltip("Erstellt nur den Anki-Block Header ohne KI-Generierung")
				.onClick(() => {
					this.close();
					this.onSubmit(this.subdeck || 'Standard', this.additionalInstructions, true);
				}));

		btnSetting.addButton((btn) =>
			btn.setButtonText("Generieren").setCta().onClick(() => {
				this.close();
				// Übergib beide Werte an den Callback
				this.onSubmit(this.subdeck || 'Standard', this.additionalInstructions, false);
			}));

		updatePreview(this.initialValue); // Initiale Vorschau
		renderSuggestions(this.initialValue); // Initial suggestions anzeigen
	}

	onClose() {
		this.contentEl.empty();
	}
}
